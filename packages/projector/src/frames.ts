import { createNode } from "./create.ts";
import { encodeRuntimeAddress } from "./runtime-address.ts";
import { ROOT_INSTANCE_ID } from "./runtime-address.ts";
import type {
  Instance,
  Node,
  RuntimeAddress,
} from "./types.ts";

export type ProjectionFrame<TDataContent = never> = {
  node: Node<TDataContent>;
  instance: Instance<TDataContent>;
  concreteInstance: Instance<TDataContent>;
  topInstance: Instance<TDataContent>;
  address: RuntimeAddress;
  runtimeInstanceId: string;
  memberPath: string[];
  parent?: ProjectionFrame<TDataContent>;
  isMember: boolean;
};

const rootNode = createNode({
  key: "root",
  name: "Root",
  stateless: true,
  runtime: {
    type: "primary",
    trigger: { type: "actor-frame" },
  },
  projection: { mode: "hidden" },
});

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

export function traversalFrames<TDataContent = never>(
  root: Instance<TDataContent>,
): ProjectionFrame<TDataContent>[] {
  const frames: ProjectionFrame<TDataContent>[] = [];
  collectInstanceFrame(frames, root, undefined, root);
  return frames;
}

export function collectProjectionFrames<TDataContent = never>(
  root: Instance<TDataContent>,
): ProjectionFrame<TDataContent>[] {
  return traversalFrames(root);
}

export function findFrameByRuntimeId<TDataContent = never>(
  root: Instance<TDataContent>,
  runtimeInstanceId: string,
): ProjectionFrame<TDataContent> | undefined {
  return traversalFrames(root).find((frame) => frame.runtimeInstanceId === runtimeInstanceId);
}

export function directProjectionChildren<TDataContent = never>(
  frame: ProjectionFrame<TDataContent>,
): ProjectionFrame<TDataContent>[] {
  const children: ProjectionFrame<TDataContent>[] = [];

  for (const member of frame.node.members) {
    const memberPath = [...frame.memberPath, member.key];
    const address: RuntimeAddress = {
      type: "member",
      ownerInstanceId: frame.concreteInstance.id,
      memberPath,
    };
    const memberFrame: ProjectionFrame<TDataContent> = {
      node: member,
      instance: frame.concreteInstance,
      concreteInstance: frame.concreteInstance,
      topInstance: frame.topInstance,
      address,
      runtimeInstanceId: encodeRuntimeAddress(address),
      memberPath,
      parent: frame,
      isMember: true,
    };
    children.push(memberFrame);
  }

  if (!frame.isMember) {
    for (const child of frame.instance.children ?? []) {
      const childAddress: RuntimeAddress = { type: "instance", instanceId: child.id };
      children.push({
        node: child.node,
        instance: child,
        concreteInstance: child,
        topInstance: frame.topInstance,
        address: childAddress,
        runtimeInstanceId: encodeRuntimeAddress(childAddress),
        memberPath: [],
        parent: frame,
        isMember: false,
      });
    }
  }

  return children;
}

export function topStateInstance<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
): Instance<TDataContent> {
  let current = frame;
  let target = frame.concreteInstance;

  while (current.parent && !current.parent.node.stateless) {
    current = current.parent;
    target = current.concreteInstance;
  }

  if (target.node.stateless) {
    throw new Error(`Cannot resolve top state for stateless instance "${target.id}"`);
  }

  return target;
}

function collectInstanceFrame<TDataContent>(
  frames: ProjectionFrame<TDataContent>[],
  instance: Instance<TDataContent>,
  parent: ProjectionFrame<TDataContent> | undefined,
  topInstance: Instance<TDataContent>,
): void {
  const address: RuntimeAddress = { type: "instance", instanceId: instance.id };
  const frame: ProjectionFrame<TDataContent> = {
    node: instance.node,
    instance,
    concreteInstance: instance,
    topInstance,
    address,
    runtimeInstanceId: encodeRuntimeAddress(address),
    memberPath: [],
    parent,
    isMember: false,
  };
  frames.push(frame);
  collectDescendants(frames, frame);
}

function collectDescendants<TDataContent>(
  frames: ProjectionFrame<TDataContent>[],
  frame: ProjectionFrame<TDataContent>,
): void {
  for (const child of directProjectionChildren(frame)) {
    frames.push(child);
    collectDescendants(frames, child);
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
