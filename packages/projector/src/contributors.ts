import { createNode } from "./create.ts";
// Function-level cycle with discriminator-eval.ts (it reads contributor
// params); safe because both modules only declare functions at init.
import { contributorStateValue, evaluateDiscriminator } from "./discriminator-eval.ts";
import {
  evaluateComputedMemberNodes,
  isComputedMemberDef,
  type ComputedMemberMemo,
} from "./computed-parts.ts";
import {
  resolveDiscriminatorRef,
  type DiscriminatorMemo,
} from "./discriminators.ts";
import { encodeProjectionAddress } from "./projection-address.ts";
import { ROOT_INSTANCE_ID } from "./projection-address.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  Charter,
  ComputedPartEnv,
  Instance,
  Node,
  ProjectionAddress,
} from "./types.ts";
import {
  resolveEffectiveParams,
  resolveNodeParams,
  type InputCharterParams,
  type JsonObject,
} from "./params.ts";

export type Contributor<TDataContent = never> = {
  node: Node<TDataContent>;
  instance: Instance<TDataContent>;
  concreteInstance: Instance<TDataContent>;
  sourceInstance?: Instance<TDataContent>;
  address: ProjectionAddress;
  id: string;
  memberPath: string[];
  parent?: Contributor<TDataContent>;
  isMember: boolean;
};

// The machine's conversational protagonist: `primary` rather than
// `actor-frame`, so a suppressing primary anywhere below (the root is an
// ancestor of every generator) takes lineage tenure from it. With no other
// primaries in the tree the root's admission is uncontended — behavior-
// preserving for every existing charter.
const rootNode = createNode({
  key: "root",
  name: "Root",
  runtime: {
    type: "generator",
    trigger: { type: "primary" },
  },
});

export type CreateInstanceOptions<TDataContent = never> = {
  id: string;
  node: Node<TDataContent>;
  isSource?: boolean;
  states?: Instance<TDataContent>["states"];
  children?: Instance<TDataContent>[];
};

export function createInstance<TDataContent = never>({
  id,
  node,
  isSource,
  states,
  children,
}: CreateInstanceOptions<TDataContent>): Instance<TDataContent> {
  assertProjectorIdentifier(id, "Instance id");
  return {
    id,
    node,
    ...(isSource ? { isSource: true } : {}),
    ...(states ? { states } : {}),
    ...(children ? { children } : {}),
  };
}

export function createSourceInstance<TDataContent = never>(
  options: Omit<CreateInstanceOptions<TDataContent>, "isSource">,
): Instance<TDataContent> {
  return createInstance({ ...options, isSource: true });
}

export function createRoot<
  TDataContent = never,
  TCharter extends Charter<TDataContent> = Charter<TDataContent>,
>(
  charter: TCharter,
  instances: Instance<TDataContent>[],
  params: InputCharterParams<TCharter>,
): Instance<TDataContent> {
  const parsedParams = charter.params.parse(params);
  return createRootInstance(instances, parsedParams);
}

export function createRootInstance<TDataContent = never>(
  instances: Instance<TDataContent>[],
  params?: Instance<TDataContent>["params"],
): Instance<TDataContent> {
  const root = {
    id: ROOT_INSTANCE_ID,
    node: rootNode as unknown as Instance<TDataContent>["node"],
    ...(params ? { params } : {}),
    children: instances,
  } satisfies Instance<TDataContent>;
  assertUniqueInstanceIds(root);
  return root;
}

export function collectContributors<TDataContent = never>(
  root: Instance<TDataContent>,
  resolution: MemberResolution<TDataContent> = { mode: "all" },
): Contributor<TDataContent>[] {
  const contributors: Contributor<TDataContent>[] = [];
  collectInstanceNode(contributors, root, undefined, undefined, resolution);
  return contributors;
}

export function findContributorById<TDataContent = never>(
  root: Instance<TDataContent>,
  id: string,
  resolution: MemberResolution<TDataContent> = { mode: "all" },
): Contributor<TDataContent> | undefined {
  return collectContributors(root, resolution).find(
    (contributor) => contributor.id === id,
  );
}

export type MemberResolution<TDataContent = never> =
  | { mode: "all" }
  | {
      mode: "effective";
      charter?: Charter<TDataContent>;
      memo?: DiscriminatorMemo;
      /** Per-compile cache for member compute returns; absent = fresh evaluation. */
      computedMembers?: ComputedMemberMemo;
    };

/**
 * The env a compute closure sees, resolved at a contributor: node params, a
 * declared-state reader (init fallback, never a side effect), and a
 * discriminator reader through the canonical evaluation path — contributor-
 * relative state resolution, memo write, vocabulary validation. Compile,
 * member resolution, and external dispatch all construct env through here so
 * every path agrees; memo-less callers (dispatch) evaluate fresh and agree
 * because correctness never depends on the memo.
 */
export function computedPartEnv<TDataContent>(
  contributor: Contributor<TDataContent>,
  charter?: Charter<TDataContent>,
  memo?: DiscriminatorMemo,
): ComputedPartEnv {
  return {
    params: resolveContributorNodeParams(contributor),
    state: (descriptor) => contributorStateValue(contributor, descriptor).value,
    discriminator: (discriminator) =>
      evaluateDiscriminator(resolveDiscriminatorRef(discriminator, charter), contributor, memo),
  };
}

/**
 * Resolves a contributor's members. Two views, per the invariant "state
 * placement follows the skeleton; state existence follows the log; state
 * persists once attached; surface follows the derivation":
 *
 * - "all" (default): every potential member reachable by walking data —
 *   static nodes plus computed-member registries (sugar-produced computeds
 *   carry every former branch node by construction) — deduped by key. Used by
 *   contributor collection and state resolution so declarations resolve for
 *   every member the data declares. Compute closures are NEVER called here
 *   (no params in scope); a bare computed return (charter-registered, not
 *   registry-listed) is invisible to this view by design.
 * - "effective": member computeds evaluated at the contributor; compile,
 *   client realization, and dispatch use this to decide which members
 *   contribute to the surface.
 */
export function resolveMemberNodes<TDataContent = never>(
  contributor: Contributor<TDataContent>,
  resolution: MemberResolution<TDataContent> = { mode: "all" },
): Node<TDataContent>[] {
  const members: Node<TDataContent>[] = [];
  const seen = new Set<string>();
  const push = (node: Node<TDataContent>) => {
    if (!seen.has(node.key)) {
      seen.add(node.key);
      members.push(node);
    }
  };

  for (const entry of contributor.node.memberEntries) {
    if (isComputedMemberDef(entry)) {
      if (resolution.mode === "all") {
        for (const node of entry.registry ?? []) {
          push(node);
        }
        continue;
      }
      const memo = resolution.computedMembers
        ? { key: `${entry.name} ${contributor.id}`, store: resolution.computedMembers }
        : undefined;
      for (const node of evaluateComputedMemberNodes(
        entry,
        computedPartEnv(contributor, resolution.charter, resolution.memo),
        resolution.charter,
        memo,
      )) {
        push(node);
      }
      continue;
    }
    push(entry);
  }
  return members;
}

export function directContributorChildren<TDataContent = never>(
  contributor: Contributor<TDataContent>,
  resolution: MemberResolution<TDataContent> = { mode: "all" },
): Contributor<TDataContent>[] {
  const children: Contributor<TDataContent>[] = [];

  for (const member of resolveMemberNodes(contributor, resolution)) {
    const memberPath = [...contributor.memberPath, member.key];
    const address: ProjectionAddress = {
      type: "member",
      ownerInstanceId: contributor.concreteInstance.id,
      memberPath,
    };
    const memberNode: Contributor<TDataContent> = {
      node: member,
      instance: contributor.concreteInstance,
      concreteInstance: contributor.concreteInstance,
      sourceInstance: contributor.sourceInstance,
      address,
      id: encodeProjectionAddress(address),
      memberPath,
      parent: contributor,
      isMember: true,
    };
    children.push(memberNode);
  }

  if (!contributor.isMember) {
    for (const child of contributor.instance.children ?? []) {
      const childAddress: ProjectionAddress = { type: "instance", instanceId: child.id };
      children.push({
        node: child.node,
        instance: child,
        concreteInstance: child,
        sourceInstance: child.isSource ? child : contributor.sourceInstance,
        address: childAddress,
        id: encodeProjectionAddress(childAddress),
        memberPath: [],
        parent: contributor,
        isMember: false,
      });
    }
  }

  return children;
}

export function instancePathForContributor<TDataContent>(
  contributor: Contributor<TDataContent>,
): Instance<TDataContent>[] {
  const reversed: Instance<TDataContent>[] = [];
  let current: Contributor<TDataContent> | undefined = contributor;
  while (current) {
    const instance = current.concreteInstance;
    if (reversed[reversed.length - 1] !== instance) {
      reversed.push(instance);
    }
    current = current.parent;
  }
  return reversed.reverse();
}

export function resolveContributorNodeParams<TDataContent>(
  contributor: Contributor<TDataContent>,
): JsonObject {
  return resolveNodeParams(
    contributor.node,
    resolveEffectiveParams(instancePathForContributor(contributor)),
  );
}

export function hoistStateInstance<TDataContent>(
  contributor: Contributor<TDataContent>,
): Instance<TDataContent> {
  if (contributor.sourceInstance) {
    return contributor.sourceInstance;
  }

  if (contributor.concreteInstance.isSource) {
    return contributor.concreteInstance;
  }

  throw new Error(
    `Cannot resolve hoist state for instance "${contributor.concreteInstance.id}" without an ancestor source instance`,
  );
}

function collectInstanceNode<TDataContent>(
  contributors: Contributor<TDataContent>[],
  instance: Instance<TDataContent>,
  parent: Contributor<TDataContent> | undefined,
  sourceInstance: Instance<TDataContent> | undefined,
  resolution: MemberResolution<TDataContent>,
): void {
  const address: ProjectionAddress = { type: "instance", instanceId: instance.id };
  const contributor: Contributor<TDataContent> = {
    node: instance.node,
    instance,
    concreteInstance: instance,
    sourceInstance: instance.isSource ? instance : sourceInstance,
    address,
    id: encodeProjectionAddress(address),
    memberPath: [],
    parent,
    isMember: false,
  };
  contributors.push(contributor);
  collectDescendants(contributors, contributor, resolution);
}

function collectDescendants<TDataContent>(
  contributors: Contributor<TDataContent>[],
  contributor: Contributor<TDataContent>,
  resolution: MemberResolution<TDataContent>,
): void {
  for (const child of directContributorChildren(contributor, resolution)) {
    contributors.push(child);
    collectDescendants(contributors, child, resolution);
  }
}

export function assertUniqueInstanceIds(root: Instance<any>): void {
  const seen = new Set<string>();
  visitInstanceIds(root, seen);
}

function visitInstanceIds(instance: Instance<any>, seen: Set<string>): void {
  assertProjectorIdentifier(instance.id, "Instance id");
  if (seen.has(instance.id)) {
    throw new Error(`Duplicate instance id "${instance.id}"`);
  }
  seen.add(instance.id);
  for (const child of instance.children ?? []) {
    visitInstanceIds(child, seen);
  }
}
