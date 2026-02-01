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
  createStandardExecutor,
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

import { createDemoCharter } from "./agent/charter.js";
import { getLiveKitExecutor } from "./agent/livekit.js";

// Create charters with their respective executors
const demoCharterStandard = createDemoCharter(
  createStandardExecutor({
    model: "claude-sonnet-4-5",
    apiKey: process.env.ANTHROPIC_API_KEY,
  }),
);
const demoCharterLiveKit = {
  ...demoCharterStandard,
  executor: getLiveKitExecutor(),
};
import { serializeInstanceForDisplay } from "markov-machines";

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

    const { sessionId, turnId: initialTurnId, branchRootTurnId: initialBranchRootTurnId, instance: serializedInstance, history: rawHistory } = agentInit;
    const initialHistory = rawHistory as MachineMessage[];
    console.log(`[DemoAgent] Session ID: ${sessionId}, ${initialHistory.length} history messages`);

    // Mutable context - all closures reference this instead of local variables
    // This enables safe time travel by swapping the machine without breaking references
    const context: {
      machine: Machine | null;
      currentTurnId: typeof initialTurnId;
      branchRootTurnId: typeof initialBranchRootTurnId;  // Only changes on user-initiated time travel
      generation: number;
    } = {
      machine: null,
      currentTurnId: initialTurnId,
      branchRootTurnId: initialBranchRootTurnId,
      generation: 0,
    };

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
          turnId: context.currentTurnId,
        });
      } catch (error) {
        console.error(`[DemoAgent] Failed to persist ${role} message:`, error);
      }
    };

    // Function to create a machine from serialized state
    const initMachine = (serializedInst: unknown, history: MachineMessage[]): Machine => {
      const instance = deserializeInstance(demoCharterLiveKit, serializedInst as any);
      console.log(`[DemoAgent] Instance deserialized: node=${instance.node?.id}`);

      const machine = createMachine(demoCharterLiveKit, {
        instance,
        history: filterValidMessages(history),
        onMessageEnqueue,
      });
      console.log(`[DemoAgent] Machine created with node: ${machine.instance.node.id}`);

      return machine;
    };

    // Create initial machine
    console.log("[DemoAgent] Creating initial machine...");
    try {
      context.machine = initMachine(serializedInstance, initialHistory);
    } catch (err) {
      console.error("[DemoAgent] Initial machine creation FAILED:", err);
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
      await liveKitExecutor.connect(context.machine!, {
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

    // Voice session event handlers
    voiceSession.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[DemoAgent] State: ${ev.oldState} -> ${ev.newState}`);
    });

    // Create a turn when user starts speaking in live mode
    voiceSession.on(voice.AgentSessionEventTypes.UserStateChanged, async (ev) => {
      if (ev.newState === "speaking" && liveKitExecutor.isLive && context.machine) {
        const activeInstance = getActiveInstance(context.machine.instance);
        await createTurn(activeInstance.id, "[voice input]");
        console.log("[DemoAgent] Created turn for voice input");
      }
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
      if (!context.machine) return null;
      try {
        let serialInstance = serializeInstance(context.machine.instance, demoCharterLiveKit)
        const newTurnId = await convex.mutation(api.machineTurns.create, {
          sessionId,
          parentId: context.currentTurnId,
          instanceId,
          instance: serialInstance,
          displayInstance: serializeInstanceForDisplay(context.machine.instance, demoCharterLiveKit),
        });
        context.currentTurnId = newTurnId;

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
      turnId: typeof context.currentTurnId,
    ) => {
      try {
        await convex.mutation(api.sessions.finalizeTurn, {
          turnId,
          instance: serializeInstance(step.instance, demoCharterLiveKit),
          displayInstance: serializeInstanceForDisplay(step.instance, demoCharterLiveKit),
          messages: allMessages,
        });
        console.log(`[DemoAgent] Updated turn: ${turnId}`);
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

        if (!context.machine) {
          throw new Error("Machine not initialized");
        }

        try {
          // Create a new turn for this user message
          const activeInstance = getActiveInstance(context.machine.instance);
          await createTurn(activeInstance.id, payload);

          // Enqueue the user message for the main loop to process
          // external: true marks this as a user-originated message (from RPC)
          const message = userMessage(payload, { source: { external: true } });
          context.machine.enqueue([message]);

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

        if (!context.machine) {
          return JSON.stringify({
            success: false,
            error: "Machine not initialized",
          });
        }

        try {
          const { commandName, input } = JSON.parse(payload) as {
            commandName: string;
            input: Record<string, unknown>;
          };

          // Execute command directly (runCommand enqueues the command message for history)
          const { machine: updatedMachine, result } = await runCommand(
            context.machine,
            commandName,
            input,
          );

          // Update machine state
          context.machine.instance = updatedMachine.instance;

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

    // Machine loop - processes turns continuously, exits when generation changes
    const startMachineLoop = async (loopGeneration: number) => {
      console.log(`[DemoAgent] Starting machine loop (generation ${loopGeneration})...`);

      while (context.generation === loopGeneration && !isShuttingDown) {
        if (!context.machine) {
          console.error("[DemoAgent] Machine is null in loop");
          break;
        }

        await context.machine.waitForQueue();

        // Check again after waking - might have been time traveled or shut down
        if (context.generation !== loopGeneration || isShuttingDown) {
          console.log(`[DemoAgent] Loop generation ${loopGeneration} exiting after waitForQueue (current: ${context.generation})`);
          break;
        }

        // Capture the turn ID at the start of processing
        const turnIdForThisTurn = context.currentTurnId;

        // Set processing = true
        await convex.mutation(api.sessionEphemera.setProcessing, {
          sessionId,
          isProcessing: true,
        });

        let lastStep: MachineStep | null = null;
        const allMessages: MachineMessage[] = [];
        let stepNumber = 0;

        for await (const step of runMachine(context.machine)) {
          stepNumber++;

          // Check after each step - exit gracefully if time traveled
          if (context.generation !== loopGeneration) {
            console.log(`[DemoAgent] Time travel detected mid-turn at step ${stepNumber}, exiting loop`);
            break;
          }

          const msgCount = step.history.length;
          const msgDesc = describeMessages(step.history);
          console.log(`[DemoAgent] Step ${stepNumber}: yieldReason=${step.yieldReason}, done=${step.done}, messages=${msgCount}`);
          if (msgCount > 0) console.log(`[DemoAgent] Messages: ${msgDesc}`);

          const activeInstance = getActiveInstance(step.instance);
          const responseText = getStepResponse(step);
          try {
            await convex.mutation(api.machineSteps.add, {
              sessionId,
              turnId: turnIdForThisTurn,
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
          await liveKitExecutor.pushConfigToLiveKit();
        }

        // Only finalize turn if we're still the active generation
        if (context.generation === loopGeneration && lastStep) {
          const responseText = getStepResponse(lastStep);
          console.log("[DemoAgent] Turn complete", truncateForLog(responseText));
          await updateTurn(lastStep, allMessages, turnIdForThisTurn);
        }

        // Set processing = false
        await convex.mutation(api.sessionEphemera.setProcessing, {
          sessionId,
          isProcessing: false,
        });
      }

      console.log(`[DemoAgent] Machine loop generation ${loopGeneration} ended`);
    };

    // Handle time travel by creating a new machine and starting a new loop
    const handleTimeTravel = async (newTurnId: typeof context.currentTurnId, newBranchRootTurnId: typeof context.branchRootTurnId) => {
      console.log(`[DemoAgent] Time travel: branch root ${context.branchRootTurnId} -> ${newBranchRootTurnId}`);

      // Increment generation to signal old loop to exit
      context.generation++;
      const newGeneration = context.generation;

      // Fetch fresh state from Convex
      const agentState = await convex.query(api.livekitAgent.getAgentInit, { roomName });
      if (!agentState) {
        console.error("[DemoAgent] Failed to fetch state for time travel");
        return;
      }

      // Create new machine with the time-traveled state
      const newMachine = initMachine(agentState.instance, agentState.history as MachineMessage[]);

      // Update context
      context.machine = newMachine;
      context.currentTurnId = newTurnId;
      context.branchRootTurnId = newBranchRootTurnId;

      // Reconnect executor to new machine
      await liveKitExecutor.connect(newMachine, {
        session: voiceSession,
        agent,
        room: ctx.room,
      });

      console.log(`[DemoAgent] Time travel complete, starting new loop (generation ${newGeneration})`);

      // Start new loop (don't await - runs concurrently while old loop exits)
      startMachineLoop(newGeneration).catch((err) => {
        console.error(`[DemoAgent] Machine loop generation ${newGeneration} error:`, err);
      });
    };

    // Subscribe to session changes (for time travel support)
    // Only trigger time travel when branchRootTurnId changes (user-initiated)
    // Normal agent turn creation only changes currentTurnId, not branchRootTurnId
    convex.onUpdate(api.sessions.get, { id: sessionId }, (session) => {
      const newRoot = session?.branchRootTurnId;
      const oldRoot = context.branchRootTurnId;
      if (newRoot !== oldRoot) {
        if (newRoot === undefined) {
          // Time travel: branchRootTurnId went null
          handleTimeTravel(session!.turnId, undefined);
        } else if (oldRoot === undefined) {
          // Branch created after time travel (by agent's machineTurns.create) — just sync
          context.branchRootTurnId = newRoot;
        } else {
          // External branch (e.g. instruction edit) — reload
          handleTimeTravel(session!.turnId, newRoot);
        }
      }
    });

    try {
      await startMachineLoop(context.generation);
    } catch (error) {
      console.error("[DemoAgent] Machine loop error:", error);
    }
    // Only cleanup if we're actually shutting down (not just switching generations due to time travel)
    if (isShuttingDown) {
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
