const ESCAPE_PREFIX = "__projector_convex_escaped_key__";
const DOLLAR_PREFIX = `${ESCAPE_PREFIX}dollar__`;
const PREFIX_PREFIX = `${ESCAPE_PREFIX}prefix__`;
const SCHEMA_PREFIX = `${ESCAPE_PREFIX}json_schema__`;

// Serialized nodes and spawn actions use different field names for the same
// JSON Schema payload. Keep every other object queryable in Convex, but store
// these known schema-bearing values as one string so schema depth does not
// count against Convex's document nesting limit.
const SCHEMA_KEYS = new Set(["schema", "inputSchema", "stateSchema", "params"]);

export function escapeConvexJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => escapeConvexJson(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      const encodedValue = isSchemaValue(key, entryValue)
        ? `${SCHEMA_PREFIX}${JSON.stringify(entryValue)}`
        : escapeConvexJson(entryValue);
      return [escapeConvexKey(key), encodedValue];
    }),
  ) as T;
}

export function restoreConvexJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => restoreConvexJson(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      const restoredKey = restoreConvexKey(key);
      return [
        restoredKey,
        isEncodedSchema(restoredKey, entryValue)
          ? JSON.parse(entryValue.slice(SCHEMA_PREFIX.length))
          : restoreConvexJson(entryValue),
      ];
    }),
  ) as T;
}

function isSchemaValue(key: string, value: unknown): value is Record<string, unknown> {
  return SCHEMA_KEYS.has(key) && value !== null && typeof value === "object";
}

function isEncodedSchema(key: string, value: unknown): value is string {
  return SCHEMA_KEYS.has(key) && typeof value === "string" && value.startsWith(SCHEMA_PREFIX);
}

export function stripClientSchemas<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripClientSchemas(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  // Drop $-prefixed keys at EVERY level, not just under schema/inputSchema:
  // Convex rejects them anywhere in a return value, and serialized inline
  // nodes carry JSON Schema under other keys (params, spawn-message nodes).
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => !key.startsWith("$") && entryValue !== undefined)
      .map(([key, entryValue]) => [
        key,
        key === "schema" || key === "inputSchema"
          ? stripJsonSchemaKeys(entryValue)
          : stripClientSchemas(entryValue),
      ]),
  ) as T;
}

function stripJsonSchemaKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripJsonSchemaKeys(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => !key.startsWith("$") && entryValue !== undefined)
      .map(([key, entryValue]) => [key, stripJsonSchemaKeys(entryValue)]),
  ) as T;
}

function escapeConvexKey(key: string): string {
  if (key.startsWith(ESCAPE_PREFIX)) {
    return `${PREFIX_PREFIX}${key.slice(ESCAPE_PREFIX.length)}`;
  }
  if (key.startsWith("$")) {
    return `${DOLLAR_PREFIX}${key.slice(1)}`;
  }
  return key;
}

function restoreConvexKey(key: string): string {
  if (key.startsWith(PREFIX_PREFIX)) {
    return `${ESCAPE_PREFIX}${key.slice(PREFIX_PREFIX.length)}`;
  }
  if (key.startsWith(DOLLAR_PREFIX)) {
    return `$${key.slice(DOLLAR_PREFIX.length)}`;
  }
  return key;
}
