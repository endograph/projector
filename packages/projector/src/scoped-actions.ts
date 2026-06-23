import type { ProjectionNode } from "./projection-nodes.ts";
import type { AnyAction, Charter, Node } from "./types.ts";

export type ActionKind = "tool" | "command";

export function resolveFrameTools<TDataContent>(
  projectionNode: ProjectionNode<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction[] {
  return projectionNode.node.toolRefs.map((name) =>
    resolveScopedAction(projectionNode, name, "tool", charter)
  );
}

export function resolveFrameCommands<TDataContent>(
  projectionNode: ProjectionNode<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction[] {
  return projectionNode.node.commandRefs.map((name) =>
    resolveScopedAction(projectionNode, name, "command", charter)
  );
}

export function resolveScopedAction<TDataContent>(
  projectionNode: ProjectionNode<TDataContent>,
  name: string,
  kind: ActionKind,
  charter: Charter<TDataContent> | undefined,
): AnyAction {
  const selfBinding = actionBinding(projectionNode.node, name, kind);
  if (selfBinding) {
    return selfBinding;
  }

  const sourceNode = projectionNode.node.sourceNodeKey
    ? charter?.nodes[projectionNode.node.sourceNodeKey]
    : undefined;
  const sourceBinding = sourceNode ? actionBinding(sourceNode, name, kind) : undefined;
  if (sourceBinding) {
    return sourceBinding;
  }

  const fallback = kind === "tool" ? charter?.tools[name] : charter?.commands[name];
  if (fallback) {
    return fallback;
  }

  throw new Error(`Unknown ${kind} ref "${name}" for node "${projectionNode.node.key}"`);
}

function actionBinding(
  node: Node<any>,
  name: string,
  kind: ActionKind,
): AnyAction | undefined {
  return kind === "tool" ? node.toolBindings[name] : node.commandBindings[name];
}
