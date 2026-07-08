import type {
  AnyAction,
  Charter,
  Node,
  NormalizedStateDescriptor,
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

export function hydrateActionRef(refValue: Ref, charter: Pick<Charter, "actions">): AnyAction {
  return expectRegistryValue(charter.actions[refValue], refValue, "action");
}

export function hydrateStateRef(
  refValue: Ref,
  charter: Pick<Charter, "states">,
): NormalizedStateDescriptor {
  return expectRegistryValue(charter.states[refValue], refValue, "state");
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
