import {
  assertNodeActionStateCompatibility,
  createUnboundActionContext,
  getActionBinding,
} from "./actions.ts";
import {
  assertUniqueInstanceIds,
  findFrameByRuntimeId,
  topStateInstance,
  traversalFrames,
  type ProjectionFrame,
} from "./frames.ts";
import {
  assistantMessageFromTextOutput,
  createActivationFrame,
  createCompletionFrame,
  isWorkActivationMessage,
  isWorkCompletionMessage,
} from "./history.ts";
import {
  isHistoryProjectionFunction,
  isProjectionFunction,
} from "./projection-functions.ts";
import { encodeRuntimeAddress } from "./runtime-address.ts";
import { resolveFrameCommands, resolveFrameTools } from "./scoped-actions.ts";
import { hydrateInstance, hydrateNode, serializeInstance, serializeNode } from "./serialization.ts";
import { resolveStates } from "./state.ts";
import { actorMessageVisibleToRuntime, isActorMessage } from "./visibility.ts";
import type {
  ActionContext,
  ActorMessage,
  AnyAction,
  Charter,
  CompiledInference,
  CommandMessage,
  ExecutorRunRequest,
  ExecutorRunResult,
  Frame,
  FrameDraft,
  FrameMessage,
  Generator,
  GeneratorId,
  Instance,
  InstanceMessage,
  NormalizedRuntime,
  OutputConfig,
  PrimaryRuntime,
  RetrievableState,
  RuntimeConcurrency,
  RuntimeInstanceId,
  RuntimeTrigger,
  SerializedInstance,
  SerializedNodeRef,
  SpawnChild,
  StateAddress,
  StateKey,
  StatePath,
  StateUpdate,
  WorkerRuntime,
  WorkActivationMessage,
  WorkCompletionMessage,
  WorkCompletionReason,
} from "./types.ts";
import { compileProjection } from "./compile.ts";

export type Machine<TDataContent = never> = {
  id: string;
  root: Instance<TDataContent>;
  charter: Charter<TDataContent>;
  frames: Frame<TDataContent>[];
  enqueueFrame(frame: FrameDraft<TDataContent> | Frame<TDataContent>): Frame<TDataContent>;
  ingestInertFrame(frame: Frame<TDataContent>): void;
  subscribe(listener: (frame: Frame<TDataContent>) => void): () => void;
};

export type MachineOptions<TDataContent = never> = {
  id?: string;
  root: Instance<TDataContent>;
  charter: Charter<TDataContent>;
  frames?: Frame<TDataContent>[];
};

export type Activation = WorkActivationMessage & {
  kind: "activation";
  generatorKind: "primary" | "worker";
  frameId: string;
  frameIndex: number;
};

export type RunMachineOptions = {
  scheduleWork?: boolean;
};

export type ExecuteCommandResult<T = unknown> =
  | { success: true; value?: T; clientId?: string }
  | { success: false; error: string; clientId?: string };

export type MachineRun<TDataContent = never> =
AsyncIterable<Frame<TDataContent>> & {
  stopSchedulingWork(): void;
  hasStarted(): boolean;
  isDraining(): boolean;
};

export type RuntimeSyncContext<TDataContent = never> = {
  machine: Machine<TDataContent>;
  runtimeInstanceId: RuntimeInstanceId;
  generator: Generator;
  inference: CompiledInference<TDataContent>;
  visibleFrames: Frame<TDataContent>[];
  createActionContext(action: AnyAction): ActionContext<unknown, TDataContent>;
  enqueueFrame(frame: FrameDraft<TDataContent> | Frame<TDataContent>): Frame<TDataContent>;
};

export type SyncableExecutor<TDataContent = never> = {
  syncRuntime?: (context: RuntimeSyncContext<TDataContent>) => unknown | Promise<unknown>;
};

export type SyncMachineRuntimeOptions<TDataContent = never> = {
  runtimeInstanceId: RuntimeInstanceId;
  generatorId?: GeneratorId;
  visibleFrames?: Frame<TDataContent>[];
};

type ProjectorMachine<TDataContent = never> =
Machine<TDataContent> & {
  pendingFrames: Frame<TDataContent>[];
  nextFrameIndex: number;
  listeners: Set<(frame: Frame<TDataContent>) => void>;
};

type WorkState = {
  activations: Map<string, Activation>;
  completions: Map<string, WorkCompletionMessage & { frameId: string; frameIndex: number }>;
  generatorRuntimeIds: Map<GeneratorId, RuntimeInstanceId>;
};

type RuntimeCandidate = {
  runtimeInstanceId: RuntimeInstanceId;
  generatorKind: "primary" | "worker";
  trigger: RuntimeTrigger;
  concurrency: RuntimeConcurrency;
  concurrencyKey: string;
  generatorId: GeneratorId;
};

type HydratableNodeRef<TDataContent> =
  | SerializedNodeRef<TDataContent>
  | Instance<TDataContent>["node"];

export function createMachine<TDataContent = never>({
  id = "machine",
  root,
  charter,
  frames = [],
}: MachineOptions<TDataContent>): Machine<TDataContent> {
  const machine: ProjectorMachine<TDataContent> = {
    id,
    root,
    charter,
    frames: [...frames],
    pendingFrames: [],
    nextFrameIndex: nextFrameIndex(frames),
    listeners: new Set(),
    enqueueFrame(frame) {
      const canonical = canonicalizeFrameDraft(frame, this.charter);
      const enqueued = "id" in canonical && typeof canonical.id === "string"
        ? { ...canonical }
        : { id: `frame-${this.nextFrameIndex++}`, ...canonical };
      foldFrameIntoMachine(this, enqueued);
      this.frames.push(enqueued);
      this.pendingFrames.push(enqueued);
      notifyFrame(this, enqueued);
      return enqueued;
    },
    ingestInertFrame(frame) {
      if (frame.inert !== true) {
        throw new Error("ingestInertFrame requires frame.inert === true");
      }
      if (this.frames.some((existing) => existing.id === frame.id)) {
        return;
      }
      const canonical = canonicalizeFrameDraft(frame, this.charter) as Frame<TDataContent>;
      foldFrameIntoMachine(this, canonical);
      this.frames.push(canonical);
    },
    subscribe(listener) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };
  assertUniqueInstanceIds(machine.root);
  validateMachineActionStateCompatibility(machine.root, machine.charter);
  return machine;
}

export function runMachine<TDataContent = never>(
  machine: Machine<TDataContent>,
  options: RunMachineOptions = {},
): MachineRun<TDataContent> {
  return new MachineRunImpl<TDataContent>(machine as ProjectorMachine<TDataContent>, {
    scheduleWork: options.scheduleWork ?? true,
  });
}

export function reconcileWork<TDataContent = never>(
  machine: Machine<TDataContent>,
): Frame<TDataContent>[] {
  const projectorMachine = machine as ProjectorMachine<TDataContent>;
  const before = projectorMachine.frames.length;

  while (true) {
    const appended = reconcileWorkOnce(projectorMachine);
    if (appended.length === 0) break;
  }

  return projectorMachine.frames.slice(before);
}

export async function syncMachineRuntime<TDataContent = never>(
  machine: Machine<TDataContent>,
  options: SyncMachineRuntimeOptions<TDataContent>,
): Promise<RuntimeSyncContext<TDataContent> | undefined> {
  const syncRuntime = (machine.charter.executor as SyncableExecutor<TDataContent>).syncRuntime;
  if (!syncRuntime) return undefined;

  const generator = generatorForRuntime(machine.root, options.runtimeInstanceId, options.generatorId);
  const inference = compileProjection(machine.root, {
    charter: machine.charter,
    targetGenerator: generator,
    frameHistory: machine.frames,
  });
  const getState = inference.retrievableStates.length > 0
    ? createRetrievableStateGetter(machine, inference.retrievableStates)
    : undefined;
  const frameDefaults = {
    generatorId: generator.id,
    runtimeInstanceId: generator.runtimeInstanceId,
  };
  const context: RuntimeSyncContext<TDataContent> = {
    machine,
    runtimeInstanceId: options.runtimeInstanceId,
    generator,
    inference,
    visibleFrames: options.visibleFrames ?? [],
    createActionContext: (action) =>
      createMachineActionContext(machine, action, frameDefaults, getState),
    enqueueFrame: (frame) =>
      machine.enqueueFrame({
        ...frame,
        generatorId: frame.generatorId ?? frameDefaults.generatorId,
        runtimeInstanceId: frame.runtimeInstanceId ?? frameDefaults.runtimeInstanceId,
      }),
  };

  await syncRuntime.call(machine.charter.executor, context);
  return context;
}

function reconcileYieldedWork<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
): Frame<TDataContent>[] {
  const before = machine.frames.length;

  while (true) {
    const appended = reconcileWorkOnce(machine, { skipPendingSources: true });
    if (appended.length === 0) break;
  }

  return machine.frames.slice(before);
}

function notifyFrame<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
  frame: Frame<TDataContent>,
): void {
  for (const listener of machine.listeners) {
    listener(frame);
  }
}

function generatorForRuntime<TDataContent>(
  root: Instance<TDataContent>,
  runtimeInstanceId: RuntimeInstanceId,
  generatorId: GeneratorId | undefined,
): Generator {
  const frame = findFrameByRuntimeId(root, runtimeInstanceId);
  if (!frame || (frame.node.runtime.type !== "primary" && frame.node.runtime.type !== "worker")) {
    throw new Error(`Unknown runtime "${runtimeInstanceId}"`);
  }

  return {
    id: generatorId ?? runtimeInstanceId,
    kind: frame.node.runtime.type,
    runtimeInstanceId,
  };
}

export function collectRunnableActivations<TDataContent = never>(
  machine: Machine<TDataContent>,
): Activation[] {
  const state = foldWork(machine);
  const candidates = [...state.activations.values()]
    .filter((activation) => !state.completions.has(activation.activationId))
    .filter((activation) => findFrameByRuntimeId(machine.root, activation.runtimeInstanceId));

  const serialByKey = new Map<string, Activation>();
  const runnable: Activation[] = [];
  for (const activation of candidates) {
    if (activation.concurrency === "parallel") {
      runnable.push(activation);
      continue;
    }

    const existing = serialByKey.get(activation.concurrencyKey);
    if (!existing || activation.frameIndex < existing.frameIndex) {
      serialByKey.set(activation.concurrencyKey, activation);
    }
  }
  runnable.push(...serialByKey.values());
  return runnable.sort((a, b) => a.frameIndex - b.frameIndex);
}

export async function runActivation<TDataContent = never>(
  machine: Machine<TDataContent>,
  activationId: string,
): Promise<ExecutorRunResult<TDataContent> | undefined> {
  const initialState = foldWork(machine);
  const activation = initialState.activations.get(activationId);
  if (!activation) return undefined;
  if (initialState.completions.has(activationId)) return undefined;

  const frame = findFrameByRuntimeId(machine.root, activation.runtimeInstanceId);
  if (!frame) {
    machine.enqueueFrame(createCompletionFrame({
      activationId,
      sourceFrameId: activation.sourceFrameId,
      reason: "cancelled",
    }));
    return { completionReason: "cancelled" };
  }

  const runtime = frame.node.runtime;
  const frameDefaults = {
    generatorId: activation.generatorId,
    runtimeInstanceId: activation.runtimeInstanceId,
    activationId,
  };
  const inference = compileProjection(machine.root, {
    charter: machine.charter,
    targetGenerator: {
      id: activation.generatorId,
      kind: activation.generatorKind,
      runtimeInstanceId: activation.runtimeInstanceId,
    } satisfies Generator,
    activationId,
    frameHistory: machine.frames,
  });
  const getState = inference.retrievableStates.length > 0
    ? createRetrievableStateGetter(machine, inference.retrievableStates)
    : undefined;
  const request: ExecutorRunRequest<TDataContent> = {
    generatorId: activation.generatorId,
    runtimeInstanceId: activation.runtimeInstanceId,
    activationId,
    inference,
    output: frame.node.output,
    createActionContext: (action) =>
      createMachineActionContext(machine, action, frameDefaults, getState),
    enqueueFrame: (draft) =>
      machine.enqueueFrame({
        ...draft,
        generatorId: draft.generatorId ?? frameDefaults.generatorId,
        runtimeInstanceId: draft.runtimeInstanceId ?? frameDefaults.runtimeInstanceId,
        activationId: draft.activationId ?? frameDefaults.activationId,
      }),
  };

  const result = await machine.charter.executor.run(request);
  enqueueExecutorResult(machine, result, frame.node.output, frameDefaults);
  if (!foldWork(machine).completions.has(activationId)) {
    machine.enqueueFrame(createCompletionFrame({
      activationId,
      sourceFrameId: activation.sourceFrameId,
      reason: completionReasonForRuntime(runtime, result.completionReason),
    }));
  }
  return result;
}

export async function executeCommand<
  T = unknown,
  TDataContent = never,
>(
  machine: Machine<TDataContent>,
  message: CommandMessage,
): Promise<ExecuteCommandResult<T>> {
  const resolved = resolveCommand(machine, message);
  if (!resolved) {
    return {
      success: false,
      error: `Unknown command: ${message.name}`,
      clientId: message.clientId,
    };
  }

  let input = message.input;
  if (resolved.command.inputSchema) {
    const parsed = resolved.command.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.message,
        clientId: message.clientId,
      };
    }
    input = parsed.data;
  }

  machine.enqueueFrame({ messages: [message] });

  try {
    const context = createFrameActionContext(machine, resolved.frame, {});
    const value = await resolved.command.run?.(input as never, context as never);
    enqueueActionResult(machine, value);
    return { success: true, value: value as T, clientId: message.clientId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      clientId: message.clientId,
    };
  }
}

function resolveCommand<TDataContent>(
  machine: Machine<TDataContent>,
  message: CommandMessage,
): { command: AnyAction; frame: ProjectionFrame<TDataContent> } | undefined {
  const frames = traversalFrames(machine.root);
  if (message.target) {
    const targetRuntimeId = encodeRuntimeAddress(message.target);
    const frame = frames.find((candidate) => candidate.runtimeInstanceId === targetRuntimeId);
    const command = frame
      ? resolveFrameCommands(frame, machine.charter).find((candidate) => candidate.name === message.name)
      : undefined;
    if (frame && command) {
      assertNodeActionStateCompatibility(command, frame.node, "command");
    }
    return frame && command ? { command, frame } : undefined;
  }

  let resolved: { command: AnyAction; frame: ProjectionFrame<TDataContent> } | undefined;
  for (const frame of frames) {
    const command = resolveFrameCommands(frame, machine.charter).find((candidate) => candidate.name === message.name);
    if (command) {
      assertNodeActionStateCompatibility(command, frame.node, "command");
      resolved = { command, frame };
    }
  }
  return resolved;
}

function validateMachineActionStateCompatibility<TDataContent>(
  root: Instance<TDataContent>,
  charter: Charter<TDataContent>,
): void {
  for (const frame of traversalFrames(root)) {
    for (const tool of resolveFrameTools(frame, charter)) {
      assertNodeActionStateCompatibility(tool, frame.node, "tool");
    }
    for (const command of resolveFrameCommands(frame, charter)) {
      assertNodeActionStateCompatibility(command, frame.node, "command");
    }
  }
}

function createMachineActionContext<TDataContent>(
  machine: Machine<TDataContent>,
  action: AnyAction,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "runtimeInstanceId" | "activationId">>,
  getState?: ActionContext["getState"],
): ActionContext<unknown, TDataContent> {
  const binding = getActionBinding(action);
  const frame = binding
    ? findFrameByRuntimeId(machine.root, binding.runtimeInstanceId)
    : undefined;
  if (!frame) {
    return createUnboundActionContext(getState);
  }
  const context = createFrameActionContext(machine, frame, frameDefaults);
  if (getState) {
    context.getState = getState;
  }
  return context;
}

function createRetrievableStateGetter<TDataContent>(
  machine: Machine<TDataContent>,
  retrievableStates: RetrievableState[],
): NonNullable<ActionContext["getState"]> {
  const retrievalTargets = new Map(
    retrievableStates.map((state) => [state.address, state.target] as const),
  );
  return (address) => {
    const target = retrievalTargets.get(address);
    if (!target) {
      throw new Error(`Unknown retrievable state address "${address}"`);
    }
    return readStateValue(machine.root, target);
  };
}

function createFrameActionContext<TDataContent>(
  machine: Machine<TDataContent>,
  frame: ProjectionFrame<TDataContent>,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "runtimeInstanceId" | "activationId">>,
): ActionContext<unknown, TDataContent> {
  const stateAddress = stateAddressForFrame(frame);
  const instance = createActionInstanceContext(machine, frame, frameDefaults);
  if (!stateAddress) {
    return { instance };
  }

  const readState = () => readStateValue(machine.root, stateAddress);
  const context: ActionContext<unknown, TDataContent> = {
    instance,
    state: readState(),
    updateState: (update) => {
      const next = applyStateUpdate(readState(), update);
      validateStateValue(machine.root, stateAddress, next);
      machine.enqueueFrame({
        ...frameDefaults,
        messages: [
          {
            type: "instance",
            kind: "state.update",
            instanceId: stateAddress.instanceId,
            stateKey: stateAddress.stateKey,
            update,
          } satisfies InstanceMessage,
        ],
      });
      context.state = readState();
    },
  };
  return context;
}

function createActionInstanceContext<TDataContent>(
  machine: Machine<TDataContent>,
  frame: ProjectionFrame<TDataContent>,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "runtimeInstanceId" | "activationId">>,
): NonNullable<ActionContext<unknown, TDataContent>["instance"]> {
  const ownerInstanceId = frame.concreteInstance.id;
  return {
    runtimeInstanceId: frame.runtimeInstanceId,
    address: frame.address,
    ownerInstanceId,
    spawn: (node, options) => {
      machine.enqueueFrame({
        ...frameDefaults,
        messages: [
          {
            type: "instance",
            kind: "spawn",
            parentInstanceId: ownerInstanceId,
            children: [
              {
                node: serializeNode(node, machine.charter),
                ...(options?.states ? { states: options.states } : {}),
                ...(options?.children ? { children: options.children } : {}),
              },
            ],
          } satisfies InstanceMessage<TDataContent>,
        ],
      });
    },
    cede: (node) => {
      const messages: InstanceMessage<TDataContent>[] = node
        ? childInstanceIdsByNodeKey(machine.root, ownerInstanceId, node.key).map((instanceId) => ({
            type: "instance",
            kind: "remove",
            instanceId,
            reason: "cede",
          }))
        : [
            {
              type: "instance",
              kind: "remove",
              instanceId: ownerInstanceId,
              reason: "cede",
            },
          ];

      if (messages.length === 0) {
        return;
      }
      machine.enqueueFrame({
        ...frameDefaults,
        messages,
      });
    },
    transition: (node, options) => {
      machine.enqueueFrame({
        ...frameDefaults,
        messages: [
          {
            type: "instance",
            kind: "transition",
            instanceId: ownerInstanceId,
            node: serializeNode(node, machine.charter),
            ...(options?.states ? { states: options.states } : {}),
          } satisfies InstanceMessage<TDataContent>,
        ],
      });
    },
  };
}

function childInstanceIdsByNodeKey(
  root: Instance<any>,
  ownerInstanceId: string,
  nodeKey: string,
): string[] {
  const owner = findInstance(root, ownerInstanceId);
  if (!owner) {
    throw new Error(`Unknown owner instance "${ownerInstanceId}"`);
  }
  return (owner.children ?? [])
    .filter((child) => child.node.key === nodeKey)
    .map((child) => child.id);
}

function enqueueActionResult<TDataContent>(
  machine: Machine<TDataContent>,
  value: unknown,
): void {
  const messages = actionResultMessages<TDataContent>(value);
  if (messages.length > 0) {
    machine.enqueueFrame({ messages });
  }
}

function enqueueExecutorResult<TDataContent>(
  machine: Machine<TDataContent>,
  result: ExecutorRunResult<TDataContent>,
  output: OutputConfig<TDataContent> | undefined,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "runtimeInstanceId" | "activationId">>,
): void {
  for (const frame of result.frames ?? []) {
    enqueueFrameWithDefaults(machine, frame, frameDefaults);
  }

  if (result.value !== undefined) {
    enqueueFrameWithDefaults(
      machine,
      { messages: [assistantMessageFromTextOutput(result.value, output) as FrameMessage<TDataContent>] },
      frameDefaults,
    );
  }
}

function enqueueFrameWithDefaults<TDataContent>(
  machine: Machine<TDataContent>,
  frame: FrameDraft<TDataContent> | Frame<TDataContent>,
  defaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "runtimeInstanceId" | "activationId">>,
): Frame<TDataContent> {
  return machine.enqueueFrame({
    ...frame,
    generatorId: frame.generatorId ?? defaults.generatorId,
    runtimeInstanceId: frame.runtimeInstanceId ?? defaults.runtimeInstanceId,
    activationId: frame.activationId ?? defaults.activationId,
  });
}

function actionResultMessages<TDataContent>(
  value: unknown,
): FrameMessage<TDataContent>[] {
  if (Array.isArray(value)) {
    return value.filter(isFrameMessageLike) as FrameMessage<TDataContent>[];
  }
  return isFrameMessageLike(value) ? [value as FrameMessage<TDataContent>] : [];
}

function isFrameMessageLike(value: unknown): value is { type: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}

function canonicalizeFrameDraft<
  TDataContent,
  TFrame extends FrameDraft<TDataContent> | Frame<TDataContent>,
>(
  frame: TFrame,
  charter: Charter<TDataContent>,
): TFrame {
  return {
    ...frame,
    messages: frame.messages.map((message) => canonicalizeMessage(message, charter)),
  };
}

function canonicalizeMessage<TDataContent>(
  message: FrameMessage<TDataContent>,
  charter: Charter<TDataContent>,
): FrameMessage<TDataContent> {
  if (!isInstanceMessage(message)) {
    return message;
  }

  if (message.kind === "transition") {
    return ({
      ...message,
      node: canonicalizeNodeRef(message.node, charter),
    } satisfies InstanceMessage<TDataContent>) as FrameMessage<TDataContent>;
  }

  if (message.kind === "spawn") {
    return ({
      ...message,
      children: message.children.map((child) => canonicalizeSpawnChild(child, charter)),
    } satisfies InstanceMessage<TDataContent>) as FrameMessage<TDataContent>;
  }

  if (message.kind === "attach") {
    return ({
      ...message,
      children: message.children.map((child) => canonicalizeSerializedInstance(child, charter)),
    } satisfies InstanceMessage<TDataContent>) as FrameMessage<TDataContent>;
  }

  return message;
}

function canonicalizeSpawnChild<TDataContent>(
  child: SpawnChild<TDataContent>,
  charter: Charter<TDataContent>,
): SpawnChild<TDataContent> {
  return {
    ...child,
    id: child.id ?? crypto.randomUUID(),
    node: canonicalizeNodeRef(child.node, charter),
    children: child.children?.map((nested) => canonicalizeSpawnChild(nested, charter)),
  };
}

function canonicalizeSerializedInstance<TDataContent>(
  instance: SerializedInstance<TDataContent>,
  charter: Charter<TDataContent>,
): SerializedInstance<TDataContent> {
  return serializeInstance(hydrateInstance(instance, charter), charter);
}

function canonicalizeNodeRef<TDataContent>(
  node: HydratableNodeRef<TDataContent>,
  charter: Charter<TDataContent>,
): SerializedNodeRef<TDataContent> {
  if (typeof node === "string") {
    return node;
  }
  if (containsHydratedNodeData(node)) {
    return serializeNode(node, charter);
  }
  return serializeNode(hydrateNode(node as SerializedNodeRef<TDataContent>, charter), charter);
}

function foldFrameIntoMachine<TDataContent>(
  machine: Machine<TDataContent>,
  frame: Frame<TDataContent>,
): void {
  for (const message of frame.messages) {
    if (isInstanceMessage(message)) {
      applyInstanceMessage(machine.root, message, machine.charter);
    }
  }
  assertUniqueInstanceIds(machine.root);
  validateMachineActionStateCompatibility(machine.root, machine.charter);
}

function applyInstanceMessage<TDataContent>(
  root: Instance<TDataContent>,
  message: InstanceMessage<TDataContent>,
  charter: Charter<TDataContent>,
): void {
  if (message.kind === "state.update") {
    const address = { instanceId: message.instanceId, stateKey: message.stateKey };
    const next = applyStateUpdate(readStateValue(root, address), message.update);
    validateStateValue(root, address, next);
    const state = findResolvedState(root, address);
    state.container.value = next;
    return;
  }

  if (message.kind === "transition") {
    const instance = findInstance(root, message.instanceId);
    if (!instance) {
      throw new Error(`Unknown instance "${message.instanceId}"`);
    }
    instance.node = hydrateNode(message.node, charter);
    if (message.states) {
      applyStateValueOverrides(root, instance, message.states);
    }
    resolveStates(root);
    return;
  }

  if (message.kind === "spawn") {
    const parent = findInstance(root, message.parentInstanceId);
    if (!parent) {
      throw new Error(`Unknown parent instance "${message.parentInstanceId}"`);
    }
    parent.children ??= [];
    const spawned = message.children.map((child) => spawnChildToInstance(child, charter));
    parent.children.push(...spawned);
    message.children.forEach((child, index) => {
      const instance = spawned[index];
      if (instance) {
        applySpawnStateOverrides(root, instance, child);
      }
    });
    resolveStates(root);
    return;
  }

  if (message.kind === "attach") {
    const parent = findInstance(root, message.parentInstanceId);
    if (!parent) {
      throw new Error(`Unknown parent instance "${message.parentInstanceId}"`);
    }
    parent.children ??= [];
    parent.children.push(...message.children.map((child) => hydrateInstance(child, charter)));
    resolveStates(root);
    return;
  }

  if (message.kind === "remove") {
    removeInstance(root, message.instanceId);
  }
}

function spawnChildToInstance<TDataContent>(
  child: SpawnChild<TDataContent>,
  charter: Charter<TDataContent>,
): Instance<TDataContent> {
  if (!child.id) {
    throw new Error("Spawn child must have an id before folding");
  }
  return {
    id: child.id,
    node: hydrateNode(child.node, charter),
    states: undefined,
    children: child.children?.map((nested) => spawnChildToInstance(nested, charter)),
  };
}

function applySpawnStateOverrides(
  root: Instance<any>,
  instance: Instance<any>,
  child: SpawnChild<any>,
): void {
  if (child.states) {
    applyStateValueOverrides(root, instance, child.states);
  }
  child.children?.forEach((nested, index) => {
    const nestedInstance = instance.children?.[index];
    if (nestedInstance) {
      applySpawnStateOverrides(root, nestedInstance, nested);
    }
  });
}

function applyStateValueOverrides(
  root: Instance<any>,
  instance: Instance<any>,
  values: Record<StateKey, unknown>,
): void {
  for (const [stateKey, value] of Object.entries(values)) {
    const target = stateOverrideTarget(root, instance, stateKey);
    target.states ??= {};
    target.states[stateKey] = { value };
  }
}

function stateOverrideTarget(
  root: Instance<any>,
  instance: Instance<any>,
  stateKey: string,
): Instance<any> {
  const frame = traversalFrames(root).find(
    (candidate) => !candidate.isMember && candidate.concreteInstance === instance,
  );
  const descriptor = frame?.node.state;
  if (!frame || !descriptor || descriptor.key !== stateKey) {
    return instance;
  }
  return descriptor.scope === "local" ? frame.concreteInstance : topStateInstance(frame);
}

function readStateValue(root: Instance<any>, address: StateAddress): unknown {
  return findResolvedState(root, address).container.value;
}

function validateStateValue(
  root: Instance<any>,
  address: StateAddress,
  value: unknown,
): void {
  const state = findResolvedState(root, address);
  state.descriptor.schema.parse(value);
}

function findResolvedState(root: Instance<any>, address: StateAddress) {
  const state = resolveStates(root).find(
    (candidate) =>
      candidate.address.instanceId === address.instanceId &&
      candidate.address.stateKey === address.stateKey,
  );
  if (!state) {
    throw new Error(`Unknown state "${address.instanceId}:${address.stateKey}"`);
  }
  return state;
}

function stateAddressForFrame(
  frame: ProjectionFrame<any>,
): StateAddress | undefined {
  const descriptor = frame.node.state;
  if (!descriptor) {
    return undefined;
  }
  return {
    instanceId:
      descriptor.scope === "local" ? frame.concreteInstance.id : topStateInstance(frame).id,
    stateKey: descriptor.key,
  };
}

function patchObject(value: unknown, patch: Record<string, unknown>): unknown {
  return {
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
    ...patch,
  };
}

function applyStateUpdate(value: unknown, update: StateUpdate): unknown {
  if (update.op === "replace") {
    return update.value;
  }

  if (update.op === "patch") {
    return updateAtPath(value, update.path ?? [], (target) =>
      patchObject(target, update.value as Record<string, unknown>),
    );
  }

  if (update.op === "append") {
    return updateAtPath(value, update.path ?? [], (target) => {
      if (!Array.isArray(target)) {
        throw new Error("Cannot append to non-array state value");
      }
      return [...target, ...update.values];
    });
  }

  const unreachable: never = update;
  return unreachable;
}

function updateAtPath(
  value: unknown,
  path: StatePath,
  updater: (target: unknown) => unknown,
): unknown {
  if (path.length === 0) {
    return updater(value);
  }

  const [segment, ...rest] = path;
  if (Array.isArray(value)) {
    if (typeof segment !== "number") {
      throw new Error("Array state paths must use numeric segments");
    }
    if (segment < 0 || segment >= value.length) {
      throw new Error(`Array state path segment ${segment} is out of bounds`);
    }
    const next = [...value];
    next[segment] = updateAtPath(next[segment], rest, updater);
    return next;
  }

  if (!value || typeof value !== "object") {
    throw new Error("Cannot update nested path on non-object state value");
  }

  if (typeof segment !== "string") {
    throw new Error("Object state paths must use string segments");
  }
  return {
    ...(value as Record<string, unknown>),
    [segment]: updateAtPath((value as Record<string, unknown>)[segment], rest, updater),
  };
}

function findInstance(root: Instance<any>, instanceId: string): Instance<any> | undefined {
  return findInstanceInTree(root, instanceId);
}

function findInstanceInTree(instance: Instance<any>, instanceId: string): Instance<any> | undefined {
  if (instance.id === instanceId) {
    return instance;
  }
  for (const child of instance.children ?? []) {
    const found = findInstanceInTree(child, instanceId);
    if (found) return found;
  }
  return undefined;
}

function removeInstance(root: Instance<any>, instanceId: string): void {
  if (root.id === instanceId) {
    throw new Error("Cannot remove the root instance");
  }

  removeChildInstance(root, instanceId);
}

function removeChildInstance(parent: Instance<any>, instanceId: string): boolean {
  const children = parent.children ?? [];
  const index = children.findIndex((child) => child.id === instanceId);
  if (index >= 0) {
    children.splice(index, 1);
    return true;
  }
  return children.some((child) => removeChildInstance(child, instanceId));
}

function containsHydratedNodeData(value: unknown): value is Instance<any>["node"] {
  if (!value || typeof value !== "object") return false;
  const record = value as {
    toolBindings?: unknown;
    commandBindings?: unknown;
    state?: unknown;
    output?: unknown;
    projection?: unknown;
    runtime?: unknown;
    members?: unknown;
  };
  return (
    containsHydratedActions(record.toolBindings) ||
    containsHydratedActions(record.commandBindings) ||
    containsHydratedState(record.state) ||
    containsHydratedOutput(record.output) ||
    isProjectionFunction(record.projection) ||
    containsHydratedRuntime(record.runtime) ||
    containsHydratedMembers(record.members)
  );
}

function containsHydratedActions(actions: unknown): boolean {
  if (!actions || typeof actions !== "object") {
    return false;
  }
  if (Array.isArray(actions)) {
    return actions.some((action) => Boolean(action && typeof action === "object"));
  }
  return Object.values(actions).some((action) =>
    Boolean(action && typeof action === "object")
  );
}

function containsHydratedState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return typeof (state as { schema?: { parse?: unknown } }).schema?.parse === "function";
}

function containsHydratedOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const record = output as { mapTextBlock?: unknown; schema?: { parse?: unknown } };
  return typeof record.mapTextBlock === "function" || typeof record.schema?.parse === "function";
}

function containsHydratedRuntime(runtime: unknown): boolean {
  if (!runtime || typeof runtime !== "object") return false;
  const record = runtime as { boundaryProjection?: unknown; historyProjection?: unknown };
  return (
    isProjectionFunction(record.boundaryProjection) ||
    isHistoryProjectionFunction(record.historyProjection)
  );
}

function containsHydratedMembers(members: unknown): boolean {
  return Array.isArray(members) &&
    members.some((member) =>
      containsHydratedNodeData(member)
    );
}

function isInstanceMessage(message: unknown): message is InstanceMessage<any> {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type !== "instance" || typeof record.kind !== "string") return false;
  return (
    record.kind === "state.update" ||
    record.kind === "transition" ||
    record.kind === "spawn" ||
    record.kind === "attach" ||
    record.kind === "remove"
  );
}

class MachineRunImpl<TDataContent> implements MachineRun<TDataContent> {
  private started = false;
  private draining = false;
  private schedulingStopped = false;
  private activeActivations = new Map<string, Promise<void>>();
  private activationErrors: unknown[] = [];

  constructor(
    private readonly machine: ProjectorMachine<TDataContent>,
    private readonly options: Required<RunMachineOptions>,
  ) {}

  hasStarted(): boolean {
    return this.started;
  }

  isDraining(): boolean {
    return this.draining;
  }

  stopSchedulingWork(): void {
    this.schedulingStopped = true;
  }

  [Symbol.asyncIterator](): AsyncIterator<Frame<TDataContent>> {
    return this.drain();
  }

  private async *drain(): AsyncGenerator<Frame<TDataContent>> {
    this.started = true;
    this.draining = true;
    try {
      while (true) {
        if (this.activationErrors.length > 0) {
          throw this.activationErrors.shift();
        }

        const pending = this.machine.pendingFrames.shift();
        if (pending) {
          yield pending;
          continue;
        }

        const reconciled = reconcileYieldedWork(this.machine);
        if (reconciled.length > 0) {
          continue;
        }

        if (this.shouldScheduleWork()) {
          this.startRunnableActivations();
        }

        if (this.machine.pendingFrames.length > 0) {
          continue;
        }
        if (this.activeActivations.size > 0) {
          await Promise.race(this.activeActivations.values());
          continue;
        }

        if (this.activationErrors.length > 0) {
          throw this.activationErrors.shift();
        }

        if (!this.shouldScheduleWork()) {
          return;
        }

        if (collectRunnableActivations(this.machine).length === 0) {
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private startRunnableActivations(): void {
    for (const activation of collectRunnableActivations(this.machine)) {
      if (this.activeActivations.has(activation.activationId)) {
        continue;
      }
      this.startRunnableActivation(activation);
    }
  }

  private startRunnableActivation(activation: Activation): void {
    if (!this.shouldScheduleWork()) return;

    const run = (async () => {
      try {
        await runActivation(this.machine, activation.activationId);
      } catch (error) {
        this.activationErrors.push(error);
      } finally {
        this.activeActivations.delete(activation.activationId);
      }
    })();

    this.activeActivations.set(activation.activationId, run);
  }

  private shouldScheduleWork(): boolean {
    return this.options.scheduleWork && !this.schedulingStopped;
  }
}

function reconcileWorkOnce<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
  options: { skipPendingSources?: boolean } = {},
): Frame<TDataContent>[] {
  const state = foldWork(machine);
  const appended: Frame<TDataContent>[] = [];
  const pendingFrameIds = options.skipPendingSources
    ? new Set(machine.pendingFrames.map((frame) => frame.id))
    : undefined;

  for (const activation of state.activations.values()) {
    if (
      !state.completions.has(activation.activationId) &&
      !findFrameByRuntimeId(machine.root, activation.runtimeInstanceId)
    ) {
      const frame = machine.enqueueFrame(createCompletionFrame({
        activationId: activation.activationId,
        sourceFrameId: activation.sourceFrameId,
        reason: "cancelled",
      }));
      appended.push(frame);
      state.completions.set(activation.activationId, {
        type: "work",
        kind: "completion",
        activationId: activation.activationId,
        sourceFrameId: activation.sourceFrameId,
        reason: "cancelled",
        frameId: frame.id,
        frameIndex: machine.frames.length - 1,
      });
    }
  }

  for (const sourceFrame of machine.frames.slice()) {
    if (sourceFrame.inert) continue;
    if (pendingFrameIds?.has(sourceFrame.id)) continue;

    const candidates = runtimeCandidatesForSource(machine, sourceFrame, state);
    for (const candidate of candidates) {
      const activationId = activationIdFor({
        machineId: machine.id,
        runtimeInstanceId: candidate.runtimeInstanceId,
        trigger: candidate.trigger,
        sourceFrameId: sourceFrame.id,
      });
      if (
        state.activations.has(activationId) ||
        hasActivationForRuntimeSource(state, candidate.runtimeInstanceId, sourceFrame.id)
      ) continue;

      const frame = machine.enqueueFrame(createActivationFrame({
        activationId,
        runtimeInstanceId: candidate.runtimeInstanceId,
        generatorId: candidate.generatorId,
        sourceFrameId: sourceFrame.id,
        concurrencyKey: candidate.concurrencyKey,
        concurrency: candidate.concurrency,
      }));
      appended.push(frame);
      state.activations.set(activationId, {
        type: "work",
        kind: "activation",
        activationId,
        runtimeInstanceId: candidate.runtimeInstanceId,
        generatorId: candidate.generatorId,
        sourceFrameId: sourceFrame.id,
        concurrencyKey: candidate.concurrencyKey,
        concurrency: candidate.concurrency,
        generatorKind: candidate.generatorKind,
        frameId: frame.id,
        frameIndex: machine.frames.length - 1,
      });
      state.generatorRuntimeIds.set(candidate.generatorId, candidate.runtimeInstanceId);
    }
  }

  return appended;
}

function hasActivationForRuntimeSource(
  state: WorkState,
  runtimeInstanceId: RuntimeInstanceId,
  sourceFrameId: string,
): boolean {
  for (const activation of state.activations.values()) {
    if (
      activation.runtimeInstanceId === runtimeInstanceId &&
      activation.sourceFrameId === sourceFrameId
    ) {
      return true;
    }
  }
  return false;
}

function runtimeCandidatesForSource<TDataContent>(
  machine: Machine<TDataContent>,
  sourceFrame: Frame<TDataContent>,
  state: WorkState,
): RuntimeCandidate[] {
  const candidates: RuntimeCandidate[] = [];
  for (const frame of traversalFrames(machine.root)) {
    if (frame.node.runtime.type !== "primary" && frame.node.runtime.type !== "worker") {
      continue;
    }

    const runtime = frame.node.runtime as PrimaryRuntime<TDataContent> | WorkerRuntime<TDataContent>;
    if (sourceFrameProducedByRuntime(sourceFrame, frame.runtimeInstanceId, state)) {
      continue;
    }
    const concurrency = runtime.concurrency ?? "serial";
    const generatorId = generatorIdFor(
      frame.runtimeInstanceId,
      runtime.type,
      concurrency,
      sourceFrame.id,
      machine.id,
      runtime.trigger,
    );
    if (!triggerMatches(machine, frame.runtimeInstanceId, runtime.trigger, sourceFrame, state)) {
      continue;
    }

    candidates.push({
      runtimeInstanceId: frame.runtimeInstanceId,
      generatorKind: runtime.type,
      trigger: runtime.trigger,
      concurrency,
      concurrencyKey: concurrency === "parallel"
        ? activationIdFor({
            machineId: machine.id,
            runtimeInstanceId: frame.runtimeInstanceId,
            trigger: runtime.trigger,
            sourceFrameId: sourceFrame.id,
          })
        : frame.runtimeInstanceId,
      generatorId,
    });
  }
  return candidates;
}

function triggerMatches<TDataContent>(
  machine: Machine<TDataContent>,
  runtimeInstanceId: RuntimeInstanceId,
  trigger: RuntimeTrigger,
  sourceFrame: Frame<TDataContent>,
  state: WorkState,
): boolean {
  if (trigger.type === "actor-frame") {
    const resolveGeneratorRuntimeId = (id: GeneratorId) =>
      state.generatorRuntimeIds.get(id) ?? serialRuntimeIdFromGeneratorId(id);
    return sourceFrame.messages.some((message) =>
      isActorMessage(message) &&
        actorMessageVisibleToRuntime(
          message,
          sourceFrame,
          { runtimeInstanceId },
          resolveGeneratorRuntimeId,
        )
    );
  }

  if (trigger.type === "parent-activation") {
    return sourceFrame.messages.some((message) =>
      isWorkActivationMessage(message) &&
      message.runtimeInstanceId === nearestAncestorRuntimeId(machine.root, runtimeInstanceId)
    );
  }

  if (trigger.type === "parent-completion") {
    return sourceFrame.messages.some((message) => {
      if (!isWorkCompletionMessage(message)) return false;
      const completed = state.activations.get(message.activationId);
      return completed?.runtimeInstanceId === nearestAncestorRuntimeId(machine.root, runtimeInstanceId);
    });
  }

  if (trigger.type === "spawn") {
    return runtimeCreatedByFrame(sourceFrame, runtimeInstanceId);
  }

  return false;
}

function foldWork<TDataContent>(machine: Machine<TDataContent>): WorkState {
  const activations = new Map<string, Activation>();
  const completions = new Map<string, WorkCompletionMessage & { frameId: string; frameIndex: number }>();
  const generatorRuntimeIds = new Map<GeneratorId, RuntimeInstanceId>();

  machine.frames.forEach((frame, frameIndex) => {
    for (const message of frame.messages) {
      if (isWorkActivationMessage(message) && !activations.has(message.activationId)) {
        const projectionFrame = findFrameByRuntimeId(machine.root, message.runtimeInstanceId);
        const runtimeType = projectionFrame?.node.runtime.type;
        if (runtimeType !== "primary" && runtimeType !== "worker") continue;
        activations.set(message.activationId, {
          ...message,
          generatorKind: runtimeType,
          frameId: frame.id,
          frameIndex,
        });
        generatorRuntimeIds.set(message.generatorId, message.runtimeInstanceId);
      }

      if (isWorkCompletionMessage(message) && !completions.has(message.activationId)) {
        completions.set(message.activationId, { ...message, frameId: frame.id, frameIndex });
      }
    }
  });

  return { activations, completions, generatorRuntimeIds };
}

function runtimeCreatedByFrame(
  frame: Frame<any>,
  runtimeInstanceId: RuntimeInstanceId,
): boolean {
  const createdInstanceIds = new Set<string>();
  for (const message of frame.messages) {
    if (!isInstanceMessage(message)) {
      continue;
    }
    if (message.kind === "spawn") {
      collectSpawnedIds(message.children, createdInstanceIds);
    }
    if (message.kind === "attach") {
      collectAttachedIds(message.children, createdInstanceIds);
    }
  }

  if (createdInstanceIds.size === 0) {
    return false;
  }

  const address = runtimeInstanceId.startsWith("member:")
    ? runtimeInstanceId.slice("member:".length).split("/")[0]
    : runtimeInstanceId.startsWith("instance:")
      ? runtimeInstanceId.slice("instance:".length)
      : undefined;
  return Boolean(address && createdInstanceIds.has(address));
}

function collectSpawnedIds(children: readonly SpawnChild<any>[], ids: Set<string>): void {
  for (const child of children) {
    if (child.id) {
      ids.add(child.id);
    }
    collectSpawnedIds(child.children ?? [], ids);
  }
}

function collectAttachedIds(children: readonly SerializedInstance<any>[], ids: Set<string>): void {
  for (const child of children) {
    ids.add(child.id);
    collectAttachedIds(child.children ?? [], ids);
  }
}

function sourceFrameProducedByRuntime(
  frame: Frame<any>,
  runtimeInstanceId: RuntimeInstanceId,
  state: WorkState,
): boolean {
  if (!frame.generatorId) return false;
  const owner = state.generatorRuntimeIds.get(frame.generatorId) ?? serialRuntimeIdFromGeneratorId(frame.generatorId);
  return owner === runtimeInstanceId;
}

function serialRuntimeIdFromGeneratorId(generatorId: GeneratorId): RuntimeInstanceId | undefined {
  if (
    generatorId.startsWith("instance:") ||
    generatorId.startsWith("member:")
  ) {
    return generatorId;
  }
  return undefined;
}

function nearestAncestorRuntimeId(
  root: Instance<any>,
  runtimeInstanceId: RuntimeInstanceId,
): RuntimeInstanceId | undefined {
  const frame = findFrameByRuntimeId(root, runtimeInstanceId);
  if (!frame) return undefined;

  let parent = frame.parent;
  while (parent) {
    if (parent.node.runtime.type === "primary" || parent.node.runtime.type === "worker") {
      return parent.runtimeInstanceId;
    }
    parent = parent.parent;
  }
  return undefined;
}

function generatorIdFor(
  runtimeInstanceId: RuntimeInstanceId,
  kind: "primary" | "worker",
  concurrency: RuntimeConcurrency,
  sourceFrameId: string,
  machineId: string,
  trigger: RuntimeTrigger,
): GeneratorId {
  if (concurrency === "serial") return runtimeInstanceId;
  return `${kind}:${runtimeInstanceId}:${activationIdFor({ machineId, runtimeInstanceId, trigger, sourceFrameId })}`;
}

function activationIdFor({
  machineId,
  runtimeInstanceId,
  trigger,
  sourceFrameId,
}: {
  machineId: string;
  runtimeInstanceId: RuntimeInstanceId;
  trigger: RuntimeTrigger;
  sourceFrameId: string;
}): string {
  return `activation:${hashString(`${machineId}\0${runtimeInstanceId}\0${triggerKey(trigger)}\0${sourceFrameId}`)}`;
}

function triggerKey(trigger: RuntimeTrigger): string {
  return trigger.type;
}

function completionReasonForRuntime(
  runtime: NormalizedRuntime<any>,
  reason: ExecutorRunResult["completionReason"],
): WorkCompletionReason {
  if (reason === "cancelled" || reason === "delegated") return reason;
  if (reason === "error") return "cancelled";
  return runtime.type === "primary" ? "end-turn" : "done";
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function nextFrameIndex(frames: Frame<any>[]): number {
  let max = -1;
  for (const frame of frames) {
    const match = /^frame-(\d+)$/.exec(frame.id);
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}
