import * as z from "zod";
import { actionExposure } from "./action-exposure.ts";
import {
  assertNodeActionStateCompatibility,
  bindAction,
  createGetStateAction,
  GET_STATE_ACTION_NAME,
} from "./actions.ts";
import {
  collectContributors,
  createRootInstance,
  directContributorChildren,
  findContributorById,
  resolveContributorNodeParams,
  type Contributor,
} from "./contributors.ts";
import { contributorStateValue } from "./discriminator-eval.ts";
import type { DiscriminatorMemo } from "./discriminators.ts";
import { resolveComputedPartRef } from "./computed-parts.ts";
import {
  actorMessages,
  isActorHistoryProjection,
  isHistoryProjectionFunction,
  isMessageHistoryProjection,
  messages,
} from "./history.ts";
import {
  implicitDefaultLayout,
  layoutRegionForSlot,
  renderRegion,
} from "./layouts.ts";
import {
  callerAllows,
  collectAllNodeActions,
  resolveActionEntry,
  visitEffectiveParts,
} from "./scoped-actions.ts";
import { slotPlacement } from "./slots.ts";
import {
  deriveStateAliases,
  groupStatesByContributor,
  resolveStates,
  type ResolvedState,
} from "./state.ts";
import { visibleFramesForGenerator } from "./visibility.ts";
import type {
  AnyAction,
  ActivationHistory,
  ActorHistoryProjection,
  Audience,
  BoundaryProjection,
  Charter,
  CompileDiagnostic,
  CompiledInference,
  CompiledPart,
  ContentPart,
  Frame,
  FrameMessage,
  GeneratorId,
  HistoryProjection,
  HistoryProjectionContext,
  HistoryProjectionFunction,
  Instance,
  LayoutDef,
  LayoutRegionName,
  MessageHistoryProjection,
  ProjectionIR,
  ProjectionPart,
  ProjectionStatePart,
  RetrievableState,
  ProjectionAddress,
  RuntimeConcurrency,
  RuntimeTrigger,
  SlotDef,
  StateAddress,
  Exposure,
  GeneratorRuntime,
} from "./types.ts";

export function emptyProjectionIR<TDataContent = never>(): ProjectionIR<TDataContent> {
  return { preamble: [], recency: [], tools: [], states: [] };
}

export function addProjectionStatePart(
  ir: ProjectionIR<any>,
  state: ProjectionStatePart,
): void {
  if (!ir.states.includes(state)) {
    ir.states.push(state);
  }
}

export type CompileProjectionOptions<
  TDataContent = never,
> = {
  targetGeneratorId?: GeneratorId;
  history?: FrameMessage<TDataContent>[];
  frameHistory?: Frame<TDataContent>[];
  activationId?: string;
  charter?: Charter<TDataContent>;
  /** Overrides the charter's default layout for this compile. */
  layout?: LayoutDef;
  onDiagnostic?: (diagnostic: CompileDiagnostic) => void;
};

/**
 * Per-compile evaluation context: the resolved layout, discriminator memo
 * (pinning derivations for the compile), and collected diagnostics.
 */
type CompileSession = {
  layout: LayoutDef;
  memo: DiscriminatorMemo;
  diagnostics: CompileDiagnostic[];
  onDiagnostic?: (diagnostic: CompileDiagnostic) => void;
};

function createCompileSession<TDataContent>(
  options: CompileProjectionOptions<TDataContent>,
): CompileSession {
  return {
    layout: options.layout ?? options.charter?.defaultLayout ?? implicitDefaultLayout,
    memo: new Map(),
    diagnostics: [],
    onDiagnostic: options.onDiagnostic,
  };
}

function reportDiagnostic(session: CompileSession, diagnostic: CompileDiagnostic): void {
  session.diagnostics.push(diagnostic);
  session.onDiagnostic?.(diagnostic);
}

export type CompiledProjectionTree<TDataContent = never> = {
  layout: CompiledLayoutView;
  roots: CompiledContributor<TDataContent>[];
};

/**
 * Serializable view of the layout a compile resolved, for inspectors.
 * `historyProjection` reduces to a label (code never serializes).
 */
export type CompiledLayoutView = {
  name: string;
  strict: boolean;
  regions: Record<LayoutRegionName, SlotDef[]>;
  historyProjection?: string;
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
  boundaryProjection: BoundaryProjection;
  compiled: {
    preamble: CompiledPart<TDataContent>[];
    recency: CompiledPart<TDataContent>[];
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
  states: Array<{
    key: string;
    address: StateAddress;
    projection?: { slot?: string; region?: LayoutRegionName; exposure: Exposure };
    value: unknown;
  }>;
  tools: ActionMeta[];
  commands: ActionMeta[];
};

type ActionMeta = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  exposure: Exposure;
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
  const root = Array.isArray(rootOrInstances) ? createRootInstance(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByContributor = groupStatesByContributor(states);
  const session = createCompileSession(options);
  const draft = emptyProjectionIR<TDataContent>();
  const targetContributor = options.targetGeneratorId
    ? findContributorById(root, options.targetGeneratorId)
    : undefined;
  if (targetContributor && isGeneratorBoundary(targetContributor)) {
    return finalizeSections(
      compileGeneratorProjection(targetContributor, options, stateByContributor, session),
      compileHistory(root, options, states, session),
      session,
    );
  }

  const rootContributor = directRootContributor(root);
  if (isGeneratorBoundary(rootContributor)) {
    return finalizeSections(
      compileGeneratorProjection(rootContributor, options, stateByContributor, session),
      compileHistory(root, options, states, session),
      session,
    );
  }
  visitContributor(draft, rootContributor, options, stateByContributor, session);

  return finalizeSections(draft, compileHistory(root, options, states, session), session);
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
  const root = Array.isArray(rootOrInstances) ? createRootInstance(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByContributor = groupStatesByContributor(states);
  const rootContributor = directRootContributor(root);
  const session = createCompileSession(options);

  return {
    layout: compiledLayoutView(session.layout),
    roots: isGeneratorBoundary(rootContributor)
      ? [createCompiledContributor(root, rootContributor, undefined, options, stateByContributor, session)]
      : collectCompiledContributorChildren(root, rootContributor, undefined, options, stateByContributor, session),
  };
}

/** A draft-IR state part with the non-serializable render/note functions dropped. */
export type DryProjectionStatePart = {
  type: "state";
  slot?: string;
  region?: LayoutRegionName;
  exposure?: Exposure;
  stateKey: string;
  target: StateAddress;
  value: unknown;
};

export type DryProjectionPart<TDataContent = never> =
  | ContentPart<TDataContent>
  | DryProjectionStatePart;

export type ProjectionIRToolView = {
  name: string;
  description?: string;
  exposure: Exposure;
  depth: number;
};

/**
 * The draft parts IR before layout render: placement tags (slot/region/
 * partDepth) intact, state parts un-rendered, and the tool pool before
 * deepest-wins dedup. The finalized `CompiledInference` keeps resolved slot
 * identity and volatility on each part but erases region/partDepth and the
 * pre-merge part structure.
 */
export type ProjectionIRView<TDataContent = never> = {
  layout: CompiledLayoutView;
  preamble: DryProjectionPart<TDataContent>[];
  recency: DryProjectionPart<TDataContent>[];
  tools: ProjectionIRToolView[];
};

export function inspectProjectionIR<TDataContent = never>(
  rootOrInstances: Instance<TDataContent> | Instance<TDataContent>[],
  options: CompileProjectionOptions<TDataContent> = {},
): ProjectionIRView<TDataContent> {
  const root = Array.isArray(rootOrInstances) ? createRootInstance(rootOrInstances) : rootOrInstances;
  const states = resolveStates(root);
  const stateByContributor = groupStatesByContributor(states);
  const session = createCompileSession(options);
  const targetContributor = options.targetGeneratorId
    ? findContributorById(root, options.targetGeneratorId)
    : undefined;

  let draft: ProjectionIR<TDataContent>;
  if (targetContributor && isGeneratorBoundary(targetContributor)) {
    draft = compileGeneratorProjection(targetContributor, options, stateByContributor, session);
  } else {
    const rootContributor = directRootContributor(root);
    if (isGeneratorBoundary(rootContributor)) {
      draft = compileGeneratorProjection(rootContributor, options, stateByContributor, session);
    } else {
      draft = emptyProjectionIR<TDataContent>();
      visitContributor(draft, rootContributor, options, stateByContributor, session);
    }
  }

  return {
    layout: compiledLayoutView(session.layout),
    preamble: draft.preamble.map(dryProjectionPart),
    recency: draft.recency.map(dryProjectionPart),
    tools: draft.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      exposure: actionExposure(tool),
      depth: toolDepth(tool),
    })),
  };
}

function dryProjectionPart<TDataContent>(
  part: ProjectionPart<TDataContent>,
): DryProjectionPart<TDataContent> {
  if (part.type !== "state") {
    return part;
  }
  const { render: _render, note: _note, ...rest } = part;
  return rest;
}

function compiledLayoutView(layout: LayoutDef): CompiledLayoutView {
  return {
    name: layout.name,
    strict: layout.strict,
    regions: layout.regions,
    ...(layout.historyProjection !== undefined
      ? { historyProjection: historyProjectionLabel(layout.historyProjection) }
      : {}),
  };
}

function historyProjectionLabel(projection: HistoryProjection<any>): string {
  if (typeof projection === "string") {
    return projection;
  }
  return "type" in projection ? projection.type : projection.name;
}

function visitContributor<TDataContent>(
  draft: ProjectionIR<TDataContent>,
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
  session: CompileSession,
): void {
  if (isGeneratorBoundary(contributor) && !belongsToGenerator(contributor, options.targetGeneratorId)) {
    const runtime = contributor.node.runtime as GeneratorRuntime;
    // A child generator's boundary is an enum: hidden exports nothing;
    // augment forwards every compiled part to the parent document as-is.
    if (runtime.boundaryProjection === "augment") {
      const exported = compileGeneratorProjection(contributor, options, stateByContributor, session);
      forwardProjectionIR(draft, exported);
    }
    return;
  }

  renderContributor(draft, contributor, options, stateByContributor, session);
  for (const child of directContributorChildren(contributor, { mode: "effective", charter: options.charter, memo: session.memo })) {
    visitContributor(draft, child, options, stateByContributor, session);
  }
}

/**
 * Compiles a generator's own document: the generator is its own target, so
 * visitContributor renders it and folds descendant boundaries in per their
 * boundaryProjection enum.
 */
function compileGeneratorProjection<TDataContent>(
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
  session: CompileSession,
): ProjectionIR<TDataContent> {
  const draft = emptyProjectionIR<TDataContent>();
  visitContributor(
    draft,
    contributor,
    { ...options, targetGeneratorId: contributor.id },
    stateByContributor,
    session,
  );
  return draft;
}

/**
 * The single render path: a contributor's surface is its node's parts. State
 * parts project per their descriptors; text/computed parts emit slot-tagged
 * content into the region their slot belongs to; action parts with caller
 * generator|any resolve, validate, and bind into the tool surface tagged with
 * contributor depth (deterministic deepest-wins LWW at finalize).
 */
function renderContributor<TDataContent>(
  draft: ProjectionIR<TDataContent>,
  contributor: Contributor<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  stateByContributor: Map<string, ResolvedState[]>,
  session: CompileSession,
): void {
  for (const state of stateByContributor.get(contributor.id) ?? []) {
    addStateProjectionSource(draft, state, session);
  }

  const depth = contributorDepth(contributor);
  let nodeParams: ReturnType<typeof resolveContributorNodeParams> | undefined;
  visitEffectiveParts(contributor.node.parts, contributor, options.charter, session.memo, (part) => {
    if (part.kind === "text") {
      pushContentPart(draft, session, {
        type: "text",
        text: part.text,
        ...slotPlacement(part.slot),
        partDepth: depth,
      });
      return;
    }

    if (part.kind === "computed") {
      const definition = resolveComputedPartRef(part.part, options.charter);
      const placement = slotPlacement(definition.slot);
      const computed = definition.compute({
        params: (nodeParams ??= resolveContributorNodeParams(contributor)),
        state: (descriptor) => contributorStateValue(contributor, descriptor).value,
      });
      const parts: ContentPart<TDataContent>[] = typeof computed === "string"
        ? computed
          ? [{ type: "text", text: computed }]
          : []
        : computed;
      for (const contentPart of parts) {
        pushContentPart(draft, session, {
          ...contentPart,
          ...placement,
          partDepth: depth,
        });
      }
      return;
    }

    if (part.kind === "action") {
      // Guidance emits whenever the contribution is present — including for
      // external-caller actions, whose prose is typically model-facing — so a
      // select that swaps the action swaps its guidance atomically.
      for (const guidance of part.guidance ?? []) {
        pushContentPart(draft, session, {
          type: "text",
          text: guidance.text,
          ...slotPlacement(guidance.slot),
          partDepth: depth,
        });
      }
      if (!callerAllows(part.caller, "generator")) {
        return;
      }
      const action = resolveActionEntry(part.action, contributor.node, options.charter);
      assertNodeActionStateCompatibility(action, contributor.node, "tool");
      if (part.exposure === "deferred" && part.guidance === undefined) {
        // Auto availability note; explicit guidance (even []) replaces it.
        const summary = action.description?.split("\n", 1)[0];
        pushContentPart(draft, session, Object.assign(
          {
            type: "text" as const,
            text: `The tool \`${action.name}\`${summary ? ` (${summary})` : ""} is available on demand via tool search.`,
            partDepth: depth,
          },
          { [DEFERRED_NOTE]: action.name },
        ));
      }
      draft.tools.push(
        Object.assign(bindAction(action, { generatorId: contributor.id }, part.exposure), {
          [PART_DEPTH]: depth,
        }),
      );
    }
  });
}

/** Symbol-keyed depth tag on bound tool copies; consumed at finalize. */
const PART_DEPTH: unique symbol = Symbol.for("projector.partDepth") as never;

/**
 * Symbol-keyed tool-name tag on auto availability notes. Tools dedupe
 * deepest-wins at finalize; the notes must follow the same rule or a
 * multiply-contributed deferred tool repeats its prose.
 */
const DEFERRED_NOTE: unique symbol = Symbol.for("projector.deferredNote") as never;

function deferredNoteName(part: ProjectionPart<any>): string | undefined {
  const name = (part as { [DEFERRED_NOTE]?: unknown })[DEFERRED_NOTE];
  return typeof name === "string" ? name : undefined;
}

function toolDepth(action: AnyAction): number {
  const depth = (action as { [PART_DEPTH]?: unknown })[PART_DEPTH];
  return typeof depth === "number" ? depth : 0;
}

function contributorDepth(contributor: Contributor<any>): number {
  let depth = 0;
  let current = contributor.parent;
  while (current) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

/** Forwards a child boundary export into the parent draft, parts as-is. */
function forwardProjectionIR<TDataContent>(
  draft: ProjectionIR<TDataContent>,
  exported: ProjectionIR<TDataContent>,
): void {
  draft.preamble.push(...exported.preamble);
  draft.recency.push(...exported.recency);
  draft.tools.push(...exported.tools);
  for (const state of exported.states) {
    addProjectionStatePart(draft, state);
  }
}

/** Routes a tagged part into its addressed region or its slot's region. */
function pushContentPart<TDataContent>(
  draft: ProjectionIR<TDataContent>,
  session: CompileSession,
  part: ProjectionPart<TDataContent>,
): void {
  const region: LayoutRegionName = part.region
    ?? (part.slot !== undefined
      ? layoutRegionForSlot(session.layout, part.slot) ?? "preamble"
      : "preamble");
  if (region === "recency") {
    draft.recency.push(part);
  } else {
    draft.preamble.push(part);
  }
}

function collectCompiledContributorChildren<TDataContent>(
  root: Instance<TDataContent>,
  contributor: Contributor<TDataContent>,
  parentId: string | undefined,
  options: Omit<CompileProjectionOptions<TDataContent>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
  session: CompileSession,
): CompiledContributor<TDataContent>[] {
  const contributors: CompiledContributor<TDataContent>[] = [];
  for (const child of directContributorChildren(contributor, { mode: "effective", charter: options.charter, memo: session.memo })) {
    if (isGeneratorBoundary(child)) {
      contributors.push(createCompiledContributor(root, child, parentId, options, stateByContributor, session));
    } else {
      contributors.push(...collectCompiledContributorChildren(root, child, parentId, options, stateByContributor, session));
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
  session: CompileSession,
): CompiledContributor<TDataContent> {
  const runtime = contributor.node.runtime as GeneratorRuntime;
  const compileOptions = {
    ...options,
    targetGeneratorId: contributor.id,
  };
  const compiled = finalizeSections(
    compileGeneratorProjection(contributor, compileOptions, stateByContributor, session),
    compileHistory(root, compileOptions, statesFromStateByContributor(stateByContributor), session),
    session,
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
    boundaryProjection: runtime.boundaryProjection,
    compiled: {
      preamble: compiled.preamble,
      recency: compiled.recency,
      tools: compiled.tools.map((tool) => actionMeta(tool, actionExposure(tool))),
      retrievableStates: compiled.retrievableStates,
    },
    contributors: [
      contributorView(contributor, options, stateByContributor),
      ...collectOwnedContributorDescendants(contributor, options, stateByContributor, session),
    ],
    children: collectCompiledContributorChildren(
      root,
      contributor,
      contributor.id,
      options,
      stateByContributor,
      session,
    ),
  };
}

function collectOwnedContributorDescendants(
  contributor: Contributor<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
  session: CompileSession,
): CompiledContributorView[] {
  const views: CompiledContributorView[] = [];
  for (const child of directContributorChildren(contributor, { mode: "effective", charter: options.charter, memo: session.memo })) {
    if (isGeneratorBoundary(child)) {
      continue;
    }
    views.push(contributorView(child, options, stateByContributor));
    views.push(...collectOwnedContributorDescendants(child, options, stateByContributor, session));
  }
  return views;
}

function contributorView(
  contributor: Contributor<any>,
  options: Omit<CompileProjectionOptions<any>, "targetGeneratorId">,
  stateByContributor: Map<string, ResolvedState[]>,
): CompiledContributorView {
  const actions = collectAllNodeActions(contributor.node, options.charter);
  return {
    id: contributor.id,
    nodeKey: contributor.node.key,
    name: contributor.node.name,
    kind: contributor.isMember ? "member" : "instance",
    address: contributor.address,
    states: (stateByContributor.get(contributor.id) ?? []).map((state) => ({
      key: state.address.stateKey,
      address: state.address,
      projection: state.descriptor.projection
        ? {
            ...slotPlacement(state.descriptor.projection.slot),
            exposure: state.descriptor.projection.exposure ?? "native",
          }
        : undefined,
      value: state.container.value,
    })),
    tools: actions
      .filter((entry) => callerAllows(entry.caller, "generator"))
      .map((entry) => actionMeta(entry.action, entry.exposure)),
    commands: actions
      .filter((entry) => callerAllows(entry.caller, "external"))
      .map((entry) => actionMeta(entry.action, entry.exposure)),
  };
}

function actionMeta(action: AnyAction, exposure: Exposure): ActionMeta {
  return {
    name: action.name,
    description: action.description,
    inputSchema: action.inputSchema ? z.toJSONSchema(action.inputSchema) : undefined,
    exposure,
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

function addStateProjectionSource(
  source: ProjectionIR<any>,
  state: ResolvedState,
  session: CompileSession,
): void {
  const part = stateProjectionPart(state);
  if (!part) {
    return;
  }

  addProjectionStatePart(source, part);
  pushContentPart(source, session, part);
}

/** A state renders per its declaration's projection config; absent = hidden. */
function stateProjectionPart(state: ResolvedState): ProjectionStatePart | undefined {
  const projection = state.descriptor.projection;
  if (!projection) {
    return undefined;
  }

  return {
    type: "state",
    ...slotPlacement(projection.slot),
    ...(projection.exposure ? { exposure: projection.exposure } : {}),
    ...(projection.render ? { render: projection.render } : {}),
    ...(projection.note ? { note: projection.note } : {}),
    stateKey: state.address.stateKey,
    target: state.address,
    value: state.container.value,
  };
}

function finalizeSections<TDataContent>(
  draft: ProjectionIR<TDataContent>,
  history: FrameMessage<TDataContent>[],
  session: CompileSession,
): CompiledInference<TDataContent> {
  const projectedStates = collectProjectedStates(draft);
  const aliases = buildAliases(projectedStates);
  const retrievableStates: RetrievableState[] = [];
  const retrievalKeys = new Set<string>();

  for (const state of projectedStates) {
    if (state.exposure !== "deferred") {
      continue;
    }
    const alias = aliases.get(state);
    if (!alias || retrievalKeys.has(alias)) {
      continue;
    }
    retrievalKeys.add(alias);
    retrievableStates.push({ address: alias, target: state.target });
  }

  const tools = finalizeTools(draft.tools, session);
  if (retrievableStates.length > 0) {
    if (tools.some((tool) => tool.name === GET_STATE_ACTION_NAME)) {
      throw new Error(`Projected tool name "${GET_STATE_ACTION_NAME}" is reserved for state retrieval`);
    }
    tools.push(createGetStateAction());
  }

  const keepNote = deferredNoteFilter(tools);
  return {
    preamble: renderRegion(
      compileContentParts(draft.preamble.filter(keepNote), aliases),
      session.layout,
      "preamble",
      (diagnostic) => reportDiagnostic(session, diagnostic),
    ),
    history,
    recency: renderRegion(
      compileContentParts(draft.recency.filter(keepNote), aliases),
      session.layout,
      "recency",
      (diagnostic) => reportDiagnostic(session, diagnostic),
    ),
    tools,
    retrievableStates,
    ...(session.diagnostics.length > 0 ? { diagnostics: [...session.diagnostics] } : {}),
  };
}

/**
 * Keeps at most one auto availability note per deferred tool: the one from
 * the contribution whose binding won deepest-wins tool dedup. Notes from
 * shadowed contributions drop with their losing tool — including when the
 * winner is native (no note belongs at all) or carries explicit guidance
 * (which replaced its note).
 */
function deferredNoteFilter(tools: AnyAction[]): (part: ProjectionPart<any>) => boolean {
  const winnerDepth = new Map(
    tools
      .filter((tool) => actionExposure(tool) === "deferred")
      .map((tool) => [tool.name, toolDepth(tool)]),
  );
  const kept = new Set<string>();
  return (part) => {
    const name = deferredNoteName(part);
    if (name === undefined) {
      return true;
    }
    if (part.type !== "text" || winnerDepth.get(name) !== (part.partDepth ?? 0) || kept.has(name)) {
      return false;
    }
    kept.add(name);
    return true;
  };
}

/**
 * Deterministic last-write-wins over same-named tools: stable sort by
 * contributor depth ascending, then dedupe keeping the last (deepest) — a
 * child's variant shadows its ancestor's, never by merge-order accident.
 * Shadowing is legal and diagnosed, not an error.
 */
function finalizeTools(tools: AnyAction[], session: CompileSession): AnyAction[] {
  const sorted = [...tools]
    .map((action, index) => ({ action, index }))
    .sort((a, b) => (toolDepth(a.action) - toolDepth(b.action)) || (a.index - b.index))
    .map((entry) => entry.action);

  const byName = new Map<string, AnyAction>();
  const shadowed = new Map<string, number>();
  for (const action of sorted) {
    if (byName.has(action.name)) {
      shadowed.set(action.name, (shadowed.get(action.name) ?? 0) + 1);
    }
    byName.set(action.name, action);
  }
  for (const [name, count] of shadowed) {
    reportDiagnostic(session, {
      severity: "warning",
      code: "shadowed-action",
      message: `Action "${name}" contributed ${count + 1} times; the deepest contributor's binding wins`,
    });
  }
  return [...byName.values()];
}

function compileHistory<TDataContent>(
  root: Instance<TDataContent>,
  options: CompileProjectionOptions<TDataContent>,
  states: ResolvedState[],
  session: CompileSession,
): FrameMessage<TDataContent>[] {
  const ctx = historyProjectionContext(root, options, states, session);
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
  session: CompileSession,
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

  const runtime = contributor.node.runtime as GeneratorRuntime;
  return {
    context: {
      generatorId: targetGeneratorId,
      activationId: options.activationId ?? "",
      trigger: runtime.trigger,
      history: visibleHistoryForTarget(root, targetGeneratorId, runtime, options),
      states: stateValues(states),
      params: resolveContributorNodeParams(contributor),
    },
    // History rendering is layout-owned (history is wire-structural: the
    // layout picks WHICH named policy, never placement); no per-node override.
    projection: session.layout.historyProjection ?? { type: "messages" },
  };
}

function visibleHistoryForTarget<TDataContent>(
  _root: Instance<TDataContent>,
  targetGeneratorId: GeneratorId,
  runtime: GeneratorRuntime,
  options: CompileProjectionOptions<TDataContent>,
): Frame<TDataContent>[] {
  if (options.activationId !== undefined && options.frameHistory === undefined) {
    throw new Error("compileProjection activationId requires frameHistory");
  }

  const rawHistory = options.frameHistory ?? framesFromMessages(options.history ?? [], targetGeneratorId);
  const visible = visibleFramesForGenerator(rawHistory, targetGeneratorId, runtime, options.activationId);
  return visible.map(stripProvenance);
}

/**
 * Provenance is observational: history-projection code never sees it, so the
 * fold cannot come to depend on it and persistence remains free to drop it.
 */
function stripProvenance<TDataContent>(frame: Frame<TDataContent>): Frame<TDataContent> {
  if (!frame.provenance) {
    return frame;
  }
  const { provenance: _omitted, ...rest } = frame;
  return rest;
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

function frameMessagesFromFrameHistory<TDataContent>(
  history: Frame<TDataContent>[],
): FrameMessage<TDataContent>[] {
  return messages({
    generatorId: "",
    activationId: "",
    trigger: { type: "actor-frame" },
    history,
    states: {},
    params: {},
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
  const aliases = deriveStateAliases(states, (state) => state.address);
  const values: Record<string, unknown> = {};
  for (const state of states) {
    values[aliases.get(state)!] = state.container.value;
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
  for (const part of draft.preamble) {
    if (part.type === "state") {
      add(part);
    }
  }
  for (const part of draft.recency) {
    if (part.type === "state") {
      add(part);
    }
  }

  return states;
}

function buildAliases(states: ProjectionStatePart[]): Map<ProjectionStatePart, string> {
  return deriveStateAliases(states, (state) => state.target);
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

    const placement = {
      ...(item.slot !== undefined ? { slot: item.slot } : {}),
      ...(item.region !== undefined ? { region: item.region } : {}),
    };
    if (item.exposure === "deferred") {
      return {
        type: "text",
        ...placement,
        text: item.note
          ? item.note(alias)
          : `You can call getState with address \`${alias}\` if you need that state.`,
      };
    }

    return {
      type: "text",
      ...placement,
      text: item.render
        ? item.render(item.value)
        : `State \`${alias}\`: ${JSON.stringify(item.value)}`,
    };
  });
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
