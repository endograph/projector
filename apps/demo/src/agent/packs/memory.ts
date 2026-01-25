import { z } from "zod";
import { createPack } from "markov-machines";

export const memoryStateValidator = z.object({
  memories: z.record(z.string(), z.string()),
});

export type MemoryState = z.infer<typeof memoryStateValidator>;

export const memoryPack = createPack({
  name: "memory",
  description: "Simple key-value memory store for persisting information across conversations",
  validator: memoryStateValidator,
  tools: {
    setMemory: {
      name: "setMemory",
      description: "Store a memory with the given key and value",
      inputSchema: z.object({
        key: z.string().describe("A short identifier for this memory"),
        value: z.string().describe("The content to remember"),
      }),
      execute: (input, ctx) => {
        ctx.updateState({
          memories: { ...ctx.state.memories, [input.key]: input.value },
        });
        return `Memory stored: "${input.key}" = "${input.value}"`;
      },
    },
    getMemory: {
      name: "getMemory",
      description: "Retrieve a memory by its key",
      inputSchema: z.object({
        key: z.string().describe("The key of the memory to retrieve"),
      }),
      execute: (input, ctx) => {
        const value = ctx.state.memories[input.key];
        if (value === undefined) {
          return `No memory found for key: "${input.key}"`;
        }
        return `Memory "${input.key}": ${value}`;
      },
    },
    listMemories: {
      name: "listMemories",
      description: "List all stored memories",
      inputSchema: z.object({}),
      execute: (_input, ctx) => {
        const entries = Object.entries(ctx.state.memories);
        if (entries.length === 0) {
          return "No memories stored yet.";
        }
        return entries.map(([key, value]) => `- ${key}: ${value}`).join("\n");
      },
    },
  },
  initialState: { memories: {} },
});
