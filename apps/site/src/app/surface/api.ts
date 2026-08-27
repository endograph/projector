// The api handed to agent-authored surfaces. Deliberately thin: it IS the
// optimistic effigy — the same client-side stand-in for the machine that the
// pane toggles use — so surfaces read projected state and run real machine
// commands with no side channel. Surfaces own zero data; this is their only
// window on the world.

import { useSyncExternalStore } from "react";
import type { OptimisticEffigy, StateAddress, StateUpdate } from "@projectors/core/client";

export type SurfaceRunOptions = {
  /**
   * updateState applies optimistically by default — the projection reflects
   * the write instantly and reconciles when the durable frame lands (or the
   * server rejects it). Pass false when last-write-wins prediction is wrong:
   * shared/multiplayer state, server-arbitrated values.
   */
  optimistic?: boolean;
};

export type SurfaceApi = {
  /** Current projected client instance tree (states, commands, children). */
  machine(): unknown;
  /** Hook form: re-renders the surface when the projection changes. */
  useMachine(): unknown;
  /** Execute a machine command (external caller), e.g. api.run("setPanes", { app: false }). */
  run(name: string, input?: unknown, options?: SurfaceRunOptions): Promise<unknown>;
};

export type SurfaceApiEvents = {
  onStateUpdateRejected?: (event: { error: unknown; input: unknown }) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSurfaceApi(
  effigy: OptimisticEffigy<any>,
  events: SurfaceApiEvents = {},
): SurfaceApi {
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
    run: async (name, input, options) => {
      try {
        // updateState's input IS its effect, so the client can run the exact
        // same fold the machine will — prediction and durable truth can't
        // diverge for a valid write. Other commands hide their effect
        // server-side and stay non-optimistic.
        const update = name === "updateState" && options?.optimistic !== false
          ? readStateUpdateInput(input)
          : null;
        const command = effigy.getCommand(name as never, update
          ? { optimistic: (ctx) => ctx.updateAt(update.address, update.update) }
          : undefined);
        const result = await command.run(input as never);
        const failure = readCommandFailure(result);
        if (failure) throw new Error(failure);
        return result;
      } catch (error) {
        if (name === "updateState") events.onStateUpdateRejected?.({ error, input });
        throw error;
      }
    },
  };
}

function readCommandFailure(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const candidate = result as { success?: unknown; error?: unknown };
  return candidate.success === false && typeof candidate.error === "string"
    ? candidate.error
    : undefined;
}

// Mirrors the charter's updateState action: {address, op, value, values, path}
// → the machine StateUpdate its run() enqueues.
function readStateUpdateInput(
  input: unknown,
): { address: StateAddress; update: StateUpdate } | null {
  if (!input || typeof input !== "object") return null;
  const record = input as {
    address?: StateAddress;
    op?: string;
    value?: unknown;
    values?: unknown[];
    path?: Array<string | number>;
  };
  const address = record.address;
  if (!address) return null;
  if (record.op === "replace") {
    return { address, update: { op: "replace", value: record.value } };
  }
  if (record.op === "patch") {
    return {
      address,
      update: {
        op: "patch",
        value: (record.value ?? {}) as Record<string, unknown>,
        ...(record.path ? { path: record.path } : {}),
      },
    };
  }
  if (record.op === "append") {
    return {
      address,
      update: {
        op: "append",
        values: record.values ?? [record.value],
        ...(record.path ? { path: record.path } : {}),
      },
    };
  }
  return null;
}
