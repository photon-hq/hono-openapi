import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import z from "zod/v4";
import { generateSpecs } from "../handler.js";
import {
  describeResponse,
  describeRoute,
  resolver,
  validator,
} from "../middlewares.js";

type ObjectSchema = { properties: Record<string, Record<string, unknown>> };

describe("zod v4", () => {
  it("basic", async () => {
    const app = new Hono().get(
      "/",
      describeRoute({
        tags: ["test"],
        summary: "Test route",
        description: "This is a test route",
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    message: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator("json", z.object({ message: z.string() })),
      async (c) => {
        return c.json({ message: "Hello, world!" });
      },
    );

    const specs = await generateSpecs(app);

    expect(specs).toMatchSnapshot();
  });

  it("with metadata", async () => {
    const app = new Hono().get(
      "/",
      describeRoute({
        tags: ["test"],
        summary: "Test route",
        description: "This is a test route",
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      message: z.string(),
                    })
                    .meta({ ref: "SuccessResponse" }),
                ),
              },
            },
          },
        },
      }),
      validator("json", z.object({ message: z.string() })),
      async (c) => {
        return c.json({ message: "Hello, world!" });
      },
    );

    const specs = await generateSpecs(app);

    expect(specs).toMatchSnapshot();
  });

  it("with response description", async () => {
    const app = new Hono().get(
      "/",
      describeRoute({
        tags: ["test"],
        summary: "Test route",
        description: "This is a test route",
      }),
      validator("json", z.object({ message: z.string() })),
      describeResponse(
        async (c) => {
          try {
            return c.json({ message: "Hello World" }, 200);
          } catch (e) {
            console.error(e);
            return c.json({ error: e.message }, 400);
          }
        },
        {
          200: {
            description: "Success",
            content: {
              "application/json": {
                vSchema: z
                  .object({
                    message: z.string(),
                  })
                  .meta({ ref: "SuccessResponse" }),
              },
            },
          },
          400: {
            description: "Error",
            content: {
              "application/json": {
                vSchema: z.object({
                  error: z.string(),
                }),
              },
            },
          },
        },
      ),
    );

    const specs = await generateSpecs(app);

    expect(specs).toMatchSnapshot();
  });

  it("with global validator", async () => {
    const app = new Hono()
      .use(validator("query", z.object({ q1: z.string() })))
      .get(
        "/",
        describeRoute({
          tags: ["test"],
          summary: "Test route",
          description: "This is a test route",
        }),
        validator("query", z.object({ q2: z.string() })),
        async (c) => {
          return c.json({ message: "Hello, world!" });
        },
      );

    const specs = await generateSpecs(app);

    expect(specs).toMatchSnapshot();
  });

  it("resolver in documentation.components.responses", async () => {
    const errorSchema = z
      .object({ message: z.string() })
      .meta({ ref: "Error" });

    const app = new Hono().get(
      "/",
      describeRoute({
        tags: ["test"],
        summary: "Test route",
        description: "This is a test route",
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    message: z.string(),
                  }),
                ),
              },
            },
          },
          404: {
            $ref: "#/components/responses/NotFoundError",
          },
        },
      }),
      validator("json", z.object({ message: z.string() })),
      async (c) => {
        return c.json({ message: "Hello, world!" });
      },
    );

    const specs = await generateSpecs(app, {
      documentation: {
        components: {
          responses: {
            NotFoundError: {
              description: "Not Found",
              content: {
                "application/json": {
                  schema: resolver(errorSchema),
                },
              },
            },
          },
        },
      },
    });

    // The resolver in documentation.components should be resolved to a proper OpenAPI schema
    const notFoundResponse = specs.components?.responses?.NotFoundError as any;
    expect(notFoundResponse).toBeDefined();
    expect(notFoundResponse.description).toBe("Not Found");

    // The schema should be resolved (not contain vendor/validate/toOpenAPISchema)
    const schema = notFoundResponse.content?.["application/json"]?.schema;
    expect(schema).toBeDefined();
    expect(schema).not.toHaveProperty("vendor");
    expect(schema).not.toHaveProperty("validate");
    expect(schema).not.toHaveProperty("toOpenAPISchema");

    // Should be a $ref since errorSchema has .meta({ ref: "Error" })
    expect(schema).toHaveProperty("$ref");
    expect(schema.$ref).toBe("#/components/schemas/Error");

    // The Error schema should be in components.schemas
    expect(specs.components?.schemas?.Error).toBeDefined();
  });

  it("resolver in documentation.components.responses without ref", async () => {
    const errorSchema = z.object({ message: z.string() });

    const app = new Hono().get(
      "/",
      describeRoute({
        tags: ["test"],
        summary: "Test route",
        description: "This is a test route",
      }),
      validator("json", z.object({ message: z.string() })),
      async (c) => {
        return c.json({ message: "Hello, world!" });
      },
    );

    const specs = await generateSpecs(app, {
      documentation: {
        components: {
          responses: {
            InternalError: {
              description: "Internal Server Error",
              content: {
                "application/json": {
                  schema: resolver(errorSchema),
                },
              },
            },
          },
        },
      },
    });

    // The resolver should be resolved to an inline schema
    const errorResponse = specs.components?.responses?.InternalError as any;
    expect(errorResponse).toBeDefined();

    const schema = errorResponse.content?.["application/json"]?.schema;
    expect(schema).toBeDefined();
    expect(schema).not.toHaveProperty("vendor");
    expect(schema).not.toHaveProperty("toOpenAPISchema");
    expect(schema).toHaveProperty("type", "object");
    expect(schema.properties?.message).toHaveProperty("type", "string");
  });

  it("defaultOptions should not cause parameter pollution between routes", async () => {
    const app = new Hono()
      .get(
        "/hello",
        describeRoute({}),
        validator("query", z.object({ name: z.string() })),
        (c) => {
          const { name } = c.req.valid("query");
          return c.text(`Hello, ${name}!`);
        },
      )
      .get(
        "/world",
        describeRoute({}),
        validator("query", z.object({ greeting: z.string() })),
        (c) => {
          const { greeting } = c.req.valid("query");
          return c.text(`${greeting}, world!`);
        },
      );

    const specs = await generateSpecs(app, {
      defaultOptions: {
        GET: {},
      },
    });

    // Verify /hello only has 'name' parameter
    const helloParams = specs.paths["/hello"]?.get?.parameters;
    expect(helloParams).toHaveLength(1);
    expect(helloParams?.[0]).toMatchObject({ name: "name", in: "query" });

    // Verify /world only has 'greeting' parameter (not 'name' from /hello)
    const worldParams = specs.paths["/world"]?.get?.parameters;
    expect(worldParams).toHaveLength(1);
    expect(worldParams?.[0]).toMatchObject({ name: "greeting", in: "query" });
  });

  it("validator should set requestBody.required to true", async () => {
    const app = new Hono().post(
      "/",
      validator("json", z.object({ name: z.string() })),
      async (c) => {
        return c.json({ ok: true });
      },
    );

    const specs = await generateSpecs(app);

    const requestBody = specs.paths["/"]?.post?.requestBody as any;
    expect(requestBody).toBeDefined();
    expect(requestBody.required).toBe(true);
  });

  it("describeResponse with Date schema matches c.json serialization", async () => {
    const ResponseSchema = z.object({
      name: z.string(),
      createdAt: z.iso.date(),
    });

    const app = new Hono().get(
      "/",
      describeResponse(
        (c) => {
          return c.json(
            {
              name: "test",
              createdAt: new Date(),
            },
            200,
          );
        },
        {
          200: {
            description: "OK",
            content: {
              "application/json": {
                vSchema: ResponseSchema,
              },
            },
          },
        },
      ),
    );

    const specs = await generateSpecs(app);

    expect(specs.paths["/"]?.get?.responses).toEqual({
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: expect.any(Object),
          },
        },
      },
    });
  });

  it("z.date() should be converted to string with date-time format", async () => {
    const app = new Hono().get(
      "/",
      describeRoute({
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    name: z.string(),
                    createdAt: z.date(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ name: "test", createdAt: new Date() });
      },
    );

    const specs = await generateSpecs(app);

    const schema =
      specs.paths["/"]?.get?.responses?.[200]?.content?.["application/json"]
        ?.schema;
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties?.createdAt).toEqual({
      type: "string",
      format: "date-time",
    });
  });

  it("documents formats without Zod's pattern where the format alone describes the value", async () => {
    const handle = /^@[a-z]+$/;
    const shape = {
      at: z.iso.datetime(),
      atWithOffset: z.iso.datetime({ offset: true }),
      day: z.iso.date(),
      email: z.email(),
      handle: z.string().regex(handle),
      id: z.uuid(),
      local: z.iso.datetime({ local: true }),
      nullableAt: z.iso.datetime().nullable(),
      phone: z.e164(),
      stampedAt: z.iso.datetime({ precision: 3 }),
      token: z.base64(),
      zulu: z.iso.datetime().regex(/Z$/),
    };
    const app = new Hono().post(
      "/",
      validator("json", z.object(shape)),
      describeRoute({
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": { schema: resolver(z.object(shape)) },
            },
          },
        },
      }),
      async (c) => c.json({}),
    );

    const specs = await generateSpecs(app);
    const output = (
      specs.paths["/"]?.post?.responses?.[200]?.content?.["application/json"]
        ?.schema as ObjectSchema
    ).properties;
    const input = (
      specs.paths["/"]?.post?.requestBody as {
        content: Record<string, { schema: ObjectSchema }>;
      }
    ).content["application/json"].schema.properties;
    const hasPattern = (schema: unknown) =>
      JSON.stringify(schema).includes('"pattern"');

    // Produced values: every value the check allows is a valid instance of
    // the format, so the format is enough.
    for (const name of [
      "at",
      "atWithOffset",
      "day",
      "email",
      "id",
      "nullableAt",
      "stampedAt",
    ]) {
      expect(hasPattern(output[name]), name).toBe(false);
    }
    expect(output.at).toEqual({ type: "string", format: "date-time" });
    // Accepted values keep the pattern unless the check accepts everything
    // the format allows: a plain z.iso.datetime() rejects offsets.
    for (const name of ["atWithOffset", "day"]) {
      expect(hasPattern(input[name]), name).toBe(false);
    }
    for (const name of ["at", "email", "id", "nullableAt", "stampedAt"]) {
      expect(hasPattern(input[name]), name).toBe(true);
    }
    // Never dropped: a schema's own regex, Zod-only formats, local times.
    for (const schemas of [input, output]) {
      expect(schemas.handle).toHaveProperty("pattern", handle.source);
      expect(JSON.stringify(schemas.zulu)).toContain("Z$");
      for (const name of ["local", "phone", "token"]) {
        expect(hasPattern(schemas[name]), name).toBe(true);
      }
    }
  });

  it("z.date() should work in validator schemas", async () => {
    const app = new Hono().post(
      "/",
      validator("json", z.object({ scheduledAt: z.date() })),
      async (c) => {
        return c.json({ ok: true });
      },
    );

    const specs = await generateSpecs(app);

    const requestBody = specs.paths["/"]?.post?.requestBody as any;
    expect(requestBody).toBeDefined();
    const schema = requestBody.content?.["application/json"]?.schema;
    expect(schema).toBeDefined();
    expect(schema.properties?.scheduledAt).toEqual({
      type: "string",
      format: "date-time",
    });
  });

  it("user-provided override should take precedence over default z.date() handling", async () => {
    const customOverride = (ctx: {
      zodSchema: { _zod: { def: { type: string } } };
      jsonSchema: Record<string, unknown>;
    }) => {
      if (ctx.zodSchema._zod.def.type === "date") {
        ctx.jsonSchema.type = "string";
        ctx.jsonSchema.format = "date";
      }
    };

    const app = new Hono().get(
      "/",
      describeRoute({
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: resolver(z.object({ createdAt: z.date() }), {
                  options: {
                    unrepresentable: "any",
                    override: customOverride,
                  },
                }),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ createdAt: new Date() });
      },
    );

    const specs = await generateSpecs(app);

    const schema =
      specs.paths["/"]?.get?.responses?.[200]?.content?.["application/json"]
        ?.schema;
    expect(schema).toBeDefined();
    // Should use the user's custom format ("date") not our default ("date-time")
    expect(schema.properties?.createdAt).toEqual({
      type: "string",
      format: "date",
    });
  });
});
