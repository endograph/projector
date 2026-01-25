/**
 * Basic usage example for @markov-machines/voice
 *
 * This example shows how to use the voice package with markov-machines
 * to create a voice-enabled state machine.
 *
 * Prerequisites:
 * - A LiveKit server (cloud or self-hosted)
 * - An OpenAI API key with realtime access
 * - A markov-machines charter with nodes and tools
 */

import { z } from "zod";
import {
  createNode,
  createCharter,
  createMachine,
  createInstance,
  createStandardExecutor,
} from "markov-machines";
import {
  createVoiceMachineRunner,
  type VoiceRuntimeConfig,
  type LiveKitOptions,
} from "@markov-machines/voice";

// 1. Define your state schema
const todoStateValidator = z.object({
  todos: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      completed: z.boolean(),
    })
  ),
});

type TodoState = z.infer<typeof todoStateValidator>;

// 2. Create a node with voice-friendly instructions
const todoNode = createNode<TodoState>({
  instructions: `You are a helpful voice assistant that manages a todo list.

When the user asks to add a todo, use the addTodo tool.
When they ask to complete a todo, use the completeTodo tool.
When they ask what's on their list, describe the current todos.

Be conversational and natural in your responses.
Keep responses brief - aim for 1-2 sentences.`,

  validator: todoStateValidator,
  initialState: { todos: [] },

  tools: {
    addTodo: {
      name: "addTodo",
      description: "Add a new todo item to the list",
      inputSchema: z.object({
        text: z.string().describe("The todo item text"),
      }),
      execute: (input, ctx) => {
        const newTodo = {
          id: crypto.randomUUID(),
          text: input.text,
          completed: false,
        };
        ctx.updateState({
          todos: [...ctx.state.todos, newTodo],
        });
        return `Added "${input.text}" to your list.`;
      },
    },
    completeTodo: {
      name: "completeTodo",
      description: "Mark a todo item as completed",
      inputSchema: z.object({
        text: z.string().describe("Part of the todo text to match"),
      }),
      execute: (input, ctx) => {
        const todo = ctx.state.todos.find((t) =>
          t.text.toLowerCase().includes(input.text.toLowerCase())
        );
        if (!todo) {
          return `Couldn't find a todo matching "${input.text}"`;
        }
        ctx.updateState({
          todos: ctx.state.todos.map((t) =>
            t.id === todo.id ? { ...t, completed: true } : t
          ),
        });
        return `Marked "${todo.text}" as completed.`;
      },
    },
  },
});

// 3. Create a charter
const charter = createCharter({
  name: "voice-todo-app",
  executor: createStandardExecutor(),
});

// 4. Create a machine
const machine = createMachine(charter, {
  instance: createInstance(todoNode, { todos: [] }),
});

// 5. Configure voice runtime
const voiceConfig: VoiceRuntimeConfig = {
  openaiApiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-realtime-preview-2024-12-17",
  voice: "alloy",
  turnDetection: {
    type: "server_vad",
    threshold: 0.5,
    silenceDurationMs: 500,
  },
  debug: true,
};

// 6. Configure LiveKit connection
const livekitOptions: LiveKitOptions = {
  serverUrl: process.env.LIVEKIT_URL!, // e.g., "wss://your-app.livekit.cloud"
  roomName: "voice-todo-room",
  token: process.env.LIVEKIT_TOKEN!, // JWT token for the room
};

// 7. Create and run the voice machine
async function main() {
  const voiceRunner = createVoiceMachineRunner(voiceConfig);

  // Subscribe to real-time events for UI updates
  voiceRunner.on("session_started", (e) => {
    console.log("🎙️ Voice session started:", e.sessionId);
  });

  voiceRunner.on("speech_started", () => {
    console.log("🗣️ User is speaking...");
  });

  voiceRunner.on("speech_ended", (e) => {
    console.log("👤 User said:", e.transcript);
  });

  voiceRunner.on("response_started", () => {
    console.log("🤖 Assistant is responding...");
  });

  voiceRunner.on("response_ended", (e) => {
    console.log("🤖 Assistant:", e.transcript);
  });

  voiceRunner.on("tool_call_started", (e) => {
    console.log(`🔧 Calling tool: ${e.name}`);
  });

  voiceRunner.on("tool_call_completed", (e) => {
    console.log(`✅ Tool ${e.name} completed: ${e.result}`);
  });

  voiceRunner.on("state_updated", (e) => {
    console.log("📝 State updated:", e.state);
  });

  voiceRunner.on("error", (e) => {
    console.error("❌ Error:", e.error.message);
  });

  // Run the voice machine - yields MachineStep like runMachine
  try {
    for await (const step of voiceRunner.run(machine, livekitOptions)) {
      // Each step is a complete voice turn + worker results
      console.log("\n--- Machine Step ---");
      console.log("Yield reason:", step.yieldReason);
      console.log("Messages:", step.messages.length);
      console.log("Done:", step.done);

      // You can persist steps just like with runMachine
      // await persistStep(step);

      if (step.done) {
        console.log("\n🏁 Conversation ended");
        break;
      }
    }
  } finally {
    await voiceRunner.stop();
  }
}

// Run the example
main().catch(console.error);
