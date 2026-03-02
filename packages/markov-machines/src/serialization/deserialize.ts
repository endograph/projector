import type { Charter } from "../types/charter";
import type {
  Machine,
  OnMessageEnqueue,
  SerializedMachine,
  SerializedInstance,
  SerialPackInstance,
} from "../types/machine";
import type { Instance } from "../types/instance";
import type { MachineMessage } from "../types/messages";
import type { Pack } from "../types/pack";
import type { Ref, SerialPack } from "../types/refs";
import { isEphemeralMessage } from "../types/messages";
import { isRef } from "../types/refs";
import { resolveNodeRef } from "../runtime/transition-executor";
import { createExternalizeRuntime } from "../runtime/externalize-manager";
export { deserializeNode } from "../runtime/transition-executor";

/**
 * Deserialize a pack from Ref or SerialPack.
 * For Refs, looks up the pack in the charter.
 * For inline SerialPack, merges with charter pack to get tools/commands.
 */
function deserializePack(
  charter: Charter,
  serialPack: Ref | SerialPack,
): Pack {
  if (isRef(serialPack)) {
    const pack = charter.packs?.find((p) => p.name === serialPack.ref);
    if (!pack) {
      throw new Error(`Pack not found in charter: ${serialPack.ref}`);
    }
    return pack;
  }

  // Inline SerialPack - need to merge with charter pack for tools/commands
  const charterPack = charter.packs?.find((p) => p.name === serialPack.name);
  if (!charterPack) {
    throw new Error(`Pack not found in charter for inline merge: ${serialPack.name}`);
  }

  // Create a modified pack that uses the serialized metadata but charter's tools/commands
  return {
    name: serialPack.name,
    description: serialPack.description,
    instructions: serialPack.instructions,
    validator: charterPack.validator, // Use charter's validator (Zod schema)
    tools: charterPack.tools, // Tools come from charter (have execute functions)
    commands: charterPack.commands, // Commands come from charter (have execute functions)
    externalize: charterPack.externalize,
    initialState: serialPack.initialState ?? charterPack.initialState,
  };
}

/**
 * Convert packInstances to packStates and deserialized packs.
 * Packs are deserialized with their actual instructions (which may differ from charter if edited).
 */
function deserializePackInstances(
  charter: Charter,
  packInstances: SerialPackInstance[],
): { packStates: Record<string, unknown>; packs: Pack[] } {
  const packStates: Record<string, unknown> = {};
  const packs: Pack[] = [];

  for (const packInstance of packInstances) {
    const pack = deserializePack(charter, packInstance.pack);
    packs.push(pack);
    packStates[pack.name] = packInstance.state;
  }

  return { packStates, packs };
}

/**
 * Deserialize a node instance from persisted state.
 */
export function deserializeInstance(
  charter: Charter<any>,
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

  // Convert packInstances to packStates and deserialized packs
  let packStates: Record<string, unknown> | undefined;
  let packs: Pack[] | undefined;
  if (serialized.packInstances && serialized.packInstances.length > 0) {
    const result = deserializePackInstances(charter, serialized.packInstances);
    packStates = result.packStates;
    if (result.packs.length > 0) {
      packs = result.packs;
    }
  }

  return {
    id: serialized.id,
    node,
    state: stateResult.data,
    children,
    ...(packStates && Object.keys(packStates).length > 0 ? { packStates } : {}),
    ...(packs && packs.length > 0 ? { packs } : {}),
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
export function deserializeMachine<AppMessage = unknown>(
  charter: Charter<AppMessage>,
  serialized: SerializedMachine<AppMessage>,
  options?: {
    onMessageEnqueue?: OnMessageEnqueue<AppMessage>;
  },
): Machine<AppMessage> {
  const queue: MachineMessage<AppMessage>[] = [];
  const onMessageEnqueue = options?.onMessageEnqueue;

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
    if (queue.some((m) => !isEphemeralMessage(m))) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queueResolvers.push(resolve);
    });
  };

  const machine: Machine<AppMessage> = {
    charter,
    instance: deserializeInstance(charter, serialized.instance),
    history: serialized.history,
    queue,
    enqueue: (messages: MachineMessage<AppMessage>[]) => {
      for (const message of messages) {
        const messageId = message.metadata?.messageId;
        if (messageId) {
          const existingIndex = queue.findIndex((m) => m.metadata?.messageId === messageId);
          if (existingIndex !== -1) {
            queue[existingIndex] = message;
          } else {
            queue.push(message);
          }
        } else {
          queue.push(message);
        }

        if (onMessageEnqueue && !isEphemeralMessage(message)) {
          onMessageEnqueue(message);
        }
      }
      if (messages.some((m) => !isEphemeralMessage(m))) {
        notifyQueue();
      }
    },
    waitForQueue,
    notifyQueue,
  };

  machine.externalize = createExternalizeRuntime(machine);
  machine.externalize.syncRegistrations();

  return machine;
}
