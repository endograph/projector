import { v4 as uuid } from "uuid";
import type { Charter } from "../types/charter.js";
import type { Machine, MachineConfig } from "../types/machine.js";
import type { Instance } from "../types/instance.js";
import type { Pack } from "../types/pack.js";
import type { MachineMessage } from "../types/messages.js";

/**
 * Validate a node instance tree recursively.
 * Ensures all states are valid according to their node validators.
 * Also ensures all instances have IDs (returns a new instance if ID was missing).
 */
function validateInstance(instance: Instance): Instance {
  // Ensure instance has ID (immutably)
  const withId = instance.id ? instance : { ...instance, id: uuid() };

  // Validate this instance's state
  const stateResult = withId.node.validator.safeParse(withId.state);
  if (!stateResult.success) {
    throw new Error(
      `Invalid state for node "${withId.node.id}": ${stateResult.error.message}`,
    );
  }

  // Recursively validate children
  if (withId.children) {
    const validatedChildren = withId.children.map(child => validateInstance(child));
    // Only create new object if children changed
    const childrenChanged = validatedChildren.some((c, i) => c !== withId.children![i]);
    if (childrenChanged) {
      return { ...withId, children: validatedChildren };
    }
  }

  return withId;
}

/**
 * Initialize pack states for all packs in the charter.
 * Uses initialState from each pack if defined.
 */
function initializePackStates(charter: Charter<any>): Record<string, unknown> {
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
  pack: Pack<any>,
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
export function createMachine<AppMessage = unknown>(
  charter: Charter<AppMessage>,
  config: MachineConfig<AppMessage>,
): Machine<AppMessage> {
  const { instance: inputInstance, history = [], onMessageEnqueue } = config;

  // Initialize pack states on root instance if not present (immutably)
  const instance =
    !inputInstance.packStates && charter.packs.length > 0
      ? { ...inputInstance, packStates: initializePackStates(charter) }
      : inputInstance;

  // Validate the entire instance tree (may return new instance with generated IDs)
  const validatedInstance = validateInstance(instance);

  // Create mutable queue for enqueuing messages
  const queue: MachineMessage<AppMessage>[] = [];

  // Queue notification system for waitForQueue
  let queueResolvers: Array<() => void> = [];

  const notifyQueue = () => {
    const resolvers = queueResolvers;
    queueResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  };

  const waitForQueue = (): Promise<void> => {
    if (queue.length > 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queueResolvers.push(resolve);
    });
  };

  return {
    charter,
    instance: validatedInstance,
    history,
    queue,
    enqueue: (messages: MachineMessage<AppMessage>[]) => {
      queue.push(...messages);
      // Call onMessageEnqueue for each message
      if (onMessageEnqueue) {
        for (const message of messages) {
          onMessageEnqueue(message);
        }
      }
      notifyQueue();
    },
    waitForQueue,
    notifyQueue,
  };
}
