import * as z from "zod";
import { createNode, normalizeStateDescriptor } from "./create.ts";
import { hydrateNodeRef } from "./refs.ts";
import type {
  ActionBindings,
  ActorHistoryProjection,
  AnyAction,
  Charter,
  DryHistoryProjection,
  DryRuntime,
  DryAction,
  DryNode,
  HistoryProjection,
  HistoryProjectionFunction,
  Instance,
  NormalizedStateDescriptor,
  AnyOutputConfig,
  Projection,
  ProjectionFunction,
  Ref,
  Runtime,
  SerializedOutputConfig,
  SerializedInstance,
  SerializedStateDescriptor,
  StateContainer,
  StaticProjection,
} from "./types.ts";

export function serializeInstance(instance: Instance, charter: Charter): SerializedInstance {
  return {
    id: instance.id,
    node: serializeNode(instance.node, charter),
    states: cloneStates(instance.states),
    children: instance.children?.map((child) => serializeInstance(child, charter)),
  };
}

export function hydrateInstance(serialized: SerializedInstance, charter: Charter): Instance {
  return {
    id: serialized.id,
    node: hydrateNode(serialized.node, charter),
    states: cloneStates(serialized.states),
    children: serialized.children?.map((child) => hydrateInstance(child, charter)),
  };
}

export function serializeNode(node: Instance["node"], charter: Charter): DryNode | Ref {
  const registeredKey = findRegisteredKey(charter.nodes, node);
  if (registeredKey) {
    return registeredKey;
  }
  const sourceNodeKey = sourceNodeKeyFor(node, charter);

  return {
    key: node.key,
    sourceNodeKey,
    name: node.name,
    instructions: node.instructions,
    tools: serializeActionRefs(node.toolRefs, node.toolBindings, charter, "tool", sourceNodeKey),
    commands: serializeActionRefs(
      node.commandRefs,
      node.commandBindings,
      charter,
      "command",
      sourceNodeKey,
    ),
    state: node.state ? serializeStateDescriptor(node.state, charter) : undefined,
    members: node.members.map((member) => serializeNode(member, charter)),
    output: node.output ? serializeOutputConfig(node.output) : undefined,
    projection: serializeProjection(node.projection, charter),
    runtime: serializeRuntime(node.runtime, charter),
  };
}

export function hydrateNode(serialized: DryNode | Ref, charter: Charter): Instance["node"] {
  if (typeof serialized === "string") {
    return hydrateNodeRef(serialized, charter);
  }

  return createNode({
    key: serialized.key,
    sourceNodeKey: serialized.sourceNodeKey,
    name: serialized.name,
    instructions: serialized.instructions,
    tools: hydrateActionRefs(serialized.tools, charter, "tool", serialized.sourceNodeKey),
    commands: hydrateActionRefs(
      serialized.commands,
      charter,
      "command",
      serialized.sourceNodeKey,
    ),
    state: serialized.state ? hydrateStateDescriptor(serialized.state, charter) : undefined,
    members: serialized.members?.map((member) => hydrateNode(member, charter)),
    output: serialized.output ? hydrateOutputConfig(serialized.output) : undefined,
    projection: serialized.projection ? hydrateProjection(serialized.projection, charter) : undefined,
    runtime: serialized.runtime ? hydrateRuntime(serialized.runtime, charter) : undefined,
  });
}

export function serializeOutputConfig(output: AnyOutputConfig): SerializedOutputConfig {
  if (output.mapTextBlock) {
    throw new Error("Cannot serialize inline output config with mapTextBlock");
  }

  return {
    audience: output.audience,
    schema: output.schema ? z.toJSONSchema(output.schema) : undefined,
  };
}

export function hydrateOutputConfig(output: SerializedOutputConfig): AnyOutputConfig {
  return {
    audience: output.audience,
    schema: output.schema
      ? z.fromJSONSchema(output.schema as Parameters<typeof z.fromJSONSchema>[0])
      : undefined,
  };
}

export function serializeProjection(projection: Projection, charter: Charter): StaticProjection | Ref {
  if (typeof projection === "function") {
    const key = findRegisteredKey(charter.projections, projection);
    if (!key) {
      throw new Error("Cannot serialize unregistered projection function");
    }
    return key;
  }

  if (typeof projection === "string") {
    return projection;
  }

  return projection;
}

export function hydrateProjection(
  projection: StaticProjection | Ref,
  charter: Charter,
): StaticProjection | ProjectionFunction {
  if (typeof projection !== "string") {
    return projection;
  }

  const fn = charter.projections[projection];
  if (!fn) {
    throw new Error(`Unknown projection ref "${projection}"`);
  }
  return fn;
}

export function serializeHistoryProjection(
  projection: HistoryProjection,
  charter: Charter,
): ActorHistoryProjection | Ref {
  if (isActorHistoryProjection(projection)) {
    return projection;
  }

  if (typeof projection === "function") {
    const key = findRegisteredKey(charter.historyProjections ?? {}, projection);
    if (!key) {
      throw new Error("Cannot serialize unregistered history projection function");
    }
    return key;
  }

  return projection;
}

export function hydrateHistoryProjection(
  projection: ActorHistoryProjection | Ref,
  charter: Charter,
): ActorHistoryProjection | HistoryProjectionFunction {
  if (isActorHistoryProjection(projection)) {
    return projection;
  }

  const fn = charter.historyProjections?.[projection];
  if (!fn) {
    throw new Error(`Unknown history projection ref "${projection}"`);
  }
  return fn;
}

function serializeRuntime(runtime: Instance["node"]["runtime"], charter: Charter): DryRuntime {
  if (runtime.type === "primary") {
    const { boundaryProjection, historyProjection, ...rest } = runtime;
    const serializedHistoryProjection = historyProjection
      ? serializeRuntimeHistoryProjection(historyProjection, charter)
      : undefined;
    return {
      ...rest,
      boundaryProjection: boundaryProjection
        ? serializeProjection(boundaryProjection, charter)
        : undefined,
      ...(serializedHistoryProjection
        ? { historyProjection: serializedHistoryProjection }
        : {}),
    };
  }

  if (runtime.type === "worker") {
    const { boundaryProjection, historyProjection, ...rest } = runtime;
    const serializedHistoryProjection = historyProjection
      ? serializeRuntimeHistoryProjection(historyProjection, charter)
      : undefined;
    return {
      ...rest,
      boundaryProjection: boundaryProjection
        ? serializeProjection(boundaryProjection, charter)
        : undefined,
      ...(serializedHistoryProjection
        ? { historyProjection: serializedHistoryProjection }
        : {}),
    };
  }

  return runtime;
}

function hydrateRuntime(runtime: DryRuntime, charter: Charter): Runtime {
  if (runtime.type === "primary") {
    return {
      ...runtime,
      boundaryProjection: runtime.boundaryProjection
        ? hydrateProjection(runtime.boundaryProjection, charter)
        : undefined,
      historyProjection: runtime.historyProjection
        ? hydrateHistoryProjection(runtime.historyProjection, charter)
        : undefined,
    };
  }

  if (runtime.type === "worker") {
    return {
      ...runtime,
      boundaryProjection: runtime.boundaryProjection
        ? hydrateProjection(runtime.boundaryProjection, charter)
        : undefined,
      historyProjection: runtime.historyProjection
        ? hydrateHistoryProjection(runtime.historyProjection, charter)
        : undefined,
    };
  }

  return runtime;
}

function serializeRuntimeHistoryProjection(
  projection: HistoryProjection,
  charter: Charter,
): DryHistoryProjection | undefined {
  if (isActorHistoryProjection(projection)) {
    return undefined;
  }
  return serializeHistoryProjection(projection, charter);
}

export function serializeStateDescriptor(
  state: NormalizedStateDescriptor,
  charter: Charter,
): SerializedStateDescriptor | Ref {
  const registeredKey = findRegisteredKey(charter.states, state);
  if (registeredKey) {
    return registeredKey;
  }

  if (typeof state.init === "function") {
    throw new Error("Cannot serialize inline state descriptor with function init");
  }

  return {
    key: state.key,
    scope: state.scope,
    onInitConflict: state.onInitConflict,
    projection: state.projection,
    init: state.init,
    schema: z.toJSONSchema(state.schema),
  };
}

export function hydrateStateDescriptor(
  serialized: SerializedStateDescriptor | Ref,
  charter: Charter,
): NormalizedStateDescriptor {
  if (typeof serialized === "string") {
    const state = charter.states[serialized];
    if (!state) {
      throw new Error(`Unknown state ref "${serialized}"`);
    }
    return state;
  }

  return normalizeStateDescriptor({
    key: serialized.key,
    schema: z.fromJSONSchema(serialized.schema as Parameters<typeof z.fromJSONSchema>[0]),
    init: serialized.init,
    scope: serialized.scope,
    onInitConflict: serialized.onInitConflict,
    projection: serialized.projection,
  });
}

function serializeActionRefs(
  refs: readonly string[],
  bindings: ActionBindings,
  charter: Charter,
  kind: "tool" | "command",
  sourceNodeKey: string | undefined,
): DryAction[] {
  return refs.map((ref) =>
    serializeActionRef(ref, bindings[ref], charter, kind, sourceNodeKey)
  );
}

function hydrateActionRefs(
  refs: readonly DryAction[] | undefined,
  charter: Charter,
  kind: "tool" | "command",
  sourceNodeKey: string | undefined,
): AnyAction[] | undefined {
  return refs?.map((ref) => hydrateActionRef(ref, charter, kind, sourceNodeKey));
}

function hydrateActionRef(
  ref: DryAction,
  charter: Charter,
  kind: "tool" | "command",
  sourceNodeKey: string | undefined,
): AnyAction {
  const sourceNode = sourceNodeKey ? charter.nodes[sourceNodeKey] : undefined;
  const sourceBinding = sourceNode ? actionBinding(sourceNode, ref, kind) : undefined;
  const registry = kind === "tool" ? charter.tools : charter.commands;
  const binding = sourceBinding ?? registry[ref];
  if (!binding) {
    throw new Error(`Unknown ${kind} ref "${ref}" for node hydration`);
  }
  if (binding.name !== ref) {
    throw new Error(
      `Cannot hydrate ${kind} ref "${ref}" because resolved action name is "${binding.name}"`,
    );
  }
  return binding;
}

function serializeActionRef(
  ref: string,
  binding: AnyAction | undefined,
  charter: Charter,
  kind: "tool" | "command",
  sourceNodeKey: string | undefined,
): DryAction {
  if (!binding) {
    return ref;
  }

  const registry = kind === "tool" ? charter.tools : charter.commands;
  const key = findRegisteredKey(registry, binding);
  if (!key) {
    const sourceNode = sourceNodeKey ? charter.nodes[sourceNodeKey] : undefined;
    const sourceBinding = sourceNode
      ? actionBinding(sourceNode, ref, kind)
      : undefined;
    if (sourceBinding === binding) {
      return ref;
    }

    throw new Error(`Cannot serialize unregistered ${kind} "${binding.name}"`);
  }

  return key;
}

function sourceNodeKeyFor(node: Instance["node"], charter: Charter): string | undefined {
  if (node.sourceNodeKey) {
    return node.sourceNodeKey;
  }
  const sourceNode = charter.nodes[node.key];
  return sourceNode && sourceNode !== node ? node.key : undefined;
}

function actionBinding(
  node: Instance["node"],
  ref: string,
  kind: "tool" | "command",
): AnyAction | undefined {
  return kind === "tool" ? node.toolBindings[ref] : node.commandBindings[ref];
}

function isActorHistoryProjection(
  projection: HistoryProjection,
): projection is ActorHistoryProjection {
  return typeof projection === "object" && projection !== null && projection.type === "actor";
}

function findRegisteredKey<T extends object>(registry: Record<string, T>, value: T): string | undefined {
  return Object.entries(registry).find(([, candidate]) => candidate === value)?.[0];
}

function cloneStates(
  states: Record<string, StateContainer> | undefined,
): Record<string, StateContainer> | undefined {
  if (!states) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(states).map(([key, container]) => [
      key,
      { value: structuredCloneIfPossible(container.value) },
    ]),
  );
}

function structuredCloneIfPossible(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
