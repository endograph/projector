import type { z } from "zod";
import type { Node } from "../types/node.js";
import type {
  CodeTransition,
  TransitionContext,
  TransitionResult,
} from "../types/transitions.js";

/**
 * Configuration for creating a transition.
 * S is the source state type.
 */
export interface TransitionConfig<S> {
  description: string;
  /** Optional custom arguments schema */
  arguments?: z.ZodType;
  /**
   * Execute function that returns a transition result.
   * Use standalone cede() and spawn() functions for child management.
   */
  execute: (
    state: S,
    ctx: TransitionContext,
  ) => Promise<TransitionResult> | TransitionResult;
}

/**
 * Create a new code transition with explicit type parameter.
 */
export function createTransition<S = unknown>(
  config: TransitionConfig<S>,
): CodeTransition<S>;

/**
 * Create a new code transition with source state type inferred from a node.
 * The node parameter is only used for type inference.
 */
export function createTransition<S>(
  from: Node<any, S>,
  config: TransitionConfig<S>,
): CodeTransition<S>;

/**
 * Create a new code transition.
 * S is the source state type.
 *
 * @example
 * // Normal transition
 * const toCheckout = createTransition({
 *   description: "Proceed to checkout",
 *   execute: (state) => transitionTo(checkoutNode, {
 *     items: state.cart,
 *   }),
 * });
 *
 * @example
 * // Spawn children
 * const spawnWorker = createTransition({
 *   description: "Spawn a worker",
 *   execute: (state) => spawn(workerNode, { taskId: "123" }),
 * });
 *
 * @example
 * // Cede to parent
 * const complete = createTransition({
 *   description: "Complete and cede",
 *   execute: (state) => cede(`Result: ${state.result}`),
 * });
 */
export function createTransition<S>(
  configOrFrom: TransitionConfig<S> | Node<any, S>,
  maybeConfig?: TransitionConfig<S>,
): CodeTransition<S> {
  // Overload resolution: if second arg exists, first arg is the node
  const config = maybeConfig ?? (configOrFrom as TransitionConfig<S>);

  return {
    type: "code",
    description: config.description,
    arguments: config.arguments,
    execute: (state: S, ctx: TransitionContext) => {
      return config.execute(state, ctx);
    },
  };
}
