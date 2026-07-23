import {
  assertNodeActionStateCompatibility,
  createActionTerminalMessages,
  createUnboundActionContext,
  executeActionInvocation,
  getActionBinding,
  isPromiseLike,
} from "./actions.ts";
import {
  assertUniqueInstanceIds,
  findContributorById,
  hoistStateInstance,
  collectContributors,
  resolveContributorNodeParams,
  type Contributor,
  type MemberResolution,
} from "./contributors.ts";
import { isComputedMemberDef } from "./computed-parts.ts";
import {
  assistantMessageFromTextOutput,
  createActivationFrame,
  createCompletionFrame,
  isWorkAbortMessage,
  isWorkActivationMessage,
  isWorkCompletionMessage,
} from "./history.ts";
import { isNode, runtimeTriggers } from "./create.ts";
import { decodeContributorId, encodeProjectionAddress } from "./projection-address.ts";
import { callerAllows, collectAllNodeActions, resolveContributorActions } from "./scoped-actions.ts";
import { collectScopeDuplicates } from "./scopes.ts";
import { hydrateInstance, hydrateNode, serializeInstance, serializeNode } from "./serialization.ts";
import { realizeResolvedState, resolveStates, type ResolveStatesOptions, type StateReset } from "./state.ts";
import {
  actorMessageVisibleToGenerator,
  isActorMessage,
  visibleFramesForGenerator,
} from "./visibility.ts";
import type {
  ActionContext,
  ActionRequestMessage,
  AnyAction,
  Charter,
  CompiledInference,
  ExecuteActionResult,
  ExecutorRunRequest,
  ExecutorRunResult,
  Frame,
  FrameDraft,
  FrameMessage,
  GeneratorId,
  Instance,
  InstanceMessage,
  ExecutionReport,
  FrameProducer,
  Node,
  NormalizedRuntime,
  OutputConfig,
  ProjectorExecutor,
  RetrievableState,
  RuntimeConcurrency,
  RuntimeTrigger,
  SerializedInstance,
  SerializedNodeRef,
  SpawnChild,
  StateAddress,
  StateKey,
  StatePath,
  StateUpdate,
  StateUpdateInput,
  GeneratorRuntime,
  WorkAbortMessage,
  WorkActivationMessage,
  WorkCompletionMessage,
  WorkCompletionReason,
} from "./types.ts";
import { compileProjection } from "./compile.ts";
import {
  assertNodeActionParamsCompatibility,
  resolveActionParams,
  resolveEffectiveParams,
} from "./params.ts";

export type Machine<TDataContent = never> = {
  id: string;
  instance: Instance<TDataContent>;
  charter: Charter<TDataContent>;
  /**
   * The generator runtime. Optional: a machine without one can hydrate and
   * fold frames (read-only replay, inspection), but scheduling work throws.
   */
  executor?: ProjectorExecutor<TDataContent>;
  /** Runner/claim info stamped into the provenance of frames this machine produces. */
  runner?: Record<string, unknown>;
  frames: Frame<TDataContent>[];
  enqueueFrame(frame: FrameDraft<TDataContent> | Frame<TDataContent>): Frame<TDataContent>;
  ingestInertFrame(frame: Frame<TDataContent>): void;
  subscribe(listener: (frame: Frame<TDataContent>) => void): () => void;
};

export type MachineOptions<TDataContent = never> = {
  id?: string;
  instance: Instance<TDataContent>;
  charter: Charter<TDataContent>;
  executor?: ProjectorExecutor<TDataContent>;
  runner?: Record<string, unknown>;
  frames?: Frame<TDataContent>[];
};

export type Activation = WorkActivationMessage & {
  kind: "activation";
  frameId: string;
  frameIndex: number;
};

export type RunMachineOptions = {
  scheduleWork?: boolean;
};

export type MachineRun<TDataContent = never> =
AsyncIterable<Frame<TDataContent>> & {
  stopSchedulingWork(): void;
  hasStarted(): boolean;
  isDraining(): boolean;
};

export type RuntimeSyncContext<TDataContent = never> = {
  machine: Machine<TDataContent>;
  generatorId: GeneratorId;
  inference: CompiledInference<TDataContent>;
  visibleFrames: Frame<TDataContent>[];
  createActionContext(action: AnyAction): ActionContext<unknown, TDataContent>;
  enqueueFrame(
    frame: FrameDraft<TDataContent> | Frame<TDataContent>,
    report?: ExecutionReport,
  ): Frame<TDataContent>;
};

export type SyncableExecutor<TDataContent = never> = {
  syncRuntime?: (context: RuntimeSyncContext<TDataContent>) => unknown | Promise<unknown>;
};

export type SyncMachineRuntimeOptions<TDataContent = never> = {
  generatorId: GeneratorId;
  visibleFrames?: Frame<TDataContent>[];
};

type ProjectorMachine<TDataContent = never> =
Machine<TDataContent> & {
  pendingFrames: Frame<TDataContent>[];
  nextFrameIndex: number;
  listeners: Set<(frame: Frame<TDataContent>) => void>;
  frameCaptures: FrameCapture<TDataContent>[];
};

type FrameCapture<TDataContent> = {
  frames: Frame<TDataContent>[];
};

type WorkState = {
  activations: Map<string, Activation>;
  completions: Map<string, WorkCompletionMessage & { frameId: string; frameIndex: number }>;
  /** Pending activations targeted by an abort message, keyed by activationId. */
  aborted: Map<string, WorkAbortMessage & { frameId: string; frameIndex: number }>;
};

type GeneratorCandidate = {
  generatorId: GeneratorId;
  trigger: RuntimeTrigger;
  concurrency: RuntimeConcurrency;
  concurrencyKey: string;
};

/** Floor arbitration's partition of a source frame's matching candidates. */
type ArbitratedCandidates = {
  admitted: GeneratorCandidate[];
  /** Matching `primary` candidates whose admission the floor denied. */
  suppressed: GeneratorCandidate[];
};

type HydratableNodeRef<TDataContent> =
  | SerializedNodeRef<TDataContent>
  | Instance<TDataContent>["node"];

export function createMachine<TDataContent = never>({
  id = "machine",
  instance,
  charter,
  executor,
  runner,
  frames = [],
}: MachineOptions<TDataContent>): Machine<TDataContent> {
  const machine: ProjectorMachine<TDataContent> = {
    id,
    instance,
    charter,
    ...(executor ? { executor } : {}),
    ...(runner ? { runner } : {}),
    frames: [...frames],
    pendingFrames: [],
    nextFrameIndex: nextFrameIndex(frames),
    listeners: new Set(),
    frameCaptures: [],
    enqueueFrame(frame) {
      const canonical = canonicalizeFrameDraft(frame, this.charter);
      const enqueued = "id" in canonical && typeof canonical.id === "string"
        ? { ...canonical }
        : { id: `frame-${this.nextFrameIndex++}`, ...canonical };
      const resets = foldFrameIntoMachine(this, enqueued);
      const capture = this.frameCaptures.at(-1);
      if (capture) {
        capture.frames.push(enqueued);
      } else {
        this.frames.push(enqueued);
        this.pendingFrames.push(enqueued);
        notifyFrame(this, enqueued);
      }
      if (resets.length > 0) {
        this.enqueueFrame(stateResetFrame(resets));
      }
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
      const resets = foldFrameIntoMachine(this, canonical);
      this.frames.push(canonical);
      if (resets.length > 0) {
        this.enqueueFrame(stateResetFrame(resets));
      }
    },
    subscribe(listener) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };
  assertUniqueInstanceIds(machine.instance);
  assertHasSourceInstance(machine.instance);
  charter.params.parse(resolveEffectiveParams([machine.instance]));
  validateMachineActionStateCompatibility(machine.instance, machine.charter);
  validateExecutorConfig(machine.instance, machine.charter, executor);
  return machine;
}

/**
 * Validates every reachable node's `executorConfig` namespace against the
 * bound executor's schema, so misconfiguration fails at bind time rather than
 * mid-activation.
 */
function validateExecutorConfig<TDataContent>(
  root: Instance<TDataContent>,
  charter: Charter<TDataContent>,
  executor: ProjectorExecutor<TDataContent> | undefined,
): void {
  const schema = executor?.configSchema;
  const namespace = executor?.identity?.name;
  if (!schema || !namespace) {
    return;
  }

  const seen = new Set<Node<TDataContent>>();
  const validate = (node: Node<TDataContent>): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const config = node.executorConfig?.[namespace];
    if (config !== undefined) {
      try {
        schema.parse(config);
      } catch (error) {
        throw new Error(
          `Invalid executorConfig["${namespace}"] on node "${node.key}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    for (const entry of node.memberEntries) {
      if (isComputedMemberDef(entry)) {
        // Registry entries are the computed's walkable candidates; bare
        // charter-node returns are covered by the charter.nodes iteration.
        for (const member of entry.registry ?? []) validate(member);
        continue;
      }
      validate(entry as Node<TDataContent>);
    }
  };

  Object.values(charter.nodes).forEach(validate);
  const visitInstance = (instance: Instance<TDataContent>): void => {
    validate(instance.node);
    instance.children?.forEach(visitInstance);
  };
  visitInstance(root);
}

function executorNodeConfig<TDataContent>(
  node: Node<TDataContent>,
  executor: ProjectorExecutor<TDataContent>,
): unknown {
  const namespace = executor.identity?.name;
  return namespace ? node.executorConfig?.[namespace] : undefined;
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
  return reconcileWorkLoop(machine as ProjectorMachine<TDataContent>, {});
}

export async function syncMachineRuntime<TDataContent = never>(
  machine: Machine<TDataContent>,
  options: SyncMachineRuntimeOptions<TDataContent>,
): Promise<RuntimeSyncContext<TDataContent> | undefined> {
  const syncRuntime = (machine.executor as SyncableExecutor<TDataContent> | undefined)?.syncRuntime;
  if (!syncRuntime) return undefined;

  const generatorId = validateGeneratorId(machine.instance, options.generatorId, machine.charter);
  reconcileStateResets(machine);
  const inference = compileProjection(machine.instance, {
    charter: machine.charter,
    targetGeneratorId: generatorId,
    frameHistory: machine.frames,
  });
  const getState = inference.retrievableStates.length > 0
    ? createRetrievableStateGetter(machine, inference.retrievableStates)
    : undefined;
  const frameDefaults = {
    generatorId,
  };
  const producer = executorProducer(machine.executor);
  const context: RuntimeSyncContext<TDataContent> = {
    machine,
    generatorId,
    inference,
    visibleFrames: options.visibleFrames ?? [],
    createActionContext: (action) =>
      createMachineActionContext(machine, action, frameDefaults, getState),
    // No generatorId default: sync-enqueued frames are not generation output
    // unless the producer says so. External user frames must stay ungenerated
    // or the self-trigger exclusion would suppress their activations.
    enqueueFrame: (frame, report) =>
      machine.enqueueFrame(signFrame(frame, producer, report, machine.runner)),
  };

  await syncRuntime.call(machine.executor, context);
  return context;
}

function reconcileYieldedWork<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
): Frame<TDataContent>[] {
  return reconcileWorkLoop(machine, { skipPendingSources: true });
}

function reconcileWorkLoop<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
  options: { skipPendingSources?: boolean },
): Frame<TDataContent>[] {
  const before = machine.frames.length;
  while (reconcileWorkOnce(machine, options).length > 0) {
    // Run to fixpoint: appended work frames can themselves be scheduling sources.
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

function startFrameCapture<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
): FrameCapture<TDataContent> {
  const capture: FrameCapture<TDataContent> = { frames: [] };
  machine.frameCaptures.push(capture);
  return capture;
}

function commitFrameCapture<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
  capture: FrameCapture<TDataContent>,
): Frame<TDataContent> | undefined {
  finishFrameCapture(machine, capture);
  if (capture.frames.length === 0) {
    return undefined;
  }
  const first = capture.frames[0];
  if (!first) {
    return undefined;
  }
  const frame: Frame<TDataContent> = {
    ...first,
    messages: mergeCapturedFrameMessages(capture.frames),
  };
  machine.frames.push(frame);
  machine.pendingFrames.push(frame);
  notifyFrame(machine, frame);
  return frame;
}

function mergeCapturedFrameMessages<TDataContent>(
  frames: readonly Frame<TDataContent>[],
): FrameMessage<TDataContent>[] {
  let offset = 0;
  return frames.flatMap((frame) => {
    const messages = frame.messages.map((message) =>
      offsetActionResultMessageIndices(message, offset),
    );
    offset += frame.messages.length;
    return messages;
  });
}

function offsetActionResultMessageIndices<TDataContent>(
  message: FrameMessage<TDataContent>,
  offset: number,
): FrameMessage<TDataContent> {
  if (
    offset === 0 ||
    message.type !== "action" ||
    message.kind !== "result" ||
    !Array.isArray(message.outputMessageIndices) ||
    message.outputMessageIndices.length === 0
  ) {
    return message;
  }

  return {
    ...message,
    outputMessageIndices: message.outputMessageIndices.map((index) => index + offset),
  };
}

function finishFrameCapture<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
  capture: FrameCapture<TDataContent>,
): void {
  const current = machine.frameCaptures.at(-1);
  if (current !== capture) {
    throw new Error("Frame captures must be finished in stack order");
  }
  machine.frameCaptures.pop();
}

function assertHasSourceInstance(root: Instance<any>): void {
  if (hasSourceInstance(root)) {
    return;
  }
  throw new Error("Projector machine requires at least one source instance");
}

function hasSourceInstance(instance: Instance<any>): boolean {
  return Boolean(instance.isSource) || (instance.children ?? []).some(hasSourceInstance);
}

function requireExecutor<TDataContent>(
  machine: Machine<TDataContent>,
): ProjectorExecutor<TDataContent> {
  if (!machine.executor) {
    throw new Error(
      "Machine has no executor; pass one to createMachine to run generator work",
    );
  }
  return machine.executor;
}

function executorProducer(
  executor: ProjectorExecutor<any> | undefined,
): FrameProducer | undefined {
  return executor?.identity ? { executor: executor.identity } : undefined;
}

/**
 * The single provenance write path: frames are signed by the framework at the
 * production boundary. A producer supplied here overrides anything a draft
 * carries — provenance is framework-owned.
 */
function signFrame<TFrame extends FrameDraft<any>>(
  frame: TFrame,
  producer: FrameProducer | undefined,
  report?: ExecutionReport,
  runner?: Record<string, unknown>,
): TFrame {
  if (!producer && !report && !runner) {
    return frame;
  }
  return {
    ...frame,
    provenance: {
      ...frame.provenance,
      ...(producer ? { producer } : {}),
      ...(report
        ? { execution: { ...frame.provenance?.execution, ...report } }
        : {}),
      ...(runner ? { runner } : {}),
    },
  };
}

const MACHINE_SCHEDULER: FrameProducer = { machine: "scheduler" };

/**
 * Machine dispatch/scheduling paths resolve members effectively — fresh
 * evaluation, no per-compile memo (correctness never depends on the memo). A
 * member whose select or computed currently derives "off" is not found, so a
 * stale dispatch errors cleanly instead of reaching a phantom contributor.
 */
function effectiveMembers<TDataContent>(
  charter: Charter<TDataContent> | undefined,
): MemberResolution<TDataContent> {
  return { mode: "effective", charter };
}

function validateGeneratorId<TDataContent>(
  root: Instance<TDataContent>,
  generatorId: GeneratorId,
  charter: Charter<TDataContent> | undefined,
): GeneratorId {
  const contributor = findContributorById(root, generatorId, effectiveMembers(charter));
  if (!contributor || contributor.node.runtime.type !== "generator") {
    throw new Error(`Unknown generator "${generatorId}"`);
  }

  return generatorId;
}

export function collectRunnableActivations<TDataContent = never>(
  machine: Machine<TDataContent>,
): Activation[] {
  const state = foldWork(machine);
  const generatorIds = collectGeneratorIds(machine.instance, machine.charter);
  const candidates = [...state.activations.values()]
    .filter((activation) => !state.completions.has(activation.activationId))
    .filter((activation) => !state.aborted.has(activation.activationId))
    .filter((activation) => generatorIds.has(activation.generatorId));

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

export type RunActivationOptions = {
  signal?: AbortSignal;
};

export async function runActivation<TDataContent = never>(
  machine: Machine<TDataContent>,
  activationId: string,
  options: RunActivationOptions = {},
): Promise<ExecutorRunResult<TDataContent> | undefined> {
  const initialState = foldWork(machine);
  const activation = initialState.activations.get(activationId);
  if (!activation) return undefined;
  if (initialState.completions.has(activationId)) return undefined;
  if (initialState.aborted.has(activationId)) {
    machine.enqueueFrame(signFrame(createCompletionFrame({
      activationId,
      generatorId: activation.generatorId,
      sourceFrameId: activation.sourceFrameId,
      reason: "cancelled",
    }), MACHINE_SCHEDULER, undefined, machine.runner));
    return { completionReason: "cancelled" };
  }

  const contributor = findContributorById(
    machine.instance,
    activation.generatorId,
    effectiveMembers(machine.charter),
  );
  if (!contributor || contributor.node.runtime.type !== "generator") {
    machine.enqueueFrame(signFrame(createCompletionFrame({
      activationId,
      generatorId: activation.generatorId,
      sourceFrameId: activation.sourceFrameId,
      reason: "cancelled",
    }), MACHINE_SCHEDULER, undefined, machine.runner));
    return { completionReason: "cancelled" };
  }

  const executor = requireExecutor(machine);
  const producer = executorProducer(executor);

  const runtime = contributor.node.runtime;
  const generatorRuntime = runtime as GeneratorRuntime;
  const frameDefaults = {
    generatorId: activation.generatorId,
    activationId,
  };
  const consumedFrameIds = new Set<string>();
  const recordConsumedFrames = (frameHistory: Frame<TDataContent>[]) => {
    const visible = visibleFramesForGenerator(
      frameHistory,
      activation.generatorId,
      generatorRuntime,
      activationId,
    );
    for (const frame of visible) {
      if (frame.messages.some(isActorMessage)) {
        consumedFrameIds.add(frame.id);
      }
    }
  };
  const compileActivationInference = (frameHistory: Frame<TDataContent>[]) =>
    compileProjection(machine.instance, {
      charter: machine.charter,
      targetGeneratorId: activation.generatorId,
      activationId,
      frameHistory,
    });
  reconcileStateResets(machine);
  const inference = compileActivationInference(machine.frames);
  recordConsumedFrames(machine.frames);
  const getState = inference.retrievableStates.length > 0
    ? createRetrievableStateGetter(machine, inference.retrievableStates)
    : undefined;
  const output = outputConfigForRuntime(contributor.node.output, runtime);
  const request: ExecutorRunRequest<TDataContent> = {
    generatorId: activation.generatorId,
    activationId,
    config: executorNodeConfig(contributor.node, executor),
    inference,
    output,
    ...(options.signal ? { signal: options.signal } : {}),
    createActionContext: (action) =>
      createMachineActionContext(machine, action, frameDefaults, getState),
    enqueueFrame: (draft, report) =>
      machine.enqueueFrame(signFrame({
        ...draft,
        generatorId: draft.generatorId ?? frameDefaults.generatorId,
        activationId: draft.activationId ?? frameDefaults.activationId,
      }, producer, report, machine.runner)),
    refreshInference: () => {
      // The executor supplies its own in-flight step messages, so its frames
      // are excluded from the re-projected history to avoid duplicating them.
      const frameHistory = machine.frames.filter((frame) => frame.activationId !== activationId);
      recordConsumedFrames(frameHistory);
      return compileActivationInference(frameHistory);
    },
  };

  const result = await executor.run(request);
  enqueueExecutorResult(machine, result, output, frameDefaults, producer);
  const workState = foldWork(machine);
  // An abort that landed mid-run wins over whatever the executor reported:
  // the turn completes cancelled (even if the executor ignored the signal and
  // finished) and absorbs nothing — messages seen mid-generation, including
  // the barge-in itself, must trigger their own follow-up work. The
  // executor's late frames were still enqueued above; valid work is never
  // dropped.
  const turnCancelled =
    result.completionReason === "cancelled" || workState.aborted.has(activationId);
  const completionMessages: FrameMessage<TDataContent>[] = [];
  if (!workState.completions.has(activationId)) {
    completionMessages.push(({
      type: "work",
      kind: "completion",
      activationId,
      generatorId: activation.generatorId,
      sourceFrameId: activation.sourceFrameId,
      reason: turnCancelled ? "cancelled" : completionReasonForRuntime(runtime, result.completionReason),
    } satisfies WorkCompletionMessage) as FrameMessage<TDataContent>);
  }
  if (!turnCancelled) {
    completionMessages.push(
      ...absorbedCompletionMessages(machine, activation, contributor, generatorRuntime, consumedFrameIds, workState),
    );
  }
  if (completionMessages.length > 0) {
    machine.enqueueFrame(signFrame({ messages: completionMessages }, producer, result.execution, machine.runner));
  }
  return result;
}

/**
 * Completes pending same-generator work for frames this activation actually
 * projected. Messages seen mid-generation are thereby absorbed instead of
 * triggering a redundant follow-up generation.
 */
function absorbedCompletionMessages<TDataContent>(
  machine: Machine<TDataContent>,
  activation: Activation,
  contributor: Contributor<TDataContent>,
  runtime: GeneratorRuntime,
  consumedFrameIds: ReadonlySet<string>,
  state: WorkState,
): FrameMessage<TDataContent>[] {
  const messages: FrameMessage<TDataContent>[] = [];
  for (const frame of machine.frames) {
    if (!consumedFrameIds.has(frame.id) || frame.id === activation.sourceFrameId) continue;
    if (frame.inert || sourceFrameProducedByGenerator(frame, activation.generatorId)) continue;
    // First-matching-trigger derivation, mirroring the scheduler's candidate
    // collection, so absorbed activation ids match what it would have minted.
    const matchedTrigger = matchingTrigger(contributor, runtime, frame, state, machine.frames);
    if (!matchedTrigger) continue;
    const absorbedActivationId =
      activationForGeneratorSource(state, activation.generatorId, frame.id)?.activationId ??
      activationIdFor({
        machineId: machine.id,
        generatorId: activation.generatorId,
        trigger: matchedTrigger,
        sourceFrameId: frame.id,
      });
    if (absorbedActivationId === activation.activationId) continue;
    if (state.completions.has(absorbedActivationId)) continue;
    if (hasCompletionForGeneratorSource(state, activation.generatorId, frame.id)) continue;
    messages.push(({
      type: "work",
      kind: "completion",
      activationId: absorbedActivationId,
      generatorId: activation.generatorId,
      sourceFrameId: frame.id,
      reason: "absorbed",
    } satisfies WorkCompletionMessage) as FrameMessage<TDataContent>);
  }
  return messages;
}

export async function executeCommand<
  T = unknown,
  TDataContent = never,
>(
  machine: Machine<TDataContent>,
  message: ActionRequestMessage & { action: "command" },
): Promise<ExecuteActionResult<T, TDataContent>> {
  if (message.kind !== "request" || message.action !== "command") {
    throw new Error("executeCommand requires a command action request");
  }

  const resolved = resolveCommand(machine, message);
  if (!resolved) {
    return enqueueImmediateActionResult(machine, message, {
      success: false,
      error: `Unknown command: ${message.name}`,
      callId: message.callId,
    });
  }

  let input = message.input;
  if (resolved.command.inputSchema) {
    const parsed = resolved.command.inputSchema.safeParse(input);
    if (!parsed.success) {
      return enqueueImmediateActionResult(machine, message, {
        success: false,
        error: parsed.error.message,
        callId: message.callId,
      });
    }
    input = parsed.data;
  }

  const projectorMachine = machine as ProjectorMachine<TDataContent>;
  const capture = startFrameCapture(projectorMachine);
  let committed = false;
  try {
    const result = executeActionInvocation<T, TDataContent>({
      request: message,
      enqueueRequestBeforeRun: true,
      enqueueMessages: (messages) => {
        machine.enqueueFrame({ messages });
      },
      run: () => {
        const context = createContributorActionContext(
          machine,
          resolved.contributor,
          resolved.command,
          {},
        );
        return resolved.command.run?.(input as never, context as never);
      },
    });

    if (isPromiseLike(result)) {
      commitFrameCapture(projectorMachine, capture);
      committed = true;
      return await result;
    }

    commitFrameCapture(projectorMachine, capture);
    committed = true;
    return result;
  } finally {
    // Frames captured before an error are real, already-folded events; commit
    // them so the frame log keeps matching the instance tree.
    if (!committed) {
      commitFrameCapture(projectorMachine, capture);
    }
  }
}

function enqueueImmediateActionResult<T, TDataContent>(
  machine: Machine<TDataContent>,
  request: ActionRequestMessage & { action: "command" },
  result: ExecuteActionResult<T, TDataContent>,
): ExecuteActionResult<T, TDataContent> {
  machine.enqueueFrame({
    messages: createActionTerminalMessages(request, result, true),
  });
  return result;
}

function resolveCommand<TDataContent>(
  machine: Machine<TDataContent>,
  message: ActionRequestMessage & { action: "command" },
): { command: AnyAction; contributor: Contributor<TDataContent> } | undefined {
  const contributors = collectContributors(machine.instance, effectiveMembers(machine.charter));
  if (message.target) {
    const targetRuntimeId = encodeProjectionAddress(message.target);
    const contributor = contributors.find((candidate) => candidate.id === targetRuntimeId);
    const command = contributor
      ? findContributorCommand(contributor, machine.charter, message.name)
      : undefined;
    if (contributor && command) {
      assertNodeActionStateCompatibility(command, contributor.node, "command");
    }
    return contributor && command ? { command, contributor } : undefined;
  }

  const matches: Array<{ command: AnyAction; contributor: Contributor<TDataContent> }> = [];
  for (const contributor of contributors) {
    const command = findContributorCommand(contributor, machine.charter, message.name);
    if (command) {
      assertNodeActionStateCompatibility(command, contributor.node, "command");
      matches.push({ command, contributor });
    }
  }
  if (matches.length > 1) {
    const contributorIds = matches.map((match) => match.contributor.id).join(", ");
    throw new Error(
      `Ambiguous command "${message.name}" is exposed by multiple contributors (${contributorIds}); specify a target`,
    );
  }
  return matches[0];
}

/**
 * External dispatch honors the caller field: only actions contributed with
 * caller external|any are reachable through executeCommand, evaluated against
 * the contributor's current scope (selects included, fresh evaluation).
 */
function findContributorCommand<TDataContent>(
  contributor: Contributor<TDataContent>,
  charter: Charter<TDataContent> | undefined,
  name: string,
): AnyAction | undefined {
  return resolveContributorActions(contributor, charter)
    .find((entry) => callerAllows(entry.caller, "external") && entry.action.name === name)?.action;
}

// Bind-time validation walks the "all" member view (sugar metadata branches
// plus computed registries): every walkable candidate validates up front. Bare
// computed returns are opaque data-side and surface at first compile instead.
function validateMachineActionStateCompatibility<TDataContent>(
  root: Instance<TDataContent>,
  charter: Charter<TDataContent>,
): void {
  for (const contributor of collectContributors(root)) {
    for (const entry of collectAllNodeActions(contributor.node, charter)) {
      const kind = callerAllows(entry.caller, "generator") ? "tool" : "command";
      assertNodeActionStateCompatibility(entry.action, contributor.node, kind);
      assertNodeActionParamsCompatibility(entry.action, contributor.node, kind);
    }
  }
}

function createMachineActionContext<TDataContent>(
  machine: Machine<TDataContent>,
  action: AnyAction,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "activationId">>,
  getState?: ActionContext["getState"],
): ActionContext<unknown, TDataContent> {
  const binding = getActionBinding(action);
  const contributor = binding
    ? findContributorById(machine.instance, binding.generatorId, effectiveMembers(machine.charter))
    : undefined;
  if (!contributor) {
    return createUnboundActionContext(getState);
  }
  const context = createContributorActionContext(machine, contributor, action, frameDefaults);
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
    return readStateValue(machine.instance, target);
  };
}

function createContributorActionContext<TDataContent>(
  machine: Machine<TDataContent>,
  contributor: Contributor<TDataContent>,
  action: AnyAction,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "activationId">>,
): ActionContext<unknown, TDataContent> {
  const stateAddress = stateAddressForContributor(contributor, action);
  const instance = createActionInstanceContext(machine, contributor, frameDefaults);
  const params = resolveActionParams(
    action,
    resolveContributorNodeParams(contributor),
  );
  if (!stateAddress) {
    return { params, instance };
  }

  const readState = () => readStateValue(machine.instance, stateAddress);
  const context: ActionContext<unknown, TDataContent> = {
    params,
    instance,
    state: readState(),
    updateState: (updateInput) => {
      const current = readState();
      const update = resolveStateUpdate(current, updateInput);
      const next = applyStateUpdate(current, update);
      validateStateValue(machine.instance, stateAddress, next);
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
  contributor: Contributor<TDataContent>,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "activationId">>,
): NonNullable<ActionContext<unknown, TDataContent>["instance"]> {
  const ownerInstanceId = contributor.concreteInstance.id;
  return {
    generatorId: contributor.id,
    address: contributor.address,
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
        ? childInstanceIdsByNodeKey(machine.instance, ownerInstanceId, node.key).map((instanceId) => ({
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

function enqueueExecutorResult<TDataContent>(
  machine: Machine<TDataContent>,
  result: ExecutorRunResult<TDataContent>,
  output: OutputConfig<TDataContent> | undefined,
  frameDefaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "activationId">>,
  producer: FrameProducer | undefined,
): void {
  for (const frame of result.frames ?? []) {
    enqueueFrameWithDefaults(machine, signFrame(frame, producer, undefined, machine.runner), frameDefaults);
  }

  if (result.value !== undefined) {
    enqueueFrameWithDefaults(
      machine,
      signFrame({
        messages: [
          assistantMessageFromTextOutput(result.value, output) as FrameMessage<TDataContent>,
        ],
      }, producer, result.execution, machine.runner),
      frameDefaults,
    );
  }
}

function outputConfigForRuntime<TDataContent>(
  output: OutputConfig<TDataContent> | undefined,
  runtime: NormalizedRuntime,
): OutputConfig<TDataContent> | undefined {
  if (runtime.type !== "generator" || output?.audience !== undefined) {
    return output;
  }

  if (runtime.outputAudienceDefault === undefined) {
    return output;
  }

  return {
    ...output,
    audience: runtime.outputAudienceDefault,
  };
}

function enqueueFrameWithDefaults<TDataContent>(
  machine: Machine<TDataContent>,
  frame: FrameDraft<TDataContent> | Frame<TDataContent>,
  defaults: Partial<Pick<FrameDraft<TDataContent>, "generatorId" | "activationId">>,
): Frame<TDataContent> {
  return machine.enqueueFrame({
    ...frame,
    generatorId: frame.generatorId ?? defaults.generatorId,
    activationId: frame.activationId ?? defaults.activationId,
  });
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
  if (isNode<TDataContent>(node)) {
    return serializeNode(node, charter);
  }
  return serializeNode(hydrateNode(node as SerializedNodeRef<TDataContent>, charter), charter);
}

/**
 * Applies a frame's instance messages atomically: the fold is dry-run against
 * a structural clone first, so a validation failure throws before the live
 * tree is touched. A frame either enters the log with its effects applied, or
 * has no effect at all. Returns any state resets the fold performed so the
 * caller can record them in the log.
 */
function foldFrameIntoMachine<TDataContent>(
  machine: Machine<TDataContent>,
  frame: Frame<TDataContent>,
): StateReset[] {
  const instanceMessages = frame.messages.filter(isInstanceMessage);
  if (instanceMessages.length === 0) {
    return [];
  }

  const draft = cloneInstanceTree(machine.instance);
  applyInstanceMessages(draft, instanceMessages, machine.charter);
  assertUniqueInstanceIds(draft);
  validateMachineActionStateCompatibility(draft, machine.charter);

  // The dry run validated every message; re-applying the same deterministic
  // operations to the live tree cannot throw.
  const resets: StateReset[] = [];
  applyInstanceMessages(machine.instance, instanceMessages, machine.charter, {
    onReset: (reset) => resets.push(reset),
  });
  return resets;
}

function applyInstanceMessages<TDataContent>(
  root: Instance<TDataContent>,
  messages: readonly InstanceMessage<TDataContent>[],
  charter: Charter<TDataContent>,
  options: ResolveStatesOptions = {},
): void {
  for (const message of messages) {
    applyInstanceMessage(root, message, charter, options);
  }
}

function stateResetFrame<TDataContent>(resets: StateReset[]): FrameDraft<TDataContent> {
  return {
    messages: resets.map((reset) =>
      ({
        type: "instance",
        kind: "state.update",
        instanceId: reset.address.instanceId,
        stateKey: reset.address.stateKey,
        update: { op: "replace", value: reset.value },
      } satisfies InstanceMessage) as FrameMessage<TDataContent>,
    ),
    provenance: { producer: { machine: "state-reconciliation" } },
  };
}

/**
 * Records any pending state resets (values invalidated by schema changes and
 * replaced with their init value) as state.update frames before compiling, so
 * the frame log reproduces the projected state.
 */
function reconcileStateResets<TDataContent>(machine: Machine<TDataContent>): void {
  const resets: StateReset[] = [];
  resolveStates(machine.instance, { onReset: (reset) => resets.push(reset) });
  if (resets.length > 0) {
    machine.enqueueFrame(stateResetFrame(resets));
  }
}

/**
 * Copies the instance wrappers, children arrays, and state containers while
 * sharing Node objects — folds never mutate nodes, only replace references.
 */
function cloneInstanceTree<TDataContent>(
  instance: Instance<TDataContent>,
): Instance<TDataContent> {
  return {
    ...instance,
    ...(instance.states
      ? {
          states: Object.fromEntries(
            Object.entries(instance.states).map(([key, container]) => [key, { ...container }]),
          ),
        }
      : {}),
    ...(instance.children
      ? { children: instance.children.map(cloneInstanceTree) }
      : {}),
  };
}

export function applyInstanceMessage<TDataContent>(
  root: Instance<TDataContent>,
  message: InstanceMessage<TDataContent>,
  charter: Charter<TDataContent>,
  options: ResolveStatesOptions = {},
): void {
  if (message.kind === "state.update") {
    const address = { instanceId: message.instanceId, stateKey: message.stateKey };
    const state = findResolvedState(root, address, options);
    const next = applyStateUpdate(state.container.value, message.update);
    state.descriptor.schema.parse(next);
    // Realization is a logged write: an unrealized state's container attaches
    // here, at the instance resolveStates derived for the declaring
    // contributor's scope, with the updater having seen init as `current`.
    realizeResolvedState(state);
    state.container.value = next;
    return;
  }

  if (message.kind === "transition") {
    const instance = findInstance(root, message.instanceId);
    if (!instance) {
      throw new Error(`Unknown instance "${message.instanceId}"`);
    }
    const scopeBaseline = scopeDuplicateBaseline(root, charter);
    instance.node = hydrateNode(message.node, charter);
    if (message.states) {
      applyStateValueOverrides(root, instance, message.states);
    }
    resolveStates(root, options);
    assertNoNewScopeDuplicates(root, charter, scopeBaseline, `transition of instance "${message.instanceId}"`);
    return;
  }

  if (message.kind === "spawn") {
    const parent = findInstance(root, message.parentInstanceId);
    if (!parent) {
      throw new Error(`Unknown parent instance "${message.parentInstanceId}"`);
    }
    const scopeBaseline = scopeDuplicateBaseline(root, charter);
    parent.children ??= [];
    const spawned = message.children.map((child) => spawnChildToInstance(child, charter));
    parent.children.push(...spawned);
    message.children.forEach((child, index) => {
      const instance = spawned[index];
      if (instance) {
        applySpawnStateOverrides(root, instance, child);
      }
    });
    resolveStates(root, options);
    assertNoNewScopeDuplicates(root, charter, scopeBaseline, `spawn under instance "${message.parentInstanceId}"`);
    return;
  }

  if (message.kind === "attach") {
    const parent = findInstance(root, message.parentInstanceId);
    if (!parent) {
      throw new Error(`Unknown parent instance "${message.parentInstanceId}"`);
    }
    const scopeBaseline = scopeDuplicateBaseline(root, charter);
    parent.children ??= [];
    parent.children.push(...message.children.map((child) => hydrateInstance(child, charter)));
    resolveStates(root, options);
    assertNoNewScopeDuplicates(root, charter, scopeBaseline, `attach under instance "${message.parentInstanceId}"`);
    return;
  }

  if (message.kind === "remove") {
    removeInstance(root, message.instanceId);
  }
}

/**
 * Mutation-time tier of the scope-uniqueness invariant: a spawn, transition,
 * or attach that would introduce a NEW duplicate node key inside one document
 * scope is rejected at the mutation, where the authoring error lives (the
 * machine's transactional dry-run fold makes rejection atomic). Pre-existing
 * duplicates are baselined out so persisted logs written before the invariant
 * keep replaying — the compile's ambiguous-include diagnostic backstops those.
 */
function scopeDuplicateBaseline<TDataContent>(
  root: Instance<TDataContent>,
  charter: Charter<TDataContent>,
): Set<string> {
  return new Set(
    collectScopeDuplicates(root, effectiveMembers(charter)).map((duplicate) => duplicate.id),
  );
}

function assertNoNewScopeDuplicates<TDataContent>(
  root: Instance<TDataContent>,
  charter: Charter<TDataContent>,
  baseline: ReadonlySet<string>,
  mutation: string,
): void {
  for (const duplicate of collectScopeDuplicates(root, effectiveMembers(charter))) {
    if (baseline.has(duplicate.id)) {
      continue;
    }
    throw new Error(
      `Rejected ${mutation}: node key "${duplicate.nodeKey}" would appear more than once in document scope "${duplicate.scopeRootId}" — a scope owns at most one contributor per node key; use distinct node keys`,
    );
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
  const contributor = collectContributors(root).find(
    (candidate) => !candidate.isMember && candidate.concreteInstance === instance,
  );
  const descriptor = contributor?.node.states.find((candidate) => candidate.key === stateKey);
  if (!contributor || !descriptor) {
    return instance;
  }
  return descriptor.scope === "local"
    ? contributor.concreteInstance
    : hoistStateInstance(contributor);
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

function findResolvedState(
  root: Instance<any>,
  address: StateAddress,
  options: ResolveStatesOptions = {},
) {
  const state = resolveStates(root, options).find(
    (candidate) =>
      candidate.address.instanceId === address.instanceId &&
      candidate.address.stateKey === address.stateKey,
  );
  if (!state) {
    throw new Error(`Unknown state "${address.instanceId}:${address.stateKey}"`);
  }
  return state;
}

function stateAddressForContributor(
  contributor: Contributor<any>,
  action: AnyAction,
): StateAddress | undefined {
  // With plural states, the action context binds the descriptor the ACTION
  // declares, resolved among the node's declarations. state: null means the
  // action gets no state context, even when the node declares states.
  const required = action.state?.key;
  if (required === undefined) {
    return undefined;
  }
  const descriptor = contributor.node.states.find((declared) => declared.key === required);
  if (!descriptor) {
    return undefined;
  }
  return {
    instanceId:
      descriptor.scope === "local"
        ? contributor.concreteInstance.id
        : hoistStateInstance(contributor).id,
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

function resolveStateUpdate<S>(
  state: S,
  update: StateUpdateInput<S>,
): StateUpdate<S> {
  return typeof update === "function" ? update(state) : update;
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

    const controller = new AbortController();
    const unsubscribe = this.machine.subscribe((frame) => {
      if (frameAbortsActivation(frame, activation)) {
        controller.abort();
      }
    });
    const run = (async () => {
      try {
        await runActivation(this.machine, activation.activationId, { signal: controller.signal });
      } catch (error) {
        this.activationErrors.push(error);
      } finally {
        unsubscribe();
        this.activeActivations.delete(activation.activationId);
      }
    })();

    this.activeActivations.set(activation.activationId, run);
  }

  private shouldScheduleWork(): boolean {
    return this.options.scheduleWork && !this.schedulingStopped;
  }
}

/**
 * Whether a newly enqueued frame requests cancellation of a specific in-flight
 * activation — either an abort message targeting it (by id, generator, or
 * unscoped) or a cancelled completion written on its behalf (e.g. by the
 * reconciler when its generator disappears).
 */
function frameAbortsActivation(frame: Frame<any>, activation: Activation): boolean {
  return frame.messages.some((message) => {
    if (isWorkAbortMessage(message)) {
      if (message.activationId !== undefined) return message.activationId === activation.activationId;
      if (message.generatorId !== undefined) return message.generatorId === activation.generatorId;
      return true;
    }
    return (
      isWorkCompletionMessage(message) &&
      message.reason === "cancelled" &&
      message.activationId === activation.activationId
    );
  });
}

function reconcileWorkOnce<TDataContent>(
  machine: ProjectorMachine<TDataContent>,
  options: { skipPendingSources?: boolean } = {},
): Frame<TDataContent>[] {
  const state = foldWork(machine);
  const contributors = collectContributors(machine.instance, effectiveMembers(machine.charter));
  const generatorContributors = contributors.filter(
    (contributor) => contributor.node.runtime.type === "generator",
  );
  const generatorIds = new Set(generatorContributors.map((contributor) => contributor.id));
  const appended: Frame<TDataContent>[] = [];
  const pendingFrameIds = options.skipPendingSources
    ? new Set(machine.pendingFrames.map((frame) => frame.id))
    : undefined;

  // Cancel pending activations whose generator no longer exists (or is no
  // longer a generator), plus pending activations targeted by an abort
  // message, so they complete durably instead of dangling. The abort frame is
  // the request; this completion is the acknowledgment — an in-flight run
  // observes the abort through its signal and unwinds without writing a
  // duplicate completion.
  for (const activation of state.activations.values()) {
    if (
      !state.completions.has(activation.activationId) &&
      (!generatorIds.has(activation.generatorId) || state.aborted.has(activation.activationId))
    ) {
      const frame = machine.enqueueFrame(signFrame(createCompletionFrame({
        activationId: activation.activationId,
        generatorId: activation.generatorId,
        sourceFrameId: activation.sourceFrameId,
        reason: "cancelled",
      }), MACHINE_SCHEDULER, undefined, machine.runner));
      appended.push(frame);
      state.completions.set(activation.activationId, {
        type: "work",
        kind: "completion",
        activationId: activation.activationId,
        generatorId: activation.generatorId,
        sourceFrameId: activation.sourceFrameId,
        reason: "cancelled",
        frameId: frame.id,
        frameIndex: machine.frames.length - 1,
      });
    }
  }

  // Every frame in the log is a scheduling source. Deterministic activation ids
  // plus the completion check make the full scan idempotent — including for
  // frames absorbed by a generation before their activation frame was written.
  for (const sourceFrame of machine.frames.slice()) {
    if (sourceFrame.inert) continue;
    if (pendingFrameIds?.has(sourceFrame.id)) continue;

    const { admitted, suppressed } = generatorCandidatesForSource(machine, sourceFrame, state, generatorContributors);
    for (const candidate of admitted) {
      const activationId = activationIdFor({
        machineId: machine.id,
        generatorId: candidate.generatorId,
        trigger: candidate.trigger,
        sourceFrameId: sourceFrame.id,
      });
      if (
        state.activations.has(activationId) ||
        state.completions.has(activationId) ||
        hasActivationForGeneratorSource(state, candidate.generatorId, sourceFrame.id) ||
        hasCompletionForGeneratorSource(state, candidate.generatorId, sourceFrame.id)
      ) continue;

      const frame = machine.enqueueFrame(signFrame(createActivationFrame({
        activationId,
        generatorId: candidate.generatorId,
        sourceFrameId: sourceFrame.id,
        concurrencyKey: candidate.concurrencyKey,
        concurrency: candidate.concurrency,
      }), MACHINE_SCHEDULER, undefined, machine.runner));
      appended.push(frame);
      state.activations.set(activationId, {
        type: "work",
        kind: "activation",
        activationId,
        generatorId: candidate.generatorId,
        sourceFrameId: sourceFrame.id,
        concurrencyKey: candidate.concurrencyKey,
        concurrency: candidate.concurrency,
        frameId: frame.id,
        frameIndex: machine.frames.length - 1,
      });
    }

    // A suppressed primary's turn is decided, not deferred: record the no-op
    // as a "suppressed" completion (no activation, no compile, no inference),
    // so a later tree change — e.g. the suppressor ceding — never re-opens a
    // frame the floor already arbitrated. Deterministic ids keep the record
    // replay-stable; the completion guard keeps the rescan idempotent.
    const suppressedCompletions: WorkCompletionMessage[] = [];
    for (const candidate of suppressed) {
      const activationId = activationIdFor({
        machineId: machine.id,
        generatorId: candidate.generatorId,
        trigger: candidate.trigger,
        sourceFrameId: sourceFrame.id,
      });
      if (
        state.activations.has(activationId) ||
        state.completions.has(activationId) ||
        hasActivationForGeneratorSource(state, candidate.generatorId, sourceFrame.id) ||
        hasCompletionForGeneratorSource(state, candidate.generatorId, sourceFrame.id)
      ) continue;

      suppressedCompletions.push({
        type: "work",
        kind: "completion",
        activationId,
        generatorId: candidate.generatorId,
        sourceFrameId: sourceFrame.id,
        reason: "suppressed",
      } satisfies WorkCompletionMessage);
    }
    if (suppressedCompletions.length > 0) {
      const frame = machine.enqueueFrame(signFrame(
        { messages: suppressedCompletions as FrameMessage<TDataContent>[] },
        MACHINE_SCHEDULER,
        undefined,
        machine.runner,
      ));
      appended.push(frame);
      for (const completion of suppressedCompletions) {
        state.completions.set(completion.activationId, {
          ...completion,
          frameId: frame.id,
          frameIndex: machine.frames.length - 1,
        });
      }
    }
  }

  return appended;
}

function hasActivationForGeneratorSource(
  state: WorkState,
  generatorId: GeneratorId,
  sourceFrameId: string,
): boolean {
  return activationForGeneratorSource(state, generatorId, sourceFrameId) !== undefined;
}

function activationForGeneratorSource(
  state: WorkState,
  generatorId: GeneratorId,
  sourceFrameId: string,
): Activation | undefined {
  for (const activation of state.activations.values()) {
    if (
      activation.generatorId === generatorId &&
      activation.sourceFrameId === sourceFrameId
    ) {
      return activation;
    }
  }
  return undefined;
}

/**
 * Completions can exist without an activation record (work absorbed by a
 * running generation), and completion ids embed the trigger type that minted
 * them. Matching by generator+source keeps the scan idempotent across trigger
 * declaration changes (e.g. the synthetic root's actor-frame → primary
 * migration): concluded work stays concluded even when the derived id
 * changes. First-match-wins mints at most one work item per generator per
 * source frame, so generator+source identifies it.
 */
function hasCompletionForGeneratorSource(
  state: WorkState,
  generatorId: GeneratorId,
  sourceFrameId: string,
): boolean {
  for (const completion of state.completions.values()) {
    if (
      completion.generatorId === generatorId &&
      completion.sourceFrameId === sourceFrameId
    ) {
      return true;
    }
  }
  return false;
}

function generatorCandidatesForSource<TDataContent>(
  machine: Machine<TDataContent>,
  sourceFrame: Frame<TDataContent>,
  state: WorkState,
  generatorContributors: readonly Contributor<TDataContent>[],
): ArbitratedCandidates {
  const candidates: GeneratorCandidate[] = [];
  for (const contributor of generatorContributors) {
    const runtime = contributor.node.runtime as GeneratorRuntime;
    if (sourceFrameProducedByGenerator(sourceFrame, contributor.id)) {
      continue;
    }
    const trigger = matchingTrigger(contributor, runtime, sourceFrame, state, machine.frames);
    if (!trigger) {
      continue;
    }

    const concurrency = runtime.concurrency ?? "serial";
    candidates.push({
      generatorId: contributor.id,
      trigger,
      concurrency,
      concurrencyKey: concurrency === "parallel"
        ? activationIdFor({
            machineId: machine.id,
            generatorId: contributor.id,
            trigger,
            sourceFrameId: sourceFrame.id,
        })
        : contributor.id,
    });
  }
  return arbitrateFloor(candidates, generatorContributors);
}

/**
 * The trigger a source frame satisfies, tried in declaration order — first
 * match wins, so a generator yields at most one candidate per frame even when
 * one frame satisfies several declared stimuli (e.g. a spawn frame that also
 * carries an actor message). The matched trigger travels on the candidate: it
 * mints the activation id and, for `primary`, carries admission semantics
 * into arbitration.
 */
function matchingTrigger<TDataContent>(
  contributor: Contributor<TDataContent>,
  runtime: GeneratorRuntime,
  sourceFrame: Frame<TDataContent>,
  state: WorkState,
  frames: readonly Frame<TDataContent>[],
): RuntimeTrigger | undefined {
  return runtimeTriggers(runtime).find((trigger) =>
    triggerMatches(contributor, trigger, sourceFrame, state, frames),
  );
}

/**
 * Whether the source frame arrived at-or-after the frame that spawned or
 * attached the contributor's runtime. Runtimes with no creating frame in the
 * log (statically declared, or reassembled from a compacted log) are eligible
 * for every frame.
 */
function primaryEligibleForFrame<TDataContent>(
  contributor: Contributor<TDataContent>,
  sourceFrame: Frame<TDataContent>,
  frames: readonly Frame<TDataContent>[],
): boolean {
  const creationIndex = frames.findIndex((frame) => runtimeCreatedByFrame(frame, contributor.id));
  if (creationIndex === -1) return true;
  const sourceIndex = frames.findIndex((frame) => frame.id === sourceFrame.id);
  return sourceIndex === -1 || sourceIndex >= creationIndex;
}

/**
 * Floor arbitration — admission control on a contended stimulus, per source
 * frame: a matching `primary` activates unless a matching `primary` with
 * `suppressAncestors` exists strictly below it on its own descendant path.
 * Peers coexist (suppression is lineage-scoped, never siblings), nested
 * suppressors compose (the deepest wins — the outer one sits on the inner
 * one's ancestor path), and candidates with any other trigger type pass
 * through untouched: unarbitrated triggers are unsuppressible by
 * construction. Suppression means do-not-activate — no activation frame, no
 * compile, no inference; it grants nothing downstream (output, audience,
 * abort scope keep their own owners). Pure function of (frame, instance tree,
 * declared triggers), so replay arbitrates identically. Arbitration itself
 * keeps no memory; the scheduler records each suppression as a "suppressed"
 * completion (the existing per-(generator, frame) work accounting, like
 * absorption), so an already-decided turn never re-opens when the tree later
 * changes. Both partitions are returned for that.
 */
function arbitrateFloor<TDataContent>(
  candidates: GeneratorCandidate[],
  generatorContributors: readonly Contributor<TDataContent>[],
): ArbitratedCandidates {
  const primaries = candidates.filter((candidate) => candidate.trigger.type === "primary");
  if (primaries.length <= 1) return { admitted: candidates, suppressed: [] }; // uncontended

  const contributorsById = new Map(
    generatorContributors.map((contributor) => [contributor.id, contributor]),
  );
  const suppressedIds = new Set<string>();
  for (const candidate of primaries) {
    if (candidate.trigger.type !== "primary" || !candidate.trigger.suppressAncestors) continue;
    for (
      let ancestor = contributorsById.get(candidate.generatorId)?.parent;
      ancestor;
      ancestor = ancestor.parent
    ) {
      suppressedIds.add(ancestor.id);
    }
  }
  if (suppressedIds.size === 0) return { admitted: candidates, suppressed: [] };

  const admitted: GeneratorCandidate[] = [];
  const suppressed: GeneratorCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.trigger.type === "primary" && suppressedIds.has(candidate.generatorId)) {
      suppressed.push(candidate);
    } else {
      admitted.push(candidate);
    }
  }
  return { admitted, suppressed };
}

function triggerMatches<TDataContent>(
  contributor: Contributor<TDataContent>,
  trigger: RuntimeTrigger,
  sourceFrame: Frame<TDataContent>,
  state: WorkState,
  frames: readonly Frame<TDataContent>[],
): boolean {
  // `primary` is `actor-frame`'s stimulus (same visibility and audience
  // rules) with negotiated admission; the negotiation lives in
  // arbitrateFloor, never in matching. One scoping difference: a primary
  // negotiates for turns that arrive while it exists, so frames that predate
  // its runtime's creation are not its stimulus. Without this, a specialist
  // spawned mid-turn to take the NEXT turn would retroactively answer the
  // current one on the full-log rescan — the double-response that making
  // spawn-activation opt-in exists to prevent. `actor-frame` is untouched:
  // observers hear the whole log.
  if (trigger.type === "actor-frame" || trigger.type === "primary") {
    if (trigger.type === "primary" && !primaryEligibleForFrame(contributor, sourceFrame, frames)) {
      return false;
    }
    return sourceFrame.messages.some((message) =>
      isActorMessage(message) &&
        actorMessageVisibleToGenerator(message, sourceFrame, contributor.id)
    );
  }

  if (trigger.type === "parent-activation") {
    return sourceFrame.messages.some((message) =>
      isWorkActivationMessage(message) &&
      message.generatorId === nearestAncestorGeneratorId(contributor)
    );
  }

  if (trigger.type === "parent-completion") {
    return sourceFrame.messages.some((message) => {
      if (!isWorkCompletionMessage(message)) return false;
      // A cancelled parent turn (abort/barge-in, orphaned generator) and a
      // floor-suppressed no-op are not completions to react to. (Suppressed
      // completions also carry no activation record, so the lookup below
      // would exclude them anyway — this keeps the rule explicit.)
      if (message.reason === "cancelled" || message.reason === "suppressed") return false;
      const completed = state.activations.get(message.activationId);
      return completed?.generatorId === nearestAncestorGeneratorId(contributor);
    });
  }

  if (trigger.type === "spawn") {
    return runtimeCreatedByFrame(sourceFrame, contributor.id);
  }

  return false;
}

/**
 * Pure fold of the frame log — includes activations for generators that no
 * longer exist in the tree. Consumers decide how to treat orphans: the
 * scheduler cancels them, runnability filters them out, and parent-completion
 * triggers still resolve their generator.
 */
function foldWork<TDataContent>(machine: Machine<TDataContent>): WorkState {
  const activations = new Map<string, Activation>();
  const completions = new Map<string, WorkCompletionMessage & { frameId: string; frameIndex: number }>();
  const aborted = new Map<string, WorkAbortMessage & { frameId: string; frameIndex: number }>();
  const abortMessages: Array<WorkAbortMessage & { frameId: string; frameIndex: number }> = [];
  const frameIndexById = new Map<string, number>();

  machine.frames.forEach((frame, frameIndex) => {
    frameIndexById.set(frame.id, frameIndex);
    for (const message of frame.messages) {
      if (isWorkActivationMessage(message) && !activations.has(message.activationId)) {
        activations.set(message.activationId, {
          ...message,
          frameId: frame.id,
          frameIndex,
        });
      }

      if (isWorkCompletionMessage(message) && !completions.has(message.activationId)) {
        completions.set(message.activationId, { ...message, frameId: frame.id, frameIndex });
      }

      if (isWorkAbortMessage(message)) {
        abortMessages.push({ ...message, frameId: frame.id, frameIndex });
      }
    }
  });

  // An abort applies to work *sourced* before the abort frame — including
  // work whose activation frame the scheduler had not materialized yet (e.g.
  // a stop racing runner startup) — and never to work sourced after it. Pure
  // fold of the log, so replay is deterministic. An explicit activationId is
  // honored even before its activation message appears — abort by id is
  // unambiguous.
  for (const abort of abortMessages) {
    if (abort.activationId !== undefined) {
      if (!aborted.has(abort.activationId)) aborted.set(abort.activationId, abort);
      continue;
    }
    for (const activation of activations.values()) {
      if (aborted.has(activation.activationId)) continue;
      if (abort.generatorId !== undefined && activation.generatorId !== abort.generatorId) continue;
      const sourceIndex = frameIndexById.get(activation.sourceFrameId) ?? activation.frameIndex;
      if (sourceIndex >= abort.frameIndex) continue;
      const completion = completions.get(activation.activationId);
      if (completion && completion.frameIndex < abort.frameIndex) continue;
      aborted.set(activation.activationId, abort);
    }
  }

  return { activations, completions, aborted };
}

function collectGeneratorIds(
  root: Instance<any>,
  charter: Charter<any> | undefined,
): Set<GeneratorId> {
  const ids = new Set<GeneratorId>();
  for (const contributor of collectContributors(root, effectiveMembers(charter))) {
    if (contributor.node.runtime.type === "generator") {
      ids.add(contributor.id);
    }
  }
  return ids;
}

function runtimeCreatedByFrame(
  frame: Frame<any>,
  generatorId: GeneratorId,
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

  const address = decodeContributorId(generatorId);
  const instanceId = address.type === "member" ? address.ownerInstanceId : address.instanceId;
  return createdInstanceIds.has(instanceId);
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

function sourceFrameProducedByGenerator(
  frame: Frame<any>,
  generatorId: GeneratorId,
): boolean {
  return frame.generatorId === generatorId;
}

function nearestAncestorGeneratorId(contributor: Contributor<any>): GeneratorId | undefined {
  let parent = contributor.parent;
  while (parent) {
    if (parent.node.runtime.type === "generator") {
      return parent.id;
    }
    parent = parent.parent;
  }
  return undefined;
}

/**
 * Activation ids are the raw scheduling coordinates joined verbatim — no
 * hashing. Ids double as dedupe keys in the frame log, so any lossy encoding
 * (e.g. a 32-bit hash) risks silently dropping distinct work on collision.
 */
function activationIdFor({
  machineId,
  generatorId,
  trigger,
  sourceFrameId,
}: {
  machineId: string;
  generatorId: GeneratorId;
  trigger: RuntimeTrigger;
  sourceFrameId: string;
}): string {
  return `activation:${machineId}|${generatorId}|${trigger.type}|${sourceFrameId}`;
}

function completionReasonForRuntime(
  runtime: NormalizedRuntime,
  reason: ExecutorRunResult["completionReason"],
): WorkCompletionReason {
  if (reason === "cancelled" || reason === "delegated" || reason === "error" || reason === "terminal-action") return reason;
  // A conversational responder ends the turn; `primary` is the same stimulus
  // as `actor-frame` (different admission), so it completes the same way.
  return runtime.type === "generator" &&
      runtimeTriggers(runtime).some(
        (trigger) => trigger.type === "actor-frame" || trigger.type === "primary",
      )
    ? "end-turn"
    : "done";
}

function nextFrameIndex(frames: Frame<any>[]): number {
  let max = -1;
  for (const frame of frames) {
    const match = /^frame-(\d+)$/.exec(frame.id);
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}
