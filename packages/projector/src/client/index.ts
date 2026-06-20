import * as z from "zod";
import { createRoot, directProjectionChildren, type ProjectionFrame, traversalFrames } from "../frames.ts";
import { encodeRuntimeAddress } from "../runtime-address.ts";
import { resolveFrameCommands } from "../scoped-actions.ts";
import { resolveStates, type ResolvedState } from "../state.ts";
import type {
  Action,
  Charter,
  Instance,
  NormalizedRuntime,
  RuntimeAddress,
  StateAddress,
  StateProjection,
} from "../types.ts";

export type JSONSchema = unknown;

export type CommandMessage = {
  type: "command";
  name: string;
  input: unknown;
  target?: RuntimeAddress;
  clientId?: string;
};

export type ClientMachineMessage = CommandMessage;

export type ExecuteCommandResult<T = unknown> =
  | { success: true; value?: T; clientId?: string }
  | { success: false; error: string; clientId?: string };

export type MachineClientSnapshot<TRoot = unknown> = {
  root: TRoot;
  recentCommandResidue: string[];
};

export type SendMachineMessage = (
  message: ClientMachineMessage,
) => unknown | Promise<unknown>;

export type MachineEffigy<TInstances = unknown> = {
  getInstances(): TInstances | undefined;
  setInstances(instances: TInstances): void;
  getRecentCommandResidue(): readonly string[];
  setRecentCommandResidue(ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  send(message: ClientMachineMessage): Promise<unknown>;
};

export type MachineSyncState = {
  recentCommandResidue: string[];
};

export type ClientRuntimeMeta = {
  type: NormalizedRuntime["type"];
  runtimeInstanceId: string;
  runtimeAddress: RuntimeAddress;
};

export type ClientStateView<TValue = unknown> = {
  key: string;
  address: StateAddress;
  value: TValue;
  schema?: JSONSchema;
  projection?: StateProjection;
};

export type ClientCommandMeta<
  TName extends string = string,
  TInput = unknown,
  TResult = unknown,
> = {
  name: TName;
  description?: string;
  inputSchema?: JSONSchema;
  target?: RuntimeAddress;
  __input?: TInput;
  __result?: TResult;
};

export type ClientInstance<
  TCommands extends ClientCommandMeta = ClientCommandMeta,
  TState = unknown,
> = {
  kind: "instance" | "member";
  id?: string;
  nodeKey: string;
  name?: string;
  runtime: ClientRuntimeMeta;
  states: ClientStateView<TState>[];
  commands: TCommands[];
  members: ClientInstance[];
  children: ClientInstance[];
};

export type AnyCommandDefinition = {
  name: string;
  inputSchema?: z.ZodType;
};

export type ClientCommandDefinitionName<TCommand> = TCommand extends {
  name: infer TName extends string;
}
  ? TName
  : string;

export type ClientCommandDefinitionInput<TCommand> = TCommand extends {
  inputSchema?: z.ZodType<infer TInput>;
}
  ? TInput
  : unknown;

export type ClientCommandOf<TCommand> = ClientCommandMeta<
  ClientCommandDefinitionName<TCommand>,
  ClientCommandDefinitionInput<TCommand>
>;

export type ClientStateOf<TStateDescriptor> = TStateDescriptor extends {
  schema: z.ZodType<infer TValue>;
}
  ? TValue
  : unknown;

export type ClientInstanceOf<TNode> = TNode extends {
  state?: infer TState;
  __commands?: infer TCommand;
}
  ? Omit<
      ClientInstance<ClientCommandOf<TCommand>, ClientStateOf<NonNullable<TState>>>,
      "members" | "children"
    > & {
      members: [];
      children: [];
    }
  : ClientInstance;

type IsNever<TValue> = [TValue] extends [never] ? true : false;

export type ClientCommandName<TInstances> =
  IsNever<ExtractClientCommands<TInstances>> extends true
    ? string
    : ExtractClientCommands<TInstances> extends infer TCommand
      ? TCommand extends { name: infer TName extends string }
        ? TName
        : string
      : string;

export type ClientCommandInput<TInstances, TName extends string> =
  IsNever<ExtractClientCommands<TInstances>> extends true
    ? unknown
    : ExtractClientCommands<TInstances> extends infer TCommand
      ? TCommand extends { name: TName; __input?: infer TInput }
        ? TInput
        : never
      : unknown;

export type ClientCommandHandle<
  TName extends string,
  TInput,
  TResult = unknown,
> = {
  name: TName;
  inputSchema: JSONSchema;
  run(input: TInput): Promise<TResult>;
  message(input: TInput): ClientMachineMessage;
};

export type ClientCommandOptions<TInstances, TName extends string> = {
  target?: RuntimeAddress;
  optimistic?: (
    ctx: OptimisticContext<TInstances>,
    input: ClientCommandInput<TInstances, TName>,
  ) => void;
};

export type OptimisticContext<TInstances = unknown> = {
  patch(patch: Record<string, unknown>): void;
  patchAt(address: StateAddress, patch: Record<string, unknown>): void;
  replaceAt(address: StateAddress, value: unknown): void;
  getInstances(): TInstances | undefined;
};

export type OptimisticEffigy<TInstances = unknown> = MachineEffigy<TInstances> & {
  getCommand<TName extends ClientCommandName<TInstances>>(
    name: TName,
    options?: ClientCommandOptions<TInstances, TName>,
  ): ClientCommandHandle<TName, ClientCommandInput<TInstances, TName>>;
  clearPending(): void;
};

type PendingOverlay<TInstances> = {
  clientId: string;
  apply(instances: TInstances | undefined): TInstances | undefined;
};

type ExtractClientCommands<TValue, TDepth extends readonly unknown[] = []> =
  TDepth["length"] extends 5
    ? never
    : TValue extends readonly (infer TItem)[]
      ? ExtractClientCommands<TItem, [...TDepth, unknown]>
      : TValue extends {
            commands: readonly (infer TCommand)[];
            members?: readonly (infer TMember)[];
            children?: readonly (infer TChild)[];
          }
        ?
            | TCommand
            | ExtractClientCommands<TMember, [...TDepth, unknown]>
            | ExtractClientCommands<TChild, [...TDepth, unknown]>
        : never;

export function createMachineEffigy<TInstances>(
  send: SendMachineMessage,
): MachineEffigy<TInstances> {
  let instances: TInstances | undefined;
  let recentCommandResidue: string[] = [];
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getInstances: () => instances,
    setInstances: (next) => {
      instances = next;
      notify();
    },
    getRecentCommandResidue: () => recentCommandResidue,
    setRecentCommandResidue: (ids) => {
      recentCommandResidue = [...ids];
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send: async (message) => send(message),
  };
}

export function createCommandMessage<TCommand extends AnyCommandDefinition>(
  name: ClientCommandDefinitionName<TCommand>,
  input: ClientCommandDefinitionInput<TCommand>,
  options: {
    target?: RuntimeAddress;
    clientId?: string;
  } = {},
): ClientMachineMessage {
  return {
    type: "command",
    name,
    input,
    target: options.target,
    clientId: options.clientId ?? createClientId(),
  };
}

export function createOptimisticEffigy<TInstances>(
  effigy: MachineEffigy<TInstances>,
): OptimisticEffigy<TInstances> {
  let pending: PendingOverlay<TInstances>[] = [];
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const retireResidue = () => {
    const residue = new Set(effigy.getRecentCommandResidue());
    if (residue.size === 0) {
      return;
    }
    pending = pending.filter((overlay) => !residue.has(overlay.clientId));
  };

  const getInstances = () => {
    retireResidue();
    let overlaid = cloneValue(effigy.getInstances());
    for (const overlay of pending) {
      overlaid = overlay.apply(overlaid);
    }
    return overlaid;
  };

  return {
    getInstances,
    setInstances: (instances) => {
      effigy.setInstances(instances);
      retireResidue();
    },
    getRecentCommandResidue: () => effigy.getRecentCommandResidue(),
    setRecentCommandResidue: (ids) => {
      effigy.setRecentCommandResidue(ids);
      retireResidue();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      const unsubscribeEffigy = effigy.subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribeEffigy();
      };
    },
    send: (message) => effigy.send(message),
    clearPending: () => {
      if (pending.length === 0) {
        return;
      }
      pending = [];
      notify();
    },
    getCommand: (name, options = {}) => {
      const command = findClientCommand(effigy.getInstances(), name, options.target);
      return {
        name,
        inputSchema: command?.inputSchema,
        message: (input) =>
          createUntypedCommandMessage(name, input, {
            target: options.target ?? command?.target,
          }),
        run: async (input) => {
          const message = createUntypedCommandMessage(name, input, {
            target: options.target ?? command?.target,
          });
          if (options.optimistic) {
            const overlay = createOverlay(
              message.clientId!,
              options.optimistic,
              input as ClientCommandInput<TInstances, typeof name>,
            );
            pending.push(overlay);
            notify();
          }
          try {
            return await effigy.send(message);
          } catch (error) {
            pending = pending.filter((overlay) => overlay.clientId !== message.clientId);
            notify();
            throw error;
          }
        },
      } satisfies ClientCommandHandle<typeof name, unknown>;
    },
  } as OptimisticEffigy<TInstances>;
}

export function createMachineSyncState(
  recentCommandResidue: readonly string[] = [],
  options: { limit?: number } = {},
): MachineSyncState {
  return {
    recentCommandResidue: boundResidue(recentCommandResidue, options.limit),
  };
}

export function recordCommandResidue(
  state: MachineSyncState,
  clientId: string | undefined,
  options: { limit?: number } = {},
): MachineSyncState {
  if (!clientId) {
    return createMachineSyncState(state.recentCommandResidue, options);
  }
  return createMachineSyncState([...state.recentCommandResidue, clientId], options);
}

export function consumeCommandResidue(
  state: MachineSyncState,
  clientIds: readonly string[],
): MachineSyncState {
  const consumed = new Set(clientIds);
  return {
    recentCommandResidue: state.recentCommandResidue.filter((id) => !consumed.has(id)),
  };
}

export function createMachineClientSnapshot<TInstances>(
  root: TInstances,
  syncState: MachineSyncState = createMachineSyncState(),
): MachineClientSnapshot<TInstances> {
  return {
    root,
    recentCommandResidue: [...syncState.recentCommandResidue],
  };
}

export function realizeClientInstances(
  instances: Instance | readonly Instance[],
  options: { charter?: Charter } = {},
): ClientInstance {
  const root: Instance = Array.isArray(instances)
    ? createRoot([...instances])
    : instances as Instance;
  const states = resolveStates(root);
  const statesByFrame = groupStatesByFrame(states);
  const frame = traversalFrames(root)[0];
  if (!frame) {
    throw new Error("Unable to realize empty client instance");
  }
  return realizeFrame(frame, statesByFrame, options.charter);
}

export function findClientCommand<TName extends string>(
  instances: unknown,
  name: TName,
  target?: RuntimeAddress,
): ClientCommandMeta<TName> | undefined {
  let match: ClientCommandMeta<TName> | undefined;

  walkClientInstances(instances, (instance) => {
    for (const command of instance.commands) {
      if (
        command.name === name &&
        (!target || (command.target && sameRuntimeAddress(command.target, target)))
      ) {
        match = command as ClientCommandMeta<TName>;
      }
    }
  });

  return match;
}

function realizeFrame(
  frame: ProjectionFrame,
  statesByFrame: Map<string, ResolvedState[]>,
  charter: Charter | undefined,
): ClientInstance {
  const memberFrames: ProjectionFrame[] = [];
  const childFrames: ProjectionFrame[] = [];
  for (const child of directProjectionChildren(frame)) {
    if (child.isMember) {
      memberFrames.push(child);
    } else {
      childFrames.push(child);
    }
  }

  return {
    kind: frame.isMember ? "member" : "instance",
    id: frame.isMember ? undefined : frame.concreteInstance.id,
    nodeKey: frame.node.key,
    name: frame.node.name,
    runtime: {
      type: frame.node.runtime.type,
      runtimeAddress: frame.address,
      runtimeInstanceId: frame.runtimeInstanceId,
    },
    states: (statesByFrame.get(frame.runtimeInstanceId) ?? []).map(realizeState),
    commands: resolveFrameCommands(frame, charter).map((command) =>
      realizeCommand(command, frame.address)
    ),
    members: memberFrames.map((member) => realizeFrame(member, statesByFrame, charter)),
    children: childFrames.map((child) => realizeFrame(child, statesByFrame, charter)),
  };
}

function realizeCommand(command: Action, target: RuntimeAddress): ClientCommandMeta {
  return {
    name: command.name,
    description: command.description,
    inputSchema: command.inputSchema ? z.toJSONSchema(command.inputSchema) : undefined,
    target,
  };
}

function realizeState(state: ResolvedState): ClientStateView {
  return {
    key: state.address.stateKey,
    address: state.address,
    value: state.container.value,
    schema: z.toJSONSchema(state.descriptor.schema),
    projection: state.descriptor.projection,
  };
}

function groupStatesByFrame(states: ResolvedState[]): Map<string, ResolvedState[]> {
  const grouped = new Map<string, ResolvedState[]>();
  for (const state of states) {
    const frameKey = stateProjectionFrameKey(state);
    const list = grouped.get(frameKey) ?? [];
    list.push(state);
    grouped.set(frameKey, list);
  }
  return grouped;
}

function stateProjectionFrameKey(state: ResolvedState): string {
  if (state.descriptor.scope === "top") {
    return encodeRuntimeAddress({
      type: "instance",
      instanceId: state.targetInstance.id,
    });
  }

  return state.sourceFrame.runtimeInstanceId;
}

function createOverlay<TInstances, TName extends string>(
  clientId: string,
  optimistic: (
    ctx: OptimisticContext<TInstances>,
    input: ClientCommandInput<TInstances, TName>,
  ) => void,
  input: ClientCommandInput<TInstances, TName>,
): PendingOverlay<TInstances> {
  return {
    clientId,
    apply: (instances) => {
      const draft = cloneValue(instances);
      const ctx = createOptimisticContext(draft);
      optimistic(ctx, input);
      return ctx.getInstances();
    },
  };
}

function createOptimisticContext<TInstances>(
  draft: TInstances | undefined,
): OptimisticContext<TInstances> {
  let instances = draft;
  return {
    patch: (patch) => {
      const state = firstStateView(instances);
      if (!state) {
        return;
      }
      state.value = patchObject(state.value, patch);
    },
    patchAt: (address, patch) => {
      const state = findStateView(instances, address);
      if (!state) {
        return;
      }
      state.value = patchObject(state.value, patch);
    },
    replaceAt: (address, value) => {
      const state = findStateView(instances, address);
      if (!state) {
        return;
      }
      state.value = value;
    },
    getInstances: () => instances,
  };
}

function createUntypedCommandMessage(
  name: string,
  input: unknown,
  options: { target?: RuntimeAddress } = {},
): ClientMachineMessage {
  return {
    type: "command",
    name,
    input,
    target: options.target,
    clientId: createClientId(),
  };
}

function walkClientInstances(
  instances: unknown,
  visitor: (instance: ClientInstance) => void,
): void {
  if (Array.isArray(instances)) {
    for (const item of instances) {
      walkClientInstances(item, visitor);
    }
    return;
  }

  if (!isClientInstance(instances)) {
    return;
  }

  visitor(instances);
  for (const member of instances.members) {
    walkClientInstances(member, visitor);
  }
  for (const child of instances.children) {
    walkClientInstances(child, visitor);
  }
}

function firstStateView(instances: unknown): ClientStateView | undefined {
  let found: ClientStateView | undefined;
  walkClientInstances(instances, (instance) => {
    found ??= instance.states[0];
  });
  return found;
}

function findStateView(
  instances: unknown,
  address: StateAddress,
): ClientStateView | undefined {
  let found: ClientStateView | undefined;
  walkClientInstances(instances, (instance) => {
    found ??= instance.states.find(
      (state) =>
        state.address.instanceId === address.instanceId &&
        state.address.stateKey === address.stateKey,
    );
  });
  return found;
}

function isClientInstance(value: unknown): value is ClientInstance {
  return Boolean(
    value &&
      typeof value === "object" &&
      "commands" in value &&
      "members" in value &&
      "children" in value &&
      "runtime" in value,
  );
}

function patchObject(value: unknown, patch: Record<string, unknown>): unknown {
  return {
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
    ...patch,
  };
}

function sameRuntimeAddress(a: RuntimeAddress, b: RuntimeAddress): boolean {
  return encodeRuntimeAddress(a) === encodeRuntimeAddress(b);
}

function boundResidue(ids: readonly string[], limit = 100): string[] {
  const unique: string[] = [];
  for (const id of ids) {
    const existing = unique.indexOf(id);
    if (existing >= 0) {
      unique.splice(existing, 1);
    }
    unique.push(id);
  }
  return unique.slice(-limit);
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function createClientId(): string {
  const cryptoWithRandomUuid = globalThis.crypto as
    | (Crypto & { randomUUID?: () => `${string}-${string}-${string}-${string}-${string}` })
    | undefined;
  if (cryptoWithRandomUuid?.randomUUID) {
    return cryptoWithRandomUuid.randomUUID();
  }
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
