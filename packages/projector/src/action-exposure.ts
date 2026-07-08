import type { AnyAction, Exposure } from "./types.ts";

const ACTION_EXPOSURE: unique symbol = Symbol.for("projector.actionExposure") as never;

/**
 * Tags a bound tool copy with its contribution's exposure. Only bindAction
 * calls this (on the fresh copy it just created); untagged actions read
 * native, so native contributions stay untagged. Not exported from the
 * package barrel.
 */
export function markActionExposure<T extends AnyAction>(action: T, exposure: Exposure): T {
  return Object.assign(action, { [ACTION_EXPOSURE]: exposure });
}

/**
 * The exposure a compiled tool was contributed with. Executors read this to
 * lower deferred tools to their provider's tool-search idiom; an executor
 * with no lowering for its model errors rather than degrades to native — the
 * compiled availability note promises tool search.
 */
export function actionExposure(action: AnyAction): Exposure {
  const exposure = (action as { [ACTION_EXPOSURE]?: unknown })[ACTION_EXPOSURE];
  return exposure === "deferred" ? "deferred" : "native";
}
