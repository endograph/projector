import { createNode } from "./create.ts";
// Function-level cycle with discriminator-eval.ts (it reads contributor
// params); safe because both modules only declare functions at init.
import { evaluateDiscriminator } from "./discriminator-eval.ts";
import {
  isMemberSelect,
  resolveDiscriminatorRef,
  type DiscriminatorMemo,
} from "./discriminators.ts";
import { encodeProjectionAddress } from "./projection-address.ts";
import { ROOT_INSTANCE_ID } from "./projection-address.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  Charter,
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

const rootNode = createNode({
  key: "root",
  name: "Root",
  runtime: {
    type: "generator",
    trigger: { type: "actor-frame" },
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
): Contributor<TDataContent>[] {
  const contributors: Contributor<TDataContent>[] = [];
  collectInstanceNode(contributors, root, undefined, undefined);
  return contributors;
}

export function findContributorById<TDataContent = never>(
  root: Instance<TDataContent>,
  id: string,
): Contributor<TDataContent> | undefined {
  return collectContributors(root).find(
    (contributor) => contributor.id === id,
  );
}

export type MemberResolution<TDataContent = never> =
  | { mode: "all" }
  | { mode: "effective"; charter?: Charter<TDataContent>; memo?: DiscriminatorMemo };

/**
 * Resolves a contributor's members. Two views, per the invariant "state
 * follows the skeleton; surface follows the derivation":
 *
 * - "all" (default): every potential member across every select branch,
 *   deduped by key. Used by contributor collection and state resolution so
 *   containers provision for every branch a select could derive — a member
 *   flapping on must find its state already in scope — and so no evaluation
 *   (which needs params in scope) happens outside a compiled root.
 * - "effective": selects evaluated at the contributor; the compile render
 *   path uses this to decide which members contribute to the surface.
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
    if (isMemberSelect(entry)) {
      if (resolution.mode === "all") {
        for (const branch of Object.values(entry.branches)) {
          for (const node of branch ?? []) {
            push(node);
          }
        }
        continue;
      }
      const discriminator = resolveDiscriminatorRef(entry.discriminator, resolution.charter);
      const value = evaluateDiscriminator(discriminator, contributor, resolution.memo);
      for (const node of entry.branches[value] ?? []) {
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
  collectDescendants(contributors, contributor);
}

function collectDescendants<TDataContent>(
  contributors: Contributor<TDataContent>[],
  contributor: Contributor<TDataContent>,
): void {
  for (const child of directContributorChildren(contributor)) {
    contributors.push(child);
    collectDescendants(contributors, child);
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
