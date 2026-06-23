import { createNode } from "./create.ts";
import { encodeRuntimeAddress } from "./runtime-address.ts";
import { ROOT_INSTANCE_ID } from "./runtime-address.ts";
import type {
  Instance,
  Node,
  RuntimeAddress,
} from "./types.ts";

export type ProjectionNode<TDataContent = never> = {
  node: Node<TDataContent>;
  instance: Instance<TDataContent>;
  concreteInstance: Instance<TDataContent>;
  sourceInstance?: Instance<TDataContent>;
  address: RuntimeAddress;
  runtimeInstanceId: string;
  memberPath: string[];
  parent?: ProjectionNode<TDataContent>;
  isMember: boolean;
};

const rootNode = createNode({
  key: "root",
  name: "Root",
  runtime: {
    type: "generator",
    trigger: { type: "actor-frame" },
  },
  projection: { mode: "hidden" },
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

export function collectProjectionNodes<TDataContent = never>(
  root: Instance<TDataContent>,
): ProjectionNode<TDataContent>[] {
  const projectionNodes: ProjectionNode<TDataContent>[] = [];
  collectInstanceNode(projectionNodes, root, undefined, undefined);
  return projectionNodes;
}

export function findProjectionNodeByRuntimeId<TDataContent = never>(
  root: Instance<TDataContent>,
  runtimeInstanceId: string,
): ProjectionNode<TDataContent> | undefined {
  return collectProjectionNodes(root).find(
    (projectionNode) => projectionNode.runtimeInstanceId === runtimeInstanceId,
  );
}

export function directProjectionNodeChildren<TDataContent = never>(
  projectionNode: ProjectionNode<TDataContent>,
): ProjectionNode<TDataContent>[] {
  const children: ProjectionNode<TDataContent>[] = [];

  for (const member of projectionNode.node.members) {
    const memberPath = [...projectionNode.memberPath, member.key];
    const address: RuntimeAddress = {
      type: "member",
      ownerInstanceId: projectionNode.concreteInstance.id,
      memberPath,
    };
    const memberNode: ProjectionNode<TDataContent> = {
      node: member,
      instance: projectionNode.concreteInstance,
      concreteInstance: projectionNode.concreteInstance,
      sourceInstance: projectionNode.sourceInstance,
      address,
      runtimeInstanceId: encodeRuntimeAddress(address),
      memberPath,
      parent: projectionNode,
      isMember: true,
    };
    children.push(memberNode);
  }

  if (!projectionNode.isMember) {
    for (const child of projectionNode.instance.children ?? []) {
      const childAddress: RuntimeAddress = { type: "instance", instanceId: child.id };
      children.push({
        node: child.node,
        instance: child,
        concreteInstance: child,
        sourceInstance: child.isSource ? child : projectionNode.sourceInstance,
        address: childAddress,
        runtimeInstanceId: encodeRuntimeAddress(childAddress),
        memberPath: [],
        parent: projectionNode,
        isMember: false,
      });
    }
  }

  return children;
}

export function hoistStateInstance<TDataContent>(
  projectionNode: ProjectionNode<TDataContent>,
): Instance<TDataContent> {
  if (projectionNode.sourceInstance) {
    return projectionNode.sourceInstance;
  }

  if (projectionNode.concreteInstance.isSource) {
    return projectionNode.concreteInstance;
  }

  throw new Error(
    `Cannot resolve hoist state for instance "${projectionNode.concreteInstance.id}" without an ancestor source instance`,
  );
}

function collectInstanceNode<TDataContent>(
  projectionNodes: ProjectionNode<TDataContent>[],
  instance: Instance<TDataContent>,
  parent: ProjectionNode<TDataContent> | undefined,
  sourceInstance: Instance<TDataContent> | undefined,
): void {
  const address: RuntimeAddress = { type: "instance", instanceId: instance.id };
  const projectionNode: ProjectionNode<TDataContent> = {
    node: instance.node,
    instance,
    concreteInstance: instance,
    sourceInstance: instance.isSource ? instance : sourceInstance,
    address,
    runtimeInstanceId: encodeRuntimeAddress(address),
    memberPath: [],
    parent,
    isMember: false,
  };
  projectionNodes.push(projectionNode);
  collectDescendants(projectionNodes, projectionNode);
}

function collectDescendants<TDataContent>(
  projectionNodes: ProjectionNode<TDataContent>[],
  projectionNode: ProjectionNode<TDataContent>,
): void {
  for (const child of directProjectionNodeChildren(projectionNode)) {
    projectionNodes.push(child);
    collectDescendants(projectionNodes, child);
  }
}

export function assertUniqueInstanceIds(root: Instance<any>): void {
  const seen = new Set<string>();
  visitInstanceIds(root, seen);
}

function visitInstanceIds(instance: Instance<any>, seen: Set<string>): void {
  if (seen.has(instance.id)) {
    throw new Error(`Duplicate instance id "${instance.id}"`);
  }
  seen.add(instance.id);
  for (const child of instance.children ?? []) {
    visitInstanceIds(child, seen);
  }
}
