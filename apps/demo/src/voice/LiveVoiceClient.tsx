"use client";

import { useAction } from "convex/react";
import { useCallback, useEffect, useRef } from "react";
import {
  ConnectionState,
  ParticipantKind,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from "livekit-client";
import type { ClientMachineMessage } from "@projectors/core/client";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type VoiceStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";
type SendLiveKitMessage = (content: string) => Promise<void>;
type SendLiveKitCommand = (message: ClientMachineMessage) => Promise<unknown>;
const MESSAGE_TOPIC = "demo.message.v1";
const COMMAND_RPC_METHOD = "demo.command.v1";
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
  onSendCommandChange?: (sendCommand: SendLiveKitCommand | null) => void;
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
  onSendCommandChange,
  onLocalCameraTrackChange,
}: LiveVoiceClientProps) {
  const getToken = useAction(api.livekitAgentActions.getToken);
  const roomRef = useRef<Room | null>(null);
  const roomSessionIdRef = useRef<Id<"sessions"> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const connectingRef = useRef(false);
  const cameraEnabledRef = useRef(cameraEnabled);
  const voiceEnabledRef = useRef(voiceEnabled);
  const publishSenderRef = useRef<(room: Room | null) => void>(() => undefined);

  useEffect(() => {
    cameraEnabledRef.current = cameraEnabled;
  }, [cameraEnabled]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  const attachAgentAudioPublication = useCallback((publication: RemoteTrackPublication) => {
    const audio = audioRef.current;
    if (!audio || !publication.track) return;
    publication.track.attach(audio);
    void audio.play().catch((error) => {
      console.info("[demo/livekit] unable to start agent audio playback", error);
    });
  }, []);

  const reconcileAgentAudioSubscriptions = useCallback((room: Room, enabled: boolean) => {
    for (const participant of room.remoteParticipants.values()) {
      if (!isAgentParticipant(participant)) continue;
      for (const publication of participant.audioTrackPublications.values()) {
        publication.setSubscribed(enabled);
        if (!enabled) {
          publication.track?.detach();
        } else {
          attachAgentAudioPublication(publication);
        }
      }
    }
  }, [attachAgentAudioPublication]);

  const setAudioElement = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element;
    const room = roomRef.current;
    if (element && room?.state === ConnectionState.Connected && voiceEnabledRef.current) {
      reconcileAgentAudioSubscriptions(room, true);
    }
  }, [reconcileAgentAudioSubscriptions]);

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
      onSendCommandChange?.(null);
      return;
    }

    const agentParticipant = findAgentParticipant(room);
    if (!agentParticipant) {
      onSendMessageChange?.(null);
      onSendCommandChange?.(null);
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

    onSendCommandChange?.(async (message: ClientMachineMessage) => {
      if (
        roomRef.current !== room ||
        roomSessionIdRef.current !== sessionId ||
        room.state !== ConnectionState.Connected
      ) {
        onSendCommandChange?.(null);
        throw new Error("LiveKit room changed before the command was sent");
      }
      const target = findAgentParticipant(room);
      if (!target) {
        onSendCommandChange?.(null);
        throw new Error("LiveKit agent is not ready");
      }
      const payload = JSON.stringify({ sessionId, message, sentAt: Date.now() });
      const response = await room.localParticipant.performRpc({
        destinationIdentity: target.identity,
        method: COMMAND_RPC_METHOD,
        payload,
        responseTimeout: 15_000,
      });
      return JSON.parse(response) as unknown;
    });
  }, [liveKitWorkerReady, onSendCommandChange, onSendMessageChange, onStatusChange, sessionId]);

  useEffect(() => {
    publishSenderRef.current = publishSender;
  }, [publishSender]);

  useEffect(() => {
    publishSender(roomRef.current);
  }, [publishSender]);

  const disconnect = useCallback(async () => {
    connectingRef.current = false;
    onSendMessageChange?.(null);
    onSendCommandChange?.(null);
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
  }, [onLocalCameraTrackChange, onSendCommandChange, onSendMessageChange, onStatusChange]);

  useEffect(() => {
    onSendMessageChange?.(null);
    onSendCommandChange?.(null);
    if (roomRef.current && roomSessionIdRef.current !== sessionId) {
      void disconnect();
    }
  }, [disconnect, onSendCommandChange, onSendMessageChange, sessionId]);

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
        const reconcileRemoteAudioSubscription = (
          publication: RemoteTrackPublication,
          participant: RemoteParticipant,
        ) => {
          if (publication.kind !== Track.Kind.Audio) return;
          const shouldSubscribe = voiceEnabledRef.current && isAgentParticipant(participant);
          publication.setSubscribed(shouldSubscribe);
          if (!shouldSubscribe) {
            publication.track?.detach();
          } else {
            attachAgentAudioPublication(publication);
          }
        };
        const reconcileRemoteAudioSubscriptions = () => {
          reconcileAgentAudioSubscriptions(room, voiceEnabledRef.current);
        };

        room.on(RoomEvent.ConnectionStateChanged, (state) => {
          if (state === ConnectionState.Connected) {
            onStatusChange?.("connected", `room ${room.name}`);
            reconcileRemoteAudioSubscriptions();
            publishSenderRef.current(room);
          }
          if (state === ConnectionState.Disconnected) {
            onStatusChange?.("disconnected");
            onSendMessageChange?.(null);
            onSendCommandChange?.(null);
          }
        });

        room.on(RoomEvent.ParticipantConnected, (participant) => {
          onStatusChange?.(
            "connected",
            isAgentParticipant(participant)
              ? `agent ${participant.identity}`
              : `${room.remoteParticipants.size} remote participant(s)`,
          );
          for (const publication of participant.audioTrackPublications.values()) {
            reconcileRemoteAudioSubscription(publication, participant);
          }
          publishSenderRef.current(room);
        });
        room.on(RoomEvent.ParticipantDisconnected, () => {
          onStatusChange?.("connected", `${room.remoteParticipants.size} remote participant(s)`);
          publishSenderRef.current(room);
        });

        room.on(RoomEvent.TrackPublished, (publication, participant) => {
          reconcileRemoteAudioSubscription(publication, participant);
        });

        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (track.kind !== Track.Kind.Audio) return;
          if (!voiceEnabledRef.current || !isAgentParticipant(participant)) {
            publication.setSubscribed(false);
            track.detach();
            return;
          }
          attachAgentAudioPublication(publication);
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

        await room.connect(url, token, { autoSubscribe: false });
        if (cancelled || roomRef.current !== room) return;
        await room.localParticipant.setMicrophoneEnabled(voiceEnabledRef.current);
        if (cancelled || roomRef.current !== room) return;
        const cameraPublication = await room.localParticipant.setCameraEnabled(
          cameraEnabledRef.current,
          CAMERA_CAPTURE_OPTIONS,
        );
        if (cancelled || roomRef.current !== room) return;
        onLocalCameraTrackChange?.(cameraPublication?.videoTrack ?? null);
        publishSenderRef.current(room);
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
  }, [attachAgentAudioPublication, disconnect, getToken, liveKitEnabled, onLocalCameraTrackChange, onSendCommandChange, onSendMessageChange, onStatusChange, reconcileAgentAudioSubscriptions, sessionId]);

  useEffect(() => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    reconcileAgentAudioSubscriptions(room, voiceEnabled);
    void room.localParticipant.setMicrophoneEnabled(voiceEnabled).catch((error) => {
      onStatusChange?.("error", error instanceof Error ? error.message : "Unable to toggle microphone");
    });
    void room.localParticipant
      .setCameraEnabled(cameraEnabled, CAMERA_CAPTURE_OPTIONS)
      .then((publication) => {
        if (roomRef.current !== room || room.state !== ConnectionState.Connected) return;
        onLocalCameraTrackChange?.(cameraEnabled ? publication?.videoTrack ?? null : null);
      })
      .catch((error) => {
        if (roomRef.current !== room) return;
        onLocalCameraTrackChange?.(null);
        onStatusChange?.("error", error instanceof Error ? error.message : "Unable to toggle camera");
      });
  }, [cameraEnabled, onLocalCameraTrackChange, onStatusChange, reconcileAgentAudioSubscriptions, voiceEnabled]);

  return <audio ref={setAudioElement} autoPlay playsInline className="hidden" />;
}

function isAgentParticipant(participant: RemoteParticipant): boolean {
  return participant.isAgent || participant.kind === ParticipantKind.AGENT;
}

function findAgentParticipant(room: Room): RemoteParticipant | undefined {
  return [...room.remoteParticipants.values()].find(isAgentParticipant);
}
