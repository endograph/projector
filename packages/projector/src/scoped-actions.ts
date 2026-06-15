import type { ProjectionFrame } from "./frames.ts";
import type { AnyAction, Charter, Node } from "./types.ts";

export type ActionKind = "tool" | "command";

export function resolveFrameTools(
  frame: ProjectionFrame,
  charter: Charter | undefined,
): AnyAction[] {
  return frame.node.toolRefs.map((name) =>
    resolveScopedAction(frame, name, "tool", charter)
  );
}

export function resolveFrameCommands(
  frame: ProjectionFrame,
  charter: Charter | undefined,
): AnyAction[] {
  return frame.node.commandRefs.map((name) =>
    resolveScopedAction(frame, name, "command", charter)
  );
}

export function resolveScopedAction(
  frame: ProjectionFrame,
  name: string,
  kind: ActionKind,
  charter: Charter | undefined,
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
  node: Node,
  name: string,
  kind: ActionKind,
): AnyAction | undefined {
  return kind === "tool" ? node.toolBindings[name] : node.commandBindings[name];
}
