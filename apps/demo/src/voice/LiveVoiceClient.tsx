"use client";

import { useAction } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState, Room, RoomEvent, Track, type LocalVideoTrack } from "livekit-client";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type VoiceStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";
type SendLiveKitMessage = (content: string) => Promise<void>;
const MESSAGE_TOPIC = "demo.message.v1";
const CAMERA_CAPTURE_OPTIONS = {
  resolution: { width: 1280, height: 720 },
  frameRate: 30,
} as const;

type LiveVoiceClientProps = {
  sessionId: Id<"sessions"> | null;
  liveKitEnabled: boolean;
  liveKitWorkerReady: boolean;
  voiceEnabled: boolean;
  cameraEnabled: boolean;
  onStatusChange?: (status: VoiceStatus, detail?: string) => void;
  onSendMessageChange?: (sendMessage: SendLiveKitMessage | null) => void;
  onLocalCameraTrackChange?: (track: LocalVideoTrack | null) => void;
};

export function LiveVoiceClient({
  sessionId,
  liveKitEnabled,
  liveKitWorkerReady,
  voiceEnabled,
  cameraEnabled,
  onStatusChange,
  onSendMessageChange,
  onLocalCameraTrackChange,
}: LiveVoiceClientProps) {
  const getToken = useAction(api.livekitAgentActions.getToken);
  const roomRef = useRef<Room | null>(null);
  const roomSessionIdRef = useRef<Id<"sessions"> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const connectingRef = useRef(false);
  const cameraEnabledRef = useRef(cameraEnabled);
  const voiceEnabledRef = useRef(voiceEnabled);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);

  useEffect(() => {
    audioRef.current = audioElement;
  }, [audioElement]);

  useEffect(() => {
    cameraEnabledRef.current = cameraEnabled;
  }, [cameraEnabled]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  const publishSender = useCallback((room: Room | null) => {
    const roomSessionId = roomSessionIdRef.current;
    if (
      !liveKitWorkerReady ||
      !sessionId ||
      roomSessionId !== sessionId ||
      !room ||
      room.state !== ConnectionState.Connected
    ) {
      onSendMessageChange?.(null);
      return;
    }

    onSendMessageChange?.(async (content: string) => {
      if (
        roomRef.current !== room ||
        roomSessionIdRef.current !== sessionId ||
        room.state !== ConnectionState.Connected
      ) {
        onSendMessageChange?.(null);
        throw new Error("LiveKit room changed before the message was sent");
      }
      const payload = new TextEncoder().encode(JSON.stringify({ content, sentAt: Date.now() }));
      console.info("[demo/livekit] publish text message", {
        topic: MESSAGE_TOPIC,
        participants: [...room.remoteParticipants.values()].map((participant) => participant.identity),
      });
      await room.localParticipant.publishData(payload, {
        reliable: true,
        topic: MESSAGE_TOPIC,
      });
      onStatusChange?.("connected", `sent ${payload.byteLength} bytes`);
    });
  }, [liveKitWorkerReady, onSendMessageChange, onStatusChange, sessionId]);

  useEffect(() => {
    publishSender(roomRef.current);
  }, [publishSender]);

  const disconnect = useCallback(async () => {
    connectingRef.current = false;
    onSendMessageChange?.(null);
    onLocalCameraTrackChange?.(null);
    const room = roomRef.current;
    roomRef.current = null;
    roomSessionIdRef.current = null;
    if (room) {
      await room.disconnect();
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    onStatusChange?.("disconnected");
  }, [onLocalCameraTrackChange, onSendMessageChange, onStatusChange]);

  useEffect(() => {
    onSendMessageChange?.(null);
    if (roomRef.current && roomSessionIdRef.current !== sessionId) {
      void disconnect();
    }
  }, [disconnect, onSendMessageChange, sessionId]);

  useEffect(() => {
    if (!liveKitEnabled || !sessionId) {
      void disconnect();
      if (!liveKitEnabled) onStatusChange?.("idle");
      return;
    }

    if (roomRef.current || connectingRef.current) {
      return;
    }

    let cancelled = false;
    connectingRef.current = true;
    onStatusChange?.("connecting");

    void (async () => {
      try {
        const { token, url } = await getToken({ sessionId });
        if (cancelled) return;

        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;
        roomSessionIdRef.current = sessionId;

        room.on(RoomEvent.ConnectionStateChanged, (state) => {
          if (state === ConnectionState.Connected) {
            onStatusChange?.("connected", `room ${room.name}`);
            publishSender(room);
          }
          if (state === ConnectionState.Disconnected) {
            onStatusChange?.("disconnected");
            onSendMessageChange?.(null);
          }
        });

        room.on(RoomEvent.ParticipantConnected, (participant) => {
          onStatusChange?.("connected", `agent ${participant.identity}`);
          publishSender(room);
        });
        room.on(RoomEvent.ParticipantDisconnected, () => {
          onStatusChange?.("connected", `${room.remoteParticipants.size} remote participant(s)`);
          publishSender(room);
        });

        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio || !audioRef.current) return;
          track.attach(audioRef.current);
          void audioRef.current.play().catch(() => undefined);
        });

        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach();
        });

        room.on(RoomEvent.LocalTrackPublished, (publication) => {
          if (publication.source === Track.Source.Camera) {
            onLocalCameraTrackChange?.(publication.videoTrack ?? null);
          }
        });

        room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (publication.source === Track.Source.Camera) {
            onLocalCameraTrackChange?.(null);
          }
        });

        await room.connect(url, token);
        await room.localParticipant.setMicrophoneEnabled(voiceEnabledRef.current);
        const cameraPublication = await room.localParticipant.setCameraEnabled(
          cameraEnabledRef.current,
          CAMERA_CAPTURE_OPTIONS,
        );
        onLocalCameraTrackChange?.(cameraPublication?.videoTrack ?? null);
        publishSender(room);
      } catch (error) {
        if (cancelled) return;
        onStatusChange?.("error", error instanceof Error ? error.message : "Unable to connect voice");
        await disconnect();
      } finally {
        connectingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
      void disconnect();
    };
  }, [disconnect, getToken, liveKitEnabled, onLocalCameraTrackChange, onSendMessageChange, onStatusChange, publishSender, sessionId]);

  useEffect(() => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    void room.localParticipant.setMicrophoneEnabled(voiceEnabled).catch((error) => {
      onStatusChange?.("error", error instanceof Error ? error.message : "Unable to toggle microphone");
    });
    void room.localParticipant
      .setCameraEnabled(cameraEnabled, CAMERA_CAPTURE_OPTIONS)
      .then((publication) => {
        onLocalCameraTrackChange?.(cameraEnabled ? publication?.videoTrack ?? null : null);
      })
      .catch((error) => {
        onLocalCameraTrackChange?.(null);
        onStatusChange?.("error", error instanceof Error ? error.message : "Unable to toggle camera");
      });
  }, [cameraEnabled, onLocalCameraTrackChange, onStatusChange, voiceEnabled]);

  return <audio ref={setAudioElement} autoPlay playsInline className="hidden" />;
}
