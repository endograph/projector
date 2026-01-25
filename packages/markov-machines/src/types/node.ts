import type { z } from "zod";
import type { Transition } from "./transitions.js";
import type { AnyToolDefinition, AnthropicBuiltinTool } from "./tools.js";
import type { AnyCommandDefinition } from "./commands.js";
import type { Pack } from "./pack.js";
import type { StandardNodeConfig } from "../executor/types.js";

/**
 * Tool entry - either a regular tool definition or an Anthropic builtin tool.
 */
export type NodeToolEntry<S = unknown> = AnyToolDefinition<S> | AnthropicBuiltinTool;

/**
 * Output configuration for structured LLM responses.
 * @typeParam M - The application message type this output maps to.
 */
export interface OutputConfig<M> {
  /** Zod schema for structured output constraint (sent to LLM API) */
  schema: z.ZodType;
  /**
   * Map the raw text response to application message format.
   * App is responsible for JSON.parse() if needed.
   */
  mapTextBlock: (text: string) => M;
}

/**
 * Node configuration for createNode.
 * @typeParam M - The output message type (never = no structured output).
 * @typeParam S - The node's state type.
 */
export interface NodeConfig<M = never, S = unknown> {
  instructions: string;
  /** Node tools (state access via context) */
  tools?: Record<string, NodeToolEntry<S>>;
  validator: z.ZodType<S>;
  /** Transitions see node state S */
  transitions?: Record<string, Transition<S>>;
  /** Commands - user-callable methods that bypass LLM inference */
  commands?: Record<string, AnyCommandDefinition<S>>;
  /** Optional initial state for this node */
  initialState?: S;
  /** Per-node executor configuration (overrides executor defaults) */
  executorConfig?: StandardNodeConfig;
  /** Structured output configuration */
  output?: OutputConfig<M>;
  /** Packs this node uses */
  packs?: Pack<any>[];
}

/**
 * Worker node configuration for createWorkerNode.
 * Worker nodes execute in parallel with the main flow but:
 * - Don't receive user input
 * - Can't access packs
 * - Must cede to return control (end_turn throws an error)
 * @typeParam M - The output message type (never = no structured output).
 * @typeParam S - The node's state type.
 */
export interface WorkerNodeConfig<M = never, S = unknown> {
  instructions: string;
  /** Node tools (state access via context) */
  tools?: Record<string, NodeToolEntry<S>>;
  validator: z.ZodType<S>;
  /** Transitions see node state S */
  transitions?: Record<string, Transition<S>>;
  /** Commands - user-callable methods that bypass LLM inference */
  commands?: Record<string, AnyCommandDefinition<S>>;
  /** Optional initial state for this node */
  initialState?: S;
  /** Per-node executor configuration (overrides executor defaults) */
  executorConfig?: StandardNodeConfig;
  /** Structured output configuration */
  output?: OutputConfig<M>;
  // packs intentionally omitted - worker nodes can't access packs
}

/**
 * Runtime node instance.
 * @typeParam M - The output message type (never = no structured output).
 * @typeParam S - The node's state type. Node has no knowledge of Charter.
 */
export interface Node<M = never, S = unknown> {
  /** Unique identifier for this node instance */
  id: string;
  /** Instructions for the agent in this node */
  instructions: string;
  /** Node tools (state access via context) */
  tools: Record<string, NodeToolEntry<S>>;
  /** Zod schema for validating state */
  validator: z.ZodType<S>;
  /** Available transitions from this node (see node state S) */
  transitions: Record<string, Transition<S>>;
  /** Commands - user-callable methods that bypass LLM inference */
  commands?: Record<string, AnyCommandDefinition<S>>;
  /** Optional initial state for this node */
  initialState?: S;
  /** Per-node executor configuration (overrides executor defaults) */
  executorConfig?: StandardNodeConfig;
  /** Structured output configuration */
  output?: OutputConfig<M>;
  /** Packs this node uses (not available on worker nodes) */
  packs?: Pack<any>[];
  /** Whether this is a worker node */
  worker?: boolean;
}

/**
 * Worker runtime node - extends Node with worker: true.
 *
 * A worker instance is one that was spawned in parallel alongside other
 * instances. Worker instances have these constraints:
 *
 * - **Don't receive user input**: Worker nodes get empty string for input,
 *   since only one node can receive user messages at a time.
 *
 * - **Can't update pack states**: Pack state updates from worker nodes are
 *   disallowed because they could conflict with updates from the non-worker node.
 *   The packs field is omitted from WorkerNodeConfig.
 *
 * - **Should cede() to return control**: When a worker node's work is complete,
 *   it should call cede() to remove itself from the tree and optionally pass
 *   content back to the parent.
 *
 * - **end_turn doesn't propagate to machine**: If a worker node returns
 *   end_turn without ceding, a warning is logged but the machine continues.
 *   This prevents worker nodes from prematurely ending the conversation.
 *
 * @typeParam M - The output message type (never = no structured output).
 * @typeParam S - The node's state type.
 */
export interface WorkerNode<M = never, S = unknown> extends Node<M, S> {
  /** Mark as worker node - enables parallel execution but disables pack access */
  worker: true;
}

/**
 * Check if a value is a Node instance.
 */
export function isNode<M = never, S = unknown>(value: unknown): value is Node<M, S> {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "instructions" in value &&
    "tools" in value &&
    "validator" in value &&
    "transitions" in value
  );
}

/**
 * Check if a node is a worker node.
 */
export function isWorkerNode<M = never, S = unknown>(node: Node<M, S>): node is WorkerNode<M, S> {
  return node.worker === true;
}
