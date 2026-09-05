import { Hono } from "hono";
import { expect, it } from "vitest";
import z from "zod/v4";
import { generateSpecs } from "../handler.js";
import { describeRoute, resolver } from "../middlewares.js";

function localReferences(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, child]) => {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
      return [child];
    }
    return localReferences(child);
  });
}

it("preserves responses with explicitly undefined content", async () => {
  const app = new Hono().get(
    "/empty",
    describeRoute({
      responses: { 204: { description: "No content", content: undefined } },
    }),
    (c) => c.body(null, 204),
  );
  const document = await generateSpecs(app);

  expect(document.paths["/empty"]?.get?.responses?.[204]).toEqual({
    description: "No content",
    content: undefined,
  });
});

it.each(["route", "component"] as const)(
  "preserves recursive components when a %s response is reused",
  async (location) => {
    const response = {
      description: "JSON schemas",
      content: {
        "application/json": {
          schema: resolver(z.record(z.string(), z.json())),
        },
      },
    };
    const middleware = describeRoute({
      responses: {
        200:
          location === "route"
            ? response
            : { $ref: "#/components/responses/EventSchemas" },
      },
    });
    const documentation =
      location === "component"
        ? { components: { responses: { EventSchemas: response } } }
        : {};
    const createApp = () =>
      new Hono().get("/schemas", middleware, (c) => c.json({}));
    const app = createApp();
    const original = await generateSpecs(app, { documentation });

    for (const target of [app, createApp()]) {
      const document = await generateSpecs(target, { documentation });
      const references = localReferences(document);

      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        const path = reference
          .slice(2)
          .split("/")
          .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
        expect(document).toHaveProperty(path);
      }
      expect(document).toEqual(original);
    }

    expect(
      response.content["application/json"].schema.toOpenAPISchema,
    ).toBeTypeOf("function");
  },
);
