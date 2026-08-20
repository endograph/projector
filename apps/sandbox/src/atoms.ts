import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { Id } from "@/convex/_generated/dataModel";

export const inputAtom = atom("");
export const isLoadingAtom = atom(false);
export const timeTravelFrameIdAtom = atom<Id<"frames"> | null>(null);
export const scanlinesEnabledAtom = atomWithStorage("sandbox-scanlines", true);
export type MessageTransport = "convex" | "livekit";
export const messageTransportAtom = atomWithStorage<MessageTransport>("sandbox-message-transport", "convex");

export type AgentTab = "tree" | "state" | "history" | "commands" | "playground" | "dev";
export const activeAgentTabAtom = atomWithStorage<AgentTab>("sandbox-agent-tab", "tree");

export type TreeSubtab = "instance" | "projection" | "ir" | "realized";
export const activeTreeSubtabAtom = atomWithStorage<TreeSubtab>("sandbox-tree-subtab", "instance");

export type HistorySubtab = "frames" | "messages" | "branches" | "controls";
export const activeHistorySubtabAtom = atomWithStorage<HistorySubtab>("sandbox-history-subtab", "frames");
