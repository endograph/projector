/**
 * Result of a state update operation.
 */
export interface StateUpdateResult<S> {
  success: boolean;
  state: S;
  error?: string;
}

/**
 * Shallow merge two objects.
 * Note: Nested objects are replaced, not merged.
 */
export function shallowMerge<T extends Record<string, unknown>>(
  target: T,
  patch: Partial<T>
): T {
  return { ...target, ...patch };
}
