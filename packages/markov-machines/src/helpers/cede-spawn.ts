import { v4 as uuid } from "uuid";
import type { Node } from "../types/node.js";
import type {
  CedeResult,
  SpawnResult,
  SpawnTarget,
  SpawnOptions,
  SuspendResult,
} from "../types/transitions.js";
import type { MachineMessage } from "../types/messages.js";
import type { SuspendOptions } from "../types/commands.js";

/**
 * Cede control back to parent with optional content.
 * The current instance is REMOVED from the tree.
 *
 * @param content - Optional string message or array of MachineMessages to pass to parent
 * @returns CedeResult to return from transition execute
 *
 * @example
 * // Cede with no content
 * const done = createTransition({
 *   description: "Complete",
 *   execute: () => cede(),
 * });
 *
 * @example
 * // Cede with a string message
 * const complete = createTransition({
 *   description: "Complete with message",
 *   execute: (state) => cede(`Found ${state.results.length} results`),
 * });
 *
 * @example
 * // Cede with structured messages
 * const completeWithData = createTransition({
 *   description: "Complete with data",
 *   execute: (state) => cede([
 *     userMessage(`Research complete: ${state.query}`),
 *   ]),
 * });
 */
export function cede<M = unknown>(
  content?: string | MachineMessage<M>[],
): CedeResult<M> {
  return { type: "cede", content };
}

/**
 * Spawn one or more child instances.
 * Children are added to the current node's children array.
 * Supports both standard and worker nodes.
 *
 * @param nodeOrTargets - Single node or array of SpawnTargets
 * @param state - Initial state (only used when first arg is a node)
 * @param options - Spawn options (executorConfig, etc.)
 * @returns SpawnResult to return from transition execute
 *
 * @example
 * // Spawn a single child
 * const spawnWorker = createTransition({
 *   description: "Spawn a worker",
 *   execute: (state) => spawn(workerNode, { taskId: "123" }),
 * });
 *
 * @example
 * // Spawn multiple children
 * const spawnWorkers = createTransition({
 *   description: "Spawn multiple workers",
 *   execute: (state) => spawn([
 *     { node: workerNode, state: { taskId: "1" } },
 *     { node: workerNode, state: { taskId: "2" } },
 *   ]),
 * });
 */
export function spawn<T = unknown>(
  nodeOrTargets: Node<any, T> | SpawnTarget<T>[],
  state?: T,
  options?: SpawnOptions,
): SpawnResult<T> {
  const children: SpawnTarget<T>[] = Array.isArray(nodeOrTargets)
    ? nodeOrTargets
    : [{ node: nodeOrTargets, state, executorConfig: options?.executorConfig }];
  return {
    type: "spawn",
    children,
  };
}

/**
 * Suspend the current instance.
 * The instance remains in the tree but is excluded from getActiveLeaves().
 * Can be resumed via Resume input or a command that returns ResumeResult.
 *
 * @param reason - Human-readable reason for suspension
 * @param options - Optional suspend ID and metadata
 * @returns SuspendResult to return from transition execute
 *
 * @example
 * // Suspend for human approval
 * const awaitApproval = createTransition({
 *   description: "Wait for approval",
 *   execute: (state) => suspend("Waiting for human approval", {
 *     metadata: { action: state.pendingAction }
 *   }),
 * });
 *
 * @example
 * // Suspend with custom ID
 * const pauseForReview = createTransition({
 *   description: "Pause for review",
 *   execute: (state) => suspend("Review required", {
 *     suspendId: `review-${state.itemId}`,
 *   }),
 * });
 */
export function suspend(
  reason: string,
  options?: SuspendOptions,
): SuspendResult {
  return {
    type: "suspend",
    suspendId: options?.suspendId ?? uuid(),
    reason,
    metadata: options?.metadata,
  };
}
