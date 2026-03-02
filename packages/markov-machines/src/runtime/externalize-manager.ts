import type { MachineStep } from "../executor/types";
import { findInstanceById, getAllInstances, type Instance } from "../types/instance";
import type { Machine } from "../types/machine";
import type {
  ExternalizeRuntime,
  ExternalScope,
  ExternalSetStateOptions,
  ExternalStateHandler,
  ExternalStateMutationEvent,
} from "../types/externalize";
import type { InstanceMessage, PackStateUpdatePayload, StateUpdatePayload } from "../types/messages";
import type { Pack } from "../types/pack";
import { updateState } from "./state-manager";

interface DesiredRegistration<AppMessage = unknown> {
  id: string;
  scope: ExternalScope;
  handler: ExternalStateHandler<unknown, AppMessage>;
}

interface Registration<AppMessage = unknown> extends DesiredRegistration<AppMessage> {
  onMutationCallbacks: Array<
    (
      state: unknown,
      event: ExternalStateMutationEvent<unknown, AppMessage>,
    ) => void | Promise<void>
  >;
  onStepCallbacks: Array<
    (
      step: MachineStep<AppMessage>,
      events: ExternalStateMutationEvent<unknown, AppMessage>[],
    ) => void | Promise<void>
  >;
  onHydrateCallbacks: Array<() => void | Promise<void>>;
  cleanup?: () => void;
}

function updateInstanceById(
  root: Instance,
  targetId: string,
  updater: (inst: Instance) => Instance,
): Instance {
  if (root.id === targetId) {
    return updater(root);
  }
  const children = root.children;
  if (!children || children.length === 0) {
    return root;
  }
  return {
    ...root,
    children: children.map((child) => updateInstanceById(child, targetId, updater)),
  };
}

function safeInvoke(
  cb: () => void | Promise<void>,
  logContext: string,
): Promise<void> {
  return Promise.resolve(cb()).catch((error) => {
    console.error(`[externalize] ${logContext}:`, error);
  });
}

export function createExternalizeRuntime<AppMessage = unknown>(
  machine: Machine<AppMessage>,
): ExternalizeRuntime<AppMessage> {
  const registrations = new Map<string, Registration<AppMessage>>();
  let mutationSequence = 0;

  const resolvePackByName = (packName: string): Pack | undefined => {
    const charterPack = machine.charter.packs.find((pack) => pack.name === packName);
    if (charterPack) return charterPack;
    const instancePacks = machine.instance.packs ?? machine.instance.node.packs ?? [];
    return instancePacks.find((pack) => pack.name === packName);
  };

  const readScopeState = (scope: ExternalScope): unknown => {
    if (scope.kind === "pack") {
      return machine.instance.packStates?.[scope.packName];
    }
    const instance = findInstanceById(machine.instance, scope.instanceId);
    if (!instance) {
      throw new Error(`Externalized node instance not found: ${scope.instanceId}`);
    }
    return instance.state;
  };

  const setScopeState = (
    scope: ExternalScope,
    next: unknown,
    options?: ExternalSetStateOptions,
  ): void => {
    const mode = options?.mode ?? "patch";

    if (scope.kind === "pack") {
      const pack = resolvePackByName(scope.packName);
      if (!pack) {
        throw new Error(`Externalized pack not found: ${scope.packName}`);
      }
      const currentPackStates = machine.instance.packStates ?? {};
      const currentState = currentPackStates[scope.packName] ?? pack.initialState ?? {};
      let nextState: unknown;
      if (mode === "replace") {
        const parsed = pack.validator.safeParse(next);
        if (!parsed.success) {
          throw new Error(
            `Externalized pack state validation failed (${scope.packName}): ${parsed.error.message}`,
          );
        }
        nextState = parsed.data;
      } else {
        const result = updateState(
          currentState as Record<string, unknown>,
          next as Partial<Record<string, unknown>>,
          pack.validator as any,
        );
        if (!result.success) {
          throw new Error(
            `Externalized pack state validation failed (${scope.packName}): ${result.error}`,
          );
        }
        nextState = result.state;
      }
      machine.instance = {
        ...machine.instance,
        packStates: {
          ...currentPackStates,
          [scope.packName]: nextState,
        },
      };
      return;
    }

    const instance = findInstanceById(machine.instance, scope.instanceId);
    if (!instance) {
      throw new Error(`Externalized node instance not found: ${scope.instanceId}`);
    }
    let nextState: unknown;
    if (mode === "replace") {
      const parsed = instance.node.validator.safeParse(next);
      if (!parsed.success) {
        throw new Error(
          `Externalized node state validation failed (${scope.instanceId}): ${parsed.error.message}`,
        );
      }
      nextState = parsed.data;
    } else {
      const result = updateState(
        instance.state as Record<string, unknown>,
        next as Partial<Record<string, unknown>>,
        instance.node.validator as any,
      );
      if (!result.success) {
        throw new Error(
          `Externalized node state validation failed (${scope.instanceId}): ${result.error}`,
        );
      }
      nextState = result.state;
    }
    machine.instance = updateInstanceById(
      machine.instance,
      scope.instanceId,
      (target) => ({ ...target, state: nextState }),
    );
  };

  const buildDesiredRegistrations = (): Map<string, DesiredRegistration<AppMessage>> => {
    const desired = new Map<string, DesiredRegistration<AppMessage>>();
    const rootInstanceId = machine.instance.id;

    const packsByName = new Map<string, Pack>();
    for (const pack of machine.charter.packs) {
      packsByName.set(pack.name, pack);
    }
    for (const pack of machine.instance.packs ?? machine.instance.node.packs ?? []) {
      if (!packsByName.has(pack.name)) {
        packsByName.set(pack.name, pack);
      }
    }

    for (const pack of packsByName.values()) {
      const handler = pack.externalize?.state as ExternalStateHandler<unknown, AppMessage> | undefined;
      if (!handler) continue;
      const scope: ExternalScope = {
        kind: "pack",
        id: `pack:${pack.name}`,
        packName: pack.name,
        rootInstanceId,
      };
      desired.set(scope.id, {
        id: scope.id,
        scope,
        handler,
      });
    }

    for (const instance of getAllInstances(machine.instance)) {
      const handler = instance.node.externalize?.state as ExternalStateHandler<unknown, AppMessage> | undefined;
      if (!handler) continue;
      const scope: ExternalScope = {
        kind: "node",
        id: `node:${instance.id}`,
        instanceId: instance.id,
        nodeId: instance.node.id,
        rootInstanceId,
      };
      desired.set(scope.id, {
        id: scope.id,
        scope,
        handler,
      });
    }

    return desired;
  };

  const register = (desired: DesiredRegistration<AppMessage>): void => {
    const registration: Registration<AppMessage> = {
      ...desired,
      onMutationCallbacks: [],
      onStepCallbacks: [],
      onHydrateCallbacks: [],
    };

    const ctx = {
      scope: desired.scope,
      getState: () => readScopeState(desired.scope),
      setState: (next: unknown, options?: ExternalSetStateOptions) => {
        setScopeState(desired.scope, next, options);
      },
      onMutation: (
        cb: (
          state: unknown,
          event: ExternalStateMutationEvent<unknown, AppMessage>,
        ) => void | Promise<void>,
      ) => {
        registration.onMutationCallbacks.push(cb);
      },
      onInstanceMessage: (
        cb: (
          state: unknown,
          event: ExternalStateMutationEvent<unknown, AppMessage>,
        ) => void | Promise<void>,
      ) => {
        registration.onMutationCallbacks.push(cb);
      },
      onStep: (
        cb: (
          step: MachineStep<AppMessage>,
          events: ExternalStateMutationEvent<unknown, AppMessage>[],
        ) => void | Promise<void>,
      ) => {
        registration.onStepCallbacks.push(cb);
      },
      onHydrate: (cb: () => void | Promise<void>) => {
        registration.onHydrateCallbacks.push(cb);
      },
    };

    registrations.set(desired.id, registration);

    try {
      const cleanup = desired.handler(ctx as any);
      if (typeof cleanup === "function") {
        registration.cleanup = cleanup;
      }
      for (const cb of registration.onHydrateCallbacks) {
        safeInvoke(() => cb(), `onHydrate callback failed for ${desired.id}`);
      }
    } catch (error) {
      console.error(`[externalize] Failed to initialize handler for ${desired.id}:`, error);
      registrations.delete(desired.id);
      try {
        registration.cleanup?.();
      } catch (cleanupError) {
        console.error(`[externalize] Cleanup failed for ${desired.id}:`, cleanupError);
      }
    }
  };

  const unregister = (id: string): void => {
    const registration = registrations.get(id);
    if (!registration) return;
    registrations.delete(id);
    try {
      registration.cleanup?.();
    } catch (error) {
      console.error(`[externalize] Cleanup failed for ${id}:`, error);
    }
  };

  const syncRegistrations = (): void => {
    const desired = buildDesiredRegistrations();

    for (const [id, registration] of registrations) {
      const target = desired.get(id);
      if (!target || target.handler !== registration.handler) {
        unregister(id);
      }
    }

    for (const [id, target] of desired) {
      if (!registrations.has(id)) {
        register(target);
      }
    }
  };

  const consumeInstanceMessage = (
    message: InstanceMessage<AppMessage>,
    stepNumber: number,
  ): ExternalStateMutationEvent<unknown, AppMessage> | undefined => {
    const payload = message.items;
    let scopeId: string | undefined;
    let patch: Record<string, unknown> | undefined;

    if (payload.kind === "state") {
      scopeId = `node:${payload.instanceId}`;
      patch = payload.patch;
    } else if (payload.kind === "packState") {
      scopeId = `pack:${payload.packName}`;
      patch = payload.patch;
    } else {
      return undefined;
    }

    const registration = registrations.get(scopeId);
    if (!registration) {
      return undefined;
    }

    const event: ExternalStateMutationEvent<unknown, AppMessage> = {
      scope: registration.scope,
      state: readScopeState(registration.scope),
      patch,
      payload: payload as StateUpdatePayload | PackStateUpdatePayload,
      message,
      stepNumber,
      sequence: ++mutationSequence,
    };

    for (const cb of registration.onMutationCallbacks) {
      safeInvoke(
        () => cb(event.state, event),
        `onMutation callback failed for ${registration.id}`,
      );
    }

    return event;
  };

  const notifyStep = (
    step: MachineStep<AppMessage>,
    events: ExternalStateMutationEvent<unknown, AppMessage>[],
  ): void => {
    for (const registration of registrations.values()) {
      const scopeEvents = events.filter((event) => event.scope.id === registration.scope.id);
      for (const cb of registration.onStepCallbacks) {
        safeInvoke(
          () => cb(step, scopeEvents),
          `onStep callback failed for ${registration.id}`,
        );
      }
    }
  };

  const dispose = (): void => {
    for (const id of [...registrations.keys()]) {
      unregister(id);
    }
  };

  return {
    syncRegistrations,
    consumeInstanceMessage,
    notifyStep,
    dispose,
  };
}
