import { v4 as uuid } from "uuid";
import type {
  Node,
  NodeConfig,
  WorkerNode,
  WorkerNodeConfig,
  OutputConfig,
} from "../types/node.js";

/**
 * Validate tool and command names match their keys.
 */
function validateNames(
  tools: Record<string, { name: string }>,
  commands?: Record<string, { name: string }>,
): void {
  for (const [key, tool] of Object.entries(tools)) {
    if (tool.name !== key) {
      throw new Error(
        `Node tool name mismatch: key "${key}" does not match tool.name "${tool.name}"`,
      );
    }
  }

  if (commands) {
    for (const [key, command] of Object.entries(commands)) {
      if (command.name !== key) {
        throw new Error(
          `Node command name mismatch: key "${key}" does not match command.name "${command.name}"`,
        );
      }
    }
  }
}

/**
 * Create a new node instance without structured output.
 * @typeParam S - The node's state type (inferred from validator).
 */
export function createNode<S>(config: NodeConfig<never, S>): Node<never, S>;

/**
 * Create a new node instance with structured output.
 * @typeParam M - The output message type.
 * @typeParam S - The node's state type (inferred from validator).
 */
export function createNode<M, S>(
  config: NodeConfig<M, S> & { output: OutputConfig<M> },
): Node<M, S>;

/**
 * Create a new node instance.
 * Node has no knowledge of Charter - it only knows about its own state type S.
 *
 * @typeParam M - The output message type (never = no structured output).
 * @typeParam S - The node's state type.
 */
export function createNode<M = never, S = unknown>(config: NodeConfig<M, S>): Node<M, S> {
  const {
    instructions,
    tools = {},
    validator,
    transitions = {},
    commands,
    initialState,
    packs,
    executorConfig,
    output,
  } = config;

  validateNames(tools, commands);

  return {
    id: uuid(),
    instructions,
    tools,
    validator,
    transitions,
    commands,
    initialState,
    packs,
    executorConfig,
    output,
  };
}

/**
 * Create a new worker node instance.
 * Worker nodes execute in parallel with the main flow but:
 * - Don't receive user input
 * - Can't access packs
 * - Must cede to return control (end_turn throws an error)
 *
 * @typeParam S - The node's state type (inferred from validator).
 */
export function createWorkerNode<S>(config: WorkerNodeConfig<never, S>): WorkerNode<never, S>;

/**
 * Create a new worker node instance with structured output.
 * @typeParam M - The output message type.
 * @typeParam S - The node's state type (inferred from validator).
 */
export function createWorkerNode<M, S>(
  config: WorkerNodeConfig<M, S> & { output: OutputConfig<M> },
): WorkerNode<M, S>;

/**
 * Create a new worker node instance.
 *
 * @typeParam M - The output message type (never = no structured output).
 * @typeParam S - The node's state type.
 */
export function createWorkerNode<M = never, S = unknown>(
  config: WorkerNodeConfig<M, S>,
): WorkerNode<M, S> {
  const {
    instructions,
    tools = {},
    validator,
    transitions = {},
    commands,
    initialState,
    executorConfig,
    output,
  } = config;

  validateNames(tools, commands);

  return {
    id: uuid(),
    instructions,
    tools,
    validator,
    transitions,
    commands,
    initialState,
    executorConfig,
    output,
    worker: true,
  };
}
