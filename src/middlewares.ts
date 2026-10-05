import { type Hook, sValidator } from "@hono/standard-validator";
import {
  loadVendor as loadVendorJson,
  toJsonSchema,
} from "@standard-community/standard-json";
import {
  loadVendor as loadVendorOpenAPI,
  toOpenAPISchema,
} from "@photon-hq/standard-openapi";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  Context,
  Env,
  Input,
  MiddlewareHandler,
  Next,
  ValidationTargets,
} from "hono";
import type { TypedResponse } from "hono/types";
import type { StatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import type { InferInput } from "hono/validator";
import type { JSONSchema7 } from "json-schema";
import type { OpenAPIV3_1 } from "openapi-types";
import type {
  DescribeRouteOptions,
  PromiseOr,
  ResolverReturnType,
} from "./types";
import { uniqueSymbol } from "./utils";

export function loadVendor(
  vendor: string,
  fn: {
    toJSONSchema?: Parameters<typeof loadVendorJson>[1];
    toOpenAPISchema?: Parameters<typeof loadVendorOpenAPI>[1];
  },
) {
  if (fn.toJSONSchema) {
    loadVendorJson(vendor, fn.toJSONSchema);
  }

  if (fn.toOpenAPISchema) {
    loadVendorOpenAPI(vendor, fn.toOpenAPISchema);
  }
}

/**
 * Default fallback for ArkType morph schemas — returns the input ("base")
 * schema so that morphs like `string.numeric.parse` produce valid JSON Schema
 * instead of throwing a `ToJsonSchemaError`.
 */
const arktypeMorphFallback = (ctx: { base: unknown }) => ctx.base;

/** JSON Schema string formats Zod writes beside a check's own regex. */
const STANDARD_FORMATS = new Set([
  "date",
  "date-time",
  "duration",
  "email",
  "ipv4",
  "ipv6",
  "uuid",
]);

type ZodFormatCheckDef = {
  check?: string;
  format?: string;
  local?: boolean;
  offset?: boolean;
  pattern?: RegExp;
  precision?: number | null;
};

type ZodV4OverrideContext = {
  zodSchema: {
    _zod: {
      def: ZodFormatCheckDef & {
        type: string;
        checks?: { _zod: { def: ZodFormatCheckDef } }[];
      };
      bag: { patterns?: Set<RegExp> };
    };
  };
  jsonSchema: Record<string, unknown>;
};

/**
 * The format check whose regex Zod wrote as `pattern` beside a standard
 * `format`, or undefined when the pattern is anything else (a schema's own
 * `.regex()`, or a Zod-only format such as base64 or e164).
 */
const formatOwnPattern = ({ zodSchema, jsonSchema }: ZodV4OverrideContext) => {
  const { format, pattern } = jsonSchema;
  if (
    typeof format !== "string" ||
    typeof pattern !== "string" ||
    !STANDARD_FORMATS.has(format) ||
    zodSchema._zod.bag.patterns?.size !== 1
  ) {
    return undefined;
  }
  const def = zodSchema._zod.def;
  const checks =
    def.check === "string_format"
      ? [def]
      : (def.checks ?? []).map((check) => check._zod.def);
  return checks.find(
    (check) =>
      check.check === "string_format" &&
      check.format !== "regex" &&
      check.pattern?.source === pattern,
  );
};

/**
 * A value the API produces needs only its format: whatever the check allows
 * is a valid instance of the format. Local date-times are the exception;
 * without an offset they are not RFC 3339 date-times.
 */
const outputNeedsOnlyFormat = (check: ZodFormatCheckDef) => !check.local;

/**
 * A value the API accepts needs only its format when the check accepts every
 * value the format allows. Otherwise the pattern tells callers what is
 * rejected, for example a date-time with an offset other than `Z`.
 */
const inputNeedsOnlyFormat = (check: ZodFormatCheckDef) =>
  check.format === "date" ||
  check.format === "ipv4" ||
  (check.format === "datetime" &&
    check.offset === true &&
    check.precision == null &&
    !check.local);

const zodV4Override =
  (needsOnlyFormat: (check: ZodFormatCheckDef) => boolean) =>
  (ctx: ZodV4OverrideContext) => {
    // Date cannot be represented in JSON Schema and Zod v4's `toJSONSchema`
    // throws by default. With `unrepresentable: "any"` it produces `{}`, and
    // the type and format are filled in here.
    if (ctx.zodSchema._zod.def.type === "date") {
      ctx.jsonSchema.type = "string";
      ctx.jsonSchema.format = "date-time";
    }
    // Zod writes the regex it validates a string format with as `pattern`
    // beside `format`. Drop it where the format alone describes the value.
    const check = formatOwnPattern(ctx);
    if (check && needsOnlyFormat(check)) {
      delete ctx.jsonSchema.pattern;
    }
  };

/**
 * Default Zod v4 overrides by direction, also exported for code that calls
 * `toJSONSchema` itself. Both document `z.date()` as a date-time string, and
 * document a standard string format (`date-time`, `email`, ...) without the
 * pattern Zod copies from the format check where the format alone describes
 * the value: always for produced values, and for accepted values only when
 * the check accepts everything the format allows. Validation is unchanged.
 */
export const zodV4OutputOverride = zodV4Override(outputNeedsOnlyFormat);
export const zodV4InputOverride = zodV4Override(inputNeedsOnlyFormat);

/**
 * Generate a resolver for a validation schema
 * @param schema Validation schema
 * @returns Resolver result
 */
export function resolver<Schema extends StandardSchemaV1>(
  schema: Schema,
  userDefinedOptions?: Record<string, unknown>,
) {
  const vendor = schema["~standard"].vendor;

  return {
    vendor,
    validate: schema["~standard"].validate,
    toJSONSchema: (customOptions?: Record<string, unknown>) =>
      toJsonSchema(schema, { ...userDefinedOptions, ...customOptions }) as
        | JSONSchema7
        | Promise<JSONSchema7>,
    toOpenAPISchema: (customOptions?: Record<string, unknown>) =>
      toOpenAPISchema(schema, {
        ...userDefinedOptions,
        ...customOptions,
        ...(vendor === "arktype"
          ? injectArktypeFallback(userDefinedOptions, customOptions)
          : undefined),
        ...(vendor === "zod"
          ? injectZodV4Override(schema, userDefinedOptions, customOptions)
          : undefined),
      }),
  };
}

/**
 * Build the `options` override for an ArkType schema's `toOpenAPISchema`
 * context. The default handler in `@photon-hq/standard-openapi`
 * passes `context.options` to ArkType's `toJsonSchema()`, so the `fallback`
 * must live inside that nested `options` object.
 *
 * If the caller already supplied a `fallback` (at either nesting level),
 * it is preserved.
 */
function injectArktypeFallback(
  userDefined?: Record<string, unknown>,
  custom?: Record<string, unknown>,
): { options: Record<string, unknown> } | undefined {
  const userNested = userDefined?.options as
    | Record<string, unknown>
    | undefined;
  const customNested = custom?.options as Record<string, unknown> | undefined;

  // User already provided a fallback — don't override
  if (
    userDefined?.fallback ||
    userNested?.fallback ||
    custom?.fallback ||
    customNested?.fallback
  ) {
    return undefined;
  }

  return {
    options: {
      fallback: arktypeMorphFallback,
      ...userNested,
      ...customNested,
    },
  };
}

/**
 * Inject a default `override` and `unrepresentable: "any"` into Zod v4
 * schemas' `toOpenAPISchema` context so that `z.date()` is converted to
 * `{ type: "string", format: "date-time" }` instead of throwing
 * "Date cannot be represented in JSON Schema".
 *
 * Two options work together:
 * - `unrepresentable: "any"` prevents the throw during processing (Date
 *   produces `{}` instead of throwing)
 * - `override` fills in `{ type: "string", format: "date-time" }` during
 *   the emit phase, and drops the pattern Zod copies beside a standard
 *   string format where the format alone describes the value (see
 *   `zodV4OutputOverride` and `zodV4InputOverride`)
 *
 * Only applies to Zod v4 schemas (detected by the `_zod` property).
 * If the caller already supplied an `override`, it is preserved.
 */
function injectZodV4Override(
  schema: StandardSchemaV1,
  userDefined?: Record<string, unknown>,
  custom?: Record<string, unknown>,
): { options: Record<string, unknown> } | undefined {
  // Only apply to Zod v4 schemas (Zod v3 doesn't have `_zod`)
  if (!("_zod" in schema)) return undefined;

  const userNested = userDefined?.options as
    | Record<string, unknown>
    | undefined;
  const customNested = custom?.options as Record<string, unknown> | undefined;

  // User already provided an override — don't replace it
  if (
    userDefined?.override ||
    userNested?.override ||
    custom?.override ||
    customNested?.override
  ) {
    return undefined;
  }

  const io =
    custom?.io ?? customNested?.io ?? userDefined?.io ?? userNested?.io;
  return {
    options: {
      unrepresentable: "any",
      // Unknown direction: document as accepted values, which keeps more.
      override: io === "output" ? zodV4OutputOverride : zodV4InputOverride,
      ...userNested,
      ...customNested,
    },
  };
}

type HasUndefined<T> = undefined extends T ? true : false;

/**
 * Create a validator middleware
 * @param target Target for validation
 * @param schema Validation schema
 * @param hook Hook for validation
 * @returns Middleware handler
 */
export function validator<
  Schema extends StandardSchemaV1,
  Target extends keyof ValidationTargets,
  E extends Env,
  P extends string,
  In = StandardSchemaV1.InferInput<Schema>,
  Out = StandardSchemaV1.InferOutput<Schema>,
  I extends Input = {
    in: HasUndefined<In> extends true
      ? {
          [K in Target]?: [In] extends [ValidationTargets[K]]
            ? In
            : InferInput<In, K>;
        }
      : {
          [K in Target]: [In] extends [ValidationTargets[K]]
            ? In
            : InferInput<In, K>;
        };
    out: { [K in Target]: Out };
  },
  V extends I = I,
>(
  target: Target,
  schema: Schema,
  hook?: Hook<StandardSchemaV1.InferOutput<Schema>, E, P, Target>,
  options?: ResolverReturnType["options"],
): MiddlewareHandler<E, P, V> {
  const middleware = sValidator(target, schema, hook);

  Object.defineProperty(middleware, "name", {
    value: "validator",
    configurable: true,
  });

  // @ts-expect-error not typed well
  return Object.assign(middleware, {
    [uniqueSymbol]: {
      target,
      ...resolver(schema, options),
      options,
    },
  });
}

/**
 * Describe a route with OpenAPI specs.
 * @param spec Options for describing a route
 * @returns Middleware handler
 */
export function describeRoute(spec: DescribeRouteOptions): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (_c, next) => {
    await next();
  };

  Object.defineProperty(middleware, "name", {
    value: "describeRoute",
    configurable: true,
  });

  return Object.assign(middleware, {
    [uniqueSymbol]: {
      spec,
    },
  });
}

type ResponseObject<T extends Partial<Record<StatusCode, StandardSchemaV1>>> = {
  [K in keyof T]:
    | OpenAPIV3_1.ReferenceObject
    | (OpenAPIV3_1.ResponseObject & {
        content?: {
          [media: string]: OpenAPIV3_1.MediaTypeObject & {
            vSchema?: T[K];
          };
        };
      });
};

type Num<T> = T extends `${infer N extends number}` ? N : T;

type HandlerResponse<
  T extends Partial<Record<StatusCode, StandardSchemaV1>> = Partial<
    Record<StatusCode, StandardSchemaV1>
  >,
> = PromiseOr<
  {
    [K in keyof T]: T[K] extends StandardSchemaV1
      ? TypedResponse<
          JSONParsed<StandardSchemaV1.InferOutput<T[K]>>,
          Num<K> extends StatusCode ? Num<K> : never
        >
      : never;
  }[keyof T]
>;

export type Handler<
  E extends Env,
  P extends string,
  I extends Input,
  T extends Partial<Record<StatusCode, StandardSchemaV1>> = Partial<
    Record<StatusCode, StandardSchemaV1>
  >,
> = (c: Context<E, P, I>, next: Next) => HandlerResponse<T>;

export function describeResponse<
  E extends Env,
  P extends string,
  I extends Input,
  T extends Partial<Record<StatusCode, StandardSchemaV1>> = Partial<
    Record<StatusCode, StandardSchemaV1>
  >,
>(
  handler: Handler<E, P, I, T>,
  responses: ResponseObject<T>,
  options?: Record<string, unknown>,
): Handler<E, P, I, T> {
  const _responses = Object.entries(responses).reduce(
    (acc, [statusCode, response]) => {
      if (response.content) {
        const content = Object.entries(response.content).reduce(
          (contentAcc, [mediaType, media]: [string, any]) => {
            if (media.vSchema) {
              const { vSchema, ...rest } = media;
              contentAcc[mediaType] = {
                ...rest,
                schema: resolver(vSchema, options),
              };
            } else {
              contentAcc[mediaType] = media;
            }
            return contentAcc;
          },
          {},
        );
        acc[statusCode] = { ...response, content };
      } else {
        acc[statusCode] = response;
      }

      return acc;
    },
    {} as NonNullable<DescribeRouteOptions["responses"]>,
  );

  return Object.assign(handler, {
    [uniqueSymbol]: {
      spec: { responses: _responses },
    },
  });
}
