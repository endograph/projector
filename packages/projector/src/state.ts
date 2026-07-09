import type { Contributor } from "./contributors.ts";
import { hoistStateInstance, collectContributors } from "./contributors.ts";
import { encodeProjectionAddress } from "./projection-address.ts";
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
  /**
   * The container view for this state. When `realized` is true this is the
   * container attached to `targetInstance.states`; when false it is a
   * detached view carrying the descriptor's init value — reading it never
   * side-effects the instance tree. Writers must call `realizeResolvedState`
   * before writing through it.
   */
  container: StateContainer;
  sourceContributor: Contributor<TDataContent>;
  realized: boolean;
};

export type StateReset = {
  address: StateAddress;
  value: unknown;
};

export type ResolveStatesOptions = {
  /**
   * Called when an existing value fails its descriptor schema and is replaced
   * with the init value (onInitConflict "replace"). Machine paths use this to
   * record the reset as a state.update frame so the log reproduces the state.
   */
  onReset?: (reset: StateReset) => void;
};

type StateGroup<TDataContent = any> = {
  targetInstance: Instance<TDataContent>;
  stateKey: StateKey;
  entries: Array<{
    descriptor: NormalizedStateDescriptor;
    contributor: Contributor<TDataContent>;
  }>;
};

/**
 * Resolves every state declared in scope of the instance tree WITHOUT
 * provisioning: existing containers are validated/parsed (keeping the
 * onInitConflict reset path for schema evolution); declared-but-unrealized
 * states resolve to a detached container view carrying the init value, and
 * nothing is attached to the tree. Realization is a logged write —
 * `realizeResolvedState` at the state.update fold, or a spawn/transition
 * `states:` seed — never a read, so any compile-reachable path may call this.
 */
export function resolveStates<TDataContent>(
  root: Instance<TDataContent>,
  options: ResolveStatesOptions = {},
): ResolvedState<TDataContent>[] {
  const groups = new Map<string, StateGroup<TDataContent>>();

  for (const contributor of collectContributors(root)) {
    for (const descriptor of contributor.node.states) {
      const targetInstance =
        descriptor.scope === "local" ? contributor.concreteInstance : hoistStateInstance(contributor);
      const groupKey = `${targetInstance.id}\u0000${descriptor.key}`;
      const group =
        groups.get(groupKey) ??
        ({
          targetInstance,
          stateKey: descriptor.key,
          entries: [],
        } satisfies StateGroup<TDataContent>);
      group.entries.push({ descriptor, contributor });
      groups.set(groupKey, group);
    }
  }

  const resolved: ResolvedState<TDataContent>[] = [];
  for (const group of groups.values()) {
    resolved.push(resolveStateGroup(group, options));
  }

  return resolved;
}

function resolveStateGroup<TDataContent>(
  group: StateGroup<TDataContent>,
  options: ResolveStatesOptions,
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
  const sourceContributor = group.entries[group.entries.length - 1]?.contributor;
  if (!sourceContributor) {
    throw new Error("State group has no source contributor");
  }

  if (existing) {
    if (allSchemasValidate(group.entries, existing.value)) {
      return {
        address: { instanceId: group.targetInstance.id, stateKey: group.stateKey },
        targetInstance: group.targetInstance,
        descriptor: effectiveDescriptor,
        container: existing,
        sourceContributor,
        realized: true,
      };
    }

    if (effectiveDescriptor.onInitConflict === "error") {
      throw new Error(`Existing state "${group.stateKey}" is invalid`);
    }

    const resetValue = resolveInitialValue(group.entries.map((entry) => entry.descriptor));
    validateAllSchemas(group.entries, resetValue, group.stateKey);
    existing.value = resetValue;
    options.onReset?.({
      address: { instanceId: group.targetInstance.id, stateKey: group.stateKey },
      value: resetValue,
    });
    return {
      address: { instanceId: group.targetInstance.id, stateKey: group.stateKey },
      targetInstance: group.targetInstance,
      descriptor: effectiveDescriptor,
      container: existing,
      sourceContributor,
      realized: true,
    };
  }

  // Unrealized: resolve a detached container view over the init value. It is
  // deliberately NOT attached to targetInstance.states — reads stay pure, and
  // the value tracks current code init until a logged write realizes it.
  const value = resolveInitialValue(group.entries.map((entry) => entry.descriptor));
  validateAllSchemas(group.entries, value, group.stateKey);

  return {
    address: { instanceId: group.targetInstance.id, stateKey: group.stateKey },
    targetInstance: group.targetInstance,
    descriptor: effectiveDescriptor,
    container: { value },
    sourceContributor,
    realized: false,
  };
}

/**
 * Attaches an unrealized resolved state's container at its target instance —
 * the placement `resolveStates` derived from the declaring contributor and
 * `descriptor.scope`. This is the only realization path besides spawn/
 * transition `states:` seeds, and it must only run under a logged write
 * (the state.update fold); no compile-reachable code may call it.
 */
export function realizeResolvedState(state: ResolvedState): void {
  if (state.realized) {
    return;
  }
  state.targetInstance.states ??= {};
  state.targetInstance.states[state.address.stateKey] = state.container;
  state.realized = true;
}

/**
 * Derives the projection-wide alias for each entry: the bare state key when
 * unique, `key:instanceId` when several instances carry the same key. One
 * scheme for every consumer (getState addresses, history state values) so
 * their naming can never drift. Throws when two distinct addresses still
 * collide on one alias.
 */
export function deriveStateAliases<T>(
  entries: readonly T[],
  addressOf: (entry: T) => StateAddress,
): Map<T, string> {
  const keyCounts = new Map<string, number>();
  for (const entry of entries) {
    const { stateKey } = addressOf(entry);
    keyCounts.set(stateKey, (keyCounts.get(stateKey) ?? 0) + 1);
  }

  const aliases = new Map<T, string>();
  const used = new Map<string, StateAddress>();
  for (const entry of entries) {
    const address = addressOf(entry);
    const duplicate = (keyCounts.get(address.stateKey) ?? 0) > 1;
    const alias = duplicate ? `${address.stateKey}:${address.instanceId}` : address.stateKey;
    const collision = used.get(alias);
    if (
      collision &&
      (collision.instanceId !== address.instanceId || collision.stateKey !== address.stateKey)
    ) {
      throw new Error(`Generated state alias collision for "${alias}"`);
    }
    used.set(alias, address);
    aliases.set(entry, alias);
  }
  return aliases;
}

/**
 * Groups resolved states under the contributor that presents them: hoist
 * states at their owning instance's contributor, local states at the declaring
 * contributor.
 */
export function groupStatesByContributor(
  states: ResolvedState[],
): Map<string, ResolvedState[]> {
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
