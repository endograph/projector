import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import * as z from "zod";

/**
 * Projector's schema seam. Every schema position (state values, action
 * inputs, params, output contracts, executor node config) accepts any
 * Standard Schema; projector normalizes it once into a {@link NormalizedSchema}
 * that validates synchronously and yields JSON Schema. zod is a private
 * dependency here only (hydration of serialized JSON Schema) — it never
 * appears in a public type.
 */
export type Schema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;
export type AnySchema = StandardSchemaV1<any, any>;
export type InferSchemaOutput<T extends StandardSchemaV1> = StandardSchemaV1.InferOutput<T>;
export type InferSchemaInput<T extends StandardSchemaV1> = StandardSchemaV1.InferInput<T>;

export type JsonSchema = Record<string, unknown>;
export type SchemaIssue = StandardSchemaV1.Issue;
export type SchemaResult<Output = unknown> = StandardSchemaV1.Result<Output>;

export type JsonSchemaOptions = {
  /** Which side of the schema to describe. Defaults to `"output"`. */
  io?: "input" | "output";
  /** Defaults to `"draft-2020-12"`. */
  target?: StandardJSONSchemaV1.Target;
  libraryOptions?: Record<string, unknown>;
};

export type NormalizedSchema<Output = unknown> = {
  readonly schema: StandardSchemaV1<unknown, Output>;
  /** Synchronous Standard Schema validation. */
  validate(value: unknown): SchemaResult<Output>;
  /** Validates and returns the output value; throws {@link SchemaError}. */
  parse(value: unknown): Output;
  accepts(value: unknown): boolean;
  /** The JSON Schema document describing this schema (memoized per io). */
  jsonSchema(options?: JsonSchemaOptions): JsonSchema;
};

export class SchemaError extends Error {
  readonly issues: readonly SchemaIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    super(formatSchemaIssues(issues));
    this.name = "SchemaError";
    this.issues = issues;
  }
}

export function formatSchemaIssues(issues: readonly SchemaIssue[]): string {
  if (issues.length === 0) return "Validation failed";
  return issues
    .map((issue) => {
      const path = formatIssuePath(issue.path);
      return path ? `${issue.message} (at ${path})` : issue.message;
    })
    .join("; ");
}

function formatIssuePath(path: SchemaIssue["path"]): string {
  if (!path || path.length === 0) return "";
  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null ? segment.key : segment,
    )
    .map(String)
    .join(".");
}

const DEFAULT_TARGET: StandardJSONSchemaV1.Target = "draft-2020-12";

const normalized = new WeakMap<object, NormalizedSchema<any>>();

/**
 * Normalizes a Standard Schema. Memoized per schema object, so calling this at
 * every use site costs one lookup; creation sites call it eagerly so an
 * unusable schema (async validation, no JSON Schema source) fails at
 * declaration time with a clear message rather than mid-activation.
 */
export function normalizeSchema<T extends StandardSchemaV1>(
  schema: T,
): NormalizedSchema<StandardSchemaV1.InferOutput<T>> {
  const cached = normalized.get(schema);
  if (cached) return cached;
  const built = buildNormalizedSchema(schema);
  normalized.set(schema, built);
  return built;
}

function buildNormalizedSchema<Output>(
  schema: StandardSchemaV1<unknown, Output>,
): NormalizedSchema<Output> {
  const props = schema["~standard"];
  if (!props || props.version !== 1 || typeof props.validate !== "function") {
    throw new Error("Expected a Standard Schema (an object with a `~standard` v1 property)");
  }

  const validate = (value: unknown): SchemaResult<Output> => {
    const result = props.validate(value);
    if (isPromiseLike(result)) {
      throw new Error(
        `Schema (vendor "${props.vendor}") validates asynchronously; projector schemas must validate synchronously`,
      );
    }
    return result;
  };
  // Probe: an always-async validator is rejected at creation, not at first use.
  validate(undefined);

  const convert = resolveJsonSchemaConverter(schema, props);
  const memo = new Map<"input" | "output", JsonSchema>();

  return {
    schema,
    validate,
    parse(value) {
      const result = validate(value);
      if (result.issues) throw new SchemaError(result.issues);
      return result.value;
    },
    accepts(value) {
      return !validate(value).issues;
    },
    jsonSchema(options = {}) {
      const io = options.io ?? "output";
      const isDefault = options.target === undefined && options.libraryOptions === undefined;
      if (isDefault) {
        const hit = memo.get(io);
        if (hit) return hit;
      }
      const document = convert(io, {
        target: options.target ?? DEFAULT_TARGET,
        libraryOptions: options.libraryOptions,
      });
      if (isDefault) memo.set(io, document);
      return document;
    },
  };
}

type Converter = (
  io: "input" | "output",
  options: StandardJSONSchemaV1.Options,
) => JsonSchema;

function resolveJsonSchemaConverter(
  schema: StandardSchemaV1,
  props: StandardSchemaV1.Props,
): Converter {
  const json = (props as Partial<StandardJSONSchemaV1.Props>).jsonSchema;
  if (json && typeof json.input === "function" && typeof json.output === "function") {
    return (io, options) => json[io](options);
  }
  if (props.vendor === "zod") {
    return (io, options) =>
      z.toJSONSchema(schema as never, {
        io,
        target: options.target as never,
        ...(options.libraryOptions ?? {}),
      }) as JsonSchema;
  }
  throw new Error(
    `Schema (vendor "${props.vendor}") has no JSON Schema source: implement \`~standard.jsonSchema\` or wrap it with withJsonSchema()`,
  );
}

/**
 * Attaches an explicit JSON Schema to a Standard Schema whose library cannot
 * produce one. The result implements StandardJSONSchemaV1 (inheriting from
 * the original schema) and normalizes like any other schema.
 */
export function withJsonSchema<T extends StandardSchemaV1>(
  schema: T,
  output: JsonSchema,
  input: JsonSchema = output,
): T & StandardJSONSchemaV1<StandardSchemaV1.InferInput<T>, StandardSchemaV1.InferOutput<T>> {
  const converter: StandardJSONSchemaV1.Converter = {
    input: () => input,
    output: () => output,
  };
  const wrapped = Object.create(schema);
  Object.defineProperty(wrapped, "~standard", {
    value: { ...schema["~standard"], jsonSchema: converter },
    enumerable: false,
  });
  return wrapped;
}

/**
 * Re-enters a serialized JSON Schema as a Standard Schema (via zod, privately).
 * Hydrated schemas normalize like any other.
 */
export function schemaFromJsonSchema(jsonSchema: unknown): Schema {
  return z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
}

/** JSON Schema properties declared by an object schema, in declaration order. */
export function jsonSchemaProperties(document: JsonSchema): string[] {
  const properties = document.properties;
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
}

/** Property names an object schema cannot resolve without. */
export function jsonSchemaRequired(document: JsonSchema): Set<string> {
  const required = document.required;
  return new Set(Array.isArray(required) ? required.map(String) : []);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
