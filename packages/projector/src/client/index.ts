import * as z from "zod";
import {
  collectContributors,
  createRootInstance,
  directContributorChildren,
  type Contributor,
} from "../contributors.ts";
import { encodeProjectionAddress } from "../projection-address.ts";
import { callerAllows, resolveContributorActions, type ResolvedNodeAction } from "../scoped-actions.ts";
import { groupStatesByContributor, resolveStates, type ResolvedState } from "../state.ts";
import type {
  Action,
  ActionRequestMessage,
  ExecuteActionResult,
  Charter,
  Instance,
  NormalizedRuntime,
  ProjectionAddress,
  StateAddress,
  Exposure,
} from "../types.ts";

export type JSONSchema = unknown;

export type ClientMachineMessage = ActionRequestMessage & { action: "command" };
export type { ActionRequestMessage, ExecuteActionResult };

export type MachineClientSnapshot<TInstance = unknown> = {
  instance: TInstance;
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

export type ClientContributorMeta = {
  id: string;
  address: ProjectionAddress;
  runtimeType: NormalizedRuntime["type"];
};

export type ClientStateView<TValue = unknown> = {
  key: string;
  address: StateAddress;
  value: TValue;
  schema?: JSONSchema;
  projection?: { exposure: Exposure };
};

export type ClientCommandMeta<
  TName extends string = string,
  TInput = unknown,
  TResult = unknown,
> = {
  name: TName;
  description?: string;
  inputSchema?: JSONSchema;
  target?: ProjectionAddress;
  __input?: TInput;
  __result?: TResult;
};

export type ClientToolMeta<
  TName extends string = string,
  TInput = unknown,
> = {
  name: TName;
  description?: string;
  inputSchema?: JSONSchema;
  exposure: Exposure;
  target?: ProjectionAddress;
  __input?: TInput;
};

export type ClientInstance<
  TCommands extends ClientCommandMeta = ClientCommandMeta,
  TState = unknown,
  TTools extends ClientToolMeta = ClientToolMeta,
> = {
  kind: "instance" | "member";
  id?: string;
  nodeKey: string;
  name?: string;
  contributor: ClientContributorMeta;
  states: ClientStateView<TState>[];
  tools: TTools[];
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

export type ClientToolOf<TTool> = ClientToolMeta<
  ClientCommandDefinitionName<TTool>,
  ClientCommandDefinitionInput<TTool>
>;

export type ClientStateOf<TStateDescriptor> = TStateDescriptor extends {
  schema: z.ZodType<infer TValue>;
}
  ? TValue
  : unknown;

/** Union of the state value types a node's `states` declarations carry. */
export type ClientStatesOf<TConfig> = TConfig extends {
  states: readonly (infer TStateDescriptor)[];
}
  ? [TStateDescriptor] extends [never]
    ? unknown
    : ClientStateOf<TStateDescriptor>
  : unknown;

export type ClientInstanceOf<TNode> = TNode extends {
  __config: infer TConfig;
  __commands?: infer TCommand;
  __tools?: infer TTool;
}
  ? Omit<
      ClientInstance<
        ClientCommandOf<TCommand>,
        ClientStatesOf<TConfig>,
        ClientToolOf<TTool>
      >,
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
  target?: ProjectionAddress;
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
  getPendingCommands(): PendingOptimisticCommand[];
  clearPending(): void;
};

export type PendingOptimisticCommand = {
  callId: string;
  name: string;
  target?: ProjectionAddress;
};

type PendingOverlay<TInstances> = {
  callId: string;
  name: string;
  target?: ProjectionAddress;
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

export function createCommandActionRequest<TCommand extends AnyCommandDefinition>(
  name: ClientCommandDefinitionName<TCommand>,
  input: ClientCommandDefinitionInput<TCommand>,
  options: {
    target?: ProjectionAddress;
    callId?: string;
  } = {},
): ClientMachineMessage {
  return {
    type: "action",
    kind: "request",
    action: "command",
    name,
    input,
    target: options.target,
    callId: options.callId ?? createCallId(),
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
      return false;
    }
    const before = pending.length;
    pending = pending.filter((overlay) => !residue.has(overlay.callId));
    return pending.length !== before;
  };

  const getInstances = () => {
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
      if (retireResidue()) {
        notify();
      }
    },
    getRecentCommandResidue: () => effigy.getRecentCommandResidue(),
    getPendingCommands: () =>
      pending.map(({ callId, name, target }) => ({ callId, name, target })),
    setRecentCommandResidue: (ids) => {
      effigy.setRecentCommandResidue(ids);
      if (retireResidue()) {
        notify();
      }
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
          createUntypedCommandActionRequest(name, input, {
            target: options.target ?? command?.target,
          }),
        run: async (input) => {
          const message = createUntypedCommandActionRequest(name, input, {
            target: options.target ?? command?.target,
          });
          if (options.optimistic) {
            const overlay = createOverlay(
              message.callId,
              name,
              options.target ?? command?.target,
              options.optimistic,
              input as ClientCommandInput<TInstances, typeof name>,
            );
            pending.push(overlay);
            notify();
          }
          try {
            return await effigy.send(message);
          } catch (error) {
            pending = pending.filter((overlay) => overlay.callId !== message.callId);
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
  callId: string | undefined,
  options: { limit?: number } = {},
): MachineSyncState {
  if (!callId) {
    return createMachineSyncState(state.recentCommandResidue, options);
  }
  return createMachineSyncState([...state.recentCommandResidue, callId], options);
}

export function consumeCommandResidue(
  state: MachineSyncState,
  callIds: readonly string[],
): MachineSyncState {
  const consumed = new Set(callIds);
  return {
    recentCommandResidue: state.recentCommandResidue.filter((id) => !consumed.has(id)),
  };
}

export function createMachineClientSnapshot<TInstances>(
  instance: TInstances,
  syncState: MachineSyncState = createMachineSyncState(),
): MachineClientSnapshot<TInstances> {
  return {
    instance,
    recentCommandResidue: [...syncState.recentCommandResidue],
  };
}

export function realizeClientInstances(
  instances: Instance | readonly Instance[],
  options: { charter?: Charter } = {},
): ClientInstance {
  const root: Instance = Array.isArray(instances)
    ? createRootInstance([...instances])
    : instances as Instance;
  const states = resolveStates(root);
  const statesByContributor = groupStatesByContributor(states);
  const rootContributor = collectContributors(root)[0];
  if (!rootContributor) {
    throw new Error("Unable to realize empty client instance");
  }
  return realizeContributor(rootContributor, statesByContributor, options.charter);
}

export function findClientCommand<TName extends string>(
  instances: unknown,
  name: TName,
  target?: ProjectionAddress,
): ClientCommandMeta<TName> | undefined {
  let match: ClientCommandMeta<TName> | undefined;

  walkClientInstances(instances, (instance) => {
    for (const command of instance.commands) {
      if (
        command.name === name &&
        (!target || (command.target && sameProjectionAddress(command.target, target)))
      ) {
        match = command as ClientCommandMeta<TName>;
      }
    }
  });

  return match;
}

function realizeContributor(
  contributor: Contributor,
  statesByContributor: Map<string, ResolvedState[]>,
  charter: Charter | undefined,
): ClientInstance {
  const memberNodes: Contributor[] = [];
  const childNodes: Contributor[] = [];
  for (const child of directContributorChildren(contributor)) {
    if (child.isMember) {
      memberNodes.push(child);
    } else {
      childNodes.push(child);
    }
  }

  return {
    kind: contributor.isMember ? "member" : "instance",
    id: contributor.isMember ? undefined : contributor.concreteInstance.id,
    nodeKey: contributor.node.key,
    name: contributor.node.name,
    contributor: {
      id: contributor.id,
      address: contributor.address,
      runtimeType: contributor.node.runtime.type,
    },
    states: (statesByContributor.get(contributor.id) ?? []).map(realizeState),
    tools: clientActions(contributor, charter, "generator").map((entry) =>
      realizeTool(entry, contributor.address)
    ),
    commands: clientActions(contributor, charter, "external").map((entry) =>
      realizeCommand(entry.action, contributor.address)
    ),
    members: memberNodes.map((member) =>
      realizeContributor(member, statesByContributor, charter)
    ),
    children: childNodes.map((child) =>
      realizeContributor(child, statesByContributor, charter)
    ),
  };
}

function clientActions(
  contributor: Contributor,
  charter: Charter | undefined,
  requirement: "generator" | "external",
): ResolvedNodeAction[] {
  return resolveContributorActions(contributor, charter)
    .filter((entry) => callerAllows(entry.caller, requirement));
}

function realizeTool(entry: ResolvedNodeAction, target: ProjectionAddress): ClientToolMeta {
  return {
    name: entry.action.name,
    description: entry.action.description,
    inputSchema: entry.action.inputSchema ? z.toJSONSchema(entry.action.inputSchema) : undefined,
    exposure: entry.exposure,
    target,
  };
}

function realizeCommand(command: Action, target: ProjectionAddress): ClientCommandMeta {
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
    projection: state.descriptor.projection
      ? { exposure: state.descriptor.projection.exposure ?? "native" }
      : undefined,
  };
}

function createOverlay<TInstances, TName extends string>(
  callId: string,
  name: string,
  target: ProjectionAddress | undefined,
  optimistic: (
    ctx: OptimisticContext<TInstances>,
    input: ClientCommandInput<TInstances, TName>,
  ) => void,
  input: ClientCommandInput<TInstances, TName>,
): PendingOverlay<TInstances> {
  return {
    callId,
    name,
    target,
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

function createUntypedCommandActionRequest(
  name: string,
  input: unknown,
  options: { target?: ProjectionAddress } = {},
): ClientMachineMessage {
  return {
    type: "action",
    kind: "request",
    action: "command",
    name,
    input,
    target: options.target,
    callId: createCallId(),
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
      "contributor" in value,
  );
}

function patchObject(value: unknown, patch: Record<string, unknown>): unknown {
  return {
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
    ...patch,
  };
}

function sameProjectionAddress(a: ProjectionAddress, b: ProjectionAddress): boolean {
  return encodeProjectionAddress(a) === encodeProjectionAddress(b);
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

function createCallId(): string {
  const cryptoWithRandomUuid = globalThis.crypto as
    | (Crypto & { randomUUID?: () => `${string}-${string}-${string}-${string}-${string}` })
    | undefined;
  if (cryptoWithRandomUuid?.randomUUID) {
    return cryptoWithRandomUuid.randomUUID();
  }
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
