import * as z from "zod";
import {
  assertNodeActionStateCompatibility,
  bindAction,
  createGetStateAction,
  GET_STATE_ACTION_NAME,
} from "./actions.ts";
import {
  collectContributors,
  createRoot,
  directContributorChildren,
  findContributorById,
  hoistStateInstance,
  type Contributor,
} from "./contributors.ts";
import { actorMessages, messages } from "./history.ts";
import {
  addProjectionStatePart,
  emptyProjectionIR,
  isHistoryProjectionFunction,
  isProjectionFunction,
} from "./projection-functions.ts";
import { encodeProjectionAddress } from "./projection-address.ts";
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
  Charter,
  CompiledInference,
  ContentPart,
  Frame,
  FrameMessage,
  GeneratorId,
  HistoryProjection,
  HistoryProjectionContext,
  HistoryProjectionFunction,
  Instance,
  MessageHistoryProjection,
  Projection,
  ProjectionContext,
  ProjectionFunction,
  ProjectionIR,
  ProjectionPart,
  ProjectionSource,
  ProjectionStatePart,
  RetrievableState,
  ProjectionAddress,
  RuntimeConcurrency,
  RuntimeTrigger,
  StateAddress,
  StateProjection,
  GeneratorRuntime,
} from "./types.ts";

export type CompileProjectionOptions<
  TDataContent = never,
> = {
  targetGeneratorId?: GeneratorId;
  history?: FrameMessage<TDataContent>[];
  frameHistory?: Frame<TDataContent>[];
  activationId?: string;
  charter?: Charter<TDataContent>;
};

export type CompiledProjectionTree<TDataContent = never> = {
  roots: CompiledContributor<TDataContent>[];
};

export type CompiledProjectionPolicy =
  | {
      type: "standard";
      name: string;
      mode: "hidden" | "augment" | "replace";
      instructions: "system" | "dynamic" | "hidden";
      tools: "provider-static" | "hidden";
    }
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

export type CompiledContributor<TDataContent = never> = {
  id: string;
  kind: "generator";
  nodeKey: string;
  name?: string;
  address: ProjectionAddress;
  parentId?: GeneratorId;
  runtime: {
    type: "generator";
    trigger: RuntimeTrigger;
    concurrency: RuntimeConcurrency;
    activationHistory: ActivationHistory;
  };
  output?: OutputMeta;
  projection: {
    own: CompiledProjectionPolicy;
    boundary: CompiledProjectionPolicy;
  };
  compiled: {
    systemParts: ContentPart<TDataContent>[];
    dynamicParts: ContentPart<TDataContent>[];
    tools: ActionMeta[];
    retrievableStates: RetrievableState[];
  };
  contributors: CompiledContributorView[];
  children: CompiledContributor<TDataContent>[];
};

export type CompiledContributorView = {
  id: string;
  nodeKey: string;
  name?: string;
  kind: "instance" | "member";
  address: ProjectionAddress;
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
  const stateByContributor = groupStatesByContributor(states);
  const draft = emptyProjectionIR<TDataContent>();
  const targetContributor = options.targetGeneratorId
    ? findContributorById(root, options.targetGeneratorId)
    : undefined;
  if (targetContributor && isGeneratorBoundary(targetContributor)) {
    return finalizeSections(
      compileTargetGeneratorProjection(targetContributor, options, stateByContributor),
      compileHistory(root, options, states),
    );
  }

  const rootContributor = directRootContributor(root);
  if (isGeneratorBoundary(rootContributor)) {
    return finalizeSections(
      compileBoundaryGeneratorProjection(rootContributor, options, stateByContributor),
      compileHistory(root, options, states),
    );
  }
  visitContributor(draft, rootContributor, options, stateByContributor);

  return finalizeSections(draft, compileHistory(root, options, states));
}

function assertActivationCompileOptions(options: CompileProjectionOptions<any>): void {
  if (options.activationId === undefined) {
    return;
  }
  if (!options.targetGeneratorId) {
    throw new Error("compileProjection activationId requires targetGeneratorId");
  }
  if (!options.frameHistory) {
    throw new Error("compileProjection activationId requires frameHistory");
  }
}

export function inspectCompiledProjectionTree<TDataContent = never>(
  rootOrInstances: Instance<TDataContent> | Instance<TDataContent>[],
  options: Omit<CompileProjectionOptions<TDataContent>, "targetGeneratorId"> = {},
): CompiledProjectionTree<TDataContent> {
  const root = Array.isArray(rootOrInstances) ? createRoot(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByContributor = groupStatesByContributor(states);
  const rootContributor = directRootContributor(root);

  return {
    roots: isGeneratorBoundary(rootContributor)
      ? [createCompiledContributor(root, rootContributor, undefined, options, stateByContributor)]
      : collectCompiledContributorChildren(root, rootContributor, undefined, options, stateByContributor),
  };
}

function visitContributor<TDataContent>(
  draft: ProjectionIR<TDataContent>,
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
): void {
  if (isGeneratorBoundary(contributor) && !belongsToGenerator(contributor, options.targetGeneratorId)) {
    const exported = compileBoundaryGeneratorProjection(contributor, options, stateByContributor);
    const runtime = contributor.node.runtime as GeneratorRuntime<TDataContent>;
    applyProjection(
      draft,
      { ir: readonlyProjectionIR(exported) },
      runtime.boundaryProjection,
      projectionContext(contributor, "boundary", options.targetGeneratorId, options, stateByContributor),
      options.charter,
      "boundaryProjection",
    );
    return;
  }

  applyProjection(
    draft,
    { node: contributor.node },
    contributor.node.projection,
    projectionContext(contributor, "node", options.targetGeneratorId, options, stateByContributor),
    options.charter,
    "projection",
  );
  for (const child of directContributorChildren(contributor)) {
    visitContributor(draft, child, options, stateByContributor);
  }
}

function compileTargetGeneratorProjection<TDataContent>(
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
): ProjectionIR<TDataContent> {
  if (!options.targetGeneratorId) {
    throw new Error("compileTargetGeneratorProjection requires targetGeneratorId");
  }
  return compileOwnedGeneratorProjection(contributor, {
    ...options,
    targetGeneratorId: options.targetGeneratorId,
  }, stateByContributor);
}

function compileBoundaryGeneratorProjection<TDataContent>(
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
): ProjectionIR<TDataContent> {
  return compileOwnedGeneratorProjection(contributor, {
    ...options,
    targetGeneratorId: contributor.id,
  }, stateByContributor);
}

function compileOwnedGeneratorProjection<TDataContent>(
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent> & { targetGeneratorId: GeneratorId },
  stateByContributor: Map<string, ResolvedState[]>,
): ProjectionIR<TDataContent> {
  const draft = emptyProjectionIR<TDataContent>();

  applyProjection(
    draft,
    { node: contributor.node },
    contributor.node.projection,
    projectionContext(contributor, "node", options.targetGeneratorId, options, stateByContributor),
    options.charter,
    "projection",
  );
  for (const child of directContributorChildren(contributor)) {
    visitContributor(draft, child, options, stateByContributor);
  }
  return draft;
}

function collectCompiledContributorChildren<TDataContent>(
  root: Instance<TDataContent>,
  contributor: Contributor<TDataContent>,
  parentId: string | undefined,
  options: Omit<CompileProjectionOptions<TDataContent>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
): CompiledContributor<TDataContent>[] {
  const contributors: CompiledContributor<TDataContent>[] = [];
  for (const child of directContributorChildren(contributor)) {
    if (isGeneratorBoundary(child)) {
      contributors.push(createCompiledContributor(root, child, parentId, options, stateByContributor));
    } else {
      contributors.push(...collectCompiledContributorChildren(root, child, parentId, options, stateByContributor));
    }
  }
  return contributors;
}

function createCompiledContributor<TDataContent>(
  root: Instance<TDataContent>,
  contributor: Contributor<TDataContent>,
  parentId: string | undefined,
  options: Omit<CompileProjectionOptions<TDataContent>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
): CompiledContributor<TDataContent> {
  const runtime = contributor.node.runtime as GeneratorRuntime<TDataContent>;
  const compileOptions = {
    ...options,
    targetGeneratorId: contributor.id,
  };
  const compiled = finalizeSections(
    compileBoundaryGeneratorProjection(contributor, compileOptions, stateByContributor),
    compileHistory(root, compileOptions, statesFromStateByContributor(stateByContributor)),
  );

  return {
    id: contributor.id,
    kind: "generator",
    nodeKey: contributor.node.key,
    name: contributor.node.name,
    address: contributor.address,
    parentId,
    runtime: {
      type: runtime.type,
      trigger: runtime.trigger,
      concurrency: runtime.concurrency ?? "serial",
      activationHistory: runtime.activationHistory ?? "live",
    },
    output: outputMeta(contributor.node.output),
    projection: {
      own: inspectProjectionPolicy(contributor.node.projection),
      boundary: inspectProjectionPolicy(runtime.boundaryProjection),
    },
    compiled: {
      systemParts: compiled.systemParts,
      dynamicParts: compiled.dynamicParts,
      tools: compiled.tools.map(actionMeta),
      retrievableStates: compiled.retrievableStates,
    },
    contributors: collectOwnedContributors(contributor, options, stateByContributor),
    children: collectCompiledContributorChildren(
      root,
      contributor,
      contributor.id,
      options,
      stateByContributor,
    ),
  };
}

function collectOwnedContributors(
  contributor: Contributor<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
): CompiledContributorView[] {
  const views: CompiledContributorView[] = [contributorView(contributor, options, stateByContributor)];
  for (const child of directContributorChildren(contributor)) {
    if (isGeneratorBoundary(child)) {
      continue;
    }
    views.push(contributorView(child, options, stateByContributor));
    views.push(...collectOwnedContributorDescendants(child, options, stateByContributor));
  }
  return views;
}

function collectOwnedContributorDescendants(
  contributor: Contributor<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
): CompiledContributorView[] {
  const views: CompiledContributorView[] = [];
  for (const child of directContributorChildren(contributor)) {
    if (isGeneratorBoundary(child)) {
      continue;
    }
    views.push(contributorView(child, options, stateByContributor));
    views.push(...collectOwnedContributorDescendants(child, options, stateByContributor));
  }
  return views;
}

function contributorView(
  contributor: Contributor<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
): CompiledContributorView {
  return {
    id: contributor.id,
    nodeKey: contributor.node.key,
    name: contributor.node.name,
    kind: contributor.isMember ? "member" : "instance",
    address: contributor.address,
    projection: inspectProjectionPolicy(contributor.node.projection),
    states: (stateByContributor.get(contributor.id) ?? []).map((state) => ({
      key: state.address.stateKey,
      address: state.address,
      projection: state.descriptor.projection,
      value: state.container.value,
    })),
    tools: resolveFrameTools(contributor, options.charter).map(actionMeta),
    commands: resolveFrameCommands(contributor, options.charter).map(actionMeta),
  };
}

function actionMeta(action: AnyAction): ActionMeta {
  return {
    name: action.name,
    description: action.description,
    inputSchema: action.inputSchema ? z.toJSONSchema(action.inputSchema) : undefined,
  };
}

function outputMeta(output: Contributor<any>["node"]["output"]): OutputMeta | undefined {
  if (!output) {
    return undefined;
  }
  return {
    audience: output.audience,
    schema: output.schema ? z.toJSONSchema(output.schema) : undefined,
    mapsTextBlock: Boolean(output.mapTextBlock),
  };
}

function compileNodeProjectionIR<TDataContent>(
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
): ProjectionIR<TDataContent> {
  const source = emptyProjectionIR<TDataContent>();

  for (const state of stateByContributor.get(contributor.id) ?? []) {
    addStateProjectionSource(source, state);
  }

  const tools = resolveFrameTools(contributor, options.charter);
  for (const tool of tools) {
    assertNodeActionStateCompatibility(tool, contributor.node, "tool");
  }
  source.tools.push(
    ...tools.map((tool) =>
      bindAction(tool, {
        generatorId: contributor.id,
      }),
    ),
  );

  return source;
}

function addStateProjectionSource(
  source: ProjectionIR<any>,
  state: ResolvedState,
): void {
  const part = stateProjectionPart(state);
  if (!part) {
    return;
  }

  addProjectionStatePart(source, part);
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

function applyProjection<TDataContent>(
  draft: ProjectionIR<TDataContent>,
  source: ProjectionSource<TDataContent>,
  projection: Projection<TDataContent>,
  ctx: ProjectionContext<TDataContent>,
  charter: Charter<TDataContent> | undefined,
  slot: "projection" | "boundaryProjection",
): void {
  const resolved = resolveProjectionValue(projection, ctx.originNode, slot, charter);
  resolved.method(ctx, draft, source);
}

function finalizeSections<TDataContent>(
  draft: ProjectionIR<TDataContent>,
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
  const targetGeneratorId = options.targetGeneratorId;
  if (!targetGeneratorId) {
    return undefined;
  }

  const contributor = findContributorById(root, targetGeneratorId);
  if (!contributor || !isGeneratorBoundary(contributor)) {
    return undefined;
  }

  const runtime = contributor.node.runtime as GeneratorRuntime<TDataContent>;
  return {
    context: {
      generatorId: targetGeneratorId,
      activationId: options.activationId ?? "",
      trigger: runtime.trigger,
      history: visibleHistoryForTarget(root, targetGeneratorId, runtime, options),
      states: stateValues(states),
    },
    projection: runtime.historyProjection ?? { type: "messages" },
  };
}

function visibleHistoryForTarget<TDataContent>(
  _root: Instance<TDataContent>,
  targetGeneratorId: GeneratorId,
  runtime: GeneratorRuntime<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
): Frame<TDataContent>[] {
  if (options.activationId !== undefined && options.frameHistory === undefined) {
    throw new Error("compileProjection activationId requires frameHistory");
  }

  const rawHistory = options.frameHistory ?? framesFromMessages(options.history ?? [], targetGeneratorId);
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
        actorMessageVisibleToGenerator(message, frame, targetGeneratorId) &&
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
    generatorId: "",
    activationId: "",
    trigger: { type: "actor-frame" },
    history,
    states: {},
  });
}

function framesFromMessages<TDataContent>(
  frameMessages: FrameMessage<TDataContent>[],
  targetGeneratorId?: GeneratorId,
): Frame<TDataContent>[] {
  return frameMessages.map((message, index) => ({
    id: `synthetic-history-${index}`,
    generatorId: targetGeneratorId ?? "synthetic-history",
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

function statesFromStateByContributor(stateByContributor: Map<string, ResolvedState[]>): ResolvedState[] {
  return [...stateByContributor.values()].flat();
}

function collectProjectedStates(draft: ProjectionIR<any>): ProjectionStatePart[] {
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

function groupStatesByContributor(states: ResolvedState[]): Map<string, ResolvedState[]> {
  const grouped = new Map<string, ResolvedState[]>();
  for (const state of states) {
    const contributorKey = stateContributorKey(state);
    const list = grouped.get(contributorKey) ?? [];
    list.push(state);
    grouped.set(contributorKey, list);
  }
  return grouped;
}

function stateContributorKey(state: ResolvedState): string {
  if (state.descriptor.scope === "hoist") {
    return encodeProjectionAddress({
      type: "instance",
      instanceId: state.targetInstance.id,
    });
  }

  return state.sourceContributor.id;
}

function resolveProjectionValue<TDataContent>(
  projection: Projection<TDataContent>,
  node: ProjectionContext<TDataContent>["originNode"],
  slot: "projection" | "boundaryProjection",
  charter: Charter<TDataContent> | undefined,
): ProjectionFunction<TDataContent> {
  if (isProjectionFunction<TDataContent>(projection)) {
    return projection;
  }

  const sourceProjection = sourceNodeProjectionSlot(node, slot, charter);
  if (sourceProjection?.name === projection) {
    return sourceProjection;
  }

  if (!charter) {
    throw new Error(`Cannot resolve projection ref "${projection}" without charter`);
  }
  const fn = charter.projections[projection];
  if (!fn) {
    throw new Error(`Unknown projection ref "${projection}"`);
  }
  return fn;
}

function sourceNodeProjectionSlot<TDataContent>(
  node: ProjectionContext<TDataContent>["originNode"],
  slot: "projection" | "boundaryProjection",
  charter: Charter<TDataContent> | undefined,
): ProjectionFunction<TDataContent> | undefined {
  const sourceNode = sourceNodeForProjectionSlot(node, charter);
  if (!sourceNode) {
    return undefined;
  }

  const value = slot === "projection"
    ? sourceNode.projection
    : sourceNode.runtime.type === "generator"
      ? sourceNode.runtime.boundaryProjection
      : undefined;
  return isProjectionFunction<TDataContent>(value) ? value : undefined;
}

function sourceNodeForProjectionSlot<TDataContent>(
  node: ProjectionContext<TDataContent>["originNode"],
  charter: Charter<TDataContent> | undefined,
): ProjectionContext<TDataContent>["originNode"] | undefined {
  if (!charter) {
    return undefined;
  }
  if (node.sourceNodeKey) {
    return charter.nodes[node.sourceNodeKey];
  }
  const sourceNode = charter.nodes[node.key];
  return sourceNode && sourceNode !== node ? sourceNode : undefined;
}

function inspectProjectionPolicy<TDataContent>(
  projection: Projection<TDataContent>,
): CompiledProjectionPolicy {
  if (isProjectionFunction<TDataContent>(projection)) {
    if (projection.standard) {
      return {
        type: "standard",
        name: projection.name,
        ...projection.standard,
      };
    }
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
  throw new Error("Cannot inspect unknown projection");
}

function projectionContext<TDataContent>(
  contributor: Contributor<TDataContent>,
  callSite: ProjectionContext<TDataContent>["callSite"],
  targetGeneratorId: GeneratorId | undefined,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
): ProjectionContext<TDataContent> {
  return {
    callSite,
    generatorId: contributor.id,
    address: contributor.address,
    targetGeneratorId,
    originNode: contributor.node,
    createNodeIR: () => compileNodeProjectionIR(contributor, options, stateByContributor),
  };
}

function readonlyProjectionIR<TDataContent>(draft: ProjectionIR<TDataContent>): ProjectionSource<TDataContent>["ir"] {
  return {
    systemParts: draft.systemParts,
    dynamicParts: draft.dynamicParts,
    tools: draft.tools,
    states: draft.states,
  };
}

function stateAddressForContributor(contributor: Contributor<any>): StateAddress | undefined {
  const descriptor = contributor.node.state;
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

function isGeneratorBoundary(contributor: Contributor<any>): boolean {
  return contributor.node.runtime.type === "generator";
}

function belongsToGenerator(
  contributor: Contributor<any>,
  generatorId: GeneratorId | undefined,
): boolean {
  return generatorId === contributor.id;
}

function directRootContributor<TDataContent>(
  instance: Instance<TDataContent>,
): Contributor<TDataContent> {
  const contributor = collectContributors(instance)[0];
  if (!contributor) {
    throw new Error("Unable to create root contributor");
  }
  return contributor;
}
