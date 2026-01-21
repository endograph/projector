import { v4 as uuid } from "uuid";
import type { Charter } from "../types/charter.js";
import type { Machine, MachineConfig } from "../types/machine.js";
import type { Instance } from "../types/instance.js";
import type { Pack } from "../types/pack.js";

/**
 * Validate a node instance tree recursively.
 * Ensures all states are valid according to their node validators.
 * Also ensures all instances have IDs.
 */
function validateInstance(instance: Instance): void {
  // Ensure instance has ID
  if (!instance.id) {
    (instance as { id: string }).id = uuid();
  }

  // Validate this instance's state
  const stateResult = instance.node.validator.safeParse(instance.state);
  if (!stateResult.success) {
    throw new Error(
      `Invalid state for node "${instance.node.id}": ${stateResult.error.message}`,
    );
  }

  // Recursively validate children
  if (instance.children) {
    for (const child of instance.children) {
      validateInstance(child);
    }
  }
}

/**
 * Initialize pack states for all packs in the charter.
 * Uses initialState from each pack if defined.
 */
function initializePackStates(charter: Charter): Record<string, unknown> {
  const packStates: Record<string, unknown> = {};
  for (const pack of charter.packs) {
    packStates[pack.name] = pack.initialState;
  }
  return packStates;
}

/**
 * Get pack state, lazily initializing if not present.
 * Mutates packStates by adding the initialized state.
 */
export function getOrInitPackState(
  packStates: Record<string, unknown>,
  pack: Pack<unknown>,
): unknown {
  if (!(pack.name in packStates)) {
    packStates[pack.name] = pack.initialState;
  }
  return packStates[pack.name];
}

/**
 * Create a new machine instance.
 * Validates all states in the instance tree.
 * Initializes pack states on root instance if not present.
 */
export function createMachine(charter: Charter, config: MachineConfig): Machine {
  const { instance: inputInstance, history = [] } = config;

  // Initialize pack states on root instance if not present (immutably)
  const instance =
    !inputInstance.packStates && charter.packs.length > 0
      ? { ...inputInstance, packStates: initializePackStates(charter) }
      : inputInstance;

  // Validate the entire instance tree
  validateInstance(instance);

  return {
    charter,
    instance,
    history,
  };
}
