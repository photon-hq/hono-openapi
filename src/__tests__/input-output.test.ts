import { Hono } from "hono";
import type { OpenAPIV3_1 } from "openapi-types";
import { expect, it } from "vitest";
import z from "zod/v4";
import { generateSpecs } from "../handler.js";
import {
  describeRoute,
  loadVendor,
  resolver,
  validator,
} from "../middlewares.js";

it("documents accepted requests and serialized responses independently", async () => {
  const shared = z
    .object({ name: z.string().default("Ada") })
    .meta({ ref: "Person" });
  const app = new Hono().post(
    "/people",
    describeRoute({
      responses: {
        200: {
          description: "Person",
          content: { "application/json": { schema: resolver(shared) } },
        },
      },
    }),
    validator("json", shared),
    (c) => c.json(c.req.valid("json")),
  );
  const response = await app.request("/people", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extra: true }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ name: "Ada" });
  const document = await generateSpecs(app);
  expect(document.components?.schemas?.input__Person).toMatchObject({
    properties: { name: { default: "Ada" } },
  });
  expect(document.components?.schemas?.input__Person).not.toHaveProperty(
    "required",
  );
  expect(document.components?.schemas?.input__Person).not.toHaveProperty(
    "additionalProperties",
    false,
  );
  expect(document.components?.schemas?.output__Person).toMatchObject({
    required: ["name"],
    additionalProperties: false,
  });
  expect(document.paths?.["/people"]?.post?.requestBody).toMatchObject({
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/input__Person" },
      },
    },
  });
  expect(document.paths?.["/people"]?.post?.responses?.[200]).toMatchObject({
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/output__Person" },
      },
    },
  });
  expect(await generateSpecs(app)).toEqual(document);
});

it("passes direction to custom vendors, including reusable responses, regardless of conflicting vendor options", async () => {
  const directions: unknown[] = [];
  loadVendor("direction-test", {
    toOpenAPISchema: (schema, context) => {
      directions.push(context.io);
      return z.toJSONSchema(schema as z.ZodType, {
        io: context.io,
      }) as OpenAPIV3_1.SchemaObject;
    },
  });
  const shared = z.object({
    count: z.number().default(1),
    get next() {
      return shared.optional();
    },
  });
  Object.assign(shared["~standard"], { vendor: "direction-test" });
  const app = new Hono().post(
    "/",
    describeRoute({
      responses: { 200: { $ref: "#/components/responses/Shared" } },
    }),
    validator("json", shared, undefined, { options: { io: "output" } }),
    (c) => c.json(c.req.valid("json")),
  );
  const result = await generateSpecs(app, {
    documentation: {
      components: {
        responses: {
          Shared: {
            description: "Shared",
            content: {
              "application/json": {
                schema: resolver(shared, { options: { io: "input" } }),
              },
            },
          },
        },
      },
    },
  });
  expect(directions).toEqual(["input", "output"]);
  const refs =
    JSON.stringify(result).match(/#\/components\/schemas\/[^"]+/g) ?? [];
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs)
    expect(result.components?.schemas).toHaveProperty(
      ref.split("/").pop() ?? "",
    );
});

it("keeps strict requests strict, typed catchalls typed and passthrough responses open", async () => {
  const request = z.strictObject({ labels: z.record(z.string(), z.string()) });
  const response = z.object({ id: z.string() }).passthrough();
  const app = new Hono().post(
    "/",
    describeRoute({
      responses: {
        200: {
          description: "Open",
          content: { "application/json": { schema: resolver(response) } },
        },
      },
    }),
    validator("json", request),
    (c) => c.json(response.parse({ id: "1", extra: true })),
  );
  expect(
    (
      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: {}, extra: true }),
      })
    ).status,
  ).toBe(400);
  const document = await generateSpecs(app);
  expect(document.paths?.["/"]?.post?.requestBody).toMatchObject({
    content: {
      "application/json": {
        schema: {
          additionalProperties: false,
          properties: { labels: { additionalProperties: { type: "string" } } },
        },
      },
    },
  });
  expect(document.paths?.["/"]?.post?.responses?.[200]).toMatchObject({
    content: { "application/json": { schema: { additionalProperties: {} } } },
  });
});

it("retains every named query property and input requiredness", async () => {
  const query = z
    .object({ term: z.string(), page: z.string().default("1") })
    .meta({ ref: "Search" });
  const app = new Hono().get("/", validator("query", query), (c) =>
    c.json(c.req.valid("query")),
  );
  const document = await generateSpecs(app);
  expect(document.paths?.["/"]?.get?.parameters).toEqual([
    { in: "query", name: "term", schema: { type: "string" }, required: true },
    { in: "query", name: "page", schema: { type: "string", default: "1" } },
  ]);
});

it("rejects conflicting response component names instead of overwriting a route's contract", async () => {
  const app = new Hono();
  for (const [path, schema] of [
    ["/text", z.object({ value: z.string() }).meta({ ref: "Shared" })],
    ["/number", z.object({ value: z.number() }).meta({ ref: "Shared" })],
  ] as const) {
    app.get(
      path,
      describeRoute({
        responses: {
          200: {
            description: "Shared",
            content: { "application/json": { schema: resolver(schema) } },
          },
        },
      }),
      (c) => c.json({}),
    );
  }
  await expect(generateSpecs(app)).rejects.toThrow(
    'Conflicting schema component "output__Shared"',
  );
});
