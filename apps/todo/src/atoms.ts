import { atomWithStorage } from "jotai/utils";
import type { Id } from "../convex/_generated/dataModel";

export const sessionIdAtom = atomWithStorage<Id<"sessions"> | null>(
  "sessionId",
  null,
  undefined,
  { getOnInit: true }
);

export const devModeAtom = atomWithStorage<boolean>(
  "devMode",
  true, // default to on
  undefined,
  { getOnInit: true }
);
