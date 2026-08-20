// The api handed to agent-authored surfaces. Deliberately thin: it IS the
// optimistic effigy — the same client-side stand-in for the machine that the
// pane toggles use — so surfaces read projected state and run real machine
// commands with no side channel. Surfaces own zero data; this is their only
// window on the world.

import { useSyncExternalStore } from "react";
import type { OptimisticEffigy } from "@projectors/core/client";

export type SurfaceApi = {
  /** Current projected client instance tree (states, commands, children). */
  machine(): unknown;
  /** Hook form: re-renders the surface when the projection changes. */
  useMachine(): unknown;
  /** Execute a machine command (external caller), e.g. api.run("setPanes", { app: false }). */
  run(name: string, input?: unknown): Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSurfaceApi(effigy: OptimisticEffigy<any>): SurfaceApi {
  // Snapshot cache, invalidated on effigy notifications. The optimistic
  // effigy materializes a fresh overlay object on every getInstances() call;
  // useSyncExternalStore requires a stable snapshot between store events or
  // it re-renders forever ("Maximum update depth exceeded").
  let snapshot: unknown;
  let fresh = false;
  const read = () => {
    if (!fresh) {
      snapshot = effigy.getInstances();
      fresh = true;
    }
    return snapshot;
  };
  const subscribe = (onChange: () => void) =>
    effigy.subscribe(() => {
      fresh = false;
      onChange();
    });

  return {
    machine: read,
    useMachine: () =>
      // Called from surface component render bodies; the hook comes from the
      // host's React, which is the only React in the page.
      useSyncExternalStore(subscribe, read),
    run: async (name, input) => {
      const command = effigy.getCommand(name as never);
      return await command.run(input as never);
    },
  };
}
