import { llm, type voice } from "@livekit/agents";
import {
  RoomEvent,
  TrackKind,
  TrackSource,
  VideoBufferType,
  VideoStream,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  type TrackPublication,
  type VideoFrameEvent,
  type VideoFrame,
} from "@livekit/rtc-node";
import sharp from "sharp";
import type { ImageDetail, Machine } from "markov-machines";
import { ephemeralMessage, instanceMessage } from "markov-machines";
import { agentControlsPack } from "./packs/agent-controls.js";

export interface VisionSamplerConfig {
  /** Frames per second while user is speaking */
  activeFps?: number;
  /** Frames per second while user is not speaking */
  idleFps?: number;
  /**
   * Fixed sampling rate (deprecated). If provided, overrides activeFps/idleFps.
   */
  fps?: number;
  maxDimension?: number;
  jpegQuality?: number;
  detail?: ImageDetail;
}

export interface VisionSamplerHandle {
  stop: () => Promise<void>;
  setMode: (mode: "active" | "idle") => void;
}

function isUserParticipant(participant: { identity: string }): boolean {
  return participant.identity.startsWith("user-");
}

function isCameraVideoPublication(publication: TrackPublication): boolean {
  return (
    publication.kind === TrackKind.KIND_VIDEO &&
    publication.source === TrackSource.SOURCE_CAMERA
  );
}

async function encodeFrameAsJpegBase64(
  frame: VideoFrame,
  options: { maxDimension: number; jpegQuality: number }
): Promise<{ base64: string; mimeType: "image/jpeg"; dataUrl: string }> {
  const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);

  const maxDim = options.maxDimension;
  const scale = Math.min(1, maxDim / Math.max(rgba.width, rgba.height));
  const targetWidth = Math.max(1, Math.round(rgba.width * scale));
  const targetHeight = Math.max(1, Math.round(rgba.height * scale));

  let pipeline = sharp(rgba.data, {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  });

  if (scale < 1) {
    pipeline = pipeline.resize(targetWidth, targetHeight, { fit: "inside" });
  }

  const jpeg = await pipeline.jpeg({ quality: options.jpegQuality }).toBuffer();
  const base64 = jpeg.toString("base64");
  return { base64, mimeType: "image/jpeg", dataUrl: `data:image/jpeg;base64,${base64}` };
}

export function attachVisionSampler({
  room,
  agent,
  getMachine,
  config,
}: {
  room: Room;
  agent: voice.Agent;
  getMachine: () => Machine<any> | null;
  config?: VisionSamplerConfig;
}): VisionSamplerHandle {
  const activeFps = config?.fps ?? config?.activeFps ?? 1;
  const idleFps = config?.fps ?? config?.idleFps ?? 1 / 3;
  const maxDimension = config?.maxDimension ?? 1024;
  const jpegQuality = config?.jpegQuality ?? 92;
  const detail: ImageDetail = config?.detail ?? "low";

  let activeCameraTrackSid: string | null = null;
  let activeCameraParticipantIdentity: string | null = null;

  let frameReader: ReadableStreamDefaultReader<VideoFrameEvent> | null = null;
  let latestFrame: VideoFrame | null = null;

  let samplingTimer: ReturnType<typeof setInterval> | null = null;
  let pushInProgress = false;
  let stopped = false;
  let mode: "active" | "idle" = "idle";

  const setCameraEnabledInPack = (enabled: boolean) => {
    const machine = getMachine();
    if (!machine) return;
    machine.enqueue([
      instanceMessage({
        kind: "packState",
        packName: agentControlsPack.name,
        patch: { cameraEnabled: enabled },
      }),
    ]);
  };

  const stopTimer = () => {
    if (samplingTimer) {
      clearInterval(samplingTimer);
      samplingTimer = null;
    }
  };

  const startTimer = () => {
    stopTimer();
    const fps = mode === "active" ? activeFps : idleFps;
    const intervalMs = Math.max(1, Math.round(1000 / Math.max(0.001, fps)));
    samplingTimer = setInterval(() => {
      void pushLatestFrameToContexts();
    }, intervalMs);
  };

  const stopSampling = async () => {
    const hadActiveTrack = !!activeCameraTrackSid;
    stopTimer();

    latestFrame = null;

    if (frameReader) {
      try {
        await frameReader.cancel();
      } catch {
        // ignore
      }
      try {
        frameReader.releaseLock();
      } catch {
        // ignore
      }
      frameReader = null;
    }

    activeCameraTrackSid = null;
    activeCameraParticipantIdentity = null;

    // Remove any previous camera frame messages from the chat context
    try {
      const rtSession = agent._agentActivity?.realtimeLLMSession;
      if (rtSession) {
        const chatCtx = rtSession.chatCtx.copy();
        chatCtx.items = chatCtx.items.filter(
          (item) => !(item.type === "message" && item.id.startsWith("camera_frame_")),
        );
        await rtSession.updateChatCtx(chatCtx);
      }
    } catch {
      // ignore
    }

    if (hadActiveTrack) {
      setCameraEnabledInPack(false);
    }
  };

  const pushLatestFrameToContexts = async () => {
    if (pushInProgress || stopped) return;
    if (!activeCameraTrackSid || !activeCameraParticipantIdentity) return;
    if (!latestFrame) return;

    pushInProgress = true;
    try {
      const { base64, mimeType, dataUrl } = await encodeFrameAsJpegBase64(latestFrame, {
        maxDimension,
        jpegQuality,
      });

      // Always enqueue an ephemeral frame for the next runMachine call (text mode + worker nodes).
      const machine = getMachine();
      if (machine) {
        machine.enqueue([
          ephemeralMessage(
            [{ type: "image", mimeType, data: base64, detail }],
            { singleton: "camera" },
          ),
        ]);
      }

      // Realtime mode: also keep a single camera frame at the head of the realtime chat context.
      const rtSession = agent._agentActivity?.realtimeLLMSession;
      if (rtSession) {
        const chatCtx = rtSession.chatCtx.copy();
        chatCtx.items = chatCtx.items.filter(
          (item) => !(item.type === "message" && item.id.startsWith("camera_frame_")),
        );

        chatCtx.addMessage({
          role: "user",
          id: `camera_frame_${Date.now()}`,
          createdAt: 0, // keep at head so future inserts don't anchor previous_item_id to this item
          content: [
            "[Camera frame] Live snapshot from the user's camera.",
            llm.createImageContent({
              image: dataUrl,
              inferenceDetail: detail,
              mimeType,
            }),
          ],
        });

        await rtSession.updateChatCtx(chatCtx);
      }
    } catch (error) {
      console.warn("[VisionSampler] Failed to push camera frame:", error);
    } finally {
      pushInProgress = false;
    }
  };

  const startSampling = async (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    if (stopped) return;
    if (!isUserParticipant(participant)) return;
    if (!isCameraVideoPublication(publication)) return;
    if (!publication.sid) return;

    // If we're already sampling this track, do nothing
    if (activeCameraTrackSid === publication.sid) return;

    await stopSampling();

    activeCameraTrackSid = publication.sid;
    activeCameraParticipantIdentity = participant.identity;
    setCameraEnabledInPack(true);

    try {
      const videoStream = new VideoStream(track);
      frameReader = videoStream.getReader();

      (async () => {
        while (!stopped && frameReader && activeCameraTrackSid === publication.sid) {
          const { done, value } = await frameReader.read();
          if (done) break;
          if (!value?.frame) continue;
          latestFrame = value.frame;
        }
      })().catch((error) => {
        console.warn("[VisionSampler] Frame reader stopped:", error);
      });

      startTimer();

      console.log(
        `[VisionSampler] Camera sampling started: participant=${participant.identity}, trackSid=${publication.sid}, activeFps=${activeFps}, idleFps=${idleFps}`
      );
    } catch (error) {
      console.warn("[VisionSampler] Failed to start camera sampling:", error);
      await stopSampling();
    }
  };

  const onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    if (track.kind !== TrackKind.KIND_VIDEO) return;
    void startSampling(track, publication, participant);
  };

  const onTrackUnsubscribed = (
    _track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    if (
      activeCameraTrackSid &&
      publication.sid === activeCameraTrackSid &&
      participant.identity === activeCameraParticipantIdentity
    ) {
      void stopSampling();
      console.log("[VisionSampler] Camera sampling stopped (track unsubscribed)");
    }
  };

  const onTrackMuted = (publication: TrackPublication, participant: Participant) => {
    if (
      activeCameraTrackSid &&
      publication.sid === activeCameraTrackSid &&
      participant.identity === activeCameraParticipantIdentity
    ) {
      void stopSampling();
      console.log("[VisionSampler] Camera sampling stopped (track muted)");
    }
  };

  const onTrackUnmuted = (publication: TrackPublication, participant: Participant) => {
    if (!isUserParticipant(participant)) return;
    if (!isCameraVideoPublication(publication)) return;
    if (publication.sid && publication.sid === activeCameraTrackSid) return;

    const track = publication.track as RemoteTrack | undefined;
    if (!track) return;
    void startSampling(track, publication as RemoteTrackPublication, participant as RemoteParticipant);
  };

  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
  room.on(RoomEvent.TrackMuted, onTrackMuted);
  room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);

  // If the user already had a camera track published before we attached handlers,
  // start sampling immediately.
  for (const participant of room.remoteParticipants.values()) {
    if (!isUserParticipant(participant)) continue;
    for (const publication of participant.trackPublications.values()) {
      if (!isCameraVideoPublication(publication)) continue;
      const track = publication.track as RemoteTrack | undefined;
      if (!track) continue;
      void startSampling(track, publication, participant);
      break;
    }
  }

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;

      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);

      await stopSampling();
    },
    setMode: (nextMode: "active" | "idle") => {
      mode = nextMode;
      if (activeCameraTrackSid) {
        startTimer();
      }
    },
  };
}
