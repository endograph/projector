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
  ROOT_RUNTIME_INSTANCE_ID,
  createMachine,
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
  type CameraSensorImage,
  type DemoMessage,
} from "./projector-demo.js";
import { attachCameraSampler, type CameraSamplerHandle } from "./vision.js";

const demoApiModule = "@projectors/demo/convex/_generated/api.js";
const { api } = (await import(demoApiModule)) as any;

const AGENT_NAME = "demo-agent";
const ENABLE_REALTIME = process.env.ENABLE_REALTIME_MODEL !== "false";
const DISCRETE_MODEL = process.env.OPENAI_DISCRETE_MODEL ?? "gpt-5.5";
const OPENAI_NO_REASONING_OPTIONS = { openai: { reasoningEffort: "none" } } as const;
const REALTIME_VAD_THRESHOLD = readVadThresholdEnv("OPENAI_REALTIME_VAD_THRESHOLD", 0.65);
const REALTIME_VAD_SILENCE_DURATION_MS = readIntegerEnv("OPENAI_REALTIME_VAD_SILENCE_DURATION_MS", 800);
const REALTIME_VAD_PREFIX_PADDING_MS = readIntegerEnv("OPENAI_REALTIME_VAD_PREFIX_PADDING_MS", 300);
const REALTIME_INTERRUPT_RESPONSE = readBooleanEnv("OPENAI_REALTIME_INTERRUPT_RESPONSE", true);
const REALTIME_MAX_RESPONSE_OUTPUT_TOKENS = readRealtimeMaxOutputTokensEnv(
  "OPENAI_REALTIME_MAX_RESPONSE_OUTPUT_TOKENS",
  "inf",
);
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
  headFrameId: Id<"frames">;
  instance: SerializedInstance;
  instanceFrameId?: Id<"frames">;
  messages: DemoMessage[];
} | null;

type AgentWorkerRoomLeaseSnapshot = {
  roomName: string;
  agentWorkerLeaseToken?: string;
} | null;

type StaleHeadErrorData = {
  code: "stale_head";
  expectedHeadFrameId?: Id<"frames">;
  headFrameId?: Id<"frames">;
};

type RealtimeModelOptions = ConstructorParameters<typeof openai.realtime.RealtimeModel>[0] & {
  maxResponseOutputTokens?: number | "inf";
};

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
    let latestCameraImage: CameraSensorImage | undefined;
    let cameraSampler: CameraSamplerHandle | undefined;
    const cameraSensor = {
      latestImage: () => latestCameraImage,
    };
    const stopCameraSampler = async () => {
      const sampler = cameraSampler;
      cameraSampler = undefined;
      latestCameraImage = undefined;
      if (sampler) {
        await sampler.stop();
      }
    };

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
      let durableHeadFrameId = init.headFrameId;
      const contextFrames = (await convex.query(api.sessions.listMachineContextFrames, {
        sessionId: init.sessionId,
      })) as Frame[];
      console.log(`[demo-agent] initialized machine with ${contextFrames.length} context frame(s)`);

      const isLiveMode = (): boolean => getAgentControlsState(root).liveMode;
      const shouldUseRealtime = (): boolean => ENABLE_REALTIME && isLiveMode();
      const shouldStreamText = (): boolean => getAgentControlsState(root).streamingEnabled;

      const addDemoMessage = (args: {
        role: "user" | "assistant";
        content: string;
        frameId?: Id<"frames">;
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
        providerOptions: OPENAI_NO_REASONING_OPTIONS,
        onStreamUpdate: (update) => persistStreamingMessageUpdate("assistant", "text", update),
      });
      const memoryExecutor = new AiSdkExecutor({
        model: aiSdkOpenAI(DISCRETE_MODEL),
        maxOutputTokens: 1024,
        maxSteps: 3,
        providerOptions: OPENAI_NO_REASONING_OPTIONS,
      });
      const isMemoryRequest = (request: { inference: { tools: Array<{ name: string }> } }) =>
        request.inference.tools.some((tool) => tool.name === "saveMemories");
      const discreteExecutor: Executor = {
        run: (request) =>
          isMemoryRequest(request)
            ? memoryExecutor.run(request)
            : agentDiscreteExecutor.run(request),
        realizePrompt: (request) =>
          isMemoryRequest(request)
            ? memoryExecutor.realizePrompt(request)
            : agentDiscreteExecutor.realizePrompt(request),
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
        void stopCameraSampler().catch((error) => {
          console.warn("[demo-agent] failed to stop camera sampler", error);
        });
      });
      const createDemoMachine = (frames: Frame[]) =>
        createMachine({
          id: init.sessionId,
          root,
          charter: createDemoCharter({ executor: liveKitExecutor, cameraSensor }),
          frames,
        });
      let machine = createDemoMachine(contextFrames);
      let unsubscribeMachine: (() => void) | undefined;

      const persistFrameMessages = async (
        frame: Frame,
        frameId: Id<"frames">,
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

      const refreshDurableMachineState = async (reason: string) => {
        const refreshed = (await convex.query(api.livekitAgent.getAgentInit, { roomName })) as AgentInit;
        if (!refreshed) {
          throw new Error(`No demo session is associated with LiveKit room "${roomName}"`);
        }

        root = hydrateDemoInstance(refreshed.instance);
        rootInstanceFrameId = refreshed.instanceFrameId;
        durableHeadFrameId = refreshed.headFrameId;
        const refreshedFrames = (await convex.query(api.sessions.listMachineContextFrames, {
          sessionId: init.sessionId,
        })) as Frame[];

        unsubscribeMachine?.();
        machine = createDemoMachine(refreshedFrames);
        unsubscribeMachine = machine.subscribe(scheduleMachineHost);
        await syncMachineRuntime(machine, {
          runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
          visibleFrames: [],
        });
        console.warn(`[demo-agent] refreshed durable session state after ${reason}`);
      };

      const persistMachineFrame = async (frame: Frame): Promise<Id<"frames"> | undefined> => {
        await assertLease();
        let frameId: Id<"frames">;
        try {
          frameId = await convex.mutation(api.sessions.appendMachineFrame, {
            sessionId: init.sessionId,
            expectedHeadFrameId: durableHeadFrameId,
            frame,
          });
        } catch (error) {
          if (!isStaleHeadError(error)) {
            throw error;
          }
          await refreshDurableMachineState("stale head");
          return undefined;
        }
        durableHeadFrameId = frameId;
        await persistFrameMessages(frame, frameId);
        return frameId;
      };

      const commitMachineInstance = async (frameId: Id<"frames"> | undefined) => {
        await assertLease();
        const result = await convex.mutation(api.sessions.commitMachineInstance, {
          sessionId: init.sessionId,
          frameId,
          ...(rootInstanceFrameId ? { expectedInstanceFrameId: rootInstanceFrameId } : {}),
          message: { type: "machine.run", trigger: "livekit-host" },
          instance: serializeDemoInstance(root),
        }) as {
          committed?: boolean;
          headFrameId?: Id<"frames">;
          instance?: SerializedInstance;
          instanceFrameId?: Id<"frames">;
        };

        if (result.committed === false && result.instance) {
          root = hydrateDemoInstance(result.instance);
          machine.root = root;
          durableHeadFrameId = result.headFrameId ?? durableHeadFrameId;
          rootInstanceFrameId = result.instanceFrameId;
          machine.frames = (await convex.query(api.sessions.listMachineContextFrames, {
            sessionId: init.sessionId,
          })) as Frame[];
          console.warn("[demo-agent] skipped stale instance commit and refreshed durable session state");
          return;
        }

        durableHeadFrameId = result.headFrameId ?? durableHeadFrameId;
        rootInstanceFrameId = result.instanceFrameId ?? frameId ?? rootInstanceFrameId;
      };

      const runMachineHost = async () => {
        for await (const frame of runMachine(machine)) {
          const frameId = await persistMachineFrame(frame);
          if (!frameId) return;
          await commitMachineInstance(frameId);
          if (!frame.inert) {
            await syncMachineRuntime(machine, {
              runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
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
      unsubscribeMachine = machine.subscribe(scheduleMachineHost);

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
        runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
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

      cameraSampler = attachCameraSampler({
        room: ctx.room,
        onImage: (image) => {
          latestCameraImage = image;
          void syncMachineRuntime(machine, {
            runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
            visibleFrames: [],
          }).catch((error) => {
            console.warn("[demo-agent] failed to sync camera sensor", error);
          });
        },
      });

      await syncMachineRuntime(machine, {
        runtimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
        visibleFrames: [],
      });

      scheduleMachineHost();
      console.log(`[demo-agent] voice session started for ${roomName}; liveMode=${isLiveMode()}`);
      console.log(`[demo-agent] connected to ${roomName} with ${liveKitExecutor.connection.inference?.tools.length ?? 0} projected tools`);
    } catch (error) {
      await stopCameraSampler().catch((stopError) => {
        console.warn("[demo-agent] failed to stop camera sampler", stopError);
      });
      releaseLease();
      throw error;
    }
  },
});

function createVoiceSession(): voice.AgentSession {
  if (!ENABLE_REALTIME) {
    return new voice.AgentSession({
      stt: new openai.STT(),
      llm: new openai.LLM({ model: DISCRETE_MODEL }),
      tts: new openai.TTS({ voice: "alloy" }),
    });
  }

  const realtimeModelOptions: RealtimeModelOptions = {
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
      interrupt_response: REALTIME_INTERRUPT_RESPONSE,
    },
    inputAudioTranscription: {
      model: "whisper-1",
    },
    maxResponseOutputTokens: REALTIME_MAX_RESPONSE_OUTPUT_TOKENS,
  };

  return new voice.AgentSession({
    llm: new openai.realtime.RealtimeModel(realtimeModelOptions),
    // Realtime normally returns audio; TTS is a fallback for text-only realtime responses.
    tts: new openai.TTS({ voice: "alloy" }),
  });
}

function isStaleHeadError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const data = (error as { data?: unknown }).data;
  if (isStaleHeadErrorData(data)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("stale_head");
}

function isStaleHeadErrorData(data: unknown): data is StaleHeadErrorData {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { code?: unknown }).code === "stale_head"
  );
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

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function readRealtimeMaxOutputTokensEnv(name: string, fallback: number | "inf"): number | "inf" {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "inf" || value === "infinity") return "inf";
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, inf, or infinity`);
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
  realtimeSession.on("input_speech_started", () => {
    console.warn("[demo-agent] realtime input_speech_started");
  });
  realtimeSession.on("input_speech_stopped", (event) => {
    const record = asRecord(event);
    console.warn(
      `[demo-agent] realtime input_speech_stopped userTranscriptionEnabled=${String(record.userTranscriptionEnabled ?? "<unknown>")}`,
    );
  });
  realtimeSession.on("input_audio_transcription_completed", (event) => {
    const record = asRecord(event);
    const transcript = typeof record.transcript === "string" ? record.transcript : "";
    console.log(
      `[demo-agent] realtime input_audio_transcription_completed itemId=${String(record.itemId ?? "<none>")} chars=${transcript.length}`,
    );
  });
  realtimeSession.on("openai_client_event_queued", (event) => {
    const summary = summarizeRealtimeClientEvent(event);
    if (summary) console.log(`[demo-agent] openai client ${summary}`);
  });
  realtimeSession.on("openai_server_event_received", (event) => {
    const summary = summarizeRealtimeServerEvent(event);
    if (summary) console.log(`[demo-agent] openai server ${summary}`);
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

function summarizeRealtimeClientEvent(event: unknown): string | undefined {
  const record = asRecord(event);
  const type = typeof record.type === "string" ? record.type : undefined;
  if (!type) return undefined;
  if (type === "session.update") {
    const session = asRecord(record.session);
    return `${type} max_output_tokens=${String(session.max_output_tokens ?? session.max_response_output_tokens ?? "<unset>")} interrupt_response=${readNestedValue(session, ["audio", "input", "turn_detection", "interrupt_response"])}`;
  }
  if (
    type === "response.cancel" ||
    type === "conversation.item.truncate" ||
    type === "response.create"
  ) {
    return `${type} ${formatRecordSummary(record, ["item_id", "response_id", "audio_end_ms"])}`;
  }
  return undefined;
}

function summarizeRealtimeServerEvent(event: unknown): string | undefined {
  const record = asRecord(event);
  const type = typeof record.type === "string" ? record.type : undefined;
  if (!type) return undefined;

  if (type === "response.done") {
    const response = asRecord(record.response);
    return `${type} id=${String(response.id ?? "<none>")} status=${String(response.status ?? "<unknown>")} status_details=${safeJson(response.status_details)} usage=${safeJson(response.usage)} output=${summarizeRealtimeOutput(response.output)}`;
  }

  if (
    type === "input_audio_buffer.speech_started" ||
    type === "input_audio_buffer.speech_stopped" ||
    type === "conversation.item.truncated" ||
    type === "response.audio_transcript.done" ||
    type === "response.output_audio_transcript.done" ||
    type === "response.audio.done" ||
    type === "response.output_audio.done" ||
    type === "response.output_item.done" ||
    type === "error"
  ) {
    return `${type} ${formatRecordSummary(record, ["item_id", "response_id", "audio_end_ms", "error"])}`;
  }

  if (
    type === "response.audio_transcript.delta" ||
    type === "response.output_audio_transcript.delta" ||
    type === "response.text.delta" ||
    type === "response.output_text.delta"
  ) {
    const delta = typeof record.delta === "string" ? record.delta : "";
    return `${type} response_id=${String(record.response_id ?? "<none>")} item_id=${String(record.item_id ?? "<none>")} chars=${delta.length}`;
  }

  return undefined;
}

function summarizeRealtimeOutput(output: unknown): string {
  if (!Array.isArray(output)) return "<none>";
  return output
    .map((item) => {
      const record = asRecord(item);
      const content = Array.isArray(record.content) ? record.content : [];
      const chars = content.reduce((sum, part) => {
        const partRecord = asRecord(part);
        const text =
          typeof partRecord.text === "string"
            ? partRecord.text
            : typeof partRecord.transcript === "string"
              ? partRecord.transcript
              : "";
        return sum + text.length;
      }, 0);
      return `${String(record.type ?? "<type>")}:${String(record.role ?? record.name ?? "<role>")}:chars=${chars}`;
    })
    .join(",");
}

function formatRecordSummary(record: Record<string, unknown>, keys: string[]): string {
  return keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${key}=${safeJson(record[key])}`)
    .join(" ");
}

function readNestedValue(record: Record<string, unknown>, path: string[]): string {
  let value: unknown = record;
  for (const key of path) {
    value = asRecord(value)[key];
  }
  return value === undefined ? "<unset>" : String(value);
}

function safeJson(value: unknown): string {
  if (value === undefined) return "<unset>";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
