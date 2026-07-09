import { computedPartEnv, type Contributor } from "./contributors.ts";
import {
  computedPartDefinition,
  evaluateComputedPartReturn,
  isComputedActionReturn,
  resolveComputedPartRef,
} from "./computed-parts.ts";
import { isNode } from "./create.ts";
import { type DiscriminatorMemo } from "./discriminators.ts";
import { walkAllParts } from "./parts.ts";
import type {
  ActionCaller,
  ActionConfigEntry,
  AnyAction,
  AnyComputedPartDef,
  Charter,
  Exposure,
  Node,
} from "./types.ts";

export type ResolvedNodeAction = {
  action: AnyAction;
  caller: ActionCaller;
  exposure: Exposure;
};

export function callerAllows(caller: ActionCaller, requirement: "generator" | "external"): boolean {
  return caller === "any" || caller === requirement;
}

/**
 * The action candidates a computed part's registry declares. Node entries
 * belong to computed members (see ComputedMemberDef): accepted and stored,
 * ignored here.
 */
export function computedRegistryActions(definition: AnyComputedPartDef): AnyAction[] {
  return (definition.registry ?? []).filter(
    (entry): entry is AnyAction => !isNode(entry),
  );
}

/**
 * The effective actions a contributor exposes this compile: walks the node's
 * parts, evaluating computed parts (select/when sugar included — the chosen
 * branch is the compute's return) against the contributor-resolved env
 * (fresh — this also runs on the executeCommand dispatch path), and resolves
 * each entry through the scoped chain — inline object → sourceNode parts →
 * charter registry, with a computed's local registry as the first tier for
 * its returned actions. De novo nodes simply have an empty middle tier.
 */
export function resolveContributorActions<TDataContent>(
  contributor: Contributor<TDataContent>,
  charter: Charter<TDataContent> | undefined,
  memo?: DiscriminatorMemo,
): ResolvedNodeAction[] {
  const actions: ResolvedNodeAction[] = [];
  for (const part of contributor.node.parts) {
    if (part.kind === "action") {
      actions.push({
        action: resolveActionEntry(part.action, contributor.node, charter),
        caller: part.caller,
        exposure: part.exposure ?? "native",
      });
      continue;
    }
    if (part.kind === "computed") {
      const definition = resolveComputedPartRef(part.part, charter);
      for (const item of evaluateComputedPartReturn(definition, computedPartEnv(contributor, charter, memo))) {
        if (!isComputedActionReturn(item)) {
          continue;
        }
        actions.push({
          action: resolveComputedActionEntry(item.action, definition, contributor.node, charter),
          caller: item.caller,
          exposure: item.exposure ?? "native",
        });
      }
    }
  }
  return actions;
}

/**
 * Every action reachable in a node's parts across ALL sugar branches (the
 * walk enters computed metadata, so branch action parts report their true
 * caller/exposure), plus the actions a bare computed part's registry declares
 * (walkable data; a closure's unlisted inline actions are opaque by design —
 * they error at compile), for static analysis (validation, client metadata,
 * serialization). Registry entries carry no contribution, so they report
 * caller "any" and exposure "native"; the effective caller/exposure ride the
 * returned part at compile. Sugar registries are skipped: they are derived
 * from the branches the walk already enters, and adding them would
 * double-count every branch action.
 */
export function collectAllNodeActions<TDataContent>(
  node: Node<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): ResolvedNodeAction[] {
  const actions: ResolvedNodeAction[] = [];
  walkAllParts(node.parts, (part) => {
    if (part.kind === "action") {
      actions.push({
        action: resolveActionEntry(part.action, node, charter),
        caller: part.caller,
        exposure: part.exposure ?? "native",
      });
      return;
    }
    if (part.kind === "computed") {
      const definition = computedPartDefinition(part.part, charter);
      if (!definition || definition.metadata) {
        return;
      }
      for (const action of computedRegistryActions(definition)) {
        actions.push({ action, caller: "any", exposure: "native" });
      }
    }
  });
  return actions;
}

export function resolveActionEntry<TDataContent>(
  entry: ActionConfigEntry,
  node: Node<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction {
  if (typeof entry !== "string") {
    return entry;
  }

  const selfBinding = nodeActionByName(node, entry, charter);
  if (selfBinding) {
    return selfBinding;
  }

  const sourceNode = node.sourceNodeKey ? charter?.nodes[node.sourceNodeKey] : undefined;
  const sourceBinding = sourceNode ? nodeActionByName(sourceNode, entry, charter) : undefined;
  if (sourceBinding) {
    return sourceBinding;
  }

  const registered = charter?.actions[entry];
  if (registered) {
    return registered;
  }

  throw new Error(`Unknown action ref "${entry}" for node "${node.key}"`);
}

/**
 * Resolution for a computed's returned action parts, extending the scoped
 * chain with the computed-local registry: registry → node self-binding →
 * sourceNode → charter. Inline objects obey the closure rule — they must BE a
 * declared identity (registry-listed by reference, or the same object a data
 * tier resolves to); a compute closure never mints identities.
 */
export function resolveComputedActionEntry<TDataContent>(
  entry: ActionConfigEntry,
  definition: AnyComputedPartDef,
  node: Node<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction {
  const registry = computedRegistryActions(definition);
  if (typeof entry === "string") {
    const local = registry.find((action) => action.name === entry);
    return local ?? resolveActionEntry(entry, node, charter);
  }

  const sourceNode = node.sourceNodeKey ? charter?.nodes[node.sourceNodeKey] : undefined;
  const declared =
    registry.includes(entry) ||
    nodeActionByName(node, entry.name, charter) === entry ||
    (sourceNode !== undefined && nodeActionByName(sourceNode, entry.name, charter) === entry) ||
    charter?.actions[entry.name] === entry;
  if (!declared) {
    throw new Error(
      `Computed part "${definition.name}" returned inline action "${entry.name}" with no declared identity; list it in the computed's registry or register it on the node/charter — identities are never minted inside a compute closure`,
    );
  }
  return entry;
}

/**
 * Finds an inline action carried by a node's parts (any sugar branch — the
 * walk enters computed metadata — or any computed part's registry) by name —
 * the "self binding" tier of scoped resolution, and the recovery path
 * serialized bare refs use through sourceNodeKey. Computed refs need the
 * charter to reach their registry; without it only inline computed defs are
 * consulted.
 */
export function nodeActionByName<TDataContent>(
  node: Node<TDataContent>,
  name: string,
  charter?: Charter<TDataContent>,
): AnyAction | undefined {
  let found: AnyAction | undefined;
  walkAllParts(node.parts, (part) => {
    if (found) {
      return;
    }
    if (part.kind === "action") {
      if (typeof part.action !== "string" && part.action.name === name) {
        found = part.action;
      }
      return;
    }
    if (part.kind === "computed") {
      const definition = computedPartDefinition(part.part, charter);
      found = definition
        ? computedRegistryActions(definition).find((action) => action.name === name)
        : undefined;
    }
  });
  return found;
}
