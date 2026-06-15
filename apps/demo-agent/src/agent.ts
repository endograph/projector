import {
  WorkerOptions,
  cli,
  defineAgent,
  type JobContext,
  voice,
} from "@livekit/agents";
import { ParticipantKind, RoomEvent, type RemoteParticipant } from "@livekit/rtc-node";
import { openai as aiSdkOpenAI } from "@ai-sdk/openai";
import * as openai from "@livekit/agents-plugin-openai";
import { LiveKitExecutor } from "@projectors/livekit-executor";
import type { LiveKitAgentLike, LiveKitRoomLike, LiveKitSessionLike } from "@projectors/livekit-executor";
import { AiSdkExecutor } from "@projectors/aisdk-executor";
import { ConvexClient } from "convex/browser";
import { fileURLToPath } from "node:url";
import {
  SYNTHETIC_ROOT_RUNTIME_ID,
  createMachine,
  createRoot,
  encodeRuntimeAddress,
  runMachine,
  type Executor,
  type Frame,
  syncMachineRuntime,
} from "@projectors/core";
import {
  createDemoCharter,
  getAgentControlsState,
  hydrateDemoInstance,
  serializeDemoInstance,
  type DemoMessage,
} from "./projector-demo.js";

const demoApiModule = "@projectors/demo/convex/_generated/api.js";
const { api } = (await import(demoApiModule)) as any;

const AGENT_NAME = "demo-agent";
const ENABLE_REALTIME = process.env.ENABLE_REALTIME_MODEL !== "false";
const DISCRETE_MODEL = process.env.OPENAI_DISCRETE_MODEL ?? "gpt-4o-mini";
const REALTIME_VAD_THRESHOLD = readVadThresholdEnv("OPENAI_REALTIME_VAD_THRESHOLD", 0.65);
const REALTIME_VAD_SILENCE_DURATION_MS = readIntegerEnv("OPENAI_REALTIME_VAD_SILENCE_DURATION_MS", 800);
const REALTIME_VAD_PREFIX_PADDING_MS = readIntegerEnv("OPENAI_REALTIME_VAD_PREFIX_PADDING_MS", 300);
const REALTIME_INPUT_NOISE_REDUCTION = readRealtimeNoiseReductionEnv(
  "OPENAI_REALTIME_INPUT_NOISE_REDUCTION",
  "near_field",
);
const MESSAGE_TOPIC = "demo.message.v1";
const WORKER_LEASE_TTL_MS = 15_000;
const WORKER_LEASE_HEARTBEAT_MS = 5_000;
const DEBUG_REALTIME_EVENTS = process.env.DEBUG_REALTIME_EVENTS === "true";

type SerializedInstance = Parameters<typeof hydrateDemoInstance>[0];
type Id<TableName extends string> = string & { __tableName: TableName };

type AgentInit = {
  sessionId: Id<"sessions">;
  instance: SerializedInstance;
  instanceFrameId?: Id<"machineFrames">;
  messages: DemoMessage[];
} | null;

type AgentWorkerRoomLeaseSnapshot = {
  roomName: string;
  agentWorkerLeaseToken?: string;
} | null;

class DemoVoiceAgent extends voice.Agent {
  constructor() {
    super({
      instructions: "Initializing projector demo voice agent.",
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log("[demo-agent] entry starting");
    assertEnv("CONVEX_URL");
    assertEnv("OPENAI_API_KEY");

    await ctx.connect();
    const roomName = ctx.room.name;
    if (!roomName) {
      throw new Error("LiveKit room has no name");
    }
    console.log(`[demo-agent] connected to room ${roomName}`);

    const convex = new ConvexClient(process.env.CONVEX_URL!);
    const workerId = `demo-agent:${process.pid}:${crypto.randomUUID()}`;
    const leaseToken = crypto.randomUUID();
    let leaseActive = false;
    let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    let leaseSubscription: { unsubscribe: () => void } | undefined;

    const releaseLease = () => {
      if (leaseSubscription) {
        leaseSubscription.unsubscribe();
        leaseSubscription = undefined;
      }
      if (leaseHeartbeat) {
        clearInterval(leaseHeartbeat);
        leaseHeartbeat = undefined;
      }
      if (!leaseActive) return;
      leaseActive = false;
      void convex.mutation(api.livekitAgent.releaseAgentWorkerLease, {
        roomName,
        leaseToken,
      }).catch((error) => {
        console.warn("[demo-agent] failed to release worker lease", error);
      });
    };

    const stopForLostLease = async () => {
      if (!leaseActive) return;
      console.warn(`[demo-agent] worker lease lost for room ${roomName}; disconnecting`);
      releaseLease();
      await ctx.room.disconnect();
    };

    const renewLease = async (): Promise<boolean> => {
      if (!leaseActive) return false;
      const renewed = await convex.mutation(api.livekitAgent.renewAgentWorkerLease, {
        roomName,
        leaseToken,
        leaseTtlMs: WORKER_LEASE_TTL_MS,
      });
      if (!renewed) {
        await stopForLostLease();
        return false;
      }
      return true;
    };

    const assertLease = async () => {
      if (!leaseActive || !(await renewLease())) {
        throw new Error("Agent worker lease is no longer active");
      }
    };

    const claimedLease = await convex.mutation(api.livekitAgent.claimAgentWorkerLease, {
      roomName,
      workerId,
      leaseToken,
      leaseTtlMs: WORKER_LEASE_TTL_MS,
    });
    if (!claimedLease) {
      console.warn(`[demo-agent] another worker owns room ${roomName}; exiting`);
      await ctx.room.disconnect();
      return;
    }

    leaseActive = true;
    leaseSubscription = convex.onUpdate(
      api.livekitAgent.getAgentWorkerRoom,
      { sessionId: claimedLease.sessionId },
      (room: AgentWorkerRoomLeaseSnapshot) => {
        if (!leaseActive) return;
        if (!room || room.roomName !== roomName || room.agentWorkerLeaseToken !== leaseToken) {
          void stopForLostLease();
        }
      },
      (error) => {
        console.error("[demo-agent] worker lease subscription failed", error);
        void stopForLostLease();
      },
    );
    leaseHeartbeat = setInterval(() => {
      void renewLease().catch((error) => {
        console.error("[demo-agent] failed to renew worker lease", error);
        void stopForLostLease();
      });
    }, WORKER_LEASE_HEARTBEAT_MS);
    ctx.room.once(RoomEvent.Disconnected, releaseLease);
    console.log(`[demo-agent] claimed worker lease ${workerId} for room ${roomName}`);

    try {
      const init = (await convex.query(api.livekitAgent.getAgentInit, { roomName })) as AgentInit;
      if (!init) {
        throw new Error(`No demo session is associated with LiveKit room "${roomName}"`);
      }
      console.log(`[demo-agent] loaded session ${init.sessionId} with ${init.messages.length} messages`);

      let root = hydrateDemoInstance(init.instance);
      let rootInstanceFrameId = init.instanceFrameId;
      const branchFrames = (await convex.query(api.sessions.listBranchFrames, {
        sessionId: init.sessionId,
      })) as Frame[];
      console.log(`[demo-agent] initialized machine with ${branchFrames.length} branch frame(s)`);

      const isLiveMode = (): boolean => getAgentControlsState(root).liveMode;
      const shouldUseRealtime = (): boolean => ENABLE_REALTIME && isLiveMode();
      const shouldStreamText = (): boolean => getAgentControlsState(root).streamingEnabled;

      const addDemoMessage = (args: {
        role: "user" | "assistant";
        content: string;
        frameId?: Id<"machineFrames">;
        mode: "text" | "voice";
        idempotencyKey?: string;
        streamState?: "streaming" | "complete" | "error";
        streamSeq?: number;
      }) => convex.mutation(api.messages.add, {
        sessionId: init.sessionId,
        ...args,
      });
      const persistStreamingMessageUpdate = (
        role: "user" | "assistant",
        mode: "text" | "voice",
        update: {
          messageId: string;
          text: string;
          streamState: "streaming" | "complete" | "error";
          streamSeq: number;
        },
      ) => {
        if (!shouldStreamText()) return;
        return addDemoMessage({
          role,
          content: update.text,
          mode,
          idempotencyKey: `${role}:${update.messageId}`,
          streamState: update.streamState,
          streamSeq: update.streamSeq,
        });
      };
      const agentDiscreteExecutor = new AiSdkExecutor({
        model: aiSdkOpenAI(DISCRETE_MODEL),
        maxOutputTokens: 4096,
        stream: shouldStreamText,
        onStreamUpdate: (update) => persistStreamingMessageUpdate("assistant", "text", update),
      });
      const memoryRuntimeInstanceId = encodeRuntimeAddress({
        type: "member",
        ownerInstanceId: root.id,
        memberPath: ["memory"],
      });
      const memoryExecutor = new AiSdkExecutor({
        model: aiSdkOpenAI(DISCRETE_MODEL),
        maxOutputTokens: 1024,
        maxSteps: 3,
        toolChoice: "required",
      });
      const discreteExecutor: Executor = {
        run: (request) =>
          request.runtimeInstanceId === memoryRuntimeInstanceId
            ? memoryExecutor.run(request)
            : agentDiscreteExecutor.run(request),
      };
      const session = createVoiceSession();
      const agent = new DemoVoiceAgent();
      const liveKitExecutor = new LiveKitExecutor({
        session: session as unknown as LiveKitSessionLike,
        agent: agent as unknown as LiveKitAgentLike,
        room: ctx.room as unknown as LiveKitRoomLike,
        discreteExecutor,
        realtime: { enabled: () => shouldUseRealtime() },
        input: {
          messageTopic: MESSAGE_TOPIC,
          parseDataMessage: (payload) => parseLiveKitTextMessage(payload),
        },
        eventNames: {
          dataReceived: RoomEvent.DataReceived as string,
        },
        onAssistantTranscriptUpdate: (update) =>
          persistStreamingMessageUpdate("assistant", "voice", update),
        onUserTranscriptUpdate: (update) =>
          persistStreamingMessageUpdate("user", "voice", update),
      });
      ctx.room.once(RoomEvent.Disconnected, () => {
        liveKitExecutor.disconnect();
      });
      const syntheticRoot = createRoot([root]);
      const machine = createMachine({
        id: init.sessionId,
        root: syntheticRoot,
        charter: createDemoCharter({ executor: liveKitExecutor }),
        frames: branchFrames,
      });

      const persistFrameMessages = async (
        frame: Frame,
        frameId: Id<"machineFrames">,
      ) => {
        const mode = frameMessageMode(frame);
        for (const message of frame.messages) {
          const text = typeof message.text === "string" ? message.text : "";
          if (message.type === "user" && text.trim()) {
            const streamState = normalizeStreamState(message.streamState);
            await addDemoMessage({
              role: "user",
              content: text,
              frameId,
              mode,
              idempotencyKey: idempotencyKey("user", message),
              ...(streamState ? { streamState } : {}),
              ...(typeof message.streamSeq === "number" ? { streamSeq: message.streamSeq } : {}),
            });
          }

          if (message.type === "assistant" && (text.trim() || hasMessageId(message))) {
            const streamState = normalizeStreamState(message.streamState);
            await addDemoMessage({
              role: "assistant",
              content: text,
              frameId,
              mode,
              idempotencyKey: idempotencyKey("assistant", message),
              ...(streamState ? { streamState } : {}),
              ...(typeof message.streamSeq === "number" ? { streamSeq: message.streamSeq } : {}),
            });
          }
        }
      };

      const persistMachineFrame = async (frame: Frame) => {
        await assertLease();
        const frameId = await convex.mutation(api.sessions.appendMachineFrame, {
          sessionId: init.sessionId,
          frame,
        });
        await persistFrameMessages(frame, frameId);
        return frameId;
      };

      const commitMachineInstance = async (frameId: Id<"machineFrames"> | undefined) => {
        await assertLease();
        const result = await convex.mutation(api.sessions.commitMachineInstance, {
          sessionId: init.sessionId,
          frameId,
          ...(rootInstanceFrameId ? { expectedInstanceFrameId: rootInstanceFrameId } : {}),
          message: { type: "machine.run", trigger: "livekit-host" },
          instance: serializeDemoInstance(root),
        }) as {
          committed?: boolean;
          instance?: SerializedInstance;
          instanceFrameId?: Id<"machineFrames">;
        };

        if (result.committed === false && result.instance) {
          root = hydrateDemoInstance(result.instance);
          syntheticRoot.instances = [root];
          rootInstanceFrameId = result.instanceFrameId;
          machine.frames = (await convex.query(api.sessions.listBranchFrames, {
            sessionId: init.sessionId,
          })) as Frame[];
          console.warn("[demo-agent] skipped stale instance commit and refreshed durable session state");
          return;
        }

        rootInstanceFrameId = result.instanceFrameId ?? frameId ?? rootInstanceFrameId;
      };

      const runMachineHost = async () => {
        for await (const frame of runMachine(machine)) {
          const frameId = await persistMachineFrame(frame);
          await commitMachineInstance(frameId);
          if (!frame.inert) {
            await syncMachineRuntime(machine, {
              runtimeInstanceId: SYNTHETIC_ROOT_RUNTIME_ID,
              visibleFrames: [frame],
            });
          }
        }
      };

      let hostScheduled = false;
      let hostTail: Promise<void> = Promise.resolve();
      const scheduleMachineHost = () => {
        if (hostScheduled) return;
        hostScheduled = true;
        hostTail = hostTail
          .catch(() => undefined)
          .then(async () => {
            hostScheduled = false;
            await runMachineHost();
          })
          .catch((error) => {
            console.error("[demo-agent] machine host failed", error);
          });
      };
      machine.subscribe(scheduleMachineHost);

      let selectedVoiceParticipantIdentity = selectVoiceParticipantIdentity(ctx.room.remoteParticipants.values());
      let appliedRoomIoParticipantIdentity: string | null | undefined;
      const setRoomIoParticipant = (identity: string | null) => {
        selectedVoiceParticipantIdentity = identity;
        const roomIO = (session as unknown as { roomIO?: { setParticipant?: (participantIdentity: string | null) => void } }).roomIO;
        if (!roomIO?.setParticipant) return;
        if (appliedRoomIoParticipantIdentity === identity) return;
        if (identity === null && appliedRoomIoParticipantIdentity === undefined) return;
        appliedRoomIoParticipantIdentity = identity;
        roomIO.setParticipant(identity);
        console.log(`[demo-agent] voice participant ${identity ?? "<auto>"}`);
      };

      // RoomIO must observe participant events before we call its private setParticipant;
      // otherwise its init task can wait forever and never publish the output audio track.
      const deferRoomIoParticipantSync = () => {
        queueMicrotask(() => {
          setRoomIoParticipant(selectVoiceParticipantIdentity(ctx.room.remoteParticipants.values()));
        });
      };

      const handleParticipantConnected = (participant: RemoteParticipant) => {
        if (!isVoiceParticipant(participant)) return;
        deferRoomIoParticipantSync();
      };
      const handleParticipantDisconnected = (participant: RemoteParticipant) => {
        if (participant.identity !== selectedVoiceParticipantIdentity) return;
        deferRoomIoParticipantSync();
      };

      ctx.room.on(RoomEvent.LocalTrackPublished, (publication) => {
        console.log(
          `[demo-agent] local track published sid=${String(publication.sid ?? "<none>")} source=${String(publication.source ?? "<unknown>")}`,
        );
      });
      ctx.room.on(RoomEvent.LocalTrackSubscribed, (track) => {
        console.log(`[demo-agent] local track subscribed sid=${String(track.sid ?? "<none>")}`);
      });
      ctx.room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
      ctx.room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);

      await syncMachineRuntime(machine, {
        runtimeInstanceId: SYNTHETIC_ROOT_RUNTIME_ID,
        visibleFrames: [],
      });

      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
        console.log(`[demo-agent] state ${event.oldState} -> ${event.newState}`);
      });
      session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) => {
        const speechId = readSpeechHandleId(event);
        console.log(`[demo-agent] speech created ${speechId ?? "<unknown>"} source=${event.source}`);
      });
      session.on(voice.AgentSessionEventTypes.Error, (event) => {
        console.error("[demo-agent] LiveKit session error", event.error);
      });

      await session.start({
        agent,
        room: ctx.room,
        inputOptions: {
          closeOnDisconnect: false,
          participantKinds: [ParticipantKind.STANDARD],
          ...(selectedVoiceParticipantIdentity ? { participantIdentity: selectedVoiceParticipantIdentity } : {}),
        },
      });
      setRoomIoParticipant(selectedVoiceParticipantIdentity);
      if (DEBUG_REALTIME_EVENTS) {
        attachRealtimeDebugLogging(agent);
      }

      await syncMachineRuntime(machine, {
        runtimeInstanceId: SYNTHETIC_ROOT_RUNTIME_ID,
        visibleFrames: [],
      });

      scheduleMachineHost();
      console.log(`[demo-agent] voice session started for ${roomName}; liveMode=${isLiveMode()}`);
      console.log(`[demo-agent] connected to ${roomName} with ${liveKitExecutor.connection.inference?.tools.length ?? 0} projected tools`);
    } catch (error) {
      releaseLease();
      throw error;
    }
  },
});

function createVoiceSession(): voice.AgentSession {
  if (!ENABLE_REALTIME) {
    return new voice.AgentSession({
      stt: new openai.STT(),
      llm: new openai.LLM({ model: "gpt-4o-mini" }),
      tts: new openai.TTS({ voice: "alloy" }),
    });
  }

  return new voice.AgentSession({
    llm: new openai.realtime.RealtimeModel({
      model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2",
      voice: process.env.OPENAI_REALTIME_VOICE ?? "alloy",
      inputAudioNoiseReduction: REALTIME_INPUT_NOISE_REDUCTION
        ? { type: REALTIME_INPUT_NOISE_REDUCTION }
        : undefined,
      turnDetection: {
        type: "server_vad",
        threshold: REALTIME_VAD_THRESHOLD,
        prefix_padding_ms: REALTIME_VAD_PREFIX_PADDING_MS,
        silence_duration_ms: REALTIME_VAD_SILENCE_DURATION_MS,
      },
      inputAudioTranscription: {
        model: "whisper-1",
      },
    }),
    // Realtime normally returns audio; TTS is a fallback for text-only realtime responses.
    tts: new openai.TTS({ voice: "alloy" }),
  });
}

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function readVadThresholdEnv(name: string, fallback: number): number {
  const parsed = readNumberEnv(name, fallback);
  if (parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return parsed;
}

function readIntegerEnv(name: string, fallback: number): number {
  const parsed = readNumberEnv(name, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function readRealtimeNoiseReductionEnv(
  name: string,
  fallback: "near_field" | "far_field" | undefined,
): "near_field" | "far_field" | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  if (value === "off" || value === "none" || value === "false") {
    return undefined;
  }
  if (value === "near_field" || value === "far_field") {
    return value;
  }
  throw new Error(`${name} must be near_field, far_field, off, none, or false`);
}

function selectVoiceParticipantIdentity(participants: Iterable<RemoteParticipant>): string | null {
  let selected: string | null = null;
  for (const participant of participants) {
    if (isVoiceParticipant(participant)) {
      selected = participant.identity;
    }
  }
  return selected;
}

function isVoiceParticipant(participant: RemoteParticipant): boolean {
  return participant.kind === ParticipantKind.STANDARD;
}

function frameMessageMode(frame: Frame): "text" | "voice" {
  return frame.metadata?.mode === "voice" ? "voice" : "text";
}

function idempotencyKey(prefix: string, source: unknown): string {
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    const messageId = record.messageId;
    if (typeof messageId === "string" && messageId) return `${prefix}:${messageId}`;
    const createdAt = record.createdAt;
    const text = record.text;
    if (createdAt !== undefined && typeof text === "string") return `${prefix}:${createdAt}:${text}`;
  }
  return `${prefix}:${crypto.randomUUID()}`;
}

function hasMessageId(source: unknown): boolean {
  return Boolean(source && typeof source === "object" && typeof (source as Record<string, unknown>).messageId === "string");
}

function normalizeStreamState(value: unknown): "streaming" | "complete" | "error" | undefined {
  return value === "streaming" || value === "complete" || value === "error" ? value : undefined;
}

function readSpeechHandleId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const speechHandle = (event as Record<string, unknown>).speechHandle;
  if (!speechHandle || typeof speechHandle !== "object") return undefined;
  const id = (speechHandle as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function attachRealtimeDebugLogging(agent: DemoVoiceAgent): void {
  const realtimeSession = (
    agent as unknown as {
      _agentActivity?: {
        realtimeLLMSession?: {
          on?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
      };
    }
  )._agentActivity?.realtimeLLMSession;
  if (!realtimeSession?.on) {
    console.log("[demo-agent] realtime debug logging skipped; no realtime session");
    return;
  }

  realtimeSession.on("generation_created", (event) => {
    const record = asRecord(event);
    console.log(
      `[demo-agent] realtime generation_created responseId=${String(record.responseId ?? "<none>")} userInitiated=${String(record.userInitiated ?? "<unknown>")}`,
    );
  });
  realtimeSession.on("input_audio_transcription_completed", (event) => {
    const record = asRecord(event);
    const transcript = typeof record.transcript === "string" ? record.transcript : "";
    console.log(
      `[demo-agent] realtime input_audio_transcription_completed itemId=${String(record.itemId ?? "<none>")} chars=${transcript.length}`,
    );
  });
  realtimeSession.on("metrics_collected", (metrics) => {
    const record = asRecord(metrics);
    const type = typeof record.type === "string" ? record.type : metrics?.constructor?.name;
    console.log(`[demo-agent] realtime metrics_collected type=${type ?? "<unknown>"}`);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function assertEnv(name: string): void {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
}

function parseLiveKitTextMessage(payload: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { content?: unknown };
    return typeof parsed.content === "string" && parsed.content.trim() ? parsed.content.trim() : undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: AGENT_NAME,
    }),
  );
}
