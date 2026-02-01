import { z } from "zod";

export const ZOD_JSON_SCHEMA_TARGET_OPENAPI_3 = "openapi-3.0" as const;
export const ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12 = "draft-2020-12" as const;

/**
 * JSON Schema 2020-12 keywords that start with `$`.
 * Many databases (e.g. Convex) reject `$`-prefixed field names,
 * so we escape them to `__`-prefixed equivalents for safe storage.
 */
const SCHEMA_DOLLAR_KEYS: Record<string, string> = {
  $schema: "__schema",
  $id: "__id",
  $ref: "__ref",
  $defs: "__defs",
  $anchor: "__anchor",
  $vocabulary: "__vocabulary",
  $comment: "__comment",
  $dynamicRef: "__dynamicRef",
  $dynamicAnchor: "__dynamicAnchor",
};

const SCHEMA_ESCAPED_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(SCHEMA_DOLLAR_KEYS).map(([k, v]) => [v, k]),
);

/**
 * Recursively rename known `$`-prefixed JSON Schema keys to `__`-prefixed.
 */
export function escapeSchemaKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(escapeSchemaKeys);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const safeKey = SCHEMA_DOLLAR_KEYS[key] ?? key;
    result[safeKey] = escapeSchemaKeys(value);
  }
  return result;
}

/**
 * Recursively restore `__`-prefixed keys back to `$`-prefixed JSON Schema keys.
 */
export function restoreSchemaKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(restoreSchemaKeys);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const restoredKey = SCHEMA_ESCAPED_KEYS[key] ?? key;
    result[restoredKey] = restoreSchemaKeys(value);
  }
  return result;
}

/**
 * Convert a Zod schema to JSON Schema with `$`-prefixed keys escaped.
 */
export function toSafeJsonSchema(zodSchema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(zodSchema, {
    target: ZOD_JSON_SCHEMA_TARGET_DRAFT_2020_12,
  });
  return escapeSchemaKeys(jsonSchema) as Record<string, unknown>;
}

/**
 * Convert an escaped JSON Schema back to a Zod schema.
 */
export function fromSafeJsonSchema<S = unknown>(jsonSchema: Record<string, unknown>): z.ZodType<S> {
  const restored = restoreSchemaKeys(jsonSchema);
  return z.fromJSONSchema(restored as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<S>;
}

