import { encodeRuntimeAddress } from "./runtime-address.ts";
import type { Instance, Node, RuntimeAddress } from "./types.ts";

export type SyntheticRoot = {
  type: "synthetic-root";
  instances: Instance[];
};

export type ProjectionFrame = {
  node: Node;
  instance: Instance;
  concreteInstance: Instance;
  topInstance: Instance;
  address: RuntimeAddress;
  runtimeInstanceId: string;
  memberPath: string[];
  parent?: ProjectionFrame;
  isMember: boolean;
};

export function createRoot(instances: Instance[]): SyntheticRoot {
  return { type: "synthetic-root", instances };
}

export function traversalFrames(root: SyntheticRoot | Instance): ProjectionFrame[] {
  const frames: ProjectionFrame[] = [];
  const instances = isSyntheticRoot(root) ? root.instances : [root];

  for (const instance of instances) {
    collectInstanceFrame(frames, instance, undefined, instance);
  }

  return frames;
}

export function collectProjectionFrames(root: SyntheticRoot | Instance): ProjectionFrame[] {
  return traversalFrames(root);
}

export function findFrameByRuntimeId(
  root: SyntheticRoot | Instance,
  runtimeInstanceId: string,
): ProjectionFrame | undefined {
  return traversalFrames(root).find((frame) => frame.runtimeInstanceId === runtimeInstanceId);
}

export function directProjectionChildren(frame: ProjectionFrame): ProjectionFrame[] {
  const children: ProjectionFrame[] = [];

  for (const member of frame.node.members) {
    const memberPath = [...frame.memberPath, member.key];
    const address: RuntimeAddress = {
      type: "member",
      ownerInstanceId: frame.concreteInstance.id,
      memberPath,
    };
    const memberFrame: ProjectionFrame = {
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

function collectInstanceFrame(
  frames: ProjectionFrame[],
  instance: Instance,
  parent: ProjectionFrame | undefined,
  topInstance: Instance,
): void {
  const address: RuntimeAddress = { type: "instance", instanceId: instance.id };
  const frame: ProjectionFrame = {
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

function collectDescendants(frames: ProjectionFrame[], frame: ProjectionFrame): void {
  for (const child of directProjectionChildren(frame)) {
    frames.push(child);
    collectDescendants(frames, child);
  }
}

function isSyntheticRoot(root: SyntheticRoot | Instance): root is SyntheticRoot {
  return "type" in root && root.type === "synthetic-root";
}
