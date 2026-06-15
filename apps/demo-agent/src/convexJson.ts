const ESCAPE_PREFIX = "__projector_convex_escaped_key__";
const DOLLAR_PREFIX = `${ESCAPE_PREFIX}dollar__`;

export function escapeConvexJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => escapeConvexJson(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key.startsWith("$") ? `${DOLLAR_PREFIX}${key.slice(1)}` : key,
      escapeConvexJson(entryValue),
    ]),
  ) as T;
}
