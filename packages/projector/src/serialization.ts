import * as z from "zod";
import {
  createNode,
  normalizeStateDescriptor,
} from "./create.ts";
import { isComputedMemberDef } from "./computed-parts.ts";
import {
  memberSelectComputed,
  partSelectComputed,
  resolveDiscriminatorRef,
} from "./discriminators.ts";
import { hydrateNodeRef } from "./refs.ts";
import { nodeActionByName } from "./scoped-actions.ts";
import { regionAddress } from "./regions.ts";
import { slotPlacement } from "./slots.ts";
import type {
  AnyAction,
  Charter,
  DryMemberEntry,
  DryPart,
  DryRuntime,
  DryAction,
  DryNode,
  Instance,
  LayoutRegionName,
  MemberEntry,
  Node,
  NormalizedStateDescriptor,
  AnyOutputConfig,
  OutputConfig,
  Part,
  Ref,
  Runtime,
  SerializedOutputConfig,
  SerializedInstance,
  SerializedStateDescriptor,
  SlotAddress,
  StateContainer,
} from "./types.ts";

/** Re-enters a dry placement tag as a slot address (regions by sentinel identity). */
function hydrateSlotAddress(entry: {
  slot?: string;
  region?: LayoutRegionName;
}): { slot?: SlotAddress } {
  if (entry.slot !== undefined) {
    return { slot: entry.slot };
  }
  if (entry.region !== undefined) {
    return { slot: regionAddress(entry.region) };
  }
  return {};
}

export function serializeInstance<TDataContent>(
  instance: Instance<TDataContent>,
  charter: Charter<TDataContent>,
): SerializedInstance<TDataContent> {
  return {
    id: instance.id,
    node: serializeNode(instance.node, charter),
    ...(instance.isSource ? { isSource: true } : {}),
    ...(instance.params ? { params: structuredClone(instance.params) } : {}),
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
    ...(serialized.params ? { params: structuredClone(serialized.params) } : {}),
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
  const sourceNode = sourceNodeKey ? charter.nodes[sourceNodeKey] : undefined;

  return {
    key: node.key,
    sourceNodeKey,
    name: node.name,
    params: serializeParams(node.params),
    parts: serializeParts(node.parts, charter, sourceNode, []),
    states: node.states.length > 0
      ? node.states.map((state) => serializeStateDescriptor(state, charter))
      : undefined,
    members: node.memberEntries.map((entry) => serializeMemberEntry(entry, charter)),
    output: node.output ? serializeOutputConfig(node.output) : undefined,
    runtime: serializeRuntime(node.runtime),
    executorConfig: node.executorConfig,
  };
}

export function hydrateNode<TDataContent = never>(
  serialized: DryNode<TDataContent> | Ref,
  charter: Charter<TDataContent>,
): Node<TDataContent> {
  if (typeof serialized === "string") {
    return hydrateNodeRef(serialized, charter);
  }

  const sourceNode = serialized.sourceNodeKey ? charter.nodes[serialized.sourceNodeKey] : undefined;
  return createNode<TDataContent>({
    key: serialized.key,
    sourceNodeKey: serialized.sourceNodeKey,
    name: serialized.name,
    params: serialized.params ? hydrateParams(serialized.params) : undefined,
    parts: serialized.parts
      ? hydrateParts<TDataContent>(serialized.parts, charter, sourceNode, [])
      : undefined,
    states: serialized.states?.map((state) => hydrateStateDescriptor(state, charter)),
    members: serialized.members?.map((entry) => hydrateMemberEntry(entry, charter)),
    output: serialized.output
      ? (hydrateOutputConfig(serialized.output) as OutputConfig<TDataContent>)
      : undefined,
    runtime: serialized.runtime,
    executorConfig: serialized.executorConfig,
  });
}

// --- Parts serialization. Invariant: every behavioral ref on a serialized
// node must be recoverable from some registry at hydration — the sourceNode's
// parts when the node descends from a charter node, or the charter's global
// registries otherwise. Code (runs, computes, derives) never serializes. ---

/** A step into a sugar select branch, for branch-scoped action recovery. */
type BranchPath = Array<{ discriminator: string; value: string }>;

function serializeParts<TDataContent>(
  parts: readonly Part<TDataContent>[],
  charter: Charter<TDataContent>,
  sourceNode: Node<TDataContent> | undefined,
  branchPath: BranchPath,
): DryPart[] {
  return parts.map((part): DryPart => {
    if (part.kind === "text") {
      return { kind: "text", ...slotPlacement(part.slot), text: part.text };
    }

    if (part.kind === "computed") {
      const definition = part.part;
      if (typeof definition === "string") {
        if (!charter.computedParts[definition]) {
          throw new Error(`Cannot serialize unknown computed part ref "${definition}"`);
        }
        return { kind: "computed", ref: definition };
      }
      const select = definition.metadata;
      if (select) {
        // Sugar-produced computeds serialize as their declarative data — the
        // same select wire shape the SelectPart kind used — so old stored
        // payloads and new ones hydrate through the same lowering.
        const discriminator = resolveDiscriminatorRef(select.discriminator, charter);
        if (charter.discriminators[discriminator.name] !== discriminator) {
          throw new Error(`Cannot serialize unregistered discriminator "${discriminator.name}"`);
        }
        const branches: Record<string, DryPart[] | null> = {};
        for (const [value, branch] of Object.entries(select.branches)) {
          branches[value] = branch
            ? serializeParts(branch, charter, sourceNode, [
                ...branchPath,
                { discriminator: discriminator.name, value },
              ])
            : null;
        }
        return { kind: "select", discriminator: discriminator.name, partial: select.partial, branches };
      }
      if (charter.computedParts[definition.name] !== definition) {
        throw new Error(`Cannot serialize unregistered computed part "${definition.name}"`);
      }
      return { kind: "computed", ref: definition.name };
    }

    return {
      kind: "action",
      caller: part.caller,
      ...(part.exposure ? { exposure: part.exposure } : {}),
      ref: serializePartAction(part.action, charter, sourceNode, branchPath),
      ...(part.guidance
        ? {
            guidance: part.guidance.map((entry) => ({
              ...slotPlacement(entry.slot),
              text: entry.text,
            })),
          }
        : {}),
    };
  });
}

function hydrateParts<TDataContent>(
  parts: readonly DryPart[],
  charter: Charter<TDataContent>,
  sourceNode: Node<TDataContent> | undefined,
  branchPath: BranchPath,
): Part<TDataContent>[] {
  return parts.map((part): Part<TDataContent> => {
    if (part.kind === "text") {
      return { kind: "text", ...hydrateSlotAddress(part), text: part.text };
    }

    if (part.kind === "computed") {
      const definition = charter.computedParts[part.ref];
      if (!definition) {
        throw new Error(`Unknown computed part ref "${part.ref}" for node hydration`);
      }
      return { kind: "computed", part: definition };
    }

    if (part.kind === "action") {
      return {
        kind: "action",
        caller: part.caller,
        ...(part.exposure ? { exposure: part.exposure } : {}),
        action: hydratePartAction(part.ref, charter, sourceNode, branchPath),
        ...(part.guidance
          ? {
              guidance: part.guidance.map((entry) => ({
                kind: "text" as const,
                ...hydrateSlotAddress(entry),
                text: entry.text,
              })),
            }
          : {}),
      };
    }

    // The select wire shape hydrates through the sugar lowering: refs resolve
    // to definitions first (the lowering's compute has no charter access), so
    // the reconstructed computed is identical to a freshly authored select.
    const discriminator = charter.discriminators[part.discriminator];
    if (!discriminator) {
      throw new Error(`Unknown discriminator ref "${part.discriminator}" for node hydration`);
    }
    const branches: Record<string, Part<TDataContent>[] | null> = {};
    for (const [value, branch] of Object.entries(part.branches)) {
      branches[value] = branch
        ? hydrateParts(branch, charter, sourceNode, [
            ...branchPath,
            { discriminator: discriminator.name, value },
          ])
        : null;
    }
    return { kind: "computed", part: partSelectComputed(discriminator, part.partial, branches) };
  });
}

/**
 * Serializes an action entry to a name ref. Recovery tiers mirror scoped
 * resolution: charter registry key, else identity-match inside the source
 * node's parts (branch-scoped first, so same-named variants in different
 * select branches stay distinguishable), else error — an inline behavioral
 * definition recoverable from no registry cannot serialize.
 */
function serializePartAction<TDataContent>(
  entry: AnyAction | string,
  charter: Charter<TDataContent>,
  sourceNode: Node<TDataContent> | undefined,
  branchPath: BranchPath,
): DryAction {
  if (typeof entry === "string") {
    return entry;
  }

  const registeredKey = findRegisteredKey(charter.actions, entry);
  if (registeredKey) {
    return registeredKey;
  }

  if (sourceNode) {
    const match = findSourceAction(sourceNode, entry.name, branchPath, charter);
    if (match === entry) {
      return entry.name;
    }
  }

  throw new Error(`Cannot serialize unregistered action "${entry.name}"`);
}

function hydratePartAction<TDataContent>(
  ref: DryAction,
  charter: Charter<TDataContent>,
  sourceNode: Node<TDataContent> | undefined,
  branchPath: BranchPath,
): AnyAction {
  if (sourceNode) {
    const match = findSourceAction(sourceNode, ref, branchPath, charter);
    if (match) {
      return match;
    }
  }
  const registered = charter.actions[ref];
  if (registered) {
    return registered;
  }
  throw new Error(`Unknown action ref "${ref}" for node hydration`);
}

/**
 * Finds an inline action by name in a source node's parts, preferring the
 * exact branch context (following selects whose discriminator+value match the
 * path) before falling back to a node-wide first match — which includes
 * computed-part registries (charter needed to resolve computed refs), so
 * registry-listed actions recover from serialized bare refs.
 */
function findSourceAction<TDataContent>(
  sourceNode: Node<TDataContent>,
  name: string,
  branchPath: BranchPath,
  charter?: Charter<TDataContent>,
): AnyAction | undefined {
  const scoped = findActionInParts(sourceNode.parts, name, branchPath);
  if (scoped) {
    return scoped;
  }
  return nodeActionByName(sourceNode, name, charter);
}

function findActionInParts<TDataContent>(
  parts: readonly Part<TDataContent>[],
  name: string,
  branchPath: BranchPath,
): AnyAction | undefined {
  const [step, ...rest] = branchPath;
  for (const part of parts) {
    if (step === undefined) {
      if (part.kind === "action" && typeof part.action !== "string" && part.action.name === name) {
        return part.action;
      }
      continue;
    }
    // Branch steps follow sugar-lowered selects through their metadata (the
    // walkable data that replaced SelectPart branches).
    if (part.kind !== "computed" || typeof part.part === "string") {
      continue;
    }
    const select = part.part.metadata;
    if (!select) {
      continue;
    }
    const discriminator = typeof select.discriminator === "string"
      ? select.discriminator
      : select.discriminator.name;
    if (discriminator !== step.discriminator) {
      continue;
    }
    const branch = select.branches[step.value];
    if (branch) {
      const found = findActionInParts(branch, name, rest);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function serializeMemberEntry<TDataContent>(
  entry: MemberEntry<TDataContent>,
  charter: Charter<TDataContent>,
): DryMemberEntry<TDataContent> {
  if (isComputedMemberDef(entry)) {
    const select = entry.metadata;
    if (!select) {
      // Compute closures are code and never serialize. Registered nodes
      // serialize as refs before reaching here, so this only bites de novo
      // nodes carrying a bare member computed.
      throw new Error(
        `Cannot serialize computed member "${entry.name}" on an unregistered node; register the carrying node on the charter`,
      );
    }
    // Sugar-produced computeds serialize as their declarative data — the same
    // select wire shape the MemberSelect kind used — so hydration reconstructs
    // the identical computed through the same lowering.
    const discriminator = resolveDiscriminatorRef(select.discriminator, charter);
    if (charter.discriminators[discriminator.name] !== discriminator) {
      throw new Error(`Cannot serialize unregistered discriminator "${discriminator.name}"`);
    }
    const branches: Record<string, Array<DryNode<TDataContent> | Ref> | null> = {};
    for (const [value, branch] of Object.entries(select.branches)) {
      branches[value] = branch ? branch.map((member) => serializeNode(member, charter)) : null;
    }
    return { kind: "select", discriminator: discriminator.name, partial: select.partial, branches };
  }
  return serializeNode(entry, charter);
}

function hydrateMemberEntry<TDataContent>(
  entry: DryMemberEntry<TDataContent>,
  charter: Charter<TDataContent>,
): MemberEntry<TDataContent> {
  if (typeof entry !== "string" && "kind" in entry && entry.kind === "select") {
    const discriminator = charter.discriminators[entry.discriminator];
    if (!discriminator) {
      throw new Error(`Unknown discriminator ref "${entry.discriminator}" for node hydration`);
    }
    const branches: Record<string, Node<TDataContent>[] | null> = {};
    for (const [value, branch] of Object.entries(entry.branches)) {
      branches[value] = branch ? branch.map((member) => hydrateNode(member, charter)) : null;
    }
    return memberSelectComputed(discriminator, entry.partial, branches);
  }
  return hydrateNode(entry as DryNode<TDataContent> | Ref, charter);
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

function serializeParams(params: Node["params"]): unknown {
  return z.toJSONSchema(params);
}

function hydrateParams(params: unknown): Node["params"] {
  return z.fromJSONSchema(params as Parameters<typeof z.fromJSONSchema>[0]) as Node["params"];
}

export function hydrateOutputConfig(output: SerializedOutputConfig): AnyOutputConfig {
  return {
    audience: output.audience,
    schema: output.schema
      ? z.fromJSONSchema(output.schema as Parameters<typeof z.fromJSONSchema>[0])
      : undefined,
  };
}

function serializeRuntime(runtime: Node["runtime"]): DryRuntime {
  if (runtime.type === "generator") {
    const { boundaryProjection, ...rest } = runtime;
    return {
      ...rest,
      ...(boundaryProjection === "hidden" ? {} : { boundaryProjection }),
    };
  }

  return runtime;
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
  if (state.projection?.render || state.projection?.note) {
    throw new Error(
      `Cannot serialize inline state descriptor "${state.key}" with a render/note function; register it on the charter`,
    );
  }

  return {
    key: state.key,
    scope: state.scope,
    onInitConflict: state.onInitConflict,
    ...(state.projection
      ? {
          projection: {
            ...slotPlacement(state.projection.slot),
            ...(state.projection.exposure ? { exposure: state.projection.exposure } : {}),
          },
        }
      : {}),
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
    projection: serialized.projection
      ? {
          ...hydrateSlotAddress(serialized.projection),
          ...(serialized.projection.exposure ? { exposure: serialized.projection.exposure } : {}),
        }
      : undefined,
  });
}

export function sourceNodeKeyFor<TDataContent>(
  node: Node<TDataContent>,
  charter: Pick<Charter<TDataContent>, "nodes">,
): string | undefined {
  if (node.sourceNodeKey) {
    return node.sourceNodeKey;
  }
  const sourceNode = charter.nodes[node.key];
  return sourceNode && sourceNode !== node ? node.key : undefined;
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
