import type { Charter, CharterConfig } from "../types/charter.js";

/**
 * Create a new charter instance.
 * A charter is a static registry with a single executor, tools, transitions, nodes, and packs.
 * It has no state - state lives in NodeInstances.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export function createCharter<AppMessage = unknown>(
  config: CharterConfig<AppMessage>,
): Charter<AppMessage> {
  const {
    name,
    instructions,
    executor,
    tools = {},
    transitions = {},
    nodes = {},
    packs = [],
    buildSystemPrompt,
  } = config;

  // Validate tool names match keys
  for (const [key, tool] of Object.entries(tools)) {
    if (tool.name !== key) {
      throw new Error(
        `Charter tool name mismatch: key "${key}" does not match tool.name "${tool.name}"`,
      );
    }
  }

  return {
    name,
    ...(instructions && { instructions }),
    executor,
    tools,
    transitions,
    nodes,
    packs,
    ...(buildSystemPrompt && { buildSystemPrompt }),
  };
}
