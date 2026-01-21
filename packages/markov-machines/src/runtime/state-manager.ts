import type { z } from "zod";
import type { StateUpdateResult } from "../types/state.js";
import { shallowMerge } from "../types/state.js";

/**
 * Update state with a partial patch.
 * Validates the result against the schema.
 */
export function updateState<S>(
  currentState: S,
  patch: Partial<S>,
  validator: z.ZodType<S>
): StateUpdateResult<S> {
  // Shallow merge the patch into current state
  const merged = shallowMerge(
    currentState as Record<string, unknown>,
    patch as Record<string, unknown>
  ) as S;

  // Validate the result
  const result = validator.safeParse(merged);

  if (!result.success) {
    return {
      success: false,
      state: currentState,
      error: result.error.message,
    };
  }

  return {
    success: true,
    state: result.data,
  };
}
