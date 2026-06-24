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
} from "./types.ts";
import { defaultProjection, hiddenProjection, isProjectionFunction } from "./projection-functions.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";

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

export type CreatedNode<
  TDataContent,
  TConfig extends NodeConfig<TDataContent>,
> = Node<TDataContent> & {
  state: InferState<TConfig>;
  __tools?: InferActionMetas<TConfig, "tools">;
  __commands?: InferActionMetas<TConfig, "commands">;
};

export function normalizeProjection<TDataContent = never>(
  projection: Projection<TDataContent> | undefined,
): Projection<TDataContent> {
  return normalizeProjectionValue(projection, defaultProjection, "Node projection");
}

export function normalizeStateDescriptor<S>(
  descriptor: StateDescriptor<S>,
): NormalizedStateDescriptor<S> {
  assertProjectorIdentifier(descriptor.key, "State key");
  const scope = descriptor.scope ?? "hoist";
  const onInitConflict = descriptor.onInitConflict ?? "replace";
  const projection = descriptor.projection ?? "hidden";
  if (
    descriptor.scope === scope &&
    descriptor.onInitConflict === onInitConflict &&
    descriptor.projection === projection
  ) {
    return descriptor as NormalizedStateDescriptor<S>;
  }

  return {
    ...descriptor,
    scope,
    onInitConflict,
    projection,
  };
}

export function normalizeRuntime<TDataContent = never>(
  runtime: Runtime<TDataContent> | undefined,
): NormalizedRuntime<TDataContent> {
  if (!runtime || runtime.type === "component" || !("trigger" in runtime)) {
    return { type: "component" };
  }

  return {
    ...runtime,
    type: "generator",
    concurrency: runtime.concurrency ?? "serial",
    activationHistory: runtime.activationHistory ?? "live",
    historyProjection: runtime.historyProjection ?? { type: "messages" },
    boundaryProjection: normalizeProjectionValue(
      runtime.boundaryProjection,
      hiddenProjection,
      "Boundary projection",
    ),
  };
}

function normalizeProjectionValue<TDataContent = never>(
  projection: Projection<TDataContent> | undefined,
  fallback: Projection,
  label: string,
): Projection<TDataContent> {
  if (!projection) {
    return fallback as Projection<TDataContent>;
  }

  if (isProjectionFunction<TDataContent>(projection) || typeof projection === "string") {
    return projection;
  }

  throw new Error(`${label} must be a projection function or ref`);
}

export function createNode<
  TDataContent = never,
  const TConfig extends NodeConfig<TDataContent> = NodeConfig<TDataContent>,
>(config: TConfig): CreatedNode<TDataContent, TConfig> {
  const key = config.key ?? config.name;
  if (!key) {
    throw new Error("Node requires key or name");
  }
  assertProjectorIdentifier(key, "Node key");
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
  } as CreatedNode<TDataContent, TConfig>;
}

function normalizeActionEntries(entries: readonly ActionConfigEntry[]): {
  bindings: ActionBindings;
  refs: string[];
} {
  const bindings: ActionBindings = {};
  const refs: string[] = [];

  for (const entry of entries) {
    if (typeof entry === "string") {
      assertProjectorIdentifier(entry, "Action ref");
      refs.push(entry);
      continue;
    }

    assertProjectorIdentifier(entry.name, "Action name");
    bindings[entry.name] = entry;
    refs.push(entry.name);
  }

  return { bindings, refs };
}

function normalizeMembers<TDataContent>(
  configs: Node<TDataContent>[],
): Node<TDataContent>[] {
  const members: Node<TDataContent>[] = [];
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
