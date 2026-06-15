import * as z from "zod";
import {
  assertNodeActionStateCompatibility,
  bindAction,
  createGetStateAction,
  GET_STATE_ACTION_NAME,
} from "./actions.ts";
import { normalizeStaticProjection } from "./create.ts";
import type { ProjectionFrame, SyntheticRoot } from "./frames.ts";
import { createRoot, directProjectionChildren, findFrameByRuntimeId, traversalFrames } from "./frames.ts";
import { actorMessages } from "./history.ts";
import { resolveFrameCommands, resolveFrameTools } from "./scoped-actions.ts";
import { resolveStates, type ResolvedState } from "./state.ts";
import {
  activationFrameIndexFor,
  actorMessageVisibleByActivationHistory,
  actorMessageVisibleByDelivery,
  actorMessageVisibleToGenerator,
  isActorMessage,
} from "./visibility.ts";
import type {
  AnyAction,
  ActorMessage,
  ActivationHistory,
  ActorHistoryProjection,
  Audience,
  Charter,
  CompiledInference,
  Frame,
  Generator,
  GeneratorKind,
  HistoryProjection,
  HistoryProjectionContext,
  HistoryProjectionFunction,
  Instance,
  PrimaryRuntime,
  Projection,
  ProjectionContext,
  RetrievableState,
  RuntimeAddress,
  RuntimeConcurrency,
  RuntimeTrigger,
  StateAddress,
  StateProjection,
  StaticProjection,
  WorkerRuntime,
} from "./types.ts";

const SYNTHETIC_ROOT_RUNTIME_ID = "synthetic-root";

type TextItem = { type: "text"; value: string };
type StateItem = {
  type: "state";
  section: "system" | "dynamic" | "retrieval";
  stateKey: string;
  target: StateAddress;
  value: unknown;
};
type SectionItem = TextItem | StateItem;

type ProjectionSections = {
  systemItems: SectionItem[];
  dynamicItems: SectionItem[];
  tools: AnyAction[];
  states: StateItem[];
};

export type CompileProjectionOptions = {
  targetGenerator?: Generator;
  history?: ActorMessage[];
  frameHistory?: Frame[];
  activationId?: string;
  charter?: Charter;
};

export type CompiledProjectionTree = {
  roots: CompiledProjectionNode[];
};

export type CompiledProjectionNode = {
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
    own: Required<StaticProjection>;
    boundary: Required<StaticProjection>;
  };
  compiled: {
    systemParts: string[];
    dynamicParts: string[];
    tools: ActionMeta[];
    retrievableStates: RetrievableState[];
  };
  frames: CompiledProjectionFrameView[];
  children: CompiledProjectionNode[];
};

export type CompiledProjectionFrameView = {
  runtimeInstanceId: string;
  nodeKey: string;
  name?: string;
  kind: "instance" | "member";
  address: RuntimeAddress;
  projection: Required<StaticProjection>;
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

export function compileProjection(
  rootOrInstances: SyntheticRoot | Instance | Instance[],
  options: CompileProjectionOptions = {},
): CompiledInference {
  assertActivationCompileOptions(options);
  const root = Array.isArray(rootOrInstances) ? createRoot(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByFrame = groupStatesByFrame(states);
  const sections = emptySections();
  const targetFrame = options.targetGenerator
    ? findFrameByRuntimeId(root, options.targetGenerator.runtimeInstanceId)
    : undefined;
  if (targetFrame && isRuntimeBoundary(targetFrame)) {
    return finalizeSections(
      compileGeneratorProjection(targetFrame, options, stateByFrame),
      compileHistory(root, options, states),
    );
  }

  const roots = isSyntheticRoot(root) ? root.instances : [root];

  for (const instance of roots) {
    const frame = directRootFrame(instance);
    visitProjectionFrame(sections, frame, options, stateByFrame);
  }

  return finalizeSections(sections, compileHistory(root, options, states));
}

function assertActivationCompileOptions(options: CompileProjectionOptions): void {
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

export function inspectCompiledProjectionTree(
  rootOrInstances: SyntheticRoot | Instance | Instance[],
  options: Omit<CompileProjectionOptions, "targetGenerator"> = {},
): CompiledProjectionTree {
  const root = Array.isArray(rootOrInstances) ? createRoot(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByFrame = groupStatesByFrame(states);
  const roots = isSyntheticRoot(root) ? root.instances : [root];

  return {
    roots: roots.flatMap((instance) => {
      const frame = directRootFrame(instance);
      return isRuntimeBoundary(frame)
        ? [createCompiledProjectionNode(root, frame, undefined, options, stateByFrame)]
        : collectCompiledProjectionChildren(root, frame, undefined, options, stateByFrame);
    }),
  };
}

function visitProjectionFrame(
  sections: ProjectionSections,
  frame: ProjectionFrame,
  options: CompileProjectionOptions,
  stateByFrame: Map<string, ResolvedState[]>,
): void {
  if (isRuntimeBoundary(frame) && !belongsToGenerator(frame, options.targetGenerator)) {
    const exported = compileGeneratorProjection(frame, options, stateByFrame);
    const runtime = frame.node.runtime as PrimaryRuntime | WorkerRuntime;
    applyProjectionAggregate(sections, exported, runtime.boundaryProjection, frame, options);
    return;
  }

  applyProjectionFrame(sections, frame, frame.node.projection, options, stateByFrame);
  for (const child of directProjectionChildren(frame)) {
    visitProjectionFrame(sections, child, options, stateByFrame);
  }
}

function compileGeneratorProjection(
  frame: ProjectionFrame,
  options: CompileProjectionOptions,
  stateByFrame: Map<string, ResolvedState[]>,
): ProjectionSections {
  const sections = emptySections();
  const ownedOptions = {
    ...options,
    targetGenerator: {
      id: frame.runtimeInstanceId,
      kind: frame.node.runtime.type === "worker" ? "worker" : "primary",
      runtimeInstanceId: frame.runtimeInstanceId,
    } satisfies Generator,
  };

  applyProjectionFrame(sections, frame, frame.node.projection, ownedOptions, stateByFrame);
  for (const child of directProjectionChildren(frame)) {
    visitProjectionFrame(sections, child, ownedOptions, stateByFrame);
  }
  return sections;
}

function collectCompiledProjectionChildren(
  root: SyntheticRoot | Instance,
  frame: ProjectionFrame,
  parentRuntimeInstanceId: string | undefined,
  options: Omit<CompileProjectionOptions, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionNode[] {
  const nodes: CompiledProjectionNode[] = [];
  for (const child of directProjectionChildren(frame)) {
    if (isRuntimeBoundary(child)) {
      nodes.push(createCompiledProjectionNode(root, child, parentRuntimeInstanceId, options, stateByFrame));
    } else {
      nodes.push(...collectCompiledProjectionChildren(root, child, parentRuntimeInstanceId, options, stateByFrame));
    }
  }
  return nodes;
}

function createCompiledProjectionNode(
  root: SyntheticRoot | Instance,
  frame: ProjectionFrame,
  parentRuntimeInstanceId: string | undefined,
  options: Omit<CompileProjectionOptions, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionNode {
  const runtime = frame.node.runtime as PrimaryRuntime | WorkerRuntime;
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
    compileGeneratorProjection(frame, compileOptions, stateByFrame),
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
      own: resolveProjection(frame.node.projection, frame, options.charter),
      boundary: resolveProjection(runtime.boundaryProjection, frame, options.charter),
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
  frame: ProjectionFrame,
  options: Omit<CompileProjectionOptions, "targetGenerator">,
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
  frame: ProjectionFrame,
  options: Omit<CompileProjectionOptions, "targetGenerator">,
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
  frame: ProjectionFrame,
  options: Omit<CompileProjectionOptions, "targetGenerator">,
  stateByFrame: Map<string, ResolvedState[]>,
): CompiledProjectionFrameView {
  return {
    runtimeInstanceId: frame.runtimeInstanceId,
    nodeKey: frame.node.key,
    name: frame.node.name,
    kind: frame.isMember ? "member" : "instance",
    address: frame.address,
    projection: resolveProjection(frame.node.projection, frame, options.charter),
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

function outputMeta(output: ProjectionFrame["node"]["output"]): OutputMeta | undefined {
  if (!output) {
    return undefined;
  }
  return {
    audience: output.audience,
    schema: output.schema ? z.toJSONSchema(output.schema) : undefined,
    mapsTextBlock: Boolean(output.mapTextBlock),
  };
}

function applyProjectionFrame(
  sections: ProjectionSections,
  frame: ProjectionFrame,
  projection: Projection,
  options: CompileProjectionOptions,
  stateByFrame: Map<string, ResolvedState[]>,
): void {
  const resolved = resolveProjection(projection, frame, options.charter);
  if (resolved.mode === "hidden") {
    return;
  }
  if (resolved.mode === "replace") {
    clearSections(sections);
  }

  const instructions = resolved.instructions;
  if (instructions !== "hidden" && frame.node.instructions) {
    const item = { type: "text", value: frame.node.instructions } satisfies TextItem;
    if (instructions === "system") {
      sections.systemItems.push(item);
    } else {
      sections.dynamicItems.push(item);
    }
  }

  if (resolved.instructions !== "hidden") {
    for (const state of stateByFrame.get(frame.runtimeInstanceId) ?? []) {
      addStateProjection(sections, state, {
        instructionProjection: resolved.instructions,
        includeRetrieval: resolved.tools !== "hidden",
      });
    }
  }

  if (resolved.tools !== "hidden") {
    const tools = resolveFrameTools(frame, options.charter);
    for (const tool of tools) {
      assertNodeActionStateCompatibility(tool, frame.node, "tool");
    }
    sections.tools.push(
      ...tools.map((tool) =>
        bindAction(tool, {
          runtimeInstanceId: frame.runtimeInstanceId,
          stateAddress: stateAddressForFrame(frame),
        }),
      ),
    );
  }
}

function applyProjectionAggregate(
  sections: ProjectionSections,
  aggregate: ProjectionSections,
  projection: Projection,
  frame: ProjectionFrame,
  options: CompileProjectionOptions,
): void {
  const resolved = resolveProjection(projection, frame, options.charter);
  if (resolved.mode === "hidden") {
    return;
  }
  if (resolved.mode === "replace") {
    clearSections(sections);
  }

  let projectedItems: SectionItem[] = [];
  if (resolved.instructions !== "hidden") {
    projectedItems = [...aggregate.systemItems, ...aggregate.dynamicItems].filter((item) =>
      resolved.tools === "hidden" && item.type === "state" && item.section === "retrieval"
        ? false
        : true,
    );
    if (resolved.instructions === "system") {
      sections.systemItems.push(...projectedItems);
    } else {
      sections.dynamicItems.push(...projectedItems);
    }
    sections.states.push(...projectedItems.filter((item): item is StateItem => item.type === "state"));
  }

  if (resolved.tools !== "hidden") {
    sections.tools.push(...aggregate.tools);
    sections.states.push(
      ...aggregate.states.filter((state) => !projectedItems.includes(state)),
    );
  }
}

function addStateProjection(
  sections: ProjectionSections,
  state: ResolvedState,
  options: {
    instructionProjection: "system" | "dynamic";
    includeRetrieval: boolean;
  },
): void {
  const projection = state.descriptor.projection;
  if (projection === "hidden") {
    return;
  }

  if (projection === "retrieval" && !options.includeRetrieval) {
    return;
  }

  const item: StateItem = {
    type: "state",
    section: projection,
    stateKey: state.address.stateKey,
    target: state.address,
    value: state.container.value,
  };

  sections.states.push(item);
  if (projection === "system") {
    sections.systemItems.push(item);
  } else if (projection === "dynamic") {
    sections.dynamicItems.push(item);
  } else {
    const noteTarget =
      options.instructionProjection === "system" ? sections.systemItems : sections.dynamicItems;
    noteTarget.push(item);
  }
}

function finalizeSections(
  sections: ProjectionSections,
  history: ActorMessage[],
): CompiledInference {
  const aliases = buildAliases(sections.states);
  const retrievableStates: RetrievableState[] = [];
  const retrievalKeys = new Set<string>();

  for (const state of sections.states) {
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

  const tools = [...sections.tools];
  if (retrievableStates.length > 0) {
    if (tools.some((tool) => tool.name === GET_STATE_ACTION_NAME)) {
      throw new Error(`Projected tool name "${GET_STATE_ACTION_NAME}" is reserved for state retrieval`);
    }
    tools.push(createGetStateAction());
  }

  return {
    systemParts: renderItems(sections.systemItems, aliases),
    history,
    dynamicParts: renderItems(sections.dynamicItems, aliases),
    tools,
    retrievableStates,
  };
}

function compileHistory(
  root: SyntheticRoot | Instance,
  options: CompileProjectionOptions,
  states: ResolvedState[],
): ActorMessage[] {
  const ctx = historyProjectionContext(root, options, states);
  if (!ctx) {
    return options.frameHistory
      ? actorMessagesFromFrameHistory(options.frameHistory)
      : options.history ?? [];
  }

  const projection = resolveHistoryProjection(ctx.projection, options.charter);
  if (isActorHistoryProjection(projection)) {
    return actorMessages(ctx.context);
  }

  return projection(ctx.context);
}

function historyProjectionContext(
  root: SyntheticRoot | Instance,
  options: CompileProjectionOptions,
  states: ResolvedState[],
):
  | {
      context: HistoryProjectionContext;
      projection: HistoryProjection;
    }
  | undefined {
  const target = options.targetGenerator;
  if (!target) {
    return undefined;
  }

  const frame = findFrameByRuntimeId(root, target.runtimeInstanceId);
  if (target.runtimeInstanceId === SYNTHETIC_ROOT_RUNTIME_ID) {
    return {
      context: {
        target,
        runtimeInstanceId: target.runtimeInstanceId,
        activationId: options.activationId ?? "",
        trigger: { type: "actor-frame" },
        history: visibleHistoryForTarget(
          root,
          target,
          syntheticRootRuntime(),
          options,
        ),
        states: stateValues(states),
      },
      projection: { type: "actor" },
    };
  }

  if (!frame || !isRuntimeBoundary(frame)) {
    return undefined;
  }

  const runtime = frame.node.runtime as PrimaryRuntime | WorkerRuntime;
  return {
    context: {
      target,
      runtimeInstanceId: target.runtimeInstanceId,
      activationId: options.activationId ?? "",
      trigger: runtime.trigger,
      history: visibleHistoryForTarget(root, target, runtime, options),
      states: stateValues(states),
    },
    projection: runtime.historyProjection ?? { type: "actor" },
  };
}

function visibleHistoryForTarget(
  _root: SyntheticRoot | Instance,
  target: Generator,
  runtime: PrimaryRuntime | WorkerRuntime,
  options: CompileProjectionOptions,
): Frame[] {
  if (options.activationId !== undefined && options.frameHistory === undefined) {
    throw new Error("compileProjection activationId requires frameHistory");
  }

  const rawHistory = options.frameHistory ?? framesFromActorMessages(options.history ?? [], target);
  const activationFrameIndex = activationFrameIndexFor(rawHistory, options.activationId, {
    requireActivationFrame: options.activationId !== undefined,
  });

  return rawHistory
    .map((frame, frameIndex) => ({
      ...frame,
      messages: frame.messages.filter((message): message is ActorMessage =>
        isActorMessage(message) &&
        actorMessageVisibleToGenerator(message, frame, target) &&
        actorMessageVisibleByDelivery(message, frameIndex, activationFrameIndex) &&
        actorMessageVisibleByActivationHistory(frame, frameIndex, activationFrameIndex, runtime, options.activationId),
      ),
    }))
    .filter((frame) => frame.messages.length > 0);
}

function syntheticRootRuntime(): PrimaryRuntime {
  return {
    type: "primary",
    trigger: { type: "actor-frame" },
    concurrency: "serial",
    activationHistory: "live",
    historyProjection: { type: "actor" },
    boundaryProjection: { mode: "hidden" },
  };
}

function resolveHistoryProjection(
  projection: HistoryProjection,
  charter: Charter | undefined,
): ActorHistoryProjection | HistoryProjectionFunction {
  if (isActorHistoryProjection(projection) || typeof projection === "function") {
    return projection;
  }

  if (!charter) {
    throw new Error(`Cannot resolve history projection ref "${projection}" without charter`);
  }
  const fn = charter.historyProjections?.[projection];
  if (!fn) {
    throw new Error(`Unknown history projection ref "${projection}"`);
  }
  return fn;
}

function isActorHistoryProjection(
  projection: HistoryProjection,
): projection is ActorHistoryProjection {
  return typeof projection === "object" && projection !== null && projection.type === "actor";
}

function actorMessagesFromFrameHistory(history: Frame[]): ActorMessage[] {
  return actorMessages({
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

function framesFromActorMessages(messages: ActorMessage[], target?: Generator): Frame[] {
  return messages.map((message, index) => ({
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

function buildAliases(states: StateItem[]): Map<StateItem, string> {
  const keyCounts = new Map<string, number>();
  for (const state of states) {
    keyCounts.set(state.stateKey, (keyCounts.get(state.stateKey) ?? 0) + 1);
  }

  const aliases = new Map<StateItem, string>();
  const used = new Map<string, StateItem>();
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

function renderItems(items: SectionItem[], aliases: Map<StateItem, string>): string[] {
  return items.map((item) => {
    if (item.type === "text") {
      return item.value;
    }

    const alias = aliases.get(item);
    if (!alias) {
      throw new Error(`Missing alias for state "${item.stateKey}"`);
    }

    if (item.section === "retrieval") {
      return `You can call getState with address \`${alias}\` if you need that state.`;
    }

    return `State \`${alias}\`: ${JSON.stringify(item.value)}`;
  });
}

function groupStatesByFrame(states: ResolvedState[]): Map<string, ResolvedState[]> {
  const grouped = new Map<string, ResolvedState[]>();
  for (const state of states) {
    const frameKey = state.sourceFrame.runtimeInstanceId;
    const list = grouped.get(frameKey) ?? [];
    list.push(state);
    grouped.set(frameKey, list);
  }
  return grouped;
}

function resolveProjection(
  projection: Projection,
  frame: ProjectionFrame,
  charter: Charter | undefined,
): Required<StaticProjection> {
  if (typeof projection === "function") {
    return normalizeStaticProjection(projection(projectionContext(frame)));
  }

  if (typeof projection === "string") {
    if (!charter) {
      throw new Error(`Cannot resolve projection ref "${projection}" without charter`);
    }
    const fn = charter.projections[projection];
    if (!fn) {
      throw new Error(`Unknown projection ref "${projection}"`);
    }
    return normalizeStaticProjection(fn(projectionContext(frame)));
  }

  return normalizeStaticProjection(projection);
}

function projectionContext(frame: ProjectionFrame): ProjectionContext {
  return {
    runtimeInstanceId: frame.runtimeInstanceId,
    instanceId: frame.concreteInstance.id,
    node: frame.node,
  };
}

function stateAddressForFrame(frame: ProjectionFrame): StateAddress | undefined {
  const descriptor = frame.node.state;
  if (!descriptor) {
    return undefined;
  }
  return {
    instanceId:
      descriptor.scope === "local" ? frame.concreteInstance.id : frame.topInstance.id,
    stateKey: descriptor.key,
  };
}

function emptySections(): ProjectionSections {
  return { systemItems: [], dynamicItems: [], tools: [], states: [] };
}

function clearSections(sections: ProjectionSections): void {
  sections.systemItems.length = 0;
  sections.dynamicItems.length = 0;
  sections.tools.length = 0;
  sections.states.length = 0;
}

function isRuntimeBoundary(frame: ProjectionFrame): boolean {
  return frame.node.runtime.type === "primary" || frame.node.runtime.type === "worker";
}

function belongsToGenerator(frame: ProjectionFrame, generator: Generator | undefined): boolean {
  return Boolean(generator && generator.runtimeInstanceId === frame.runtimeInstanceId);
}

function directRootFrame(instance: Instance): ProjectionFrame {
  const root = createRoot([instance]);
  const frame = traversalFrames(root)[0];
  if (!frame) {
    throw new Error("Unable to create root projection frame");
  }
  return frame;
}

function isSyntheticRoot(root: SyntheticRoot | Instance): root is SyntheticRoot {
  return "type" in root && root.type === "synthetic-root";
}
