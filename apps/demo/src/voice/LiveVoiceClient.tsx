"use client";

import { useEffect, useRef, useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useAction } from "convex/react";
import { Room, RoomEvent, Track, ConnectionState, ParticipantKind } from "livekit-client";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isLiveModeAtom, voiceConnectionStatusAtom, voiceAgentConnectedAtom } from "@/src/atoms";

interface LiveVoiceClientProps {
  sessionId: Id<"sessions">;
}

/**
 * LiveVoiceClient manages the LiveKit connection for voice mode.
 *
 * When live mode is enabled:
 * 1. Fetches a LiveKit token from Convex
 * 2. Connects to the LiveKit room
 * 3. Publishes user microphone
 * 4. Subscribes to agent audio and plays it
 *
 * Transcripts are persisted by the voice agent directly to Convex,
 * so this component doesn't need to handle transcript ingestion.
 */
export function LiveVoiceClient({ sessionId }: LiveVoiceClientProps) {
  const [isLiveMode, setIsLiveMode] = useAtom(isLiveModeAtom);
  const setConnectionStatus = useSetAtom(voiceConnectionStatusAtom);
  const setAgentConnected = useSetAtom(voiceAgentConnectedAtom);
  const getToken = useAction(api.voiceActions.getToken);

  const roomRef = useRef<Room | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  // Check if any agent is in the room
  const checkForAgent = useCallback((room: Room) => {
    const hasAgent = Array.from(room.remoteParticipants.values()).some(
      (p) => p.kind === ParticipantKind.AGENT
    );
    setAgentConnected(hasAgent);
  }, [setAgentConnected]);

  // Cleanup function
  const cleanup = useCallback(async () => {
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
    }
    setConnectionStatus("disconnected");
    setAgentConnected(false);
  }, [setConnectionStatus, setAgentConnected]);

  // Connect to LiveKit room
  const connect = useCallback(async () => {
    if (roomRef.current) {
      await cleanup();
    }

    setConnectionStatus("connecting");

    try {
      // Get token from Convex
      const { token, url, room: roomName } = await getToken({ sessionId });

      // Create and connect room
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      roomRef.current = room;

      // Handle connection state changes
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === ConnectionState.Connected) {
          setConnectionStatus("connected");
        } else if (state === ConnectionState.Disconnected) {
          setConnectionStatus("disconnected");
          setIsLiveMode(false);
        }
      });

      // Handle agent audio track subscription
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Audio && !participant.isLocal) {
          // Create audio element for agent audio
          if (!audioElementRef.current) {
            audioElementRef.current = document.createElement("audio");
            audioElementRef.current.autoplay = true;
            document.body.appendChild(audioElementRef.current);
          }
          track.attach(audioElementRef.current);
        }
      });

      // Handle track unsubscription
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && audioElementRef.current) {
          track.detach(audioElementRef.current);
        }
      });

      // Handle disconnection
      room.on(RoomEvent.Disconnected, () => {
        setConnectionStatus("disconnected");
        setAgentConnected(false);
        setIsLiveMode(false);
      });

      // Handle participant connections (to detect agent)
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        if (participant.kind === ParticipantKind.AGENT) {
          setAgentConnected(true);
        }
      });

      // Handle participant disconnections
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.kind === ParticipantKind.AGENT) {
          checkForAgent(room); // Check if any other agents remain
        }
      });

      // Connect to room
      await room.connect(url, token);

      // Check for existing agent in the room
      checkForAgent(room);

      // Enable microphone
      await room.localParticipant.setMicrophoneEnabled(true);

      setConnectionStatus("connected");
    } catch (error) {
      console.error("Failed to connect to voice room:", error);
      setConnectionStatus("disconnected");
      setIsLiveMode(false);
    }
  }, [sessionId, getToken, setConnectionStatus, setIsLiveMode, cleanup]);

  // React to live mode changes
  useEffect(() => {
    if (isLiveMode) {
      connect();
    } else {
      cleanup();
    }

    return () => {
      cleanup();
    };
  }, [isLiveMode, connect, cleanup]);

  // Cleanup audio element on unmount
  useEffect(() => {
    return () => {
      if (audioElementRef.current) {
        audioElementRef.current.remove();
        audioElementRef.current = null;
      }
    };
  }, []);

  // This component doesn't render anything visible
  return null;
}
