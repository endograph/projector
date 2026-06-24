import type { Contributor } from "./contributors.ts";
import type { ActionKind, AnyAction, Charter, Node } from "./types.ts";

export function resolveFrameTools<TDataContent>(
  contributor: Contributor<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction[] {
  return contributor.node.toolRefs.map((name) =>
    resolveScopedAction(contributor, name, "tool", charter)
  );
}

export function resolveFrameCommands<TDataContent>(
  contributor: Contributor<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): AnyAction[] {
  return contributor.node.commandRefs.map((name) =>
    resolveScopedAction(contributor, name, "command", charter)
  );
}

export function resolveScopedAction<TDataContent>(
  contributor: Contributor<TDataContent>,
  name: string,
  kind: ActionKind,
  charter: Charter<TDataContent> | undefined,
): AnyAction {
  const selfBinding = actionBinding(contributor.node, name, kind);
  if (selfBinding) {
    return selfBinding;
  }

  const sourceNode = contributor.node.sourceNodeKey
    ? charter?.nodes[contributor.node.sourceNodeKey]
    : undefined;
  const sourceBinding = sourceNode ? actionBinding(sourceNode, name, kind) : undefined;
  if (sourceBinding) {
    return sourceBinding;
  }

  const fallback = kind === "tool" ? charter?.tools[name] : charter?.commands[name];
  if (fallback) {
    return fallback;
  }

  throw new Error(`Unknown ${kind} ref "${name}" for node "${contributor.node.key}"`);
}

function actionBinding(
  node: Node<any>,
  name: string,
  kind: ActionKind,
): AnyAction | undefined {
  return kind === "tool" ? node.toolBindings[name] : node.commandBindings[name];
}
