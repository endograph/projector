import type { ProjectionNode } from "./projection-nodes.ts";
import { hoistStateInstance, collectProjectionNodes } from "./projection-nodes.ts";
import type {
  Instance,
  NormalizedStateDescriptor,
  StateAddress,
  StateContainer,
  StateKey,
} from "./types.ts";

export type ResolvedState<TDataContent = any> = {
  address: StateAddress;
  targetInstance: Instance<TDataContent>;
  descriptor: NormalizedStateDescriptor;
  container: StateContainer;
  sourceProjectionNode: ProjectionNode<TDataContent>;
};

type StateGroup<TDataContent = any> = {
  targetInstance: Instance<TDataContent>;
  stateKey: StateKey;
  entries: Array<{
    descriptor: NormalizedStateDescriptor;
    projectionNode: ProjectionNode<TDataContent>;
  }>;
};

export function resolveStates<TDataContent>(
  root: Instance<TDataContent>,
): ResolvedState<TDataContent>[] {
  const groups = new Map<string, StateGroup<TDataContent>>();

  for (const projectionNode of collectProjectionNodes(root)) {
    const descriptor = projectionNode.node.state;
    if (!descriptor) {
      continue;
    }

    const targetInstance =
      descriptor.scope === "local" ? projectionNode.concreteInstance : hoistStateInstance(projectionNode);
    const groupKey = `${targetInstance.id}\u0000${descriptor.key}`;
    const group =
      groups.get(groupKey) ??
      ({
        targetInstance,
        stateKey: descriptor.key,
        entries: [],
      } satisfies StateGroup<TDataContent>);
    group.entries.push({ descriptor, projectionNode });
    groups.set(groupKey, group);
  }

  const resolved: ResolvedState<TDataContent>[] = [];
  for (const group of groups.values()) {
    resolved.push(resolveStateGroup(group));
  }

  return resolved;
}

function resolveStateGroup<TDataContent>(
  group: StateGroup<TDataContent>,
): ResolvedState<TDataContent> {
  const scope = group.entries[0]?.descriptor.scope;
  if (!scope) {
    throw new Error("State group has no descriptors");
  }

  for (const entry of group.entries) {
    if (entry.descriptor.scope !== scope) {
      throw new Error(
        `Incompatible state descriptors for "${group.stateKey}": scopes differ`,
      );
    }
  }

  const existing = group.targetInstance.states?.[group.stateKey];
  const effectiveDescriptor = mergeDescriptors(group.entries.map((entry) => entry.descriptor));
  const sourceProjectionNode = group.entries[group.entries.length - 1]?.projectionNode;
  if (!sourceProjectionNode) {
    throw new Error("State group has no source projection node");
  }

  if (existing) {
    if (allSchemasValidate(group.entries, existing.value)) {
      return {
        address: { instanceId: group.targetInstance.id, stateKey: group.stateKey },
        targetInstance: group.targetInstance,
        descriptor: effectiveDescriptor,
        container: existing,
        sourceProjectionNode,
      };
    }

    if (effectiveDescriptor.onInitConflict === "error") {
      throw new Error(`Existing state "${group.stateKey}" is invalid`);
    }

    const resetValue = resolveInitialValue(group.entries.map((entry) => entry.descriptor));
    validateAllSchemas(group.entries, resetValue, group.stateKey);
    existing.value = resetValue;
    return {
      address: { instanceId: group.targetInstance.id, stateKey: group.stateKey },
      targetInstance: group.targetInstance,
      descriptor: effectiveDescriptor,
      container: existing,
      sourceProjectionNode,
    };
  }

  const value = resolveInitialValue(group.entries.map((entry) => entry.descriptor));
  validateAllSchemas(group.entries, value, group.stateKey);
  group.targetInstance.states ??= {};
  const container: StateContainer = { value };
  group.targetInstance.states[group.stateKey] = container;

  return {
    address: { instanceId: group.targetInstance.id, stateKey: group.stateKey },
    targetInstance: group.targetInstance,
    descriptor: effectiveDescriptor,
    container,
    sourceProjectionNode,
  };
}

function mergeDescriptors(
  descriptors: NormalizedStateDescriptor[],
): NormalizedStateDescriptor {
  const latest = descriptors[descriptors.length - 1];
  if (!latest) {
    throw new Error("Cannot merge empty state descriptors");
  }

  return {
    ...latest,
    onInitConflict: descriptors.some((descriptor) => descriptor.onInitConflict === "error")
      ? "error"
      : "replace",
    projection: latest.projection,
  };
}

function allSchemasValidate<TDataContent>(
  entries: StateGroup<TDataContent>["entries"],
  value: unknown,
): boolean {
  return entries.every((entry) => entry.descriptor.schema.safeParse(value).success);
}

function validateAllSchemas(
  entries: StateGroup<any>["entries"],
  value: unknown,
  stateKey: string,
): void {
  const invalid = entries.find((entry) => !entry.descriptor.schema.safeParse(value).success);
  if (invalid) {
    throw new Error(`Incompatible state descriptors for "${stateKey}": schema validation failed`);
  }
}

function resolveInitialValue(descriptors: NormalizedStateDescriptor[]): unknown {
  const withInit = descriptors.filter((descriptor) => "init" in descriptor);
  if (withInit.length === 0) {
    return undefined;
  }

  const first = withInit[0];
  if (!first) {
    return undefined;
  }

  for (const descriptor of withInit.slice(1)) {
    if (!equivalentInit(first.init, descriptor.init)) {
      throw new Error(`Conflicting init values for state "${descriptor.key}"`);
    }
  }

  return evaluateInit(first.init);
}

function equivalentInit(a: unknown, b: unknown): boolean {
  if (typeof a === "function" || typeof b === "function") {
    return a === b;
  }

  if (Object.is(a, b)) {
    return true;
  }

  const stableA = stableJson(a);
  const stableB = stableJson(b);
  return stableA !== undefined && stableA === stableB;
}

function evaluateInit(init: unknown): unknown {
  if (typeof init === "function") {
    return (init as () => unknown)();
  }
  return cloneJson(init);
}

function cloneJson(value: unknown): unknown {
  if (value === undefined || typeof value === "function") {
    return value;
  }

  const serialized = stableJson(value);
  if (serialized === undefined) {
    return value;
  }
  return JSON.parse(serialized);
}

function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(sortJson(value));
  } catch {
    return undefined;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}
