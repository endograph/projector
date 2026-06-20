import * as z from "zod";
import {
  assertNodeActionStateCompatibility,
  bindAction,
  createGetStateAction,
  GET_STATE_ACTION_NAME,
} from "./actions.ts";
import {
  normalizeStaticBoundaryProjection,
  normalizeStaticProjection,
} from "./create.ts";
import type { ProjectionFrame } from "./frames.ts";
import { createRoot, directProjectionChildren, findFrameByRuntimeId, topStateInstance, traversalFrames } from "./frames.ts";
import { actorMessages, messages } from "./history.ts";
import {
  isHistoryProjectionFunction,
  isProjectionFunction,
} from "./projection-functions.ts";
import { encodeRuntimeAddress } from "./runtime-address.ts";
import { resolveFrameCommands, resolveFrameTools } from "./scoped-actions.ts";
import { resolveStates, type ResolvedState } from "./state.ts";
import {
  activationFrameIndexFor,
  actorMessageVisibleByDelivery,
  actorMessageVisibleToGenerator,
  frameVisibleByActivationHistory,
  isActorMessage,
} from "./visibility.ts";
import type {
  AnyAction,
  ActivationHistory,
  ActorHistoryProjection,
  Audience,
  BoundaryProjection,
  Charter,
  CompiledInference,
  ContentPart,
  Frame,
  FrameMessage,
  Generator,
  GeneratorKind,
  HistoryProjection,
  HistoryProjectionContext,
  HistoryProjectionFunction,
  Instance,
  MessageHistoryProjection,
  PrimaryRuntime,
  Projection,
  ProjectionContext,
  ProjectionDraft,
  ProjectionFunction,
  ProjectionPart,
  ProjectionSource,
  ProjectionStatePart,
  ProjectionTextPart,
  RetrievableState,
  RuntimeAddress,
  RuntimeConcurrency,
  RuntimeTrigger,
  StateAddress,
  StateProjection,
  StaticBoundaryProjection,
  StaticProjection,
  WorkerRuntime,
} from "./types.ts";

export type CompileProjectionOptions<
  TDataContent = never,
> = {
  targetGenerator?: Generator;
  history?: FrameMessage<TDataContent>[];
  frameHistory?: Frame<TDataContent>[];
  activationId?: string;
  charter?: Charter<TDataContent>;
};

export type CompiledProjectionTree<TDataContent = never> = {
  roots: CompiledProjectionNode<TDataContent>[];
};

export type CompiledProjectionPolicy =
  | Required<StaticProjection>
  | {
      type: "function";
      name: string;
      mode: "function";
      instructions: "function";
      tools: "function";
    }
  | {
      type: "ref";
      ref: string;
      mode: "ref";
      instructions: "ref";
      tools: "ref";
    };

export type CompiledBoundaryProjectionPolicy =
  | Required<StaticBoundaryProjection>
  | {
      type: "function";
      name: string;
      mode: "function";
    }
  | {
      type: "ref";
      ref: string;
      mode: "ref";
    };

export type CompiledProjectionNode<TDataContent = never> = {
  id: string;
  kind: GeneratorKind;
  runtimeInstanceId: string;
  nodeKey: string;
  name?: string;
  address: RuntimeAddress;
  parentRuntimeInstanceId?: string;
  runtime: {
    type: "primary" | "worker";
    trigger: RuntimeTrigger;
    concurrency: RuntimeConcurrency;
    activationHistory: ActivationHistory;
  };
  output?: OutputMeta;
  projection: {
    own: CompiledProjectionPolicy;
    boundary: CompiledBoundaryProjectionPolicy;
  };
  compiled: {
    systemParts: ContentPart<TDataContent>[];
    dynamicParts: ContentPart<TDataContent>[];
    tools: ActionMeta[];
    retrievableStates: RetrievableState[];
  };
  frames: CompiledProjectionFrameView[];
  children: CompiledProjectionNode<TDataContent>[];
};

export type CompiledProjectionFrameView = {
  runtimeInstanceId: string;
  nodeKey: string;
  name?: string;
  kind: "instance" | "member";
  address: RuntimeAddress;
  projection: CompiledProjectionPolicy;
  states: Array<{
    key: string;
    address: StateAddress;
    projection: StateProjection;
    value: unknown;
  }>;
  tools: ActionMeta[];
  commands: ActionMeta[];
};

type ActionMeta = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type OutputMeta = {
  audience?: Audience;
  schema?: unknown;
  mapsTextBlock: boolean;
};

export function compileProjection<TDataContent = never>(
  rootOrInstances:
    | Instance<TDataContent>
    | Instance<TDataContent>[],
  options: CompileProjectionOptions<TDataContent> = {},
): CompiledInference<TDataContent> {
  assertActivationCompileOptions(options);
  const root = Array.isArray(rootOrInstances) ? createRoot(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByFrame = groupStatesByFrame(states);
  const draft = emptyProjectionDraft<TDataContent>();
  const targetFrame = options.targetGenerator
    ? findFrameByRuntimeId(root, options.targetGenerator.runtimeInstanceId)
    : undefined;
  if (targetFrame && isRuntimeBoundary(targetFrame)) {
    return finalizeSections(
      compileTargetGeneratorProjection(targetFrame, options, stateByFrame),
      compileHistory(root, options, states),
    );
  }

  const frame = directRootFrame(root);
  if (isRuntimeBoundary(frame)) {
    return finalizeSections(
      compileBoundaryGeneratorProjection(frame, options, stateByFrame),
      compileHistory(root, options, states),
    );
  }
  visitProjectionFrame(draft, frame, options, stateByFrame);

  return finalizeSections(draft, compileHistory(root, options, states));
}

function assertActivationCompileOptions(options: CompileProjectionOptions<any>): void {
  if (options.activationId === undefined) {
    return;
  }
  if (!options.targetGenerator) {
    throw new Error("compileProjection activationId requires targetGenerator");
  }
  if (!options.frameHistory) {
    throw new Error("compileProjection activationId requires frameHistory");
  }
}

export function inspectCompiledProjectionTree<TDataContent = never>(
  rootOrInstances: Instance<TDataContent> | Instance<TDataContent>[],
  options: Omit<CompileProjectionOptions<TDataContent>, "targetGenerator"> = {},
): CompiledProjectionTree<TDataContent> {
  const root = Array.isArray(rootOrInstances) ? createRoot(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByFrame = groupStatesByFrame(states);
  const frame = directRootFrame(root);

  return {
    roots: isRuntimeBoundary(frame)
      ? [createCompiledProjectionNode(root, frame, undefined, options, stateByFrame)]
      : collectCompiledProjectionChildren(root, frame, undefined, options, stateByFrame),
  };
}

function visitProjectionFrame<TDataContent>(
  draft: ProjectionDraft<TDataContent>,
  frame: ProjectionFrame<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByFrame: Map<string, ResolvedState[]>,
): void {
  if (isRuntimeBoundary(frame) && !belongsToGenerator(frame, options.targetGenerator)) {
    const exported = compileBoundaryGeneratorProjection(frame, options, stateByFrame);
    const runtime = frame.node.runtime as PrimaryRuntime<TDataContent> | WorkerRuntime<TDataContent>;
    applyBoundaryProjection(
      draft,
      readonlyProjectionSource(exported),
      runtime.boundaryProjection,
      projectionContext(frame, "boundary", options.targetGenerator),
      options.charter,
    );
    return;
  }

  applyProjection(
    draft,
    compileNodeProjectionSource(frame, options, stateByFrame),
    frame.node.projection,
    projectionContext(frame, "node", options.targetGenerator),
    options.charter,
  );
  for (const child of directProjectionChildren(frame)) {
    visitProjectionFrame(draft, child, options, stateByFrame);
  }
}

function compileTargetGeneratorProjection<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByFrame: Map<string, ResolvedState[]>,
): ProjectionDraft<TDataContent> {
  if (!options.targetGenerator) {
    throw new Error("compileTargetGeneratorProjection requires targetGenerator");
  }
  return compileOwnedGeneratorProjection(frame, {
    ...options,
    targetGenerator: options.targetGenerator,
  }, stateByFrame);
}

function compileBoundaryGeneratorProjection<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByFrame: Map<string, ResolvedState[]>,
): ProjectionDraft<TDataContent> {
  return compileOwnedGeneratorProjection(frame, {
    ...options,
    targetGenerator: generatorForFrame(frame),
  }, stateByFrame);
}

function compileOwnedGeneratorProjection<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  options: CompileProjectionOptions<TDataContent> & { targetGenerator: Generator },
  stateByFrame: Map<string, ResolvedState[]>,
): ProjectionDraft<TDataContent> {
  const draft = emptyProjectionDraft<TDataContent>();

  applyProjection(
    draft,
    compileNodeProjectionSource(frame, options, stateByFrame),
    frame.node.projection,
    projectionContext(frame, "node", options.targetGenerator),
    options.charter,
  );
  for (const child of directProjectionChildren(frame)) {
    visitProjectionFrame(draft, child, options, stateByFrame);
  }
  return draft;
}

function collectCompiledProjectionChildren<TDataContent>(
  root: Instance<TDataContent>,
  frame: ProjectionFrame<TDataContent>,
  parentRuntimeInstanceId: string | undefined,
  options: Omit<CompileProjectionOptions<TDataContent>, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionNode<TDataContent>[] {
  const nodes: CompiledProjectionNode<TDataContent>[] = [];
  for (const child of directProjectionChildren(frame)) {
    if (isRuntimeBoundary(child)) {
      nodes.push(createCompiledProjectionNode(root, child, parentRuntimeInstanceId, options, stateByFrame));
    } else {
      nodes.push(...collectCompiledProjectionChildren(root, child, parentRuntimeInstanceId, options, stateByFrame));
    }
  }
  return nodes;
}

function createCompiledProjectionNode<TDataContent>(
  root: Instance<TDataContent>,
  frame: ProjectionFrame<TDataContent>,
  parentRuntimeInstanceId: string | undefined,
  options: Omit<CompileProjectionOptions<TDataContent>, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionNode<TDataContent> {
  const runtime = frame.node.runtime as PrimaryRuntime<TDataContent> | WorkerRuntime<TDataContent>;
  const kind = runtime.type === "worker" ? "worker" : "primary";
  const targetGenerator = {
    id: frame.runtimeInstanceId,
    kind,
    runtimeInstanceId: frame.runtimeInstanceId,
  } satisfies Generator;
  const compileOptions = {
    ...options,
    targetGenerator,
  };
  const compiled = finalizeSections(
    compileBoundaryGeneratorProjection(frame, compileOptions, stateByFrame),
    compileHistory(root, compileOptions, statesFromStateByFrame(stateByFrame)),
  );

  return {
    id: frame.runtimeInstanceId,
    kind,
    runtimeInstanceId: frame.runtimeInstanceId,
    nodeKey: frame.node.key,
    name: frame.node.name,
    address: frame.address,
    parentRuntimeInstanceId,
    runtime: {
      type: runtime.type,
      trigger: runtime.trigger,
      concurrency: runtime.concurrency ?? "serial",
      activationHistory: runtime.activationHistory ?? "live",
    },
    output: outputMeta(frame.node.output),
    projection: {
      own: inspectProjectionPolicy(frame.node.projection),
      boundary: inspectBoundaryProjectionPolicy(runtime.boundaryProjection),
    },
    compiled: {
      systemParts: compiled.systemParts,
      dynamicParts: compiled.dynamicParts,
      tools: compiled.tools.map(actionMeta),
      retrievableStates: compiled.retrievableStates,
    },
    frames: collectOwnedProjectionFrames(frame, options, stateByFrame),
    children: collectCompiledProjectionChildren(
      root,
      frame,
      frame.runtimeInstanceId,
      options,
      stateByFrame,
    ),
  };
}

function collectOwnedProjectionFrames(
  frame: ProjectionFrame<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionFrameView[] {
  const views: CompiledProjectionFrameView[] = [projectionFrameView(frame, options, stateByFrame)];
  for (const child of directProjectionChildren(frame)) {
    if (isRuntimeBoundary(child)) {
      continue;
    }
    views.push(projectionFrameView(child, options, stateByFrame));
    views.push(...collectOwnedProjectionDescendantFrames(child, options, stateByFrame));
  }
  return views;
}

function collectOwnedProjectionDescendantFrames(
  frame: ProjectionFrame<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionFrameView[] {
  const views: CompiledProjectionFrameView[] = [];
  for (const child of directProjectionChildren(frame)) {
    if (isRuntimeBoundary(child)) {
      continue;
    }
    views.push(projectionFrameView(child, options, stateByFrame));
    views.push(...collectOwnedProjectionDescendantFrames(child, options, stateByFrame));
  }
  return views;
}

function projectionFrameView(
  frame: ProjectionFrame<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionFrameView {
  return {
    runtimeInstanceId: frame.runtimeInstanceId,
    nodeKey: frame.node.key,
    name: frame.node.name,
    kind: frame.isMember ? "member" : "instance",
    address: frame.address,
    projection: inspectProjectionPolicy(frame.node.projection),
    states: (stateByFrame.get(frame.runtimeInstanceId) ?? []).map((state) => ({
      key: state.address.stateKey,
      address: state.address,
      projection: state.descriptor.projection,
      value: state.container.value,
    })),
    tools: resolveFrameTools(frame, options.charter).map(actionMeta),
    commands: resolveFrameCommands(frame, options.charter).map(actionMeta),
  };
}

function actionMeta(action: AnyAction): ActionMeta {
  return {
    name: action.name,
    description: action.description,
    inputSchema: action.inputSchema ? z.toJSONSchema(action.inputSchema) : undefined,
  };
}

function outputMeta(output: ProjectionFrame<any>["node"]["output"]): OutputMeta | undefined {
  if (!output) {
    return undefined;
  }
  return {
    audience: output.audience,
    schema: output.schema ? z.toJSONSchema(output.schema) : undefined,
    mapsTextBlock: Boolean(output.mapTextBlock),
  };
}

function compileNodeProjectionSource<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByFrame: Map<string, ResolvedState[]>,
): ProjectionSource<TDataContent> {
  const source = emptyProjectionDraft<TDataContent>();

  for (const state of stateByFrame.get(frame.runtimeInstanceId) ?? []) {
    addStateProjectionSource(source, state);
  }

  const tools = resolveFrameTools(frame, options.charter);
  for (const tool of tools) {
    assertNodeActionStateCompatibility(tool, frame.node, "tool");
  }
  source.tools.push(
    ...tools.map((tool) =>
      bindAction(tool, {
        runtimeInstanceId: frame.runtimeInstanceId,
      }),
    ),
  );

  return {
    instructions: frame.node.instructions,
    systemParts: source.systemParts,
    dynamicParts: source.dynamicParts,
    tools: source.tools,
    states: source.states,
  };
}

function addStateProjectionSource(
  source: ProjectionDraft<any>,
  state: ResolvedState,
): void {
  const part = stateProjectionPart(state);
  if (!part) {
    return;
  }

  addStatePart(source, part);
  if (part.section === "system") {
    source.systemParts.push(part);
  } else if (part.section === "dynamic") {
    source.dynamicParts.push(part);
  }
}

function stateProjectionPart(state: ResolvedState): ProjectionStatePart | undefined {
  const projection = state.descriptor.projection;
  if (projection === "hidden") {
    return undefined;
  }

  return {
    type: "state",
    section: projection,
    stateKey: state.address.stateKey,
    target: state.address,
    value: state.container.value,
  };
}

export function applyStaticProjection(
  draft: ProjectionDraft<any>,
  source: ProjectionSource<any>,
  projection?: StaticProjection,
): void {
  const resolved = normalizeStaticProjection(projection);
  if (resolved.mode === "hidden") {
    return;
  }
  if (resolved.mode === "replace") {
    clearProjectionDraft(draft);
  }

  if (resolved.instructions !== "hidden") {
    if (source.instructions) {
      const item = {
        type: "text",
        text: source.instructions,
      } satisfies ProjectionTextPart;
      if (resolved.instructions === "system") {
        draft.systemParts.push(item);
      } else {
        draft.dynamicParts.push(item);
      }
    }

    appendProjectionParts(draft, draft.systemParts, source.systemParts);
    appendProjectionParts(draft, draft.dynamicParts, source.dynamicParts);

    if (resolved.tools !== "hidden") {
      appendProjectionParts(
        draft,
        resolved.instructions === "system" ? draft.systemParts : draft.dynamicParts,
        source.states.filter((state) => state.section === "retrieval"),
      );
    }
  }

  if (resolved.tools !== "hidden") {
    draft.tools.push(...source.tools);
  }
}

export function applyStaticBoundaryProjection(
  parentDraft: ProjectionDraft<any>,
  source: ProjectionSource<any>,
  projection?: StaticBoundaryProjection,
): void {
  const resolved = normalizeStaticBoundaryProjection(projection);
  if (resolved.mode === "hidden") {
    return;
  }
  if (resolved.mode === "replace") {
    clearProjectionDraft(parentDraft);
  }

  mergeProjectionSource(parentDraft, source);
}

function applyProjection<TDataContent>(
  draft: ProjectionDraft<TDataContent>,
  source: ProjectionSource<TDataContent>,
  projection: Projection<TDataContent>,
  ctx: ProjectionContext<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): void {
  const resolved = resolveProjectionValue(projection, charter);
  if (isProjectionFunction<TDataContent>(resolved)) {
    resolved.method(ctx, draft, source);
    return;
  }

  applyStaticProjection(draft, source, resolved);
}

function applyBoundaryProjection<TDataContent>(
  draft: ProjectionDraft<TDataContent>,
  source: ProjectionSource<TDataContent>,
  projection: BoundaryProjection<TDataContent>,
  ctx: ProjectionContext<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): void {
  const resolved = resolveBoundaryProjectionValue(projection, charter);
  if (isProjectionFunction<TDataContent>(resolved)) {
    resolved.method(ctx, draft, source);
    return;
  }

  applyStaticBoundaryProjection(draft, source, resolved);
}

function finalizeSections<TDataContent>(
  draft: ProjectionDraft<TDataContent>,
  history: FrameMessage<TDataContent>[],
): CompiledInference<TDataContent> {
  const projectedStates = collectProjectedStates(draft);
  const aliases = buildAliases(projectedStates);
  const retrievableStates: RetrievableState[] = [];
  const retrievalKeys = new Set<string>();

  for (const state of projectedStates) {
    if (state.section !== "retrieval") {
      continue;
    }
    const alias = aliases.get(state);
    if (!alias || retrievalKeys.has(alias)) {
      continue;
    }
    retrievalKeys.add(alias);
    retrievableStates.push({ address: alias, target: state.target });
  }

  const tools = [...draft.tools];
  if (retrievableStates.length > 0) {
    if (tools.some((tool) => tool.name === GET_STATE_ACTION_NAME)) {
      throw new Error(`Projected tool name "${GET_STATE_ACTION_NAME}" is reserved for state retrieval`);
    }
    tools.push(createGetStateAction());
  }

  return {
    systemParts: compileContentParts(draft.systemParts, aliases),
    history,
    dynamicParts: compileContentParts(draft.dynamicParts, aliases),
    tools,
    retrievableStates,
  };
}

function compileHistory<TDataContent>(
  root: Instance<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  states: ResolvedState[],
): FrameMessage<TDataContent>[] {
  const ctx = historyProjectionContext(root, options, states);
  if (!ctx) {
    return options.frameHistory
      ? frameMessagesFromFrameHistory(options.frameHistory)
      : options.history ?? [];
  }

  const projection = resolveHistoryProjection(ctx.projection, options.charter);
  if (isMessageHistoryProjection(projection)) {
    return messages(ctx.context);
  }
  if (isActorHistoryProjection(projection)) {
    return actorMessages(ctx.context);
  }

  return projection.method(ctx.context);
}

function historyProjectionContext<TDataContent>(
  root: Instance<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  states: ResolvedState[],
):
  | {
      context: HistoryProjectionContext<TDataContent>;
      projection: HistoryProjection<TDataContent>;
    }
  | undefined {
  const target = options.targetGenerator;
  if (!target) {
    return undefined;
  }

  const frame = findFrameByRuntimeId(root, target.runtimeInstanceId);
  if (!frame || !isRuntimeBoundary(frame)) {
    return undefined;
  }

  const runtime = frame.node.runtime as PrimaryRuntime<TDataContent> | WorkerRuntime<TDataContent>;
  return {
    context: {
      target,
      runtimeInstanceId: target.runtimeInstanceId,
      activationId: options.activationId ?? "",
      trigger: runtime.trigger,
      history: visibleHistoryForTarget(root, target, runtime, options),
      states: stateValues(states),
    },
    projection: runtime.historyProjection ?? { type: "messages" },
  };
}

function visibleHistoryForTarget<TDataContent>(
  _root: Instance<TDataContent>,
  target: Generator,
  runtime: PrimaryRuntime<TDataContent> | WorkerRuntime<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
): Frame<TDataContent>[] {
  if (options.activationId !== undefined && options.frameHistory === undefined) {
    throw new Error("compileProjection activationId requires frameHistory");
  }

  const rawHistory = options.frameHistory ?? framesFromMessages(options.history ?? [], target);
  const activationFrameIndex = activationFrameIndexFor(rawHistory, options.activationId, {
    requireActivationFrame: options.activationId !== undefined,
  });

  return rawHistory.flatMap((frame, frameIndex) => {
    if (!frameVisibleByActivationHistory(
      frame,
      frameIndex,
      activationFrameIndex,
      runtime,
      options.activationId,
    )) {
      return [];
    }

    const frameMessages = frame.messages.filter((message) => {
      if (!isActorMessage(message)) {
        return true;
      }
      return (
        actorMessageVisibleToGenerator(message, frame, target) &&
        actorMessageVisibleByDelivery(message, frameIndex, activationFrameIndex)
      );
    });

    return frameMessages.length > 0 ? [{ ...frame, messages: frameMessages }] : [];
  });
}

function resolveHistoryProjection<TDataContent>(
  projection: HistoryProjection<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): ActorHistoryProjection | MessageHistoryProjection | HistoryProjectionFunction<TDataContent> {
  if (
    isActorHistoryProjection(projection) ||
    isMessageHistoryProjection(projection) ||
    isHistoryProjectionFunction(projection)
  ) {
    return projection as ActorHistoryProjection | MessageHistoryProjection | HistoryProjectionFunction<TDataContent>;
  }

  if (!charter) {
    throw new Error(`Cannot resolve history projection ref "${projection}" without charter`);
  }
  if (typeof projection !== "string") {
    throw new Error(`Cannot resolve unknown history projection`);
  }
  const historyProjection = charter.historyProjections[projection];
  if (!historyProjection) {
    throw new Error(`Unknown history projection ref "${projection}"`);
  }
  return historyProjection;
}

function isActorHistoryProjection<TDataContent>(
  projection: HistoryProjection<TDataContent>,
): projection is ActorHistoryProjection {
  return (
    typeof projection === "object" &&
    projection !== null &&
    "type" in projection &&
    projection.type === "actor"
  );
}

function isMessageHistoryProjection<TDataContent>(
  projection: HistoryProjection<TDataContent>,
): projection is MessageHistoryProjection {
  return (
    typeof projection === "object" &&
    projection !== null &&
    "type" in projection &&
    projection.type === "messages"
  );
}

function frameMessagesFromFrameHistory<TDataContent>(
  history: Frame<TDataContent>[],
): FrameMessage<TDataContent>[] {
  return messages({
    target: {
      id: "",
      kind: "primary",
      runtimeInstanceId: "",
    },
    runtimeInstanceId: "",
    activationId: "",
    trigger: { type: "actor-frame" },
    history,
    states: {},
  });
}

function framesFromMessages<TDataContent>(
  frameMessages: FrameMessage<TDataContent>[],
  target?: Generator,
): Frame<TDataContent>[] {
  return frameMessages.map((message, index) => ({
    id: `synthetic-history-${index}`,
    generatorId: target?.id ?? "synthetic-history",
    messages: [message],
  }));
}

function stateValues(states: ResolvedState[]): Record<string, unknown> {
  const keyCounts = new Map<string, number>();
  for (const state of states) {
    const key = state.address.stateKey;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const values: Record<string, unknown> = {};
  for (const state of states) {
    const stateKey = state.address.stateKey;
    const duplicate = (keyCounts.get(stateKey) ?? 0) > 1;
    const alias = duplicate ? `${stateKey}:${state.address.instanceId}` : stateKey;
    if (alias in values) {
      throw new Error(`Generated history state alias collision for "${alias}"`);
    }
    values[alias] = state.container.value;
  }
  return values;
}

function statesFromStateByFrame(stateByFrame: Map<string, ResolvedState[]>): ResolvedState[] {
  return [...stateByFrame.values()].flat();
}

function collectProjectedStates(draft: ProjectionDraft<any>): ProjectionStatePart[] {
  const states: ProjectionStatePart[] = [];
  const seen = new Set<ProjectionStatePart>();
  const add = (state: ProjectionStatePart) => {
    if (!seen.has(state)) {
      seen.add(state);
      states.push(state);
    }
  };

  for (const state of draft.states) {
    add(state);
  }
  for (const part of draft.systemParts) {
    if (part.type === "state") {
      add(part);
    }
  }
  for (const part of draft.dynamicParts) {
    if (part.type === "state") {
      add(part);
    }
  }

  return states;
}

function buildAliases(states: ProjectionStatePart[]): Map<ProjectionStatePart, string> {
  const keyCounts = new Map<string, number>();
  for (const state of states) {
    keyCounts.set(state.stateKey, (keyCounts.get(state.stateKey) ?? 0) + 1);
  }

  const aliases = new Map<ProjectionStatePart, string>();
  const used = new Map<string, ProjectionStatePart>();
  for (const state of states) {
    const duplicate = (keyCounts.get(state.stateKey) ?? 0) > 1;
    const alias = duplicate ? `${state.stateKey}:${state.target.instanceId}` : state.stateKey;
    const collision = used.get(alias);
    if (collision && collision.target !== state.target) {
      throw new Error(`Generated state alias collision for "${alias}"`);
    }
    used.set(alias, state);
    aliases.set(state, alias);
  }

  return aliases;
}

function compileContentParts<TDataContent>(
  items: ProjectionPart<TDataContent>[],
  aliases: Map<ProjectionStatePart, string>,
): ContentPart<TDataContent>[] {
  return items.map((item) => {
    if (item.type === "text") {
      return item;
    }
    if (item.type === "image" || item.type === "data") {
      return item;
    }

    const alias = aliases.get(item);
    if (!alias) {
      throw new Error(`Missing alias for state "${item.stateKey}"`);
    }

    if (item.section === "retrieval") {
      return {
        type: "text",
        text: `You can call getState with address \`${alias}\` if you need that state.`,
      };
    }

    return {
      type: "text",
      text: `State \`${alias}\`: ${JSON.stringify(item.value)}`,
    };
  });
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

function resolveProjectionValue<TDataContent>(
  projection: Projection<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): StaticProjection | ProjectionFunction<TDataContent> {
  if (typeof projection === "string") {
    if (!charter) {
      throw new Error(`Cannot resolve projection ref "${projection}" without charter`);
    }
    const fn = charter.projections[projection];
    if (!fn) {
      throw new Error(`Unknown projection ref "${projection}"`);
    }
    return fn;
  }

  return projection;
}

function resolveBoundaryProjectionValue<TDataContent>(
  projection: BoundaryProjection<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): StaticBoundaryProjection | ProjectionFunction<TDataContent> {
  if (typeof projection === "string") {
    if (!charter) {
      throw new Error(`Cannot resolve projection ref "${projection}" without charter`);
    }
    const fn = charter.projections[projection];
    if (!fn) {
      throw new Error(`Unknown projection ref "${projection}"`);
    }
    return fn;
  }

  return projection;
}

function inspectProjectionPolicy<TDataContent>(
  projection: Projection<TDataContent>,
): CompiledProjectionPolicy {
  if (isProjectionFunction<TDataContent>(projection)) {
    return {
      type: "function",
      name: projection.name,
      mode: "function",
      instructions: "function",
      tools: "function",
    };
  }
  if (typeof projection === "string") {
    return {
      type: "ref",
      ref: projection,
      mode: "ref",
      instructions: "ref",
      tools: "ref",
    };
  }
  return normalizeStaticProjection(projection);
}

function inspectBoundaryProjectionPolicy<TDataContent>(
  projection: BoundaryProjection<TDataContent>,
): CompiledBoundaryProjectionPolicy {
  if (isProjectionFunction<TDataContent>(projection)) {
    return { type: "function", name: projection.name, mode: "function" };
  }
  if (typeof projection === "string") {
    return { type: "ref", ref: projection, mode: "ref" };
  }
  return normalizeStaticBoundaryProjection(projection);
}

function projectionContext<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  callSite: ProjectionContext<TDataContent>["callSite"],
  target: Generator | undefined,
): ProjectionContext<TDataContent> {
  return {
    callSite,
    runtimeInstanceId: frame.runtimeInstanceId,
    address: frame.address,
    target,
    node: frame.node,
  };
}

function readonlyProjectionSource<TDataContent>(draft: ProjectionDraft<TDataContent>): ProjectionSource<TDataContent> {
  return {
    systemParts: draft.systemParts,
    dynamicParts: draft.dynamicParts,
    tools: draft.tools,
    states: draft.states,
  };
}

function mergeProjectionSource(
  draft: ProjectionDraft<any>,
  source: ProjectionSource<any>,
): void {
  appendProjectionParts(draft, draft.systemParts, source.systemParts);
  appendProjectionParts(draft, draft.dynamicParts, source.dynamicParts);
  for (const state of source.states) {
    addStatePart(draft, state);
  }
  draft.tools.push(...source.tools);
}

function appendProjectionParts(
  draft: ProjectionDraft<any>,
  target: ProjectionPart<any>[],
  parts: readonly ProjectionPart<any>[],
): void {
  for (const part of parts) {
    target.push(part);
    if (part.type === "state") {
      addStatePart(draft, part);
    }
  }
}

function addStatePart(draft: ProjectionDraft<any>, state: ProjectionStatePart): void {
  if (!draft.states.includes(state)) {
    draft.states.push(state);
  }
}

function stateAddressForFrame(frame: ProjectionFrame<any>): StateAddress | undefined {
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

function emptyProjectionDraft<TDataContent = never>(): ProjectionDraft<TDataContent> {
  return { systemParts: [], dynamicParts: [], tools: [], states: [] };
}

function clearProjectionDraft(draft: ProjectionDraft<any>): void {
  draft.systemParts.length = 0;
  draft.dynamicParts.length = 0;
  draft.tools.length = 0;
  draft.states.length = 0;
}

function isRuntimeBoundary(frame: ProjectionFrame<any>): boolean {
  return frame.node.runtime.type === "primary" || frame.node.runtime.type === "worker";
}

function generatorForFrame(frame: ProjectionFrame<any>): Generator {
  return {
    id: frame.runtimeInstanceId,
    kind: frame.node.runtime.type === "worker" ? "worker" : "primary",
    runtimeInstanceId: frame.runtimeInstanceId,
  };
}

function belongsToGenerator(frame: ProjectionFrame<any>, generator: Generator | undefined): boolean {
  return Boolean(generator && generator.runtimeInstanceId === frame.runtimeInstanceId);
}

function directRootFrame<TDataContent>(
  instance: Instance<TDataContent>,
): ProjectionFrame<TDataContent> {
  const frame = traversalFrames(instance)[0];
  if (!frame) {
    throw new Error("Unable to create root projection frame");
  }
  return frame;
}
