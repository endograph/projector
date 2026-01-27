import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandExecutionResult } from "markov-machines/client";

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
export type TreeSubtab = "server" | "client";
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
export const isLiveModeAtom = atom<boolean>(false);
export const voiceConnectionStatusAtom = atom<VoiceConnectionStatus>("disconnected");
export const voiceAgentConnectedAtom = atom<boolean>(false);

// LiveKit client handle for RPC calls
export interface LiveClientHandle {
  sendMessage: (message: string) => Promise<{ response: string; instance: unknown } | null>;
  executeCommand: (
    commandName: string,
    input: Record<string, unknown>
  ) => Promise<CommandExecutionResult>;
  isConnected: () => boolean;
}
export const liveClientAtom = atom<LiveClientHandle | null>(null);
