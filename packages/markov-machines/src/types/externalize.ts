import type { MachineStep } from "../executor/types";
import type { InstanceMessage, PackStateUpdatePayload, StateUpdatePayload } from "./messages";

/**
 * Scope identity for externalized state handlers.
 */
export type ExternalScope =
  | {
      kind: "pack";
      id: string;
      packName: string;
      rootInstanceId: string;
    }
  | {
      kind: "node";
      id: string;
      instanceId: string;
      nodeId: string;
      rootInstanceId: string;
    };

/**
 * Event emitted when an instance message mutates state.
 * This is the normalized unit for syncing externalized state.
 */
export interface ExternalStateMutationEvent<S = unknown, AppMessage = unknown> {
  /** Scope this mutation targets */
  scope: ExternalScope;
  /** Current local state at dispatch time */
  state: S;
  /** Partial patch requested by the runtime */
  patch: Record<string, unknown>;
  /** Original instance message payload */
  payload: StateUpdatePayload | PackStateUpdatePayload;
  /** Full instance message */
  message: InstanceMessage<AppMessage>;
  /** Step number where this mutation was observed */
  stepNumber: number;
  /** Monotonic sequence within this machine runtime */
  sequence: number;
}

/**
 * Options for applying externalized state back into runtime.
 */
export interface ExternalSetStateOptions {
  /** patch = shallow merge, replace = replace full state */
  mode?: "patch" | "replace";
  /** Optional external revision/version for conflict handling */
  revision?: number;
  /** Source attribution for diagnostics */
  source?: "external" | "optimistic";
}

/**
 * Context passed to externalized state handlers.
 * Works identically for pack and node scopes.
 */
export interface ExternalStateHandlerContext<S = unknown, AppMessage = unknown> {
  scope: ExternalScope;
  getState: () => S;
  setState: (next: Partial<S> | S, options?: ExternalSetStateOptions) => void;
  onMutation: (cb: (state: S, event: ExternalStateMutationEvent<S, AppMessage>) => void | Promise<void>) => void;
  /** Alias for onMutation for ergonomic parity with prior proposal */
  onInstanceMessage: (
    cb: (state: S, event: ExternalStateMutationEvent<S, AppMessage>) => void | Promise<void>
  ) => void;
  onStep: (
    cb: (
      step: MachineStep<AppMessage>,
      events: ExternalStateMutationEvent<S, AppMessage>[],
    ) => void | Promise<void>,
  ) => void;
  onHydrate: (cb: () => void | Promise<void>) => void;
}

/**
 * External state handler. Return cleanup to unsubscribe listeners.
 */
export type ExternalStateHandler<S = unknown, AppMessage = unknown> = (
  ctx: ExternalStateHandlerContext<S, AppMessage>,
) => void | (() => void);

/**
 * Externalization config for state ownership.
 */
export interface ExternalizeStateConfig<S = unknown, AppMessage = unknown> {
  state: ExternalStateHandler<S, AppMessage>;
}

/**
 * Runtime interface attached to Machine for dispatching externalized state events.
 */
export interface ExternalizeRuntime<AppMessage = unknown> {
  syncRegistrations: () => void;
  consumeInstanceMessage: (
    message: InstanceMessage<AppMessage>,
    stepNumber: number,
  ) => ExternalStateMutationEvent<unknown, AppMessage> | undefined;
  notifyStep: (
    step: MachineStep<AppMessage>,
    events: ExternalStateMutationEvent<unknown, AppMessage>[],
  ) => void;
  dispose: () => void;
}

