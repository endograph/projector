import type { Charter } from "../types/charter.js";
import type {
  Machine,
  SerializedMachine,
  SerializedInstance,
} from "../types/machine.js";
import type { Instance } from "../types/instance.js";
import { resolveNodeRef } from "../runtime/transition-executor.js";
export { deserializeNode } from "../runtime/transition-executor.js";

/**
 * Deserialize a node instance from persisted state.
 */
export function deserializeInstance(
  charter: Charter,
  serialized: SerializedInstance,
): Instance {
  // Resolve node
  const node = resolveNodeRef(charter, serialized.node);

  // Validate state against the node's validator
  const stateResult = node.validator.safeParse(serialized.state);
  if (!stateResult.success) {
    throw new Error(`Invalid state: ${stateResult.error.message}`);
  }

  // Recursively deserialize children
  let children: Instance[] | undefined;
  if (serialized.children && serialized.children.length > 0) {
    children = serialized.children.map((c) => deserializeInstance(charter, c));
  }

  return {
    id: serialized.id,
    node,
    state: stateResult.data,
    children,
    ...(serialized.packStates ? { packStates: serialized.packStates } : {}),
    ...(serialized.executorConfig ? { executorConfig: serialized.executorConfig } : {}),
    ...(serialized.suspended ? {
      suspended: {
        suspendId: serialized.suspended.suspendId,
        reason: serialized.suspended.reason,
        suspendedAt: new Date(serialized.suspended.suspendedAt),
        metadata: serialized.suspended.metadata,
      }
    } : {}),
  };
}

/**
 * Deserialize a machine from persisted state.
 * The charter must be the same (or compatible) as when serialized.
 */
export function deserializeMachine(
  charter: Charter,
  serialized: SerializedMachine,
): Machine {
  return {
    charter,
    instance: deserializeInstance(charter, serialized.instance),
    history: serialized.history,
  };
}
