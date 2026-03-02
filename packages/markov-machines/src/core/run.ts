import type { Machine } from "../types/machine";
import type { RunOptions, MachineStep, RunResult, SuspendedInstanceInfo } from "../executor/types";
import type { Instance, ActiveLeafInfo } from "../types/instance";
import type { Resume } from "../types/commands";
import type {
  MachineMessage,
  InstanceMessage,
  ConversationMessage,
  EphemeralMessage,
  InstancePayload,
  ImageBlock,
  TextBlock,
} from "../types/messages";
import type { ExternalStateMutationEvent } from "../types/externalize";
import type { YieldReason } from "../executor/types";
import type { Charter } from "../types/charter";
import type { Pack } from "../types/pack";
import type { Tracer, Span } from "../types/tracer";
import { getActiveLeaves, isWorkerInstance, getSuspendedInstances, findInstanceById, clearSuspension, createInstance } from "../types/instance";
import { userMessage, isInstanceMessage, isEphemeralMessage } from "../types/messages";
import { isResume } from "../types/commands";
import { serializeNode } from "../serialization/serialize";
import { getOrInitPackState } from "./machine";


/** Check if packStates has any entries */
const hasPackStates = (ps?: Record<string, unknown>): boolean =>
  ps !== undefined && Object.keys(ps).length > 0;

/**
 * Hoist packs from a node to the root instance.
 * Adds any new packs to instance.packs and initializes their states in packStates.
 * This is called lazily when nodes with packs are discovered via transition or spawn.
 */
function hoistPacksToRoot<AppMessage>(
  machine: Machine<AppMessage>,
  newPacks: Pack[] | undefined,
): void {
  if (!newPacks || newPacks.length === 0) return;

  const existingPacks = machine.instance.packs ?? [];
  const existingPackNames = new Set(existingPacks.map(p => p.name));

  const packsToAdd = newPacks.filter(p => !existingPackNames.has(p.name));
  if (packsToAdd.length === 0) return;

  // Ensure packStates exists
  const packStates = machine.instance.packStates ?? {};

  // Initialize state for new packs
  for (const pack of packsToAdd) {
    getOrInitPackState(packStates, pack);
  }

  machine.instance = {
    ...machine.instance,
    packs: [...existingPacks, ...packsToAdd],
    packStates,
  };
}

// ============================================================================
// Parallel Execution Helpers
// ============================================================================

/**
 * Result from a single leaf execution.
 * With the new message-passing flow, the executor enqueues messages directly
 * and returns only the yield reason.
 */
export interface LeafResult {
  /** Index path to this leaf in the tree */
  leafIndex: number[];
  /** Whether this is a worker instance */
  isWorker: boolean;
  /** Instance ID for attribution */
  instanceId: string;
  /** Why this leaf yielded */
  yieldReason: YieldReason;
}

/**
 * Update a leaf instance at the given index path.
 */
function updateLeafAtIndex(
  root: Instance,
  indices: number[],
  updater: (leaf: Instance) => Instance,
): Instance {
  if (indices.length === 0) return updater(root);

  const [head, ...rest] = indices;
  const children = root.children ?? [];
  const updated = children.map((c, i) => i === head ? updateLeafAtIndex(c, rest, updater) : c);

  return {
    ...root,
    children: updated.length === 0 ? undefined : updated,
  };
}

/**
 * Remove a leaf instance at the given index path.
 */
function removeLeafAtIndex(root: Instance, indices: number[]): Instance {
  const children = root.children ?? [];

  if (indices.length === 1) {
    const [idx] = indices;
    const filtered = children.filter((_, i) => i !== idx);
    return {
      ...root,
      children: filtered.length === 0 ? undefined : filtered,
    };
  }

  const [head, ...rest] = indices;
  const updated = children.map((c, i) => i === head ? removeLeafAtIndex(c, rest) : c);

  return {
    ...root,
    children: updated.length === 0 ? undefined : updated,
  };
}

/**
 * Update an instance in the tree by ID.
 */
function updateInstanceById(
  root: Instance,
  targetId: string,
  updater: (inst: Instance) => Instance,
): Instance {
  if (root.id === targetId) {
    return updater(root);
  }

  const children = root.children;
  if (!children || children.length === 0) {
    return root;
  }

  return {
    ...root,
    children: children.map((c) => updateInstanceById(c, targetId, updater)),
  };
}

/**
 * Remove an instance from the tree by ID.
 * Returns the updated tree, or the original if not found.
 */
function removeInstanceById(root: Instance, targetId: string): Instance {
  // Can't remove root
  if (root.id === targetId) {
    console.warn(`[removeInstanceById] Cannot remove root instance ${targetId}`);
    return root;
  }

  const children = root.children;
  if (!children || children.length === 0) {
    return root;
  }

  // Check if any direct child matches
  const filtered = children.filter((c) => c.id !== targetId);
  if (filtered.length !== children.length) {
    // Found and removed
    return {
      ...root,
      children: filtered.length === 0 ? undefined : filtered,
    };
  }

  // Recurse into children
  return {
    ...root,
    children: children.map((c) => removeInstanceById(c, targetId)),
  };
}

// ============================================================================
// Queue Drain & Apply Logic
// ============================================================================

/**
 * Result of draining the queue.
 */
export interface DrainResult<AppMessage = unknown> {
  /** All drained messages in original queue order */
  ordered: MachineMessage<AppMessage>[];
  /** Instance mutation messages (applied to machine.instance) */
  instanceMessages: InstanceMessage<AppMessage>[];
  /** Conversation messages (user, assistant, system, command) for history */
  conversationMessages: ConversationMessage<AppMessage>[];
  /** Ephemeral messages (role: "ephemeral") */
  ephemeralMessages: EphemeralMessage<AppMessage>[];
}

export interface DrainOptions {
  /** When false, ephemeral messages remain in the machine queue. Defaults to true. */
  includeEphemeral?: boolean;
}

/**
 * Drain all messages from the machine queue into categorized buckets.
 * This empties the queue and returns messages partitioned by type.
 */
export function drainQueue<AppMessage = unknown>(
  machine: Machine<AppMessage>,
  options?: DrainOptions,
): DrainResult<AppMessage> {
  const includeEphemeral = options?.includeEphemeral !== false;

  let messages: MachineMessage<AppMessage>[];
  if (includeEphemeral) {
    messages = machine.queue.splice(0, machine.queue.length);
  } else {
    const drained: MachineMessage<AppMessage>[] = [];
    const remaining: MachineMessage<AppMessage>[] = [];
    for (const msg of machine.queue) {
      if (isEphemeralMessage(msg)) {
        remaining.push(msg);
      } else {
        drained.push(msg);
      }
    }
    machine.queue.splice(0, machine.queue.length, ...remaining);
    messages = drained;
  }

  const instanceMessages: InstanceMessage<AppMessage>[] = [];
  const conversationMessages: ConversationMessage<AppMessage>[] = [];
  const ephemeralMessages: EphemeralMessage<AppMessage>[] = [];

  for (const msg of messages) {
    if (isInstanceMessage(msg)) {
      instanceMessages.push(msg);
    } else if (isEphemeralMessage(msg)) {
      ephemeralMessages.push(msg);
    } else {
      // user, assistant, system, command - all go to conversation history
      conversationMessages.push(msg as ConversationMessage<AppMessage>);
    }
  }

  return { ordered: messages, instanceMessages, conversationMessages, ephemeralMessages };
}

/**
 * Serialize Node references in instance messages to Ref/SerialNode for history persistence.
 * Transition and spawn payloads contain live Node objects with functions/validators
 * that are not serializable. This replaces them with charter refs.
 */
function serializeInstanceMessageForHistory<AppMessage>(
  msg: InstanceMessage<AppMessage>,
  charter?: Charter<AppMessage>,
): InstanceMessage<AppMessage> {
  const payload = msg.items;
  switch (payload.kind) {
    case "transition":
      return {
        ...msg,
        items: {
          ...payload,
          node: serializeNode(payload.node, charter) as any,
        },
      };
    case "spawn":
      return {
        ...msg,
        items: {
          ...payload,
          children: payload.children.map(c => ({
            ...c,
            node: serializeNode(c.node, charter) as any,
          })),
        },
      };
    default:
      return msg;
  }
}

/**
 * Build step history from ordered drain output.
 * - Non-ephemeral messages pass through in order.
 * - Non-singleton ephemerals pass through in order.
 * - Singleton ephemerals collapse: only the last message per singleton key is kept,
 *   annotated with singletonFrameCount.
 * - Instance messages have Node references serialized for persistence.
 */
function buildStepHistory<AppMessage = unknown>(
  ordered: MachineMessage<AppMessage>[],
  charter?: Charter<AppMessage>,
): MachineMessage<AppMessage>[] {
  // First pass: find last index and count for each singleton key
  const lastIndexBySingleton = new Map<string, number>();
  const countBySingleton = new Map<string, number>();

  for (let i = 0; i < ordered.length; i++) {
    const msg = ordered[i]!;
    if (!isEphemeralMessage(msg)) continue;
    const singleton = msg.metadata?.singleton;
    if (!singleton) continue;
    lastIndexBySingleton.set(singleton, i);
    countBySingleton.set(singleton, (countBySingleton.get(singleton) ?? 0) + 1);
  }

  // Second pass: build result, collapsing singleton ephemerals and serializing instance messages
  const result: MachineMessage<AppMessage>[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const msg = ordered[i]!;

    if (isInstanceMessage(msg)) {
      result.push(serializeInstanceMessageForHistory(msg, charter));
      continue;
    }

    if (isEphemeralMessage(msg)) {
      const singleton = msg.metadata?.singleton;
      if (!singleton) {
        result.push(msg);
        continue;
      }
      // Only keep the last message for this singleton key
      if (lastIndexBySingleton.get(singleton) !== i) continue;
      const frameCount = countBySingleton.get(singleton) ?? 1;
      result.push({
        ...msg,
        metadata: {
          ...(msg.metadata ?? {}),
          singletonFrameCount: frameCount,
        },
      });
      continue;
    }

    result.push(msg);
  }

  return result;
}

/**
 * Convert ephemeral messages in history to model-friendly user messages.
 * Non-ephemeral messages pass through unchanged.
 */
function convertEphemeralsForModel<AppMessage = unknown>(
  history: MachineMessage<AppMessage>[],
): MachineMessage<AppMessage>[] {
  return history.flatMap((msg) => {
    if (!isEphemeralMessage(msg)) return msg;

    const items = msg.items;
    if (typeof items === "string") {
      return userMessage<AppMessage>(items, { silent: true });
    }

    const imageBlocks = items.filter(
      (b): b is ImageBlock => typeof b === "object" && b !== null && b.type === "image",
    );

    if (imageBlocks.length > 0) {
      const frameCount = msg.metadata?.singletonFrameCount ?? 1;
      const preamble: TextBlock = {
        type: "text",
        text: `[Camera frame] This is a snapshot from the user's live camera (not an uploaded file). Frames since last turn: ${frameCount}.`,
      };

      return imageBlocks.map((image) =>
        userMessage<AppMessage>([preamble, image], { silent: true }),
      );
    }

    return userMessage<AppMessage>(items, { silent: true });
  });
}

/**
 * Apply instance messages to the machine's instance tree.
 * Uses shallow merge for state updates, last-write-wins with warnings for duplicates.
 *
 * @param machine - The machine to update
 * @param instanceMessages - Instance messages to apply
 * @param stepNumber - Current step number for logging
 * @returns Object with hasCede flag and any cede contents
 */
export function applyInstanceMessages<AppMessage = unknown>(
  machine: Machine<AppMessage>,
  instanceMessages: InstanceMessage<AppMessage>[],
  stepNumber: number,
): {
  hasCede: boolean;
  cedeContents: Array<{ instanceId: string; content: string | MachineMessage<AppMessage>[] | undefined }>;
  stateMutations: ExternalStateMutationEvent<unknown, AppMessage>[];
} {
  // Track writes for duplicate detection
  const stateWrites = new Map<string, number>(); // instanceId -> write count
  const packStateWrites = new Map<string, number>(); // packName -> write count

  const cedeContents: Array<{ instanceId: string; content: string | MachineMessage<AppMessage>[] | undefined }> = [];
  const stateMutations: ExternalStateMutationEvent<unknown, AppMessage>[] = [];
  let hasCede = false;

  for (const msg of instanceMessages) {
    const payload = msg.items;

    switch (payload.kind) {
      case "state": {
        // Track duplicate writes
        const count = (stateWrites.get(payload.instanceId) ?? 0) + 1;
        stateWrites.set(payload.instanceId, count);
        if (count > 1) {
          console.warn(
            `[runMachine] Step ${stepNumber}: instanceId ${payload.instanceId} state updated ${count} times, last write wins`
          );
        }

        const externalMutation = machine.externalize?.consumeInstanceMessage(msg, stepNumber);
        if (externalMutation) {
          stateMutations.push(externalMutation);
          break;
        }

        // Shallow merge into instance state
        machine.instance = updateInstanceById(
          machine.instance,
          payload.instanceId,
          (inst) => ({
            ...inst,
            state: { ...(inst.state as Record<string, unknown>), ...payload.patch },
          }),
        );
        break;
      }

      case "packState": {
        // Track duplicate writes
        const count = (packStateWrites.get(payload.packName) ?? 0) + 1;
        packStateWrites.set(payload.packName, count);
        if (count > 1) {
          console.warn(
            `[runMachine] Step ${stepNumber}: packState ${payload.packName} updated ${count} times, last write wins`
          );
        }

        const externalMutation = machine.externalize?.consumeInstanceMessage(msg, stepNumber);
        if (externalMutation) {
          stateMutations.push(externalMutation);
          break;
        }

        // Shallow merge into pack state on root
        const currentPackStates = machine.instance.packStates ?? {};
        const currentPackState = currentPackStates[payload.packName] as Record<string, unknown> | undefined;
        machine.instance = {
          ...machine.instance,
          packStates: {
            ...currentPackStates,
            [payload.packName]: { ...currentPackState, ...payload.patch },
          },
        };
        break;
      }

      case "transition": {
        // Hoist packs from new node to root
        hoistPacksToRoot(machine, payload.node.packs);

        // Replace node/state, clear children
        machine.instance = updateInstanceById(
          machine.instance,
          payload.instanceId,
          (inst) => ({
            ...inst,
            node: payload.node,
            state: payload.state ?? payload.node.initialState,
            children: undefined,
            executorConfig: payload.executorConfig ?? payload.node.executorConfig,
          }),
        );
        break;
      }

      case "spawn": {
        // Hoist packs from all spawned nodes to root
        for (const { node } of payload.children) {
          hoistPacksToRoot(machine, node.packs);
        }

        // Add children to parent instance
        const newChildren = payload.children.map(({ node, state, executorConfig }) =>
          createInstance(
            node,
            state ?? node.initialState,
            undefined,
            undefined,
            executorConfig ?? node.executorConfig,
          ),
        );

        machine.instance = updateInstanceById(
          machine.instance,
          payload.parentInstanceId,
          (inst) => ({
            ...inst,
            children: [...(inst.children ?? []), ...newChildren],
          }),
        );
        break;
      }

      case "cede": {
        // Remove instance from tree
        machine.instance = removeInstanceById(machine.instance, payload.instanceId);
        cedeContents.push({ instanceId: payload.instanceId, content: payload.content });
        hasCede = true;
        break;
      }

      case "suspend": {
        // Mark instance as suspended
        machine.instance = updateInstanceById(
          machine.instance,
          payload.instanceId,
          (inst) => ({
            ...inst,
            suspended: payload.suspendInfo,
          }),
        );
        break;
      }
    }
  }

  machine.externalize?.syncRegistrations();

  return { hasCede, cedeContents, stateMutations };
}

/**
 * Run the machine by draining its queue and executing.
 * Yields MachineStep for each inference call or command execution.
 * Continues until there's a text response or max steps exceeded.
 *
 * Use machine.enqueue() to add messages before calling runMachine:
 * - Regular messages (user, assistant) are added to history and sent to the model
 * - Command messages are processed with higher precedence
 * - Instance messages describe mutations to the instance tree
 * - System messages (with Resume) are used for internal control flow
 *
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export async function* runMachine<AppMessage = unknown>(
  machine: Machine<AppMessage>,
  options?: RunOptions<AppMessage>,
): AsyncGenerator<MachineStep<AppMessage>> {
  const tracer = options?.tracer;
  const rootSpan = tracer?.startSpan("machine.run", {
    input: { charterName: machine.charter.name },
    attributes: { maxSteps: options?.maxSteps ?? 50 },
  });

  try {
  yield* runMachineInner(machine, options, tracer, rootSpan);
  } finally {
    rootSpan?.end();
  }
}

async function* runMachineInner<AppMessage = unknown>(
  machine: Machine<AppMessage>,
  options: RunOptions<AppMessage> | undefined,
  tracer: Tracer | undefined,
  rootSpan: Span | undefined,
): AsyncGenerator<MachineStep<AppMessage>> {
  const rootTracer = rootSpan?.child();

  // Initial drain of queue
  const initialDrain = drainQueue(machine);
  const initialStepHistory = buildStepHistory(initialDrain.ordered, machine.charter);

  // Check for Resume in system messages
  for (const msg of initialDrain.conversationMessages) {
    if (msg.role === "system" && Array.isArray(msg.items)) {
      const resumeItem = msg.items.find(isResume) as Resume | undefined;
      if (resumeItem) {
        // Process Resume
        const targetInstance = findInstanceById(machine.instance, resumeItem.instanceId);
        if (!targetInstance) {
          throw new Error(`Instance not found: ${resumeItem.instanceId}`);
        }
        if (!targetInstance.suspended) {
          throw new Error(`Instance ${resumeItem.instanceId} is not suspended`);
        }
        if (targetInstance.suspended.suspendId !== resumeItem.suspendId) {
          throw new Error(
            `Suspend ID mismatch: expected ${targetInstance.suspended.suspendId}, got ${resumeItem.suspendId}`
          );
        }

        // Clear the suspended field
        machine.instance = updateInstanceById(
          machine.instance,
          resumeItem.instanceId,
          clearSuspension,
        );

        const stepHistory: MachineMessage<AppMessage>[] = [userMessage(`[Resumed instance ${resumeItem.instanceId}]`)];
        machine.history = [...machine.history, ...stepHistory];

        const step: MachineStep<AppMessage> = {
          instance: machine.instance,
          history: stepHistory,
          yieldReason: "command",
          done: false,
        };
        machine.externalize?.notifyStep(step, []);
        yield step;
        return;
      }
    }
  }

  // Add initial step history to machine.history (all messages in queue order, singletons collapsed)
  machine.history = [...machine.history, ...initialStepHistory];

  // Apply any initial instance messages
  const initialApplyResult = applyInstanceMessages(machine, initialDrain.instanceMessages, 0);

  // Check if we should skip leaf execution (only silent user messages)
  const hasNonSilentUserMessage = initialDrain.conversationMessages.some(
    msg => msg.role === "user" && msg.metadata?.silent !== true
  );

  if (!hasNonSilentUserMessage) {
    // All processing done (history updated, instance messages applied)
    // Yield step without running leaves
    const step: MachineStep<AppMessage> = {
      instance: machine.instance,
      history: initialStepHistory,
      yieldReason: "end_turn",
      done: true,
    };
    machine.externalize?.notifyStep(step, initialApplyResult.stateMutations);
    yield step;
    return;
  }

  const maxSteps = options?.maxSteps ?? 50;
  let steps = 0;
  let tokenRecoveryAttempted = false;
  // Initial drain messages are prepended to the first yielded step's history
  let pendingInitialHistory: MachineMessage<AppMessage>[] | null = initialStepHistory;
  // Initial drain mutations are merged into the first yielded step.
  let pendingInitialStateMutations: ExternalStateMutationEvent<unknown, AppMessage>[] | null =
    initialApplyResult.stateMutations;

  while (steps < maxSteps) {
    steps++;

    // Get all active leaves for parallel execution
    const activeLeaves = getActiveLeaves(machine.instance);

    if (activeLeaves.length === 0) {
      // Check if all leaves are suspended
      const suspendedInstances = getSuspendedInstances(machine.instance);
      if (suspendedInstances.length > 0) {
        // All leaves are suspended - yield awaiting_resume
        const suspendedInfo: SuspendedInstanceInfo[] = suspendedInstances.map((inst) => ({
          instanceId: inst.id,
          suspendId: inst.suspended!.suspendId,
          reason: inst.suspended!.reason,
          metadata: inst.suspended!.metadata,
        }));
        const step: MachineStep<AppMessage> = {
          instance: machine.instance,
          history: [],
          yieldReason: "awaiting_resume",
          done: true,
          suspendedInstances: suspendedInfo,
        };
        machine.externalize?.notifyStep(step, []);
        yield step;
        return;
      }
      throw new Error("No active instances found");
    }

    const stepSpan = rootTracer?.startSpan(`machine.step.${steps}`, {
      attributes: { step: steps, activeLeafCount: activeLeaves.length },
    });
    const stepTracer = stepSpan?.child();

    try {

    // Validate: max 1 non-worker leaf
    const nonWorkerLeaves = activeLeaves.filter(l => !l.isWorker);
    if (nonWorkerLeaves.length > 1) {
      throw new Error(
        `Invalid state: ${nonWorkerLeaves.length} non-worker active leaves. ` +
        `At most one instance can receive user input per step.`
      );
    }

    if (options?.debug) {
      console.log(`[runMachine] Step ${steps}/${maxSteps}`);
      console.log(`[runMachine]   Active leaves: ${activeLeaves.length} (${nonWorkerLeaves.length} non-worker)`);
    }

    const historyForModel = convertEphemeralsForModel(machine.history);

    // Execute all leaves in parallel - they enqueue messages directly
    const results = await Promise.all(
      activeLeaves.map(async ({ path, leafIndex, isWorker }) => {
        const leaf = path[path.length - 1]!;
        const ancestors = path.slice(0, -1);

        if (options?.debug) {
          const instructions = leaf.node.instructions;
          console.log(`[runMachine]   Leaf ${leafIndex.join('.')}: ${instructions.slice(0, 40)}... (worker: ${isWorker})`);
        }

        const result = await machine.charter.executor.run(
          machine.charter,
          leaf,
          ancestors,
          "",
          {
            ...options,
            history: historyForModel,
            currentStep: steps,
            maxSteps,
            enqueue: machine.enqueue,
            instanceId: leaf.id,
            isWorker,
            tracer: stepTracer,
          },
        );

        return {
          leafIndex,
          isWorker,
          instanceId: leaf.id,
          yieldReason: result.yieldReason,
        };
      })
    );

    if (options?.debug) {
      for (const r of results) {
        console.log(`[runMachine]   Leaf ${r.leafIndex.join('.')} result: ${r.yieldReason}`);
      }
    }

    // Drain the queue to collect step history and apply instance changes
    const stepDrain = drainQueue(machine, { includeEphemeral: false });

    // Apply instance messages and collect cede info
    const { hasCede, cedeContents, stateMutations } = applyInstanceMessages(machine, stepDrain.instanceMessages, steps);

    // Step history is all drained messages in queue order
    const stepHistory = buildStepHistory(stepDrain.ordered, machine.charter);

    // Add step history to machine.history
    machine.history = [...machine.history, ...stepHistory];

    // First step includes initial drain messages (user input, etc.)
    const fullStepHistory = pendingInitialHistory
      ? [...pendingInitialHistory, ...stepHistory]
      : stepHistory;
    pendingInitialHistory = null;
    const fullStateMutations = pendingInitialStateMutations
      ? [...pendingInitialStateMutations, ...stateMutations]
      : stateMutations;
    pendingInitialStateMutations = null;

    // Determine primary yield reason (from non-worker leaf)
    const primaryResult = results.find(r => !r.isWorker);
    const primaryYieldReason = primaryResult?.yieldReason ?? "end_turn";

    // Check for worker end_turn without cede (warning)
    for (const r of results) {
      if (r.isWorker && r.yieldReason === "end_turn") {
        console.warn(
          `[runMachine] Worker instance ${r.instanceId} returned end_turn without ceding. ` +
          `This is unexpected - worker nodes should cede to return control to parent.`
        );
      }
      if (r.isWorker && r.yieldReason === "tool_use" && primaryYieldReason === "end_turn") {
        console.warn(
          `[runMachine] Warning: Worker ${r.instanceId} has yieldReason=tool_use but primary ended turn. Worker work abandoned.`
        );
      }
    }

    // Handle cede
    if (hasCede) {
      const cedeInfo = cedeContents[0];
      const cedeContent = cedeInfo?.content;

      // Add cede content as user message for parent context
      if (cedeContent !== undefined) {
        if (typeof cedeContent === "string") {
          const cedeMessage = userMessage<AppMessage>(cedeContent, { source: { instanceId: cedeInfo!.instanceId } });
          machine.history = [...machine.history, cedeMessage];
        } else {
          machine.history = [...machine.history, ...cedeContent];
        }
      }

      // If single-leaf cede, yield explicit cede step
      if (activeLeaves.length === 1) {
        const step: MachineStep<AppMessage> = {
          instance: machine.instance,
          history: fullStepHistory,
          yieldReason: "cede",
          done: false,
          cedeContent,
        };
        machine.externalize?.notifyStep(step, fullStateMutations);
        yield step;
        continue;
      }
    }

    // Handle max_tokens recovery for primary leaf
    if (primaryYieldReason === "max_tokens") {
      if (!tokenRecoveryAttempted) {
        tokenRecoveryAttempted = true;
        if (options?.debug) {
          console.log(`[runMachine] max_tokens hit, attempting recovery...`);
        }

        // Yield the partial step (not final)
        const step: MachineStep<AppMessage> = {
          instance: machine.instance,
          history: fullStepHistory,
          yieldReason: "max_tokens",
          done: false,
        };
        machine.externalize?.notifyStep(step, fullStateMutations);
        yield step;

        // Add recovery message
        const recoveryMessage = userMessage<AppMessage>(
          `[System: Your response was cut off due to length limits. Please provide a brief summary of your findings and respond to the user now. Do not use any tools - just give your final answer.]`
        );
        machine.history = [...machine.history, recoveryMessage];
        continue;
      } else {
        // Recovery already attempted, treat as final
        const step: MachineStep<AppMessage> = {
          instance: machine.instance,
          history: fullStepHistory,
          yieldReason: "max_tokens",
          done: true,
        };
        machine.externalize?.notifyStep(step, fullStateMutations);
        yield step;
        return;
      }
    }

    // Determine if step is final based on primary yield reason
    // "end_turn" = LLM finished responding
    // "external" = inference delegated to external system (e.g., LiveKit voice)
    const isFinal = primaryYieldReason === "end_turn" || primaryYieldReason === "external";

    const step: MachineStep<AppMessage> = {
      instance: machine.instance,
      history: fullStepHistory,
      yieldReason: primaryYieldReason,
      done: isFinal,
    };
    machine.externalize?.notifyStep(step, fullStateMutations);
    yield step;

    if (isFinal) {
      return;
    }

    } finally {
      stepSpan?.end();
    }
  }

  throw new Error(`Max steps (${maxSteps}) exceeded`);
}

/**
 * Run the machine to completion, returning only the final step.
 * Convenience wrapper for cases that don't need step-by-step control.
 *
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export async function runMachineToCompletion<AppMessage = unknown>(
  machine: Machine<AppMessage>,
  options?: RunOptions<AppMessage>,
): Promise<MachineStep<AppMessage>> {
  let lastStep: MachineStep<AppMessage> | null = null;
  for await (const step of runMachine(machine, options)) {
    lastStep = step;
  }
  if (!lastStep) {
    throw new Error("No steps produced");
  }
  return lastStep;
}
