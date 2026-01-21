import { atomWithStorage } from "jotai/utils";
import { atom } from "jotai";
import type { Id } from "../convex/_generated/dataModel";

export const sessionIdAtom = atomWithStorage<Id<"sessions"> | null>(
  "automaton-sessionId",
  null,
  undefined,
  { getOnInit: true }
);

export const devModeAtom = atomWithStorage<boolean>(
  "automaton-devMode",
  true,
  undefined,
  { getOnInit: true }
);

export const sidebarOpenAtom = atomWithStorage<boolean>(
  "automaton-sidebarOpen",
  true,
  undefined,
  { getOnInit: true }
);

// For showing/hiding the node tree in sidebar
export const showNodeTreeAtom = atomWithStorage<boolean>(
  "automaton-showNodeTree",
  true,
  undefined,
  { getOnInit: true }
);

// Debug panel state
export const debugPanelOpenAtom = atom<boolean>(false);

// Selected turn for debugging
export const selectedDebugTurnAtom = atom<Id<"machineTurns"> | null>(null);
