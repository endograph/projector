/**
 * Demo Agent - Unified LiveKit-based architecture
 *
 * Handles both voice and text input through a single LiveKit room:
 * - Voice (live mode): Uses LiveKitExecutor with STT/TTS pipeline
 * - Text (non-live mode): Receives messages via RPC, runs through StandardExecutor
 *
 * Machine state is loaded from Convex and synchronized after each turn.
 */

import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { ConvexClient } from "convex/browser";
import { api } from "demo/convex/_generated/api.js";
import { fileURLToPath } from "node:url";
import {
  createMachine,
  deserializeInstance,
  serializeInstance,
  runMachine,
  runCommand,
  userMessage,
  getMessageText,
  getActiveInstance,
  type Machine,
  type MachineStep,
  type MachineMessage,
  type MachineItem,
  type OnMessageEnqueue,
} from "markov-machines";

import { demoCharterStandard } from "./agent/charter.js";
import { getLiveKitExecutor } from "./agent/livekit.js";

// Create LiveKit version of the charter by overriding the executor
const demoCharterLiveKit = {
  ...demoCharterStandard,
  executor: getLiveKitExecutor(),
};
import { ConvexTranscriptSink } from "./transcript-sink.js";
import { serializeInstanceForDisplay } from "./serializeForDisplay.js";

const ENABLE_REALTIME = process.env.ENABLE_REALTIME_MODEL === "true";

console.log("[DemoAgent] Configuration:");
console.log(`  ENABLE_REALTIME_MODEL: ${ENABLE_REALTIME}`);
console.log(`  CONVEX_URL: ${process.env.CONVEX_URL ? "set" : "NOT SET"}`);
console.log(`  OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "set" : "NOT SET"}`);
console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET"}`);
console.log(`  LIVEKIT_URL: ${process.env.LIVEKIT_URL ?? "NOT SET"}`);

class VoiceAssistant extends voice.Agent {
  constructor() {
    super({
      instructions: "Initializing...",
    });
  }
}

function getStepResponse(step: MachineStep<unknown>): string {
  for (let i = step.history.length - 1; i >= 0; i--) {
    const msg = step.history[i];
    if (msg && msg.role === "assistant") {
      return getMessageText(msg);
    }
  }
  return "";
}

function describeMessages(messages: MachineMessage[]): string {
  return messages.map(msg => {
    if (msg.role === "instance") {
      return `${msg.role}:payload`;
    }
    if (typeof msg.items === "string") {
      return `${msg.role}:text`;
    }
    const blockTypes = (msg.items as MachineItem[]).map(item => item.type).join(",");
    return `${msg.role}:[${blockTypes}]`;
  }).join(" | ");
}

function filterValidMessages(messages: MachineMessage[]): MachineMessage[] {
  return messages.filter((msg) => {
    if (!msg.items) return false;
    if (Array.isArray(msg.items)) {
      return msg.items.length > 0;
    }
    if (typeof msg.items === "string") {
      return msg.items.length > 0;
    }
    return true;
  });
}

const MAX_LOG_MESSAGE_CHARS = 200;
function truncateForLog(value: string, maxChars: number = MAX_LOG_MESSAGE_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

console.log("[DemoAgent] ========== DEFINING AGENT ==========");

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    console.log("[DemoAgent] ========== PREWARM STARTING ==========");

    if (!ENABLE_REALTIME) {
      console.log("[DemoAgent] Loading Silero VAD model (pipeline mode)...");
      try {
        proc.userData.vad = await silero.VAD.load();
        console.log("[DemoAgent] Silero VAD model loaded successfully");
      } catch (error) {
        console.error("[DemoAgent] Failed to load Silero VAD model:", error);
        console.error("[DemoAgent] Did you run 'bun run download-files'?");
        throw error;
      }
    } else {
      console.log("[DemoAgent] Skipping VAD load (realtime mode)");
    }

    console.log("[DemoAgent] Prewarm complete");
  },

  entry: async (ctx: JobContext) => {
    console.log("[DemoAgent] ========== ENTRY CALLED ==========");
    console.log(`[DemoAgent] Job ID: ${ctx.job.id}`);
    console.log(`[DemoAgent] Job metadata:`, JSON.stringify(ctx.job, null, 2));

    // Connect to room first to get room name
    console.log("[DemoAgent] Connecting to room...");
    try {
      await ctx.connect();
      console.log("[DemoAgent] ctx.connect() completed successfully");
    } catch (err) {
      console.error("[DemoAgent] ctx.connect() FAILED:", err);
      throw err;
    }

    const roomName = ctx.room.name ?? "";
    console.log(`[DemoAgent] Connected to room: ${roomName}`);
    console.log(`[DemoAgent] Participants:`, ctx.room.remoteParticipants?.size ?? 0);

    if (!roomName) {
      console.error("[DemoAgent] No room name - cannot load session");
      return;
    }

    // Initialize Convex client
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      console.error("[DemoAgent] CONVEX_URL not set");
      return;
    }

    console.log("[DemoAgent] Creating ConvexClient...");
    const convex = new ConvexClient(convexUrl);
    console.log("[DemoAgent] ConvexClient created");

    // Load session, turn, and history in one query
    console.log(`[DemoAgent] Loading agent init for room: ${roomName}`);
    let agentInit;
    try {
      agentInit = await convex.query(api.livekitAgent.getAgentInit, { roomName });
      console.log(`[DemoAgent] getAgentInit returned:`, agentInit ? "found" : "null");
    } catch (err) {
      console.error(`[DemoAgent] getAgentInit FAILED:`, err);
      throw err;
    }
    if (!agentInit) {
      console.error(`[DemoAgent] No session found for room: ${roomName}`);
      return;
    }

    const { sessionId, turnId: initialTurnId, instance: serializedInstance, history: rawHistory } = agentInit;
    let currentTurnId = initialTurnId;
    const history = rawHistory as MachineMessage[];
    console.log(`[DemoAgent] Session ID: ${sessionId}, ${history.length} history messages`);

    // Deserialize instance from session
    console.log("[DemoAgent] Deserializing instance...");
    let instance;
    try {
      instance = deserializeInstance(demoCharterLiveKit, serializedInstance as any);
      console.log(`[DemoAgent] Instance deserialized: node=${instance.node?.id}`);
    } catch (err) {
      console.error("[DemoAgent] deserializeInstance FAILED:", err);
      throw err;
    }

    // Callback for persisting messages when enqueued
    // Save external messages (user input from LiveKit STT, etc.)
    // Save assistant messages with displayable content
    // Skip everything else (command-generated userMessages, etc.)
    const onMessageEnqueue: OnMessageEnqueue = async (message) => {
      const isExternal = message.metadata?.source?.external;
      const isAssistant = message.role === "assistant";

      if (!isExternal && !isAssistant) {
        return; // Skip non-external user messages (e.g., command-generated)
      }

      // Extract displayable content from the message
      const content = typeof message.items === "string"
        ? message.items
        : getMessageText(message);

      if (!content) {
        return; // No displayable content
      }

      const role = message.role === "assistant" ? "assistant" : "user";
      console.log(
        `[DemoAgent] Persisting ${role} message: "${truncateForLog(content)}"`
      );
      try {
        await convex.mutation(api.messages.add, {
          sessionId,
          role,
          content,
          turnId: currentTurnId,
        });
      } catch (error) {
        console.error(`[DemoAgent] Failed to persist ${role} message:`, error);
      }
    };

    // Create machine with loaded state
    console.log("[DemoAgent] Creating machine...");
    let machine;
    try {
      machine = createMachine(demoCharterLiveKit, {
        instance,
        history: filterValidMessages(history),
        onMessageEnqueue,
      });
      console.log(`[DemoAgent] Machine created with node: ${machine.instance.node.id}`);
    } catch (err) {
      console.error("[DemoAgent] createMachine FAILED:", err);
      throw err;
    }

    // Set up voice session
    const agent = new VoiceAssistant();
    let voiceSession: voice.AgentSession;

    if (ENABLE_REALTIME) {
      console.log("[DemoAgent] Using OpenAI Realtime mode");
      voiceSession = new voice.AgentSession({
        llm: new openai.realtime.RealtimeModel({
          model: "gpt-realtime",
          voice: "alloy",
          turnDetection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: 500,
          },
          inputAudioTranscription: {
            model: "whisper-1",
          },
        }),
      });
    } else {
      console.log("[DemoAgent] Using STT->LLM->TTS pipeline mode");
      voiceSession = new voice.AgentSession({
        stt: new openai.STT(),
        llm: new openai.LLM({ model: "gpt-4o-mini" }),
        tts: new openai.TTS({ voice: "alloy" }),
        vad: ctx.proc.userData.vad as silero.VAD,
      });
    }

    // Get executor and connect to machine
    console.log("[DemoAgent] Getting LiveKit executor...");
    const liveKitExecutor = getLiveKitExecutor();
    console.log("[DemoAgent] Connecting executor to machine...");
    try {
      await liveKitExecutor.connect(machine, {
        session: voiceSession,
        agent,
        room: ctx.room,
      });
      console.log("[DemoAgent] Executor connected successfully");
    } catch (err) {
      console.error("[DemoAgent] liveKitExecutor.connect FAILED:", err);
      throw err;
    }

    // Start with isLive = false (text mode by default)
    // Frontend will toggle this when user enables voice
    liveKitExecutor.setLive(false);
    console.log("[DemoAgent] Executor set to text mode (isLive=false)");

    // Set up transcript sink
    let transcriptSink: ConvexTranscriptSink | null = null;
    try {
      transcriptSink = new ConvexTranscriptSink(roomName);
      console.log("[DemoAgent] Transcript sink created");
    } catch (error) {
      console.error("[DemoAgent] Failed to create transcript sink:", error);
    }

    // Voice session event handlers
    voiceSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, async (ev) => {
      console.log(`[DemoAgent] User: "${ev.transcript}" (final: ${ev.isFinal})`);
      if (ev.isFinal && transcriptSink) {
        await transcriptSink.appendTranscript("user", ev.transcript);
      }
    });

    voiceSession.on(voice.AgentSessionEventTypes.ConversationItemAdded, async (ev) => {
      const item = ev.item as { role?: string; content?: unknown };
      if (item.role === "assistant" && typeof item.content === "string") {
        console.log(`[DemoAgent] Assistant: "${item.content.slice(0, 80)}..."`);
        if (transcriptSink) {
          await transcriptSink.appendTranscript("assistant", item.content);
        }
      }
    });

    voiceSession.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[DemoAgent] State: ${ev.oldState} -> ${ev.newState}`);
    });

    voiceSession.on(voice.AgentSessionEventTypes.Error, (ev) => {
      console.error(`[DemoAgent] Error:`, ev.error);
    });

    // Start voice session
    console.log("[DemoAgent] Starting agent session...");
    try {
      await voiceSession.start({
        agent,
        room: ctx.room,
      });
      console.log("[DemoAgent] Voice session started successfully");
    } catch (err) {
      console.error("[DemoAgent] voiceSession.start FAILED:", err);
      throw err;
    }

    // Graceful shutdown handling
    let isShuttingDown = false;

    const cleanup = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log("[DemoAgent] Shutting down...");

      // Remove voice session event listeners
      try {
        voiceSession.removeAllListeners();
      } catch (e) {
        console.error("[DemoAgent] Error cleaning up voice session:", e);
      }

      // Close Convex client
      try {
        await convex.close();
      } catch (e) {
        console.error("[DemoAgent] Error closing Convex:", e);
      }

      console.log("[DemoAgent] Cleanup complete");
      process.exit(0);
    };

    // Register signal handlers for graceful shutdown
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Helper to create a new turn when user message is received
    const createTurn = async (instanceId: string, userContent: string) => {
      try {
        const newTurnId = await convex.mutation(api.machineTurns.create, {
          sessionId,
          parentId: currentTurnId,
          instanceId,
          instance: serializeInstance(machine.instance, demoCharterLiveKit),
          displayInstance: serializeInstanceForDisplay(machine.instance, demoCharterLiveKit),
        });
        currentTurnId = newTurnId;

        console.log(`[DemoAgent] Created turn: ${newTurnId}`);
        return newTurnId;
      } catch (error) {
        console.error("[DemoAgent] Failed to create turn:", error);
        return null;
      }
    };

    // Helper to update current turn with final state
    const updateTurn = async (
      step: MachineStep,
      allMessages: MachineMessage[],
    ) => {
      try {
        await convex.mutation(api.sessions.finalizeTurn, {
          turnId: currentTurnId,
          instance: serializeInstance(step.instance, demoCharterLiveKit),
          displayInstance: serializeInstanceForDisplay(step.instance, demoCharterLiveKit),
          messages: allMessages,
        });
        console.log(`[DemoAgent] Updated turn: ${currentTurnId}`);
      } catch (error) {
        console.error("[DemoAgent] Failed to update turn:", error);
      }
    };

    // Register RPC methods
    console.log("[DemoAgent] Registering RPC methods...");
    console.log(`[DemoAgent] localParticipant exists: ${!!ctx.room.localParticipant}`);
    console.log(`[DemoAgent] localParticipant identity: ${ctx.room.localParticipant?.identity}`);
    ctx.room.localParticipant?.registerRpcMethod(
      "sendMessage",
      async (data) => {
        const { payload } = data;
        console.log(`[DemoAgent] RPC sendMessage: "${payload.slice(0, 80)}..."`);

        try {
          // Create a new turn for this user message
          const activeInstance = getActiveInstance(machine.instance);
          await createTurn(activeInstance.id, payload);

          // Enqueue the user message for the main loop to process
          // external: true marks this as a user-originated message (from RPC)
          const message = userMessage(payload, { source: { external: true } });
          machine.enqueue([message]);

          console.log("[DemoAgent] RPC message enqueued");
          return JSON.stringify(message);
        } catch (error) {
          console.error("[DemoAgent] RPC sendMessage error:", error);
          throw error;
        }
      }
    );

    // RPC to toggle live mode
    ctx.room.localParticipant?.registerRpcMethod(
      "setLiveMode",
      async (data) => {
        const isLive = data.payload === "true";
        console.log(`[DemoAgent] RPC setLiveMode: ${isLive}`);
        liveKitExecutor.setLive(isLive);
        return JSON.stringify({ isLive });
      }
    );

    // RPC to execute a command
    ctx.room.localParticipant?.registerRpcMethod(
      "executeCommand",
      async (data) => {
        const { payload } = data;
        console.log(`[DemoAgent] RPC executeCommand: ${payload}`);

        try {
          const { commandName, input } = JSON.parse(payload) as {
            commandName: string;
            input: Record<string, unknown>;
          };

          // Execute command directly (runCommand enqueues the command message for history)
          const { machine: updatedMachine, result } = await runCommand(
            machine,
            commandName,
            input,
          );

          // Update machine state
          machine.instance = updatedMachine.instance;

          console.log(`[DemoAgent] Command ${commandName} executed: ${result.success ? "success" : result.error}`);
          return JSON.stringify({
            success: result.success,
            value: result.value,
            error: result.error,
          });
        } catch (error) {
          console.error("[DemoAgent] RPC executeCommand error:", error);
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    );

    console.log("[DemoAgent] RPC methods registered");

    // Main machine loop - processes turns continuously
    const runMainLoop = async () => {
      console.log("[DemoAgent] Starting main machine loop...");
      while (!isShuttingDown) {
        await machine.waitForQueue();
        if (isShuttingDown) break;

        let lastStep: MachineStep | null = null;
        const allMessages: MachineMessage[] = [];
        let stepNumber = 0;

        for await (const step of runMachine(machine)) {
          stepNumber++;

          const msgCount = step.history.length;
          const msgDesc = describeMessages(step.history);
          console.log(`[DemoAgent] Step ${stepNumber}: yieldReason=${step.yieldReason}, done=${step.done}, messages=${msgCount}`);
          if (msgCount > 0) {
            console.log(`[DemoAgent]   Messages: ${msgDesc}`);
          }

          const activeInstance = getActiveInstance(step.instance);
          const responseText = getStepResponse(step);
          try {
            console.log("%%% add machine step", truncateForLog(responseText));
            await convex.mutation(api.machineSteps.add, {
              sessionId,
              turnId: currentTurnId,
              stepNumber,
              yieldReason: step.yieldReason,
              response: responseText,
              done: step.done,
              messages: step.history,
              instance: serializeInstance(step.instance, demoCharterLiveKit),
              displayInstance: serializeInstanceForDisplay(step.instance, demoCharterLiveKit),
              activeNodeInstructions: activeInstance.node.instructions ?? "",
            });
          } catch (err) {
            console.error(`[DemoAgent] Failed to persist step ${stepNumber}:`, err);
          }

          allMessages.push(...step.history);
          lastStep = step;

          // Sync LiveKit config after each step in case instance changed
          // (e.g., transitions that didn't trigger executor.run())
          liveKitExecutor.pushConfigToLiveKit();
        }

        if (lastStep) {
          const responseText = getStepResponse(lastStep);
          console.log("[DemoAgent] Turn complete", truncateForLog(responseText));
          await updateTurn(lastStep, allMessages);
        }
      }
    };

    try {
      await runMainLoop();
    } catch (error) {
      console.error("[DemoAgent] Machine loop error:", error);
    } finally {
      await cleanup();
    }

    console.log(`[DemoAgent] Agent exiting for room: ${roomName}`);
  },
});

// Use explicit agent name to require explicit dispatch from getToken
cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "demo-agent",
  })
);
