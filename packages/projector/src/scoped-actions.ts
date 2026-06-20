import type { ProjectionFrame } from "./frames.ts";
import type { AnyAction, Charter, Node } from "./types.ts";

export type ActionKind = "tool" | "command";

export function resolveFrameTools<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction[] {
  return frame.node.toolRefs.map((name) =>
    resolveScopedAction(frame, name, "tool", charter)
  );
}

export function resolveFrameCommands<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction[] {
  return frame.node.commandRefs.map((name) =>
    resolveScopedAction(frame, name, "command", charter)
  );
}

export function resolveScopedAction<TDataContent>(
  frame: ProjectionFrame<TDataContent>,
  name: string,
  kind: ActionKind,
  charter: Charter<TDataContent> | undefined,
): AnyAction {
  const selfBinding = actionBinding(frame.node, name, kind);
  if (selfBinding) {
    return selfBinding;
  }

  const sourceNode = frame.node.sourceNodeKey
    ? charter?.nodes[frame.node.sourceNodeKey]
    : undefined;
  const sourceBinding = sourceNode ? actionBinding(sourceNode, name, kind) : undefined;
  if (sourceBinding) {
    return sourceBinding;
  }

  const fallback = kind === "tool" ? charter?.tools[name] : charter?.commands[name];
  if (fallback) {
    return fallback;
  }

  throw new Error(`Unknown ${kind} ref "${name}" for node "${frame.node.key}"`);
}

function actionBinding(
  node: Node<any>,
  name: string,
  kind: ActionKind,
): AnyAction | undefined {
  return kind === "tool" ? node.toolBindings[name] : node.commandBindings[name];
}
