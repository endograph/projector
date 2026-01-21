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
 * @typeParam S - The node's state type.
 */
export function createNode<S>(config: NodeConfig<S>): Node<S, never>;

/**
 * Create a new node instance with structured output.
 * @typeParam S - The node's state type.
 * @typeParam M - The output message type.
 */
export function createNode<S, M>(
  config: NodeConfig<S, M> & { output: OutputConfig<M> },
): Node<S, M>;

/**
 * Create a new node instance.
 * Node has no knowledge of Charter - it only knows about its own state type S.
 *
 * @typeParam S - The node's state type.
 * @typeParam M - The output message type (never = no structured output).
 */
export function createNode<S, M = never>(config: NodeConfig<S, M>): Node<S, M> {
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
 * @typeParam S - The node's state type.
 */
export function createWorkerNode<S>(config: WorkerNodeConfig<S>): WorkerNode<S, never>;

/**
 * Create a new worker node instance with structured output.
 * @typeParam S - The node's state type.
 * @typeParam M - The output message type.
 */
export function createWorkerNode<S, M>(
  config: WorkerNodeConfig<S, M> & { output: OutputConfig<M> },
): WorkerNode<S, M>;

/**
 * Create a new worker node instance.
 *
 * @typeParam S - The node's state type.
 * @typeParam M - The output message type (never = no structured output).
 */
export function createWorkerNode<S, M = never>(
  config: WorkerNodeConfig<S, M>,
): WorkerNode<S, M> {
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
