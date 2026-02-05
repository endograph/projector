import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandExecutionResult } from "markov-machines/client";
import type { Room } from "livekit-client";

// Chat input state
export const inputAtom = atom<string>("");
export const isLoadingAtom = atom<boolean>(false);

// Keyboard state
export const shiftHeldAtom = atom<boolean>(false);

// UI settings (persisted)
export const scanlinesEnabledAtom = atomWithStorage<boolean>("demo-scanlines", true);

// Agent pane tabs (persisted)
export type AgentTab = "tree" | "state" | "history" | "commands" | "dev";
export const activeAgentTabAtom = atomWithStorage<AgentTab>("demo-agent-tab", "tree");

// Tree subtabs (persisted)
export type TreeSubtab = "server" | "client" | "prompt" | "restore";
export const activeTreeSubtabAtom = atomWithStorage<TreeSubtab>("demo-tree-subtab", "server");

// History subtabs (persisted)
export type HistorySubtab = "steps" | "turns" | "messages" | "branches";
export const activeHistorySubtabAtom = atomWithStorage<HistorySubtab>("demo-history-subtab", "steps");

// Step preview state
export const selectedStepIdAtom = atom<Id<"machineSteps"> | null>(null);
export const stepPreviewInstanceAtom = atom<unknown | null>(null);
export const isPreviewingAtom = atom<boolean>(false);

// Theme state (synced from session instance)
export const themeHueAtom = atom<number>(120);
export const themeSaturationAtom = atom<number>(100);
export const themeAnimatedAtom = atom<boolean>(false); // flux mode
export const themeGradientAtom = atom<boolean>(false); // gradient overlay

// Derived: current display hue (animated when flux mode is on)
export const displayHueAtom = atom<number>(120);

// Voice mode state
export type VoiceConnectionStatus = "disconnected" | "connecting" | "connected";
export const voiceConnectionStatusAtom = atom<VoiceConnectionStatus>("disconnected");
export const voiceAgentConnectedAtom = atom<boolean>(false);
export const liveKitRoomAtom = atom<Room | null>(null);

// LiveKit client handle for RPC calls
export interface LiveClientHandle {
  sendMessage: (message: string) => Promise<{ response: string; instance: unknown } | null>;
  executeCommand: (
    commandName: string,
    input: Record<string, unknown>,
    clientId?: string,
  ) => Promise<CommandExecutionResult>;
  isConnected: () => boolean;
}
export const liveClientAtom = atom<LiveClientHandle | null>(null);

// LiveKit streaming (ephemeral UI enhancement; Convex is source of truth)
export type StreamPacket =
  | {
    v: 1;
    t: "mm.stream";
    turnId: string;
    event:
      | { type: "message_start"; messageId: string; seq: number }
      | {
        type: "message_update";
        messageId: string;
        seq: number;
        delta: { kind: "text" | "thinking"; contentIndex: number; delta: string };
      }
      | { type: "message_end"; messageId: string; seq: number }
      | { type: "message_error"; messageId: string; seq: number; error: { message: string; code?: string } };
  };

export type StreamBuffer = {
  messageId: string;
  /** Last applied seq */
  seq: number;
  /** Accumulated text */
  content: string;
  /** Local timestamp for display ordering when Convex envelope hasn't arrived yet */
  startedAt: number;
  ended?: boolean;
  error?: string;
};

export const streamBuffersAtom = atom<Record<string, StreamBuffer>>({});

// Lightweight presence metadata — only updates on stream start/end/error, NOT on every delta.
// HomeClient subscribes to this instead of streamBuffersAtom to avoid re-rendering on every delta.
export const streamPresenceAtom = atom<Record<string, { startedAt: number; error?: string }>>({});

export const ingestStreamPacketAtom = atom(null, (get, set, packet: StreamPacket) => {
  if (packet.v !== 1 || packet.t !== "mm.stream") return;

  const event = packet.event;
  const messageId = event.messageId;
  const nextSeq = event.seq;

  set(streamBuffersAtom, (prev) => {
    const existing = prev[messageId];

    // Ignore out-of-order or duplicate events.
    if (existing && nextSeq <= existing.seq) {
      return prev;
    }

    const base: StreamBuffer = existing ?? {
      messageId,
      seq: 0,
      content: "",
      startedAt: Date.now(),
    };

    if (event.type === "message_start") {
      return {
        ...prev,
        [messageId]: {
          ...base,
          seq: nextSeq,
          // Keep existing content if we already started buffering via early deltas.
          content: base.content,
        },
      };
    }

    if (event.type === "message_update") {
      if (event.delta.kind !== "text") {
        return {
          ...prev,
          [messageId]: {
            ...base,
            seq: nextSeq,
          },
        };
      }

      return {
        ...prev,
        [messageId]: {
          ...base,
          seq: nextSeq,
          content: base.content + event.delta.delta,
        },
      };
    }

    if (event.type === "message_end") {
      return {
        ...prev,
        [messageId]: {
          ...base,
          seq: nextSeq,
          ended: true,
        },
      };
    }

    // message_error
    return {
      ...prev,
      [messageId]: {
        ...base,
        seq: nextSeq,
        ended: true,
        error: event.error.message,
      },
    };
  });

  // Update presence atom only on start/end/error — NOT on deltas.
  if (event.type === "message_start") {
    set(streamPresenceAtom, (prev) => ({
      ...prev,
      [messageId]: { startedAt: Date.now() },
    }));
  } else if (event.type === "message_error") {
    set(streamPresenceAtom, (prev) => ({
      ...prev,
      [messageId]: { ...prev[messageId], error: event.error.message },
    }));
  }
});

export const pruneStreamBuffersAtom = atom(null, (get, set, messageIds: string[]) => {
  if (messageIds.length === 0) return;

  const currentBuffers = get(streamBuffersAtom);
  let buffersChanged = false;
  const nextBuffers: Record<string, StreamBuffer> = { ...currentBuffers };
  for (const id of messageIds) {
    if (id in nextBuffers) {
      delete nextBuffers[id];
      buffersChanged = true;
    }
  }
  if (buffersChanged) {
    set(streamBuffersAtom, nextBuffers);
  }

  const currentPresence = get(streamPresenceAtom);
  let presenceChanged = false;
  const nextPresence: Record<string, { startedAt: number; error?: string }> = { ...currentPresence };
  for (const id of messageIds) {
    if (id in nextPresence) {
      delete nextPresence[id];
      presenceChanged = true;
    }
  }
  if (presenceChanged) {
    set(streamPresenceAtom, nextPresence);
  }
});
