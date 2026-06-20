import type {
  AnyAction,
  Charter,
  HistoryProjectionFunction,
  Node,
  NormalizedStateDescriptor,
  ProjectionFunction,
  Ref,
} from "./types.ts";

export function ref(value: string): Ref {
  return value;
}

export function hydrateNodeRef<TDataContent>(
  refValue: Ref,
  charter: Charter<TDataContent>,
): Node<TDataContent> {
  return expectRegistryValue(charter.nodes[refValue], refValue, "node");
}

export function hydrateToolRef(refValue: Ref, charter: Pick<Charter, "tools">): AnyAction {
  return expectRegistryValue(charter.tools[refValue], refValue, "tool");
}

export function hydrateCommandRef(refValue: Ref, charter: Pick<Charter, "commands">): AnyAction {
  return expectRegistryValue(charter.commands[refValue], refValue, "command");
}

export function hydrateStateRef(
  refValue: Ref,
  charter: Pick<Charter, "states">,
): NormalizedStateDescriptor {
  return expectRegistryValue(charter.states[refValue], refValue, "state");
}

export function hydrateProjectionRef<TDataContent>(
  refValue: Ref,
  charter: Charter<TDataContent>,
): ProjectionFunction<TDataContent> {
  return expectRegistryValue(
    charter.projections[refValue],
    refValue,
    "projection",
  );
}

export function hydrateHistoryProjectionRef<TDataContent>(
  refValue: Ref,
  charter: Charter<TDataContent>,
): HistoryProjectionFunction<TDataContent> {
  return expectRegistryValue(
    charter.historyProjections[refValue],
    refValue,
    "history projection",
  );
}

function expectRegistryValue<T>(
  value: T | undefined,
  refValue: string,
  kind: string,
): T {
  if (!value) {
    throw new Error(`Unknown ${kind} ref "${refValue}"`);
  }
  return value;
}
