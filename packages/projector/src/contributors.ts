import { createNode } from "./create.ts";
import { hiddenProjection } from "./projection-functions.ts";
import { encodeProjectionAddress } from "./projection-address.ts";
import { ROOT_INSTANCE_ID } from "./projection-address.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  Instance,
  Node,
  ProjectionAddress,
} from "./types.ts";

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
  projection: hiddenProjection,
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

export function createRoot<TDataContent = never>(
  instances: Instance<TDataContent>[],
): Instance<TDataContent> {
  const root = {
    id: ROOT_INSTANCE_ID,
    node: rootNode as unknown as Instance<TDataContent>["node"],
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

export function directContributorChildren<TDataContent = never>(
  contributor: Contributor<TDataContent>,
): Contributor<TDataContent>[] {
  const children: Contributor<TDataContent>[] = [];

  for (const member of contributor.node.members) {
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
