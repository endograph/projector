const ESCAPE_PREFIX = "__projector_convex_escaped_key__";
const DOLLAR_PREFIX = `${ESCAPE_PREFIX}dollar__`;
const PREFIX_PREFIX = `${ESCAPE_PREFIX}prefix__`;

export function escapeConvexJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => escapeConvexJson(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      escapeConvexKey(key),
      escapeConvexJson(entryValue),
    ]),
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
    Object.entries(value).map(([key, entryValue]) => [
      restoreConvexKey(key),
      restoreConvexJson(entryValue),
    ]),
  ) as T;
}

export function stripClientSchemas<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripClientSchemas(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
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
