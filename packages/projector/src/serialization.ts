import * as z from "zod";
import {
  createNode,
  normalizeStateDescriptor,
} from "./create.ts";
import {
  defaultProjection,
  hiddenProjection,
  isHistoryProjectionFunction,
  isProjectionFunction,
} from "./projection-functions.ts";
import { hydrateNodeRef } from "./refs.ts";
import type {
  ActionBindings,
  ActionKind,
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
  MessageHistoryProjection,
  Node,
  NormalizedStateDescriptor,
  AnyOutputConfig,
  OutputConfig,
  Projection,
  ProjectionFunction,
  Ref,
  Runtime,
  SerializedOutputConfig,
  SerializedInstance,
  SerializedStateDescriptor,
  StateContainer,
} from "./types.ts";

export function serializeInstance<TDataContent>(
  instance: Instance<TDataContent>,
  charter: Charter<TDataContent>,
): SerializedInstance<TDataContent> {
  return {
    id: instance.id,
    node: serializeNode(instance.node, charter),
    ...(instance.isSource ? { isSource: true } : {}),
    states: cloneStates(instance.states),
    children: instance.children?.map((child) => serializeInstance(child, charter)),
  };
}

export function hydrateInstance<TDataContent = never>(
  serialized: SerializedInstance<TDataContent>,
  charter: Charter<TDataContent>,
): Instance<TDataContent> {
  return {
    id: serialized.id,
    node: hydrateNode(serialized.node, charter),
    ...(serialized.isSource ? { isSource: true } : {}),
    states: cloneStates(serialized.states),
    children: serialized.children?.map((child) => hydrateInstance(child, charter)),
  };
}

export function serializeNode<TDataContent>(
  node: Node<TDataContent>,
  charter: Charter<TDataContent>,
): DryNode<TDataContent> | Ref {
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
    projection: serializeNodeProjection(node, charter, sourceNodeKey),
    runtime: serializeRuntime(node.runtime, charter, sourceNodeKey),
  };
}

export function hydrateNode<TDataContent = never>(
  serialized: DryNode<TDataContent> | Ref,
  charter: Charter<TDataContent>,
): Node<TDataContent> {
  if (typeof serialized === "string") {
    return hydrateNodeRef(serialized, charter);
  }

  return createNode<TDataContent>({
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
    output: serialized.output
      ? (hydrateOutputConfig(serialized.output) as OutputConfig<TDataContent>)
      : undefined,
    projection: serialized.projection
      ? hydrateNodeProjection(serialized.projection, charter, serialized.sourceNodeKey)
      : undefined,
    runtime: serialized.runtime
      ? hydrateRuntime(serialized.runtime, charter, serialized.sourceNodeKey)
      : undefined,
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

export function serializeProjection<TDataContent>(
  projection: Projection<TDataContent>,
  charter: Charter<TDataContent>,
): Ref {
  if (isProjectionFunction<TDataContent>(projection)) {
    const registered = charter.projections[projection.name];
    if (registered !== projection) {
      throw new Error(
        `Cannot serialize unregistered projection function "${projection.name}"`,
      );
    }
    return projection.name;
  }

  if (typeof projection === "string") {
    assertProjectionRef(projection, charter);
    return projection;
  }

  throw new Error("Cannot serialize unknown projection");
}

export function hydrateProjection<TDataContent>(
  projection: Ref,
  charter: Charter<TDataContent>,
): ProjectionFunction<TDataContent> {
  const fn = charter.projections[projection];
  if (!fn) {
    throw new Error(`Unknown projection ref "${projection}"`);
  }
  return fn;
}

function serializeNodeProjection<TDataContent>(
  node: Node<TDataContent>,
  charter: Charter<TDataContent>,
  sourceNodeKey: string | undefined,
): Ref | undefined {
  if (node.projection === defaultProjection) {
    return undefined;
  }
  return serializeProjectionSlot(node.projection, charter, "projection", sourceNodeKey);
}

function hydrateNodeProjection<TDataContent>(
  projection: Ref,
  charter: Charter<TDataContent>,
  sourceNodeKey: string | undefined,
): ProjectionFunction<TDataContent> {
  return hydrateProjectionSlot(projection, charter, "projection", sourceNodeKey);
}

function serializeProjectionSlot<TDataContent>(
  projection: Projection<TDataContent>,
  charter: Charter<TDataContent>,
  slot: "projection" | "boundaryProjection",
  sourceNodeKey: string | undefined,
): Ref {
  if (typeof projection === "string") {
    assertProjectionSlotRef(projection, charter, slot, sourceNodeKey);
    return projection;
  }

  const sourceProjection = sourceNodeProjectionSlot(charter, slot, sourceNodeKey);
  if (sourceProjection === projection) {
    return projection.name;
  }

  return serializeProjection(projection, charter);
}

function hydrateProjectionSlot<TDataContent>(
  projection: Ref,
  charter: Charter<TDataContent>,
  slot: "projection" | "boundaryProjection",
  sourceNodeKey: string | undefined,
): ProjectionFunction<TDataContent> {
  const sourceProjection = sourceNodeProjectionSlot(charter, slot, sourceNodeKey);
  if (sourceProjection?.name === projection) {
    return sourceProjection;
  }
  return hydrateProjection(projection, charter);
}

function assertProjectionSlotRef<TDataContent>(
  projection: Ref,
  charter: Charter<TDataContent>,
  slot: "projection" | "boundaryProjection",
  sourceNodeKey: string | undefined,
): void {
  const sourceProjection = sourceNodeProjectionSlot(charter, slot, sourceNodeKey);
  if (sourceProjection?.name === projection) {
    return;
  }
  assertProjectionRef(projection, charter);
}

function sourceNodeProjectionSlot<TDataContent>(
  charter: Charter<TDataContent>,
  slot: "projection" | "boundaryProjection",
  sourceNodeKey: string | undefined,
): ProjectionFunction<TDataContent> | undefined {
  if (!sourceNodeKey) {
    return undefined;
  }
  const sourceNode = charter.nodes[sourceNodeKey];
  if (!sourceNode) {
    return undefined;
  }

  const projection = slot === "projection"
    ? sourceNode.projection
    : sourceNode.runtime.type === "generator"
      ? sourceNode.runtime.boundaryProjection
      : undefined;
  return isProjectionFunction<TDataContent>(projection) ? projection : undefined;
}

function assertProjectionRef<TDataContent>(
  projection: Ref,
  charter: Charter<TDataContent>,
): void {
  if (!charter.projections[projection]) {
    throw new Error(`Unknown projection ref "${projection}"`);
  }
}

export function serializeHistoryProjection<TDataContent>(
  projection: HistoryProjection<TDataContent>,
  charter: Charter<TDataContent>,
): ActorHistoryProjection | MessageHistoryProjection | Ref {
  if (isActorHistoryProjection(projection) || isMessageHistoryProjection(projection)) {
    return projection;
  }

  if (isHistoryProjectionFunction(projection)) {
    const registered = charter.historyProjections[projection.name];
    if (registered !== projection) {
      throw new Error(
        `Cannot serialize unregistered history projection function "${projection.name}"`,
      );
    }
    return projection.name;
  }

  if (typeof projection === "string") {
    assertHistoryProjectionRef(projection, charter);
    return projection;
  }

  throw new Error(`Cannot serialize unknown history projection`);
}

function assertHistoryProjectionRef<TDataContent>(
  projection: Ref,
  charter: Charter<TDataContent>,
): void {
  if (!charter.historyProjections[projection]) {
    throw new Error(`Unknown history projection ref "${projection}"`);
  }
}

export function hydrateHistoryProjection<TDataContent>(
  projection: ActorHistoryProjection | MessageHistoryProjection | Ref,
  charter: Charter<TDataContent>,
): ActorHistoryProjection | MessageHistoryProjection | HistoryProjectionFunction<TDataContent> {
  if (isActorHistoryProjection(projection) || isMessageHistoryProjection(projection)) {
    return projection;
  }

  if (typeof projection !== "string") {
    throw new Error(`Cannot hydrate unknown history projection`);
  }
  const historyProjection = charter.historyProjections[projection];
  if (!historyProjection) {
    throw new Error(`Unknown history projection ref "${projection}"`);
  }
  return historyProjection;
}

function serializeRuntime<TDataContent>(
  runtime: Node<TDataContent>["runtime"],
  charter: Charter<TDataContent>,
  sourceNodeKey: string | undefined,
): DryRuntime {
  if (runtime.type === "generator") {
    const { boundaryProjection, historyProjection, ...rest } = runtime;
    const serializedHistoryProjection = historyProjection
      ? serializeRuntimeHistoryProjection(historyProjection, charter)
      : undefined;
    return {
      ...rest,
      boundaryProjection: boundaryProjection === hiddenProjection
        ? undefined
        : serializeProjectionSlot(boundaryProjection, charter, "boundaryProjection", sourceNodeKey),
      ...(serializedHistoryProjection
        ? { historyProjection: serializedHistoryProjection }
        : {}),
    };
  }

  return runtime;
}

function hydrateRuntime<TDataContent>(
  runtime: DryRuntime,
  charter: Charter<TDataContent>,
  sourceNodeKey: string | undefined,
): Runtime<TDataContent> {
  if (runtime.type === "generator") {
    return {
      ...runtime,
      boundaryProjection: runtime.boundaryProjection
        ? hydrateProjectionSlot(runtime.boundaryProjection, charter, "boundaryProjection", sourceNodeKey)
        : undefined,
      historyProjection: runtime.historyProjection
        ? hydrateHistoryProjection(runtime.historyProjection, charter)
        : undefined,
    };
  }

  return runtime;
}

function serializeRuntimeHistoryProjection<TDataContent>(
  projection: HistoryProjection<TDataContent>,
  charter: Charter<TDataContent>,
): DryHistoryProjection | undefined {
  if (isMessageHistoryProjection(projection)) {
    return undefined;
  }
  return serializeHistoryProjection(projection, charter);
}

export function serializeStateDescriptor(
  state: NormalizedStateDescriptor,
  charter: Pick<Charter, "states">,
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
  charter: Pick<Charter, "states">,
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

function serializeActionRefs<TDataContent>(
  refs: readonly string[],
  bindings: ActionBindings,
  charter: Pick<Charter<TDataContent>, "nodes" | "tools" | "commands">,
  kind: ActionKind,
  sourceNodeKey: string | undefined,
): DryAction[] {
  return refs.map((ref) =>
    serializeActionRef(ref, bindings[ref], charter, kind, sourceNodeKey)
  );
}

function hydrateActionRefs<TDataContent>(
  refs: readonly DryAction[] | undefined,
  charter: Pick<Charter<TDataContent>, "nodes" | "tools" | "commands">,
  kind: ActionKind,
  sourceNodeKey: string | undefined,
): AnyAction[] | undefined {
  return refs?.map((ref) => hydrateActionRef(ref, charter, kind, sourceNodeKey));
}

function hydrateActionRef<TDataContent>(
  ref: DryAction,
  charter: Pick<Charter<TDataContent>, "nodes" | "tools" | "commands">,
  kind: ActionKind,
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

function serializeActionRef<TDataContent>(
  ref: string,
  binding: AnyAction | undefined,
  charter: Pick<Charter<TDataContent>, "nodes" | "tools" | "commands">,
  kind: ActionKind,
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

function sourceNodeKeyFor<TDataContent>(
  node: Node<TDataContent>,
  charter: Pick<Charter<TDataContent>, "nodes">,
): string | undefined {
  if (node.sourceNodeKey) {
    return node.sourceNodeKey;
  }
  const sourceNode = charter.nodes[node.key];
  return sourceNode && sourceNode !== node ? node.key : undefined;
}

function actionBinding(
  node: Node<any>,
  ref: string,
  kind: ActionKind,
): AnyAction | undefined {
  return kind === "tool" ? node.toolBindings[ref] : node.commandBindings[ref];
}

function isActorHistoryProjection(
  projection: HistoryProjection<any>,
): projection is ActorHistoryProjection {
  return (
    typeof projection === "object" &&
    projection !== null &&
    "type" in projection &&
    projection.type === "actor"
  );
}

function isMessageHistoryProjection(
  projection: HistoryProjection<any>,
): projection is MessageHistoryProjection {
  return (
    typeof projection === "object" &&
    projection !== null &&
    "type" in projection &&
    projection.type === "messages"
  );
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
