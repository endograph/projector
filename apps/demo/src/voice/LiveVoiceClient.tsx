"use client";

import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import { useSetAtom } from "jotai";
import { useAction } from "convex/react";
import { Room, RoomEvent, Track, ConnectionState, ParticipantKind } from "livekit-client";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandExecutionResult } from "markov-machines/client";
import {
  ingestStreamPacketAtom,
  liveKitRoomAtom,
  voiceConnectionStatusAtom,
  voiceAgentConnectedAtom,
} from "@/src/atoms";

const STREAM_TOPIC = "mm.stream.v1";

interface LiveVoiceClientProps {
  sessionId: Id<"sessions">;
  voiceEnabled: boolean;
  cameraEnabled: boolean;
}

export interface LiveVoiceClientHandle {
  sendMessage: (message: string) => Promise<{ response: string; instance: unknown } | null>;
  executeCommand: (
    commandName: string,
    input: Record<string, unknown>
  ) => Promise<CommandExecutionResult>;
  isConnected: () => boolean;
}

/**
 * LiveVoiceClient manages the LiveKit connection for the agent.
 *
 * Always connects to the LiveKit room (for RPC text messages).
 * When live mode is enabled, also enables microphone for voice input.
 *
 * 1. Fetches a LiveKit token from Convex on mount (this also dispatches the agent)
 * 2. Connects to the LiveKit room
 * 3. In live mode: Publishes user microphone, subscribes to agent audio
 * 4. Exposes sendMessage() for text messages via RPC
 *
 * Transcripts are persisted by the voice agent directly to Convex.
 */
  export const LiveVoiceClient = forwardRef<LiveVoiceClientHandle, LiveVoiceClientProps>(
  function LiveVoiceClient({ sessionId, voiceEnabled, cameraEnabled }, ref) {
    const setConnectionStatus = useSetAtom(voiceConnectionStatusAtom);
    const setAgentConnected = useSetAtom(voiceAgentConnectedAtom);
    const ingestStreamPacket = useSetAtom(ingestStreamPacketAtom);
    const setLiveKitRoom = useSetAtom(liveKitRoomAtom);
    const getToken = useAction(api.livekitAgentActions.getToken);

    // Store action function in ref to avoid unstable dependencies
    const getTokenRef = useRef(getToken);
    getTokenRef.current = getToken;

    const voiceEnabledRef = useRef(voiceEnabled);
    voiceEnabledRef.current = voiceEnabled;

    const cameraEnabledRef = useRef(cameraEnabled);
    cameraEnabledRef.current = cameraEnabled;

    const roomRef = useRef<Room | null>(null);
    const audioElementRef = useRef<HTMLAudioElement | null>(null);
    const isConnectingRef = useRef(false);

    // Cleanup function
    const cleanup = useCallback(async () => {
      if (roomRef.current) {
        await roomRef.current.disconnect();
        roomRef.current = null;
      }
      setLiveKitRoom(null);
      if (audioElementRef.current) {
        audioElementRef.current.srcObject = null;
      }
      setConnectionStatus("disconnected");
      setAgentConnected(false);
      isConnectingRef.current = false;
    }, [setConnectionStatus, setAgentConnected, setLiveKitRoom]);

    // Connect to LiveKit room
    const connect = useCallback(async () => {
      // Guard: prevent multiple concurrent connection attempts
      if (roomRef.current || isConnectingRef.current) {
        return;
      }
      isConnectingRef.current = true;

      setConnectionStatus("connecting");

      try {
        // Get token from Convex (this also dispatches an agent)
        const { token, url } = await getTokenRef.current({ sessionId });

        // Create and connect room
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
        });

        roomRef.current = room;
        setLiveKitRoom(room);

        // Handle connection state changes
        room.on(RoomEvent.ConnectionStateChanged, (state) => {
          console.log(`[LiveVoiceClient] ConnectionStateChanged: ${state}`);
          if (state === ConnectionState.Connected) {
            setConnectionStatus("connected");
            // Apply current mic/camera state (in case props changed before connect finished)
            room.localParticipant
              .setMicrophoneEnabled(voiceEnabledRef.current)
              .then(() => {
                console.log(
                  `[LiveVoiceClient] setMicrophoneEnabled(${voiceEnabledRef.current}) ok`
                );
              })
              .catch((error) => {
                console.error("Failed to toggle microphone:", error);
              });
            room.localParticipant
              .setCameraEnabled(cameraEnabledRef.current, {
                resolution: { width: 1280, height: 720 },
                frameRate: 30,
              })
              .then(() => {
                console.log(
                  `[LiveVoiceClient] setCameraEnabled(${cameraEnabledRef.current}) ok`
                );
              })
              .catch((error) => {
                console.error("Failed to toggle camera:", error);
              });
          } else if (state === ConnectionState.Disconnected) {
            setConnectionStatus("disconnected");
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

        // Log local track publish/unpublish (debug mic/camera)
        room.on(RoomEvent.LocalTrackPublished, (publication) => {
          console.log(
            `[LiveVoiceClient] LocalTrackPublished: source=${publication.source} kind=${publication.kind} sid=${publication.trackSid} muted=${publication.isMuted}`
          );
        });
        room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
          console.log(
            `[LiveVoiceClient] LocalTrackUnpublished: source=${publication.source} kind=${publication.kind} sid=${publication.trackSid}`
          );
        });

        // Handle disconnection
        room.on(RoomEvent.Disconnected, () => {
          setConnectionStatus("disconnected");
          setAgentConnected(false);
          setLiveKitRoom(null);
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
            // Check if any other agents remain
            const stillHasAgent = roomRef.current
              ? Array.from(roomRef.current.remoteParticipants.values()).some(
                  (p) => p.kind === ParticipantKind.AGENT
                )
              : false;
            setAgentConnected(stillHasAgent);
          }
        });

        // Handle streaming deltas from the agent over LiveKit data channel
        room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
          if (topic !== STREAM_TOPIC) return;
          try {
            const text = new TextDecoder().decode(payload);
            const packet = JSON.parse(text) as unknown;
            // Best-effort validation happens in the atom.
            ingestStreamPacket(packet as any);
          } catch (error) {
            console.warn("Failed to parse stream packet:", error);
          }
        });

        // Connect to room
        await room.connect(url, token);

        // Check for existing agent in the room
        const hasAgent = Array.from(room.remoteParticipants.values()).some(
          (p) => p.kind === ParticipantKind.AGENT
        );
        setAgentConnected(hasAgent);

        setConnectionStatus("connected");
      } catch (error) {
        console.error("Failed to connect to voice room:", error);
        setConnectionStatus("disconnected");
        setAgentConnected(false);
        setLiveKitRoom(null);
        roomRef.current = null;
        isConnectingRef.current = false;
      }
    }, [sessionId, setConnectionStatus, setAgentConnected, setLiveKitRoom]);

    // Always connect when component mounts with a valid session
    useEffect(() => {
      connect();

      return () => {
        cleanup();
      };
    }, [connect, cleanup]);

    // Toggle microphone based on voiceEnabled prop (driven by pack state)
    useEffect(() => {
      const room = roomRef.current;
      if (!room || room.state !== ConnectionState.Connected) return;

      room.localParticipant
        .setMicrophoneEnabled(voiceEnabled)
        .then(() => {
          console.log(`[LiveVoiceClient] setMicrophoneEnabled(${voiceEnabled}) ok`);
        })
        .catch((error) => {
          console.error("Failed to toggle microphone:", error);
        });
    }, [voiceEnabled]);

    // Toggle camera based on cameraEnabled prop (driven by pack state)
    useEffect(() => {
      const room = roomRef.current;
      if (!room || room.state !== ConnectionState.Connected) return;

      room.localParticipant
        .setCameraEnabled(cameraEnabled, {
          resolution: { width: 1280, height: 720 },
          frameRate: 30,
        })
        .then(() => {
          console.log(`[LiveVoiceClient] setCameraEnabled(${cameraEnabled}) ok`);
        })
        .catch((error) => {
          console.error("Failed to toggle camera:", error);
        });
    }, [cameraEnabled]);

    // Cleanup audio element on unmount
    useEffect(() => {
      return () => {
        if (audioElementRef.current) {
          audioElementRef.current.remove();
          audioElementRef.current = null;
        }
      };
    }, []);

    // Send a text message to the agent via RPC
    const sendMessage = useCallback(
      async (message: string): Promise<{ response: string; instance: unknown } | null> => {
        const room = roomRef.current;
        if (!room || room.state !== ConnectionState.Connected) {
          console.error("Cannot send message: room not connected");
          return null;
        }

        // Find the agent participant
        const agentParticipant = Array.from(room.remoteParticipants.values()).find(
          (p) => p.kind === ParticipantKind.AGENT
        );

        if (!agentParticipant) {
          console.error("Cannot send message: no agent in room");
          return null;
        }

        try {
          const response = await room.localParticipant.performRpc({
            destinationIdentity: agentParticipant.identity,
            method: "sendMessage",
            payload: message,
            responseTimeout: 60000, // 60s timeout for LLM response
          });

          return JSON.parse(response);
        } catch (error) {
          console.error("RPC sendMessage failed:", error);
          throw error;
        }
      },
      []
    );

    // Execute a command on the agent via RPC
    const executeCommand = useCallback(
      async (commandName: string, input: Record<string, unknown>, clientId?: string): Promise<CommandExecutionResult> => {
        const room = roomRef.current;
        if (!room || room.state !== ConnectionState.Connected) {
          console.error("Cannot execute command: room not connected");
          return { success: false, error: "Not connected to agent" };
        }

        // Find the agent participant
        const agentParticipant = Array.from(room.remoteParticipants.values()).find(
          (p) => p.kind === ParticipantKind.AGENT
        );

        if (!agentParticipant) {
          console.error("Cannot execute command: no agent in room");
          return { success: false, error: "No agent in room" };
        }

        try {
          const response = await room.localParticipant.performRpc({
            destinationIdentity: agentParticipant.identity,
            method: "executeCommand",
            payload: JSON.stringify({ commandName, input, clientId }),
            responseTimeout: 30000, // 30s timeout for command execution
          });

          return JSON.parse(response) as CommandExecutionResult;
        } catch (error) {
          console.error("RPC executeCommand failed:", error);
          return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
        }
      },
      []
    );

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        sendMessage,
        executeCommand,
        isConnected: () => roomRef.current?.state === ConnectionState.Connected,
      }),
      [sendMessage, executeCommand]
    );

    // This component doesn't render anything visible
    return null;
  }
);
