import type {
  ActionConfigEntry,
  ActionBindings,
  AnyAction,
  Node,
  NodeConfig,
  NormalizedRuntime,
  NormalizedStateDescriptor,
  Projection,
  Runtime,
  StateDescriptor,
  StaticProjection,
} from "./types.ts";

type InferActions<TConfig, TKey extends "tools" | "commands"> = TConfig extends Record<
  TKey,
  infer TActions extends readonly ActionConfigEntry[]
>
  ? TActions
  : [];

type ActionEntryMeta<TEntry> = TEntry extends AnyAction
  ? TEntry
  : TEntry extends string
    ? AnyAction & { name: TEntry }
    : never;

type InferActionMetas<TConfig, TKey extends "tools" | "commands"> = ActionEntryMeta<
  InferActions<TConfig, TKey>[number]
>;

type InferState<TConfig> = TConfig extends { state: StateDescriptor<infer S> }
  ? NormalizedStateDescriptor<S>
  : undefined;

export type CreatedNode<TConfig extends NodeConfig> = Node & {
  state: InferState<TConfig>;
  __tools?: InferActionMetas<TConfig, "tools">;
  __commands?: InferActionMetas<TConfig, "commands">;
};

export const DEFAULT_STATIC_PROJECTION: Required<StaticProjection> = {
  mode: "augment",
  instructions: "system",
  tools: "provider-static",
};

export const DEFAULT_BOUNDARY_PROJECTION: StaticProjection = { mode: "hidden" };

export function normalizeStaticProjection(
  projection: StaticProjection | undefined,
): Required<StaticProjection> {
  return { ...DEFAULT_STATIC_PROJECTION, ...projection };
}

export function normalizeProjection(projection: Projection | undefined): Projection {
  if (!projection) {
    return { ...DEFAULT_STATIC_PROJECTION };
  }

  if (typeof projection === "function" || typeof projection === "string") {
    return projection;
  }

  return normalizeStaticProjection(projection);
}

export function normalizeStateDescriptor<S>(
  descriptor: StateDescriptor<S>,
): NormalizedStateDescriptor<S> {
  return {
    ...descriptor,
    scope: descriptor.scope ?? "top",
    onInitConflict: descriptor.onInitConflict ?? "replace",
    projection: descriptor.projection ?? "hidden",
  };
}

export function normalizeRuntime(runtime: Runtime | undefined): NormalizedRuntime {
  if (!runtime || !runtime.type || runtime.type === "component") {
    return { type: "component" };
  }

  if (runtime.type === "primary") {
    return {
      ...runtime,
      concurrency: runtime.concurrency ?? "serial",
      activationHistory: runtime.activationHistory ?? "live",
      historyProjection: runtime.historyProjection ?? { type: "actor" },
      boundaryProjection: normalizeProjection(runtime.boundaryProjection ?? DEFAULT_BOUNDARY_PROJECTION),
    };
  }

  if (runtime.type !== "worker") {
    return { type: "component" };
  }

  return {
    ...runtime,
    concurrency: runtime.concurrency ?? "serial",
    activationHistory: runtime.activationHistory ?? "live",
    historyProjection: runtime.historyProjection ?? { type: "actor" },
    boundaryProjection: normalizeProjection(runtime.boundaryProjection ?? DEFAULT_BOUNDARY_PROJECTION),
  };
}

export function createNode<const TConfig extends NodeConfig>(config: TConfig): CreatedNode<TConfig> {
  const key = config.key ?? config.name;
  if (!key) {
    throw new Error("Node requires key or name");
  }
  const tools = normalizeActionEntries(config.tools ?? []);
  const commands = normalizeActionEntries(config.commands ?? []);

  return {
    key,
    sourceNodeKey: config.sourceNodeKey,
    name: config.name,
    instructions: config.instructions,
    toolBindings: tools.bindings,
    toolRefs: tools.refs,
    commandBindings: commands.bindings,
    commandRefs: commands.refs,
    state: config.state ? normalizeStateDescriptor(config.state) : undefined,
    members: normalizeMembers(config.members ?? []),
    output: config.output,
    projection: normalizeProjection(config.projection),
    runtime: normalizeRuntime(config.runtime),
  } as CreatedNode<TConfig>;
}

function normalizeActionEntries(entries: readonly ActionConfigEntry[]): {
  bindings: ActionBindings;
  refs: string[];
} {
  const bindings: ActionBindings = {};
  const refs: string[] = [];

  for (const entry of entries) {
    if (typeof entry === "string") {
      refs.push(entry);
      continue;
    }

    bindings[entry.name] = entry;
    refs.push(entry.name);
  }

  return { bindings, refs };
}

function normalizeMembers(configs: Node[]): Node[] {
  const members: Node[] = [];
  const keys = new Set<string>();

  for (const node of configs) {
    const key = node.key;

    if (keys.has(key)) {
      throw new Error(`Duplicate member key "${key}"`);
    }
    keys.add(key);

    members.push(node);
  }

  return members;
}
