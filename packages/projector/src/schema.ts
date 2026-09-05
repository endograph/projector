import { Validator, type OutputUnit } from "@cfworker/json-schema";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Projector schemas are validation-only contracts: accepted values keep the
 * same type and value. A source library may expose richer decoding behavior,
 * but Projector converts only its input contract to JSON Schema and uses that
 * document as the canonical validator and serialized form.
 */
export type Schema<Value = unknown> = StandardSchemaV1<Value, Value>;
export type AnySchema = StandardSchemaV1<any, any>;
export type InferSchemaValue<T extends StandardSchemaV1> = StandardSchemaV1.InferInput<T>;

export type JsonSchema = Record<string, unknown>;
export type SchemaIssue = StandardSchemaV1.Issue;
export type SchemaCheckResult =
  | { readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

export type JsonSchemaOptions = {
  /** Defaults to `"draft-2020-12"`. */
  target?: StandardJSONSchemaV1.Target;
  libraryOptions?: Record<string, unknown>;
};

export type NormalizedSchema<Value = unknown> = {
  /** Checks the original value without returning or applying a decoded value. */
  check(value: unknown): SchemaCheckResult;
  /** Throws {@link SchemaError} when the original value is invalid. */
  assert(value: unknown): void;
  accepts(value: unknown): value is Value;
  /** The canonical input JSON Schema document. */
  jsonSchema(options?: JsonSchemaOptions): JsonSchema;
};

export type SchemaTransformError<TSchema extends StandardSchemaV1> =
  [StandardSchemaV1.InferInput<TSchema>] extends [StandardSchemaV1.InferOutput<TSchema>]
    ? [StandardSchemaV1.InferOutput<TSchema>] extends [StandardSchemaV1.InferInput<TSchema>]
      ? unknown
      : SchemaTransformDiagnostic<TSchema>
    : SchemaTransformDiagnostic<TSchema>;

type SchemaTransformDiagnostic<TSchema extends StandardSchemaV1> = {
  readonly __schemaTransformError: "Projector schemas must have identical input and output types";
  readonly input: StandardSchemaV1.InferInput<TSchema>;
  readonly output: StandardSchemaV1.InferOutput<TSchema>;
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
 * Converts a Standard Schema's input contract to Projector's canonical JSON
 * Schema form. The source validator is deliberately never invoked: authored
 * and hydrated schemas therefore have exactly the same validation behavior,
 * and source-library coercions/transforms cannot enter the durable machine.
 */
export function normalizeSchema<T extends StandardSchemaV1>(
  schema: T & SchemaTransformError<T>,
): NormalizedSchema<StandardSchemaV1.InferInput<T>> {
  const cached = normalized.get(schema);
  if (cached) return cached;
  const built = buildNormalizedSchema(schema);
  normalized.set(schema, built);
  return built;
}

function buildNormalizedSchema<Value>(
  schema: StandardSchemaV1<Value, unknown>,
): NormalizedSchema<Value> {
  const props = schema["~standard"];
  if (!props || props.version !== 1 || typeof props.validate !== "function") {
    throw new Error("Expected a Standard Schema (an object with a `~standard` v1 property)");
  }

  const convert = resolveJsonSchemaConverter(schema, props);
  const canonicalDocument = convert({ target: DEFAULT_TARGET });
  const check = createJsonSchemaCheck(canonicalDocument);

  return {
    check,
    assert(value) {
      const result = check(value);
      if (result.issues) throw new SchemaError(result.issues);
    },
    accepts(value): value is Value {
      return !check(value).issues;
    },
    jsonSchema(options = {}) {
      if (options.target === undefined && options.libraryOptions === undefined) {
        return canonicalDocument;
      }
      return convert({
        target: options.target ?? DEFAULT_TARGET,
        libraryOptions: options.libraryOptions,
      });
    },
  };
}

type Converter = (options: StandardJSONSchemaV1.Options) => JsonSchema;

function resolveJsonSchemaConverter(
  schema: StandardSchemaV1,
  props: StandardSchemaV1.Props,
): Converter {
  const json = (props as Partial<StandardJSONSchemaV1.Props>).jsonSchema;
  if (json && typeof json.input === "function") {
    return (options) => json.input(options);
  }
  throw new Error(
    `Schema (vendor "${props.vendor}") has no JSON Schema source: implement \`~standard.jsonSchema\` or wrap it with withJsonSchema()`,
  );
}

/** Attaches Projector's single canonical JSON Schema to a Standard Schema. */
export function withJsonSchema<T extends StandardSchemaV1>(
  schema: T,
  jsonSchema: JsonSchema,
): T & StandardJSONSchemaV1<StandardSchemaV1.InferInput<T>, StandardSchemaV1.InferOutput<T>> {
  const converter: StandardJSONSchemaV1.Converter = {
    input: () => jsonSchema,
    output: () => jsonSchema,
  };
  const wrapped = Object.create(schema);
  Object.defineProperty(wrapped, "~standard", {
    value: { ...schema["~standard"], jsonSchema: converter },
    enumerable: false,
  });
  return wrapped;
}

/** Re-enters Projector's canonical JSON Schema as a validation-only schema. */
export function schemaFromJsonSchema<Value = unknown>(
  jsonSchema: unknown,
): Schema<Value> {
  const document = jsonSchema as JsonSchema;
  let check: ((value: unknown) => SchemaCheckResult) | undefined;
  const schema: Schema<Value> = {
    "~standard": {
      version: 1,
      vendor: "projector",
      validate(value) {
        const result = (check ??= createJsonSchemaCheck(document))(value);
        return result.issues ? result : { value: value as Value };
      },
    },
  };
  return withJsonSchema(schema, document);
}

function createJsonSchemaCheck(
  document: JsonSchema,
): (value: unknown) => SchemaCheckResult {
  // Report every problem (no short-circuit): a caller fixes all fields in
  // one round trip, and the issue list is the durable record of a rejection.
  const validator = new Validator(document as never, "2020-12", false);
  return (value) => {
    try {
      // Validate the value as JSON would carry it: the machine's durable form
      // is JSON, so a key holding `undefined` is absent, not a wrong type.
      const result = validator.validate(jsonView(value));
      return result.valid ? {} : { issues: jsonSchemaIssues(result.errors) };
    } catch (error) {
      return {
        issues: [{ message: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
}

/** The value as JSON serialization sees it: undefined properties dropped, undefined array items null. */
function jsonView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : jsonView(item)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = jsonView(item);
    }
    return out;
  }
  return value;
}

/**
 * Validator errors → Standard Schema issues, structurally. The validator
 * reports each problem at a JSON pointer; we keep the leaf-most report and
 * drop its container echoes:
 * - `properties` at the parent ("Property x does not match schema") echoes
 *   the error at `#/x`.
 * - `additionalProperties` at the parent names the offending key only in
 *   prose; the paired `false` error at `#/x` carries the path, so that one
 *   becomes the issue — unless `#/x` also failed its own subschema, in which
 *   case the property is declared and the `false` report is an echo too.
 * A missing required property is reported at its parent; the message names it.
 */
function jsonSchemaIssues(errors: OutputUnit[]): readonly SchemaIssue[] {
  const reportedAt = new Set(
    errors.filter((error) => error.keyword !== "false").map((error) => error.instanceLocation),
  );
  const issues: SchemaIssue[] = [];
  for (const error of errors) {
    if (error.keyword === "properties" || error.keyword === "additionalProperties") continue;
    const path = decodeJsonPointer(error.instanceLocation);
    if (error.keyword === "false") {
      if (reportedAt.has(error.instanceLocation)) continue;
      issues.push({ message: "Property is not allowed.", path });
      continue;
    }
    issues.push({ message: error.error, path });
  }
  return issues;
}

function decodeJsonPointer(pointer: string): string[] {
  if (pointer === "#") return [];
  const path = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (!path.startsWith("/")) return [path];
  return path
    .slice(1)
    .split("/")
    .map((segment) =>
      decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"),
    );
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
