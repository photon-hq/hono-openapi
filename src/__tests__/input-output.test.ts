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
  expect(document.components?.schemas?.PersonInput).toMatchObject({
    properties: { name: { default: "Ada" } },
  });
  expect(document.components?.schemas?.PersonInput).not.toHaveProperty(
    "required",
  );
  expect(document.components?.schemas?.PersonInput).not.toHaveProperty(
    "additionalProperties",
    false,
  );
  expect(document.components?.schemas?.Person).toMatchObject({
    required: ["name"],
    additionalProperties: false,
  });
  expect(document.paths?.["/people"]?.post?.requestBody).toMatchObject({
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/PersonInput" },
      },
    },
  });
  expect(document.paths?.["/people"]?.post?.responses?.[200]).toMatchObject({
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Person" },
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
  const shared = z
    .object({
      count: z.number().default(1),
      get next() {
        return shared.optional();
      },
    })
    .meta({ ref: "Shared" });
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
  // The request conversion is compared with an output conversion of the same
  // schema to decide whether the request component needs its own name.
  expect(directions).toEqual(["input", "output", "output"]);
  expect(Object.keys(result.components?.schemas ?? {}).sort()).toEqual([
    "Shared",
    "SharedInput",
  ]);
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
    .object({
      term: z.string().describe("Search term"),
      page: z.string().default("1"),
    })
    .meta({ ref: "Search" });
  const app = new Hono().get("/", validator("query", query), (c) =>
    c.json(c.req.valid("query")),
  );
  const document = await generateSpecs(app);
  expect(document.paths?.["/"]?.get?.parameters).toEqual([
    {
      in: "query",
      name: "term",
      schema: { type: "string" },
      required: true,
      description: "Search term",
    },
    { in: "query", name: "page", schema: { type: "string", default: "1" } },
  ]);
  expect(document.components?.schemas?.SearchInput).toMatchObject({
    properties: { term: { type: "string", description: "Search term" } },
  });
  expect(await generateSpecs(app)).toEqual(document);
});

it("requires named path parameters even when their input schema is optional or defaulted", async () => {
  const params = z
    .object({
      id: z.string().default("fallback"),
      revision: z.string().optional(),
    })
    .meta({ ref: "PathParams" });
  const app = new Hono().get(
    "/items/:id/:revision",
    validator("param", params),
    (c) => c.json(c.req.valid("param")),
  );
  const document = await generateSpecs(app);
  expect(document.paths?.["/items/{id}/{revision}"]?.get?.parameters).toEqual([
    {
      in: "path",
      name: "id",
      schema: { type: "string", default: "fallback" },
      required: true,
    },
    {
      in: "path",
      name: "revision",
      schema: { type: "string" },
      required: true,
    },
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
    'Conflicting schema component "Shared"',
  );
});

it("accepts equivalent documented and generated components with reordered object keys", async () => {
  const shared = z
    .object({ name: z.string().describe("Display name"), active: z.boolean() })
    .meta({ ref: "Documented" });
  const app = new Hono().get(
    "/",
    describeRoute({
      responses: {
        200: {
          description: "Documented",
          content: { "application/json": { schema: resolver(shared) } },
        },
      },
    }),
    (c) => c.json({ name: "Ada", active: true }),
  );
  const documentation = {
    components: {
      schemas: {
        Documented: {
          description: undefined,
          additionalProperties: false,
          required: ["name", "active"],
          properties: {
            active: { type: "boolean" },
            name: { description: "Display name", type: "string" },
          },
          type: "object",
        },
      },
    },
  } satisfies Partial<OpenAPIV3_1.Document>;
  const document = await generateSpecs(app, { documentation });
  expect(document.components?.schemas?.Documented).toEqual(
    documentation.components.schemas.Documented,
  );
  expect(await generateSpecs(app, { documentation })).toEqual(document);
});

it.each([
  { label: "array order", example: [2, 1] },
  { label: "array length", example: [1, 2, 3] },
  { label: "primitive value", example: [1, 3] },
  { label: "null value", example: null },
])("rejects component differences in $label", async ({ example }) => {
  const shared = z.array(z.number()).meta({ ref: "Example", example: [1, 2] });
  const app = new Hono().get(
    "/",
    describeRoute({
      responses: {
        200: {
          description: "Example",
          content: { "application/json": { schema: resolver(shared) } },
        },
      },
    }),
    (c) => c.json([1, 2]),
  );
  await expect(
    generateSpecs(app, {
      documentation: {
        components: {
          schemas: {
            Example: {
              type: "array",
              items: { type: "number" },
              example,
            },
          },
        },
      },
    }),
  ).rejects.toThrow('Conflicting schema component "Example"');
});
