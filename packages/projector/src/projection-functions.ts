import type {
  HistoryProjectionFunction,
  HistoryProjectionFunctionMethod,
  ProjectionContext,
  ProjectionFunction,
  ProjectionFunctionMethod,
  ProjectionIR,
  ProjectionPart,
  ProjectionSource,
  ProjectionStatePart,
  ProjectionTextPart,
  ReadonlyProjectionIR,
  ResolvedStandardProjectionConfig,
  StandardProjectionConfig,
} from "./types.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";

export const DEFAULT_STANDARD_PROJECTION: ResolvedStandardProjectionConfig = {
  mode: "augment",
  instructions: "system",
  tools: "provider-static",
};

export function createProjectionFunction<
  TDataContent = never,
>(config: {
  name: string;
  method: ProjectionFunctionMethod<TDataContent>;
}): ProjectionFunction<TDataContent> {
  assertProjectorIdentifier(config.name, "Projection function name");
  return {
    kind: "projection",
    name: config.name,
    method: config.method,
  };
}

export function createStandardProjectionFunction<
  TDataContent = never,
>(config: StandardProjectionConfig & {
  name: string;
}): ProjectionFunction<TDataContent> {
  const standard = normalizeStandardProjectionConfig(config);
  const projection = createProjectionFunction({
    name: config.name,
    method: (ctx, draft, source) => {
      applyStandardProjection(ctx, draft, source, standard);
    },
  });
  return { ...projection, standard };
}

export const defaultProjection = createStandardProjectionFunction({
  name: "defaultProjection",
});

export const hiddenProjection = createStandardProjectionFunction({
  name: "hiddenProjection",
  mode: "hidden",
});

export const augmentProjection = createStandardProjectionFunction({
  name: "augmentProjection",
  mode: "augment",
});

export const replaceProjection = createStandardProjectionFunction({
  name: "replaceProjection",
  mode: "replace",
});

export function normalizeStandardProjectionConfig(
  config: StandardProjectionConfig | undefined,
): ResolvedStandardProjectionConfig {
  return { ...DEFAULT_STANDARD_PROJECTION, ...config };
}

export function emptyProjectionIR<TDataContent = never>(): ProjectionIR<TDataContent> {
  return { systemParts: [], dynamicParts: [], tools: [], states: [] };
}

export function clearProjectionIR(ir: ProjectionIR<any>): void {
  ir.systemParts.length = 0;
  ir.dynamicParts.length = 0;
  ir.tools.length = 0;
  ir.states.length = 0;
}

export function mergeProjectionIR<TDataContent>(
  target: ProjectionIR<TDataContent>,
  source: ReadonlyProjectionIR<TDataContent>,
  options: Pick<ResolvedStandardProjectionConfig, "tools"> = DEFAULT_STANDARD_PROJECTION,
): void {
  appendProjectionParts(target, target.systemParts, source.systemParts, options);
  appendProjectionParts(target, target.dynamicParts, source.dynamicParts, options);

  for (const state of source.states) {
    if (shouldProjectStateMetadata(state, options)) {
      addProjectionStatePart(target, state);
    }
  }

  if (options.tools !== "hidden") {
    target.tools.push(...source.tools);
  }
}

export function applyStandardProjection<TDataContent>(
  ctx: ProjectionContext<TDataContent>,
  draft: ProjectionIR<TDataContent>,
  source: ProjectionSource<TDataContent>,
  config?: StandardProjectionConfig,
): void {
  const resolved = normalizeStandardProjectionConfig(config);
  if (resolved.mode === "hidden") {
    return;
  }
  if (resolved.mode === "replace") {
    clearProjectionIR(draft);
  }

  const ir = emptyProjectionIR<TDataContent>();
  if (source.ir) {
    mergeProjectionIR(ir, source.ir, resolved);
  }
  if (source.node) {
    mergeProjectionNode(ir, ctx, source.node, resolved);
  }

  mergeProjectionIR(draft, ir);
}

export function addProjectionStatePart(
  ir: ProjectionIR<any>,
  state: ProjectionStatePart,
): void {
  if (!ir.states.includes(state)) {
    ir.states.push(state);
  }
}

function mergeProjectionNode<TDataContent>(
  target: ProjectionIR<TDataContent>,
  ctx: ProjectionContext<TDataContent>,
  node: ProjectionSource<TDataContent>["node"],
  config: ResolvedStandardProjectionConfig,
): void {
  if (!node) {
    return;
  }

  const nodeIR = ctx.createNodeIR();
  if (config.instructions !== "hidden") {
    if (node.instructions) {
      const item = {
        type: "text",
        text: node.instructions,
      } satisfies ProjectionTextPart;
      if (config.instructions === "system") {
        target.systemParts.push(item);
      } else {
        target.dynamicParts.push(item);
      }
    }

    appendProjectionParts(target, target.systemParts, nodeIR.systemParts, config);
    appendProjectionParts(target, target.dynamicParts, nodeIR.dynamicParts, config);

    if (config.tools !== "hidden") {
      appendProjectionParts(
        target,
        config.instructions === "system" ? target.systemParts : target.dynamicParts,
        nodeIR.states.filter((state) => state.section === "retrieval"),
        config,
      );
    }
  }

  if (config.tools !== "hidden") {
    target.tools.push(...nodeIR.tools);
  }
}

function appendProjectionParts<TDataContent>(
  ir: ProjectionIR<TDataContent>,
  target: ProjectionPart<TDataContent>[],
  parts: readonly ProjectionPart<TDataContent>[],
  options: Pick<ResolvedStandardProjectionConfig, "tools">,
): void {
  for (const part of parts) {
    if (part.type === "state" && !shouldProjectStateMetadata(part, options)) {
      continue;
    }
    target.push(part);
    if (part.type === "state") {
      addProjectionStatePart(ir, part);
    }
  }
}

function shouldProjectStateMetadata(
  state: ProjectionStatePart,
  options: Pick<ResolvedStandardProjectionConfig, "tools">,
): boolean {
  return options.tools !== "hidden" || state.section !== "retrieval";
}

export function createHistoryProjectionFunction<
  TDataContent = never,
>(config: {
  name: string;
  method: HistoryProjectionFunctionMethod<TDataContent>;
}): HistoryProjectionFunction<TDataContent> {
  assertProjectorIdentifier(config.name, "History projection function name");
  return {
    kind: "historyProjection",
    name: config.name,
    method: config.method,
  };
}

export function isProjectionFunction<
  TDataContent = never,
>(
  value: unknown,
): value is ProjectionFunction<TDataContent> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "projection" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { method?: unknown }).method === "function",
  );
}

export function isHistoryProjectionFunction<
  TDataContent = never,
>(
  value: unknown,
): value is HistoryProjectionFunction<TDataContent> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "historyProjection" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { method?: unknown }).method === "function",
  );
}
