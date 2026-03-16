export { isRef, isSerialTransition } from "./helpers.ts";

// Re-export client-safe types only.
export type { Ref, SerialNode, SerialTransition, JSONSchema } from "./src/types/refs";
export type {
  CommandMeta,
  DryClientNode,
  DryClientInstance,
  DryClientPack,
  ClientNode,
  ClientInstance,
  ClientPack,
} from "./src/types/client";
export type { SerializedInstance, SerializedSuspendInfo } from "./src/types/machine";
export type {
  MachineMessage,
  ConversationMessage,
  EphemeralMessage,
  InstanceMessage,
  MachineItem,
  TextBlock,
  ImageDetail,
  ImageBlock,
  FileBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  OutputBlock,
} from "./src/types/messages";
export type { CommandExecutionResult } from "./src/types/commands";
export type { StandardNodeConfig } from "./src/executor/types";
export type { DisplayCommand, DisplayInstance, DisplayNode, DisplayPack } from "./src/types/display";
export type { CommandHandle, MachineContract, ContractCommandEntry } from "./src/types/contract";
export { findCommand } from "./src/core/client-helpers";
