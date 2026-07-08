import type { Contributor } from "./contributors.ts";
import { evaluateDiscriminator } from "./discriminator-eval.ts";
import {
  resolveDiscriminatorRef,
  type DiscriminatorMemo,
} from "./discriminators.ts";
import { walkAllParts } from "./parts.ts";
import type {
  ActionCaller,
  ActionConfigEntry,
  AnyAction,
  Charter,
  Exposure,
  Node,
  Part,
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
 * The effective actions a contributor exposes this compile: walks the node's
 * parts, evaluating selects at the contributor (chosen branches only), and
 * resolves each entry through the scoped chain — inline object → sourceNode
 * parts → charter registry. De novo nodes simply have an empty middle tier.
 */
export function resolveContributorActions<TDataContent>(
  contributor: Contributor<TDataContent>,
  charter: Charter<TDataContent> | undefined,
  memo?: DiscriminatorMemo,
): ResolvedNodeAction[] {
  const actions: ResolvedNodeAction[] = [];
  visitEffectiveParts(contributor.node.parts, contributor, charter, memo, (part) => {
    if (part.kind !== "action") {
      return;
    }
    actions.push({
      action: resolveActionEntry(part.action, contributor.node, charter),
      caller: part.caller,
      exposure: part.exposure ?? "native",
    });
  });
  return actions;
}

/**
 * Walks the parts effective at a contributor: selects contribute only their
 * chosen branch, evaluated against the contributor's scope.
 */
export function visitEffectiveParts<TDataContent>(
  parts: readonly Part<TDataContent>[],
  contributor: Contributor<TDataContent>,
  charter: Charter<TDataContent> | undefined,
  memo: DiscriminatorMemo | undefined,
  visit: (part: Part<TDataContent>) => void,
): void {
  for (const part of parts) {
    if (part.kind === "select") {
      const discriminator = resolveDiscriminatorRef(part.discriminator, charter);
      const value = evaluateDiscriminator(discriminator, contributor, memo);
      const branch = part.branches[value];
      if (branch) {
        visitEffectiveParts(branch, contributor, charter, memo, visit);
      }
      continue;
    }
    visit(part);
  }
}

/**
 * Every action reachable in a node's parts across ALL select branches, for
 * static analysis (validation, client metadata, serialization).
 */
export function collectAllNodeActions<TDataContent>(
  node: Node<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): ResolvedNodeAction[] {
  const actions: ResolvedNodeAction[] = [];
  walkAllParts(node.parts, (part) => {
    if (part.kind !== "action") {
      return;
    }
    actions.push({
      action: resolveActionEntry(part.action, node, charter),
      caller: part.caller,
      exposure: part.exposure ?? "native",
    });
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

  const selfBinding = nodeActionByName(node, entry);
  if (selfBinding) {
    return selfBinding;
  }

  const sourceNode = node.sourceNodeKey ? charter?.nodes[node.sourceNodeKey] : undefined;
  const sourceBinding = sourceNode ? nodeActionByName(sourceNode, entry) : undefined;
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
 * Finds an inline action carried by a node's parts (any select branch) by
 * name — the "self binding" tier of scoped resolution, and the recovery path
 * serialized bare refs use through sourceNodeKey.
 */
export function nodeActionByName<TDataContent>(
  node: Node<TDataContent>,
  name: string,
): AnyAction | undefined {
  let found: AnyAction | undefined;
  walkAllParts(node.parts, (part) => {
    if (found || part.kind !== "action") {
      return;
    }
    if (typeof part.action !== "string" && part.action.name === name) {
      found = part.action;
    }
  });
  return found;
}
