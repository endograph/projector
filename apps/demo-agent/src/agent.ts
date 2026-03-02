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
import { RoomEvent, TrackKind, TrackSource } from "@livekit/rtc-node";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { ConvexClient } from "convex/browser";
import { api } from "demo/convex/_generated/api.js";
import type { Id } from "demo/convex/_generated/dataModel.js";
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
  type MessageStreamEvent,
} from "markov-machines";

import { createDemoCharter } from "./agent/charter.js";
import { getLiveKitExecutor } from "./agent/livekit.js";
import { attachVisionSampler, type VisionSamplerHandle } from "./agent/vision.js";
import { type AgentControlsState } from "./agent/packs/agent-controls.js";

// Create charters with their respective executors
const demoCharterStandard = createDemoCharter({
  executor: createStandardExecutor({
    model: "claude-sonnet-4-5",
    apiKey: process.env.ANTHROPIC_API_KEY,
  }),
});
const demoCharterLiveKit = {
  ...demoCharterStandard,
  executor: getLiveKitExecutor(),
};
import { serializeInstanceForDisplay } from "markov-machines";

const ENABLE_REALTIME = process.env.ENABLE_REALTIME_MODEL === "true";
const STREAM_TOPIC = "mm.stream.v1";

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

    ctx.room.on(RoomEvent.ParticipantConnected, (participant) => {
      console.log(
        `[DemoAgent] ParticipantConnected: identity=${participant.identity} kind=${participant.kind}`
      );
    });
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log(
        `[DemoAgent] ParticipantDisconnected: identity=${participant.identity} kind=${participant.kind}`
      );
    });
    ctx.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log(
        `[DemoAgent] TrackSubscribed: identity=${participant.identity} kind=${publication.kind} source=${publication.source} sid=${publication.sid}`
      );
    });
    ctx.room.on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
      console.log(
        `[DemoAgent] TrackUnsubscribed: identity=${participant.identity} kind=${publication.kind} source=${publication.source} sid=${publication.sid}`
      );
    });
    ctx.room.on(RoomEvent.TrackMuted, (publication, participant) => {
      console.log(
        `[DemoAgent] TrackMuted: identity=${participant.identity} kind=${publication.kind} source=${publication.source} sid=${publication.sid}`
      );
    });
    ctx.room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      console.log(
        `[DemoAgent] TrackUnmuted: identity=${participant.identity} kind=${publication.kind} source=${publication.source} sid=${publication.sid}`
      );
    });

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

      const idempotencyKey =
        message.role === "assistant"
          ? message.metadata?.messageId
          : (isExternal ? pendingUserMessageKeys.shift() : undefined);
      const streamState =
        message.role === "assistant"
          ? message.metadata?.stream?.state
          : (idempotencyKey ? "complete" : undefined);
      const streamSeq =
        message.role === "assistant"
          ? message.metadata?.stream?.seq
          : (idempotencyKey ? 1 : undefined);

      // Persist streaming assistant envelopes even when content is empty.
      if (!content && !idempotencyKey) {
        return; // No displayable content
      }

      const role = message.role === "assistant" ? "assistant" : "user";
      console.log(
        `[DemoAgent] Persisting ${role} message: "${truncateForLog(content)}"`
      );
      try {
        const persist = async () => {
          await convex.mutation(api.messages.add, {
            sessionId,
            role,
            content,
            turnId: context.currentTurnId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            ...(streamState !== undefined ? { streamState } : {}),
            ...(streamSeq !== undefined ? { streamSeq } : {}),
          });
        };

        // Durability: if streaming finalization fails to persist, retry with backoff.
        if (idempotencyKey && (streamState === "complete" || streamState === "error")) {
          const maxAttempts = 5;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              await persist();
              break;
            } catch (err) {
              if (attempt === maxAttempts) throw err;
              const delayMs = 200 * (2 ** (attempt - 1));
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }
        } else {
          await persist();
        }
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
    let visionSampler: VisionSamplerHandle | null = null;

    // Helper: create a fresh voice.AgentSession (used at startup and on participant reconnect)
    const createVoiceSession = (): voice.AgentSession => {
      if (ENABLE_REALTIME) {
        console.log("[DemoAgent] Creating voice session (OpenAI Realtime mode)");
        return new voice.AgentSession({
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
        console.log("[DemoAgent] Creating voice session (STT->LLM->TTS pipeline mode)");
        return new voice.AgentSession({
          stt: new openai.STT(),
          llm: new openai.LLM({ model: "gpt-4o-mini" }),
          tts: new openai.TTS({ voice: "alloy" }),
          vad: ctx.proc.userData.vad as silero.VAD,
        });
      }
    };

    let voiceSession = createVoiceSession();

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

    // Sync executor live mode from initial pack state
    const initialControls = context.machine!.instance.packStates?.agentControls as AgentControlsState | undefined;
    liveKitExecutor.setLive(initialControls?.voiceEnabled ?? false);
    console.log(`[DemoAgent] Executor set from pack state (isLive=${initialControls?.voiceEnabled ?? false})`);

    // Helper: attach event handlers to a voice session (used at startup and on reconnect)
    const attachVoiceSessionHandlers = (session: voice.AgentSession) => {
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
        console.log(`[DemoAgent] State: ${ev.oldState} -> ${ev.newState}`);
      });
      // Create a turn when user starts speaking in live mode
      session.on(voice.AgentSessionEventTypes.UserStateChanged, async (ev) => {
        console.log(`[DemoAgent] UserState: ${ev.oldState} -> ${ev.newState}`);
        visionSampler?.setMode(ev.newState === "speaking" ? "active" : "idle");
        if (ev.newState === "speaking" && liveKitExecutor.isLive && context.machine) {
          const activeInstance = getActiveInstance(context.machine.instance);
          await createTurn(activeInstance.id, "[voice input]");
          console.log("[DemoAgent] Created turn for voice input");
        }
      });
      session.on(voice.AgentSessionEventTypes.Error, (ev) => {
        console.error(`[DemoAgent] Error:`, ev.error);
      });
    };

    // Attach initial event handlers
    attachVoiceSessionHandlers(voiceSession);

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

    // Stream realtime audio transcript deltas over LiveKit to the UI.
    // Convex remains the durable source of truth: we upsert an envelope (empty content)
    // and later patch it when the final assistant message is enqueued via LiveKitExecutor.
    const transcriptTextEncoder = new TextEncoder();
    let transcriptPublishChain: Promise<void> = Promise.resolve();
    const publishTranscriptPacket = (packet: unknown) => {
      const lp = ctx.room.localParticipant;
      if (!lp) return;
      const bytes = transcriptTextEncoder.encode(JSON.stringify(packet));
      transcriptPublishChain = transcriptPublishChain
        .then(() => lp.publishData(bytes, { reliable: true, topic: STREAM_TOPIC }))
        .catch((err) => {
          console.warn("[DemoAgent] Failed to publish transcript stream packet:", err);
        });
    };

    const activeTranscriptStreams = new Map<
      string,
      { turnId: string; seq: number; source: "audio_transcript" | "text" }
    >();
    const envelopePersistTasks = new Map<string, Promise<void>>();
    const persistTranscriptEnvelopeOnce = (messageId: string, turnId: Id<"machineTurns"> | null | undefined) => {
      const existing = envelopePersistTasks.get(messageId);
      if (existing) return existing;
      const task = (async () => {
        try {
          await convex.mutation(api.messages.add, {
            sessionId,
            role: "assistant",
            content: "",
            ...(turnId ? { turnId } : {}),
            mode: "voice",
            idempotencyKey: messageId,
            streamState: "streaming",
            streamSeq: 0,
          });
        } catch (err) {
          console.warn("[DemoAgent] Failed to persist transcript envelope:", err);
        }
      })();
      envelopePersistTasks.set(messageId, task);
      return task;
    };

    // User message envelopes: reserve ordering position in Convex before the transcript is known.
    // We listen for input_audio_buffer.speech_started (fires when user BEGINS speaking) which
    // is seconds before any response, eliminating the race between user and assistant envelopes.
    const pendingUserMessageKeys: string[] = [];
    const userEnvelopePersistTasks = new Map<string, Promise<void>>();
    const persistUserEnvelopeOnce = (envelopeId: string, turnId: Id<"machineTurns"> | null | undefined) => {
      const existing = userEnvelopePersistTasks.get(envelopeId);
      if (existing) return existing;
      const task = (async () => {
        try {
          await convex.mutation(api.messages.add, {
            sessionId,
            role: "user",
            content: "",
            ...(turnId ? { turnId } : {}),
            mode: "voice",
            idempotencyKey: envelopeId,
            streamState: "streaming",
            streamSeq: 0,
          });
        } catch (err) {
          console.warn("[DemoAgent] Failed to persist user envelope:", err);
        }
      })();
      userEnvelopePersistTasks.set(envelopeId, task);
      return task;
    };

    let realtimeSession = agent._agentActivity?.realtimeLLMSession as any;
    const onOpenAIServerEvent = (event: any) => {
      if (!event || typeof event !== "object") return;

      const type = event.type as string | undefined;
      if (!type) return;

      // User message envelope: speech_started fires when user BEGINS speaking,
      // well before any response events — gives the Convex mutation plenty of time.
      // Push to queue immediately so onMessageEnqueue can match it to the transcript.
      if (type === "input_audio_buffer.speech_started") {
        const envelopeId = crypto.randomUUID();
        pendingUserMessageKeys.push(envelopeId);
        persistUserEnvelopeOnce(envelopeId, context.currentTurnId);
        return;
      }

      const isAudioTranscriptDelta =
        type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta";
      const isTextDelta =
        type === "response.output_text.delta" || type === "response.text.delta";

      // Check streaming preference on each event so mid-session toggles take effect.
      const streamingControls = context.machine?.instance?.packStates?.agentControls as AgentControlsState | undefined;
      const isStreamingEnabled = streamingControls?.enableStreaming ?? false;

      if (isAudioTranscriptDelta || isTextDelta) {
        // When streaming is disabled, skip incremental packets and envelopes.
        // The complete message will arrive via LiveKitExecutor → onMessageEnqueue.
        if (!isStreamingEnabled) return;

        const messageId = event.item_id as unknown;
        const delta = event.delta as unknown;
        const contentIndex = event.content_index as unknown;

        if (typeof messageId !== "string" || typeof delta !== "string") return;

        let stream = activeTranscriptStreams.get(messageId);
        if (!stream) {
          const turnId = context.currentTurnId ? String(context.currentTurnId) : "";
          stream = { turnId, seq: 0, source: isAudioTranscriptDelta ? "audio_transcript" : "text" };
          activeTranscriptStreams.set(messageId, stream);

          // Best-effort: insert envelope so Convex/UI has a stable message row immediately.
          persistTranscriptEnvelopeOnce(messageId, context.currentTurnId);

          publishTranscriptPacket({
            v: 1,
            t: "mm.stream",
            turnId,
            event: { type: "message_start", messageId, seq: 0 },
          });
        }

        // Avoid double-streaming if the server emits both text deltas and audio transcript deltas.
        if (stream.source === "audio_transcript" && isTextDelta) return;
        if (stream.source === "text" && isAudioTranscriptDelta) return;

        const nextSeq = stream.seq + 1;
        stream.seq = nextSeq;

        publishTranscriptPacket({
          v: 1,
          t: "mm.stream",
          turnId: stream.turnId,
          event: {
            type: "message_update",
            messageId,
            seq: nextSeq,
            delta: {
              kind: "text",
              contentIndex: typeof contentIndex === "number" ? contentIndex : 0,
              delta,
            },
          },
        });
        return;
      }

      if (type === "response.output_item.done") {
        const item = event.item as any;
        if (!item || item.type !== "message" || item.role !== "assistant" || typeof item.id !== "string") {
          return;
        }

        const messageId = item.id;
        const stream = activeTranscriptStreams.get(messageId);
        if (stream) {
          activeTranscriptStreams.delete(messageId);
        }

        // Only emit message_end if we were actively streaming this message.
        if (!stream || !isStreamingEnabled) return;

        const nextSeq = stream.seq + 1;
        stream.seq = nextSeq;

        publishTranscriptPacket({
          v: 1,
          t: "mm.stream",
          turnId: stream.turnId,
          event: { type: "message_end", messageId, seq: nextSeq },
        });
        return;
      }

      if (type === "error") {
        // Fail closed: mark all active transcript streams as errored.
        const message = (event.error && typeof event.error.message === "string")
          ? event.error.message
          : "Realtime error";
        for (const [messageId, stream] of activeTranscriptStreams) {
          const nextSeq = stream.seq + 1;
          stream.seq = nextSeq;
          publishTranscriptPacket({
            v: 1,
            t: "mm.stream",
            turnId: stream.turnId,
            event: { type: "message_error", messageId, seq: nextSeq, error: { message } },
          });
        }
        activeTranscriptStreams.clear();
      }
    };

    // Helper: attach onOpenAIServerEvent to the current realtime session
    const attachRealtimeHandler = () => {
      realtimeSession = agent._agentActivity?.realtimeLLMSession as any;
      if (ENABLE_REALTIME && realtimeSession && typeof realtimeSession.on === "function") {
        realtimeSession.on("openai_server_event_received", onOpenAIServerEvent);
        console.log("[DemoAgent] Attached realtime transcript streaming handler");
      } else if (ENABLE_REALTIME) {
        console.warn("[DemoAgent] Realtime session not available for transcript streaming");
      }
    };

    attachRealtimeHandler();

    // Start camera frame sampling (1 fps) and feed frames into the realtime chat context.
    // This is a demo-only implementation (no adaptive sampling).
    visionSampler = attachVisionSampler({
      room: ctx.room,
      agent,
      getMachine: () => context.machine,
      config: { activeFps: 1, idleFps: 1 / 3, maxDimension: 1024, jpegQuality: 92, detail: "low" },
    });

    // Graceful shutdown handling
    let isShuttingDown = false;

    const cleanup = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log("[DemoAgent] Shutting down...");

      if (ENABLE_REALTIME && realtimeSession && typeof realtimeSession.off === "function") {
        try {
          realtimeSession.off("openai_server_event_received", onOpenAIServerEvent);
        } catch (e) {
          console.warn("[DemoAgent] Failed to detach realtime transcript streaming handler:", e);
        }
      }

      // Stop camera sampling
      try {
        await visionSampler?.stop();
      } catch (e) {
        console.error("[DemoAgent] Error stopping vision sampler:", e);
      }

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

    // ── Voice session reconnection on page refresh ──
    // When a user refreshes the page, their old participant disconnects and a new
    // one joins.  The SDK's RoomIO calls _closeSoon() (closeOnDisconnect=true by
    // default) which permanently tears down the voice session.  We detect the
    // reconnection and spin up a fresh voice session + executor connection.

    let userParticipantIdentity: string | null = null;
    let awaitingVoiceReconnect = false;

    // Seed initial identity from participants already in the room
    for (const p of ctx.room.remoteParticipants.values()) {
      if (!userParticipantIdentity) {
        userParticipantIdentity = p.identity;
      }
    }

    const restartVoiceSession = async () => {
      console.log("[DemoAgent] Restarting voice session for reconnected participant...");

      // Clean up old session
      try {
        if (realtimeSession && typeof realtimeSession.off === "function") {
          realtimeSession.off("openai_server_event_received", onOpenAIServerEvent);
        }
        voiceSession.removeAllListeners();
      } catch (e) {
        console.warn("[DemoAgent] Old voice session cleanup error:", e);
      }

      // Create, configure, and start new session
      const newSession = createVoiceSession();
      attachVoiceSessionHandlers(newSession);
      await newSession.start({ agent, room: ctx.room });

      // Reconnect executor to the new session
      await liveKitExecutor.connect(context.machine!, {
        session: newSession,
        agent,
        room: ctx.room,
      });

      // Update mutable references
      voiceSession = newSession;
      attachRealtimeHandler();

      // Sync live mode from current pack state
      const controls = context.machine?.instance?.packStates?.agentControls as AgentControlsState | undefined;
      liveKitExecutor.setLive(controls?.voiceEnabled ?? false);

      console.log("[DemoAgent] Voice session restarted successfully");
    };

    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === userParticipantIdentity) {
        console.log(`[DemoAgent] User participant disconnected: ${participant.identity} — awaiting reconnect`);
        awaitingVoiceReconnect = true;
      }
    });

    ctx.room.on(RoomEvent.ParticipantConnected, async (participant) => {
      // Track the first remote (user) participant
      if (!userParticipantIdentity) {
        userParticipantIdentity = participant.identity;
      }

      if (awaitingVoiceReconnect) {
        awaitingVoiceReconnect = false;
        userParticipantIdentity = participant.identity;
        console.log(`[DemoAgent] User participant reconnected: ${participant.identity} — restarting voice session`);
        try {
          await restartVoiceSession();
        } catch (err) {
          console.error("[DemoAgent] Failed to restart voice session:", err);
        }
      }
    });

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
          const { commandName, input, clientId } = JSON.parse(payload) as {
            commandName: string;
            input: Record<string, unknown>;
            clientId?: string;
          };

          // Execute command directly (runCommand enqueues the command message for history)
          const { machine: updatedMachine, result } = await runCommand(
            context.machine,
            commandName,
            input,
            { clientId },
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

        const textEncoder = new TextEncoder();
        let publishChain: Promise<void> = Promise.resolve();

        const publishStreamPacket = (packet: unknown) => {
          const lp = ctx.room.localParticipant;
          if (!lp) return;
          const bytes = textEncoder.encode(JSON.stringify(packet));
          publishChain = publishChain
            .then(() => lp.publishData(bytes, { reliable: true, topic: STREAM_TOPIC }))
            .catch((err) => {
              console.warn("[DemoAgent] Failed to publish stream packet:", err);
            });
        };

        const onMessageStream = (event: MessageStreamEvent<unknown>) => {
          // Only stream primary leaf output to the UI.
          if (event.source?.isPrimary === false) return;

          if (event.type === "message_update" && event.delta.kind !== "text") {
            return; // ignore non-text deltas for terminal UI
          }

          publishStreamPacket({
            v: 1,
            t: "mm.stream",
            turnId: turnIdForThisTurn,
            event:
              event.type === "message_update"
                ? {
                  type: event.type,
                  messageId: event.messageId,
                  seq: event.seq,
                  delta: event.delta,
                }
                : event.type === "message_error"
                  ? {
                    type: event.type,
                    messageId: event.messageId,
                    seq: event.seq,
                    error: event.error,
                  }
                  : {
                    type: event.type,
                    messageId: event.messageId,
                    seq: event.seq,
                  },
          });
        };

        const agentControls = context.machine.instance.packStates?.agentControls as AgentControlsState | undefined;
        const streamWhenAvailable = agentControls?.enableStreaming ?? true;
        for await (const step of runMachine(context.machine, { streamWhenAvailable, onMessageStream })) {
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

          // Sync live mode from pack state after each step
          const stepControls = step.instance.packStates?.agentControls as AgentControlsState | undefined;
          const stepVoiceEnabled = stepControls?.voiceEnabled ?? false;
          if (liveKitExecutor.isLive !== stepVoiceEnabled) {
            liveKitExecutor.setLive(stepVoiceEnabled);
            console.log(`[DemoAgent] Synced live mode from pack state: ${stepVoiceEnabled}`);
          }

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

      // Sync live mode from new machine's pack state
      const ttControls = newMachine.instance.packStates?.agentControls as AgentControlsState | undefined;
      liveKitExecutor.setLive(ttControls?.voiceEnabled ?? false);

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
