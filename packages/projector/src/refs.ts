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

export function parseRef(refValue: string): { key: string } {
  if (!refValue) {
    throw new Error("Malformed empty ref");
  }
  return { key: refValue };
}

export function hydrateRef(refValue: Ref, charter: Charter): unknown {
  return (
    charter.nodes[refValue] ??
    charter.tools[refValue] ??
    charter.commands[refValue] ??
    charter.states[refValue] ??
    charter.projections[refValue] ??
    charter.historyProjections?.[refValue] ??
    missingRef(refValue)
  );
}

export function hydrateNodeRef(refValue: Ref, charter: Charter): Node {
  return expectRegistryValue(charter.nodes[refValue], refValue, "node");
}

export function hydrateToolRef(refValue: Ref, charter: Charter): AnyAction {
  return expectRegistryValue(charter.tools[refValue], refValue, "tool");
}

export function hydrateCommandRef(refValue: Ref, charter: Charter): AnyAction {
  return expectRegistryValue(charter.commands[refValue], refValue, "command");
}

export function hydrateStateRef(
  refValue: Ref,
  charter: Charter,
): NormalizedStateDescriptor {
  return expectRegistryValue(charter.states[refValue], refValue, "state");
}

export function hydrateProjectionRef(
  refValue: Ref,
  charter: Charter,
): ProjectionFunction {
  return expectRegistryValue(charter.projections[refValue], refValue, "projection");
}

export function hydrateHistoryProjectionRef(
  refValue: Ref,
  charter: Charter,
): HistoryProjectionFunction {
  return expectRegistryValue(
    charter.historyProjections?.[refValue],
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

function missingRef(refValue: string): never {
  throw new Error(`Unknown ref "${refValue}"`);
}
