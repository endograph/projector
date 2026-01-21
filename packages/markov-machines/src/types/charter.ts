import type { AnyToolDefinition } from "./tools.js";
import type { Transition } from "./transitions.js";
import type { Node } from "./node.js";
import type { Executor } from "../executor/types.js";
import type { Pack } from "./pack.js";

/**
 * Charter configuration for createCharter.
 * Charter is purely static - a registry for serialization and ref resolution.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface CharterConfig<AppMessage = unknown> {
  name: string;
  /** Single executor for running nodes */
  executor: Executor<AppMessage>;
  /** Registered tools (for ref-based lookup, available to all nodes) */
  tools?: Record<string, AnyToolDefinition>;
  /** Registered transitions (for ref-based lookup) */
  transitions?: Record<string, Transition<unknown>>;
  /**
   * Registered nodes (for ref-based lookup).
   * Nodes must output AppMessage or have no output.
   */
  nodes?: Record<string, Node<unknown, AppMessage> | Node<unknown, never>>;
  /** Registered packs (reusable modules with state and tools) */
  packs?: Pack<unknown>[];
}

/**
 * Charter instance - static registry with single executor, tools, transitions, and nodes.
 * Charter has no state - state lives in NodeInstances.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface Charter<AppMessage = unknown> {
  name: string;
  /** Single executor for running nodes */
  executor: Executor<AppMessage>;
  /** Registered tools (available to all nodes via ref resolution) */
  tools: Record<string, AnyToolDefinition>;
  /** Registered transitions */
  transitions: Record<string, Transition<unknown>>;
  /**
   * Registered nodes.
   * Nodes must output AppMessage or have no output.
   */
  nodes: Record<string, Node<unknown, AppMessage> | Node<unknown, never>>;
  /** Registered packs */
  packs: Pack<unknown>[];
}
