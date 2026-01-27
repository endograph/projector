import type { Charter } from "./charter.js";
import type { Instance, SuspendInfo } from "./instance.js";
import type { MachineMessage } from "./messages.js";
import type { Ref, SerialNode } from "./refs.js";
import type { StandardNodeConfig } from "../executor/types.js";

/**
 * Callback invoked when a message is enqueued.
 * Called once per message, immediately when enqueue() is called.
 */
export type OnMessageEnqueue<AppMessage = unknown> = (
  message: MachineMessage<AppMessage>
) => void | Promise<void>;

/**
 * Machine configuration for createMachine.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface MachineConfig<AppMessage = unknown> {
  /** Root node instance (may have nested children) */
  instance: Instance;
  /** Conversation history */
  history?: MachineMessage<AppMessage>[];
  /** Callback invoked for each message when enqueue() is called */
  onMessageEnqueue?: OnMessageEnqueue<AppMessage>;
}

/**
 * Machine instance - the runtime context for running the agent.
 * Contains the charter and the node instance tree.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface Machine<AppMessage = unknown> {
  /** Reference to the charter (static registry) */
  charter: Charter<AppMessage>;
  /** Root node instance (may have nested children) */
  instance: Instance;
  /** Conversation history */
  history: MachineMessage<AppMessage>[];
  /** Queued messages to be processed on next runMachine call */
  queue: MachineMessage<AppMessage>[];
  /** Enqueue messages to be processed on next runMachine call */
  enqueue: (messages: MachineMessage<AppMessage>[]) => void;
  /** Wait until queue has content. Resolves immediately if queue is non-empty. */
  waitForQueue: () => Promise<void>;
  /** Notify any waiters that queue has content (called automatically by enqueue) */
  notifyQueue: () => void;
}

/**
 * Serialized suspend info for persistence.
 * Uses ISO string for date instead of Date object.
 */
export interface SerializedSuspendInfo {
  suspendId: string;
  reason: string;
  /** ISO 8601 date string */
  suspendedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Serialized node instance for persistence.
 */
export interface SerializedInstance {
  /** Unique instance ID */
  id: string;
  /** Node (inline or registry ref) */
  node: SerialNode | Ref;
  /** State for this node */
  state: unknown;
  /** Optional child instances - always an array when present */
  children?: SerializedInstance[];
  /** Pack states (only on root instance) */
  packStates?: Record<string, unknown>;
  /** Per-instance executor configuration override */
  executorConfig?: StandardNodeConfig;
  /** Suspension info if suspended */
  suspended?: SerializedSuspendInfo;
}

/**
 * Serialized machine for persistence.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export interface SerializedMachine<AppMessage = unknown> {
  /** Root instance tree */
  instance: SerializedInstance;
  /** Full conversation history */
  history: MachineMessage<AppMessage>[];
}
