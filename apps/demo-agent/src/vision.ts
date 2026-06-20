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
  type VideoFrame,
  type VideoFrameEvent,
} from "@livekit/rtc-node";
import sharp from "sharp";
import type { CameraSensorImage } from "./projector-demo.js";

export type CameraSamplerHandle = {
  stop(): Promise<void>;
};

export function attachCameraSampler({
  room,
  onImage,
  config,
}: {
  room: Room;
  onImage: (image: CameraSensorImage | undefined) => void;
  config?: {
    fps?: number;
    maxDimension?: number;
    jpegQuality?: number;
  };
}): CameraSamplerHandle {
  const fps = config?.fps ?? 1;
  const maxDimension = config?.maxDimension ?? 1024;
  const jpegQuality = config?.jpegQuality ?? 92;

  let activeTrackSid: string | null = null;
  let activeParticipantIdentity: string | null = null;
  let frameReader: ReadableStreamDefaultReader<VideoFrameEvent> | null = null;
  let latestFrame: VideoFrame | null = null;
  let sampledFirstFrameForTrack = false;
  let samplingTimer: ReturnType<typeof setInterval> | null = null;
  let sampleInProgress = false;
  let stopped = false;

  const stopTimer = () => {
    if (!samplingTimer) return;
    clearInterval(samplingTimer);
    samplingTimer = null;
  };

  const startTimer = () => {
    stopTimer();
    const intervalMs = Math.max(1, Math.round(1000 / Math.max(0.001, fps)));
    samplingTimer = setInterval(() => {
      void sampleLatestFrame();
    }, intervalMs);
  };

  const stopSampling = async () => {
    stopTimer();
    latestFrame = null;
    sampledFirstFrameForTrack = false;
    activeTrackSid = null;
    activeParticipantIdentity = null;
    onImage(undefined);

    if (!frameReader) return;
    try {
      await frameReader.cancel();
    } catch {
      // ignore cancellation races
    }
    try {
      frameReader.releaseLock();
    } catch {
      // ignore already-released readers
    }
    frameReader = null;
  };

  const sampleLatestFrame = async () => {
    if (stopped || sampleInProgress || !latestFrame || !activeTrackSid || !activeParticipantIdentity) {
      return;
    }

    sampleInProgress = true;
    try {
      const image = await encodeFrameAsJpegDataUrl(latestFrame, {
        maxDimension,
        jpegQuality,
      });
      onImage({
        ...image,
        capturedAt: Date.now(),
        participantIdentity: activeParticipantIdentity,
        trackSid: activeTrackSid,
      });
    } catch (error) {
      console.warn("[camera-sampler] Failed to sample camera frame", error);
    } finally {
      sampleInProgress = false;
    }
  };

  const startSampling = async (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (stopped) return;
    if (!isUserParticipant(participant)) return;
    if (!isCameraVideoPublication(publication)) return;
    if (!publication.sid) return;
    if (activeTrackSid === publication.sid) return;

    await stopSampling();
    activeTrackSid = publication.sid;
    activeParticipantIdentity = participant.identity;
    sampledFirstFrameForTrack = false;

    try {
      const stream = new VideoStream(track);
      frameReader = stream.getReader();
      void readFrames(publication.sid, frameReader);
      startTimer();
    } catch (error) {
      console.warn("[camera-sampler] Failed to start camera sampling", error);
      await stopSampling();
    }
  };

  const readFrames = async (
    trackSid: string,
    reader: ReadableStreamDefaultReader<VideoFrameEvent>,
  ) => {
    try {
      while (!stopped && frameReader === reader && activeTrackSid === trackSid) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.frame) {
          latestFrame = value.frame;
          if (!sampledFirstFrameForTrack) {
            sampledFirstFrameForTrack = true;
            void sampleLatestFrame();
          }
        }
      }
    } catch (error) {
      if (!stopped) {
        console.warn("[camera-sampler] Frame reader stopped", error);
      }
    }
  };

  const onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== TrackKind.KIND_VIDEO) return;
    void startSampling(track, publication, participant);
  };

  const subscribeToCameraPublication = (
    publication: TrackPublication,
    participant: Participant,
  ) => {
    if (!isUserParticipant(participant)) return;
    if (!isCameraVideoPublication(publication)) return;

    const remotePublication = publication as RemoteTrackPublication;
    if (!remotePublication.subscribed) {
      remotePublication.setSubscribed(true);
    }

    const track = remotePublication.track as RemoteTrack | undefined;
    if (track) {
      void startSampling(track, remotePublication, participant as RemoteParticipant);
    }
  };

  const onTrackPublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    subscribeToCameraPublication(publication, participant);
  };

  const onTrackUnsubscribed = (
    _track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (
      publication.sid === activeTrackSid &&
      participant.identity === activeParticipantIdentity
    ) {
      void stopSampling();
    }
  };

  const onTrackMuted = (publication: TrackPublication, participant: Participant) => {
    if (
      publication.sid === activeTrackSid &&
      participant.identity === activeParticipantIdentity
    ) {
      void stopSampling();
    }
  };

  const onTrackUnmuted = (publication: TrackPublication, participant: Participant) => {
    if (!isUserParticipant(participant)) return;
    if (!isCameraVideoPublication(publication)) return;
    if (publication.sid && publication.sid === activeTrackSid) return;

    const track = publication.track as RemoteTrack | undefined;
    if (!track) {
      subscribeToCameraPublication(publication, participant);
      return;
    }
    void startSampling(
      track,
      publication as RemoteTrackPublication,
      participant as RemoteParticipant,
    );
  };

  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  room.on(RoomEvent.TrackPublished, onTrackPublished);
  room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
  room.on(RoomEvent.TrackMuted, onTrackMuted);
  room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);

  for (const participant of room.remoteParticipants.values()) {
    if (!isUserParticipant(participant)) continue;
    for (const publication of participant.trackPublications.values()) {
      if (!isCameraVideoPublication(publication)) continue;
      subscribeToCameraPublication(publication, participant);
      break;
    }
  }

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.off(RoomEvent.TrackPublished, onTrackPublished);
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
      await stopSampling();
    },
  };
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

async function encodeFrameAsJpegDataUrl(
  frame: VideoFrame,
  options: { maxDimension: number; jpegQuality: number },
): Promise<Pick<CameraSensorImage, "dataUrl" | "mimeType" | "width" | "height">> {
  const rgba = frame.type === VideoBufferType.RGBA
    ? frame
    : frame.convert(VideoBufferType.RGBA);
  const scale = Math.min(
    1,
    options.maxDimension / Math.max(rgba.width, rgba.height),
  );
  const width = Math.max(1, Math.round(rgba.width * scale));
  const height = Math.max(1, Math.round(rgba.height * scale));

  let pipeline = sharp(rgba.data, {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  });
  if (scale < 1) {
    pipeline = pipeline.resize(width, height, { fit: "inside" });
  }

  const jpeg = await pipeline.jpeg({ quality: options.jpegQuality }).toBuffer();
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    mimeType: "image/jpeg",
    width,
    height,
  };
}
