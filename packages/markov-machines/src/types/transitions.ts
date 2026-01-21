import type { z } from "zod";
import type { Ref, SerialNode, SerialTransition } from "./refs.js";
import type { Node } from "./node.js";
import type { StandardNodeConfig } from "../executor/types.js";
import type { Message } from "./messages.js";

/**
 * Context passed to code transition execute functions.
 */
export interface TransitionContext {
  /** Arguments passed by the agent when calling the transition */
  args: unknown;
  /** Reason provided by the agent for the transition */
  reason: string;
}

/**
 * Spawn target specification.
 * Supports both standard and worker nodes.
 */
export interface SpawnTarget<T = unknown> {
  node: Node<T>;
  state?: T;
  /** Override executor config for this spawned instance */
  executorConfig?: StandardNodeConfig;
}

/**
 * Normal transition - replace current instance with new node.
 * Supports both standard and worker nodes.
 */
export interface TransitionToResult<T = unknown> {
  type: "transition";
  node: Node<T>;
  state?: T;
  /** Override executor config for this transition */
  executorConfig?: StandardNodeConfig;
}

/**
 * Spawn - add child instance(s) to current node.
 */
export interface SpawnResult<T = unknown> {
  type: "spawn";
  children: Array<SpawnTarget<T>>;
}

/**
 * Cede - return control to parent with optional content.
 * The ceding instance is REMOVED from the tree.
 * @typeParam M - The application message type for content (defaults to unknown).
 */
export interface CedeResult<M = unknown> {
  type: "cede";
  /** String or Message[] to pass to parent */
  content?: string | Message<M>[];
}

/**
 * Suspend - pause execution while remaining in the tree.
 * Suspended instances are excluded from getActiveLeaves() but can still receive commands.
 */
export interface SuspendResult {
  type: "suspend";
  /** Unique ID for this suspension - must match to resume */
  suspendId: string;
  /** Human-readable reason for suspension */
  reason: string;
  /** Optional metadata for application use */
  metadata?: Record<string, unknown>;
}

/**
 * Union of all transition results.
 */
export type TransitionResult<T = unknown> =
  | TransitionToResult<T>
  | SpawnResult<T>
  | CedeResult
  | SuspendResult;

/**
 * Options for spawn helper.
 */
export interface SpawnOptions {
  /** Override executor config for spawned instance(s) */
  executorConfig?: StandardNodeConfig;
}

/**
 * Options for transitionTo helper.
 */
export interface TransitionToOptions {
  /** Override executor config for the transition target */
  executorConfig?: StandardNodeConfig;
}


/**
 * Code-defined transition (not serializable).
 * Executes custom logic to determine the target node and state.
 * S is the source state type.
 */
export interface CodeTransition<S = unknown> {
  type: "code";
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
 * General transition - agent can create nodes dynamically.
 * The arguments implicitly include a `node` property for inline node definitions.
 */
export interface GeneralTransition {
  type: "general";
  description: string;
}

/**
 * Union of all transition types.
 * S is the source state type.
 */
export type Transition<S = unknown> =
  | CodeTransition<S>
  | SerialTransition
  | GeneralTransition
  | Ref;

/**
 * Helper to create a type-safe transition result.
 * Supports both standard and worker nodes.
 */
export function transitionTo<T>(
  node: Node<T>,
  state?: T,
  options?: TransitionToOptions,
): TransitionToResult<T> {
  return {
    type: "transition",
    node,
    state,
    executorConfig: options?.executorConfig,
  };
}

/**
 * Type guard for TransitionToResult
 */
export function isTransitionToResult<T = unknown>(
  value: unknown,
): value is TransitionToResult<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as TransitionToResult).type === "transition"
  );
}

/**
 * Type guard for SpawnResult
 */
export function isSpawnResult<T = unknown>(value: unknown): value is SpawnResult<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as SpawnResult).type === "spawn"
  );
}

/**
 * Type guard for CedeResult
 */
export function isCedeResult(value: unknown): value is CedeResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as CedeResult).type === "cede"
  );
}

/**
 * Type guard for SuspendResult
 */
export function isSuspendResult(value: unknown): value is SuspendResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as SuspendResult).type === "suspend"
  );
}

/**
 * Type guard for CodeTransition
 */
export function isCodeTransition<S>(
  value: unknown,
): value is CodeTransition<S> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as CodeTransition<S>).type === "code"
  );
}

/**
 * Type guard for GeneralTransition
 */
export function isGeneralTransition(
  value: unknown,
): value is GeneralTransition {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as GeneralTransition).type === "general"
  );
}

/**
 * Check if a transition has custom arguments (requires named tool).
 */
export function transitionHasArguments<S>(transition: Transition<S>): boolean {
  if (isCodeTransition(transition)) {
    return transition.arguments !== undefined;
  }
  if (isGeneralTransition(transition)) {
    return true; // General transitions always have node argument
  }
  if ("arguments" in transition && transition.arguments !== undefined) {
    return true;
  }
  return false;
}
