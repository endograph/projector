import { z } from "zod";
import {
  createCharter,
  createStandardExecutor,
} from "markov-machines";
import { createAssemblerNodeWithClient, assemblerStateValidator, type AssemblerState, type ConvexClientInterface } from "./nodes/assembler";
import type { Id } from "../../convex/_generated/dataModel";

// Create charter with single executor
export const automatonCharter = createCharter({
  name: "automaton",
  executor: createStandardExecutor({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-sonnet-4-20250514",
    maxTokens: 1024 * 10,
    debug: false,
  }),
});

// Factory to create assembler node with session context and client interface
export function createSessionAssemblerNodeWithClient(sessionId: Id<"sessions">, convexClient: ConvexClientInterface) {
  const assemblerNode = createAssemblerNodeWithClient(sessionId, convexClient);

  // Register node in charter for serialization
  automatonCharter.nodes = automatonCharter.nodes || {};
  automatonCharter.nodes.assemblerNode = assemblerNode;

  return assemblerNode;
}

// Re-export types
export { assemblerStateValidator, type AssemblerState };

// Initial state factory
export function createInitialState(): AssemblerState {
  return {
    createdNodes: [],
    userContext: undefined,
  };
}
