// Refs
export type { Ref, SerialNode, SerialTransition, JSONSchema } from "./refs.js";
export { isRef, isSerialNode, isSerialTransition } from "./refs.js";

// Tools
export type {
  ToolContext,
  ToolDefinition,
  AnyToolDefinition,
  AnthropicToolDefinition,
  AnthropicBuiltinTool,
  ToolReply,
} from "./tools.js";
export { isAnthropicBuiltinTool, isToolReply, toolReply } from "./tools.js";

// Transitions
export type {
  Transition,
  CodeTransition,
  GeneralTransition,
  TransitionContext,
  TransitionResult,
  TransitionToResult,
  SpawnResult,
  CedeResult,
  SuspendResult,
  SpawnTarget,
  SpawnOptions,
  TransitionToOptions,
} from "./transitions.js";
export {
  transitionTo,
  isCodeTransition,
  isGeneralTransition,
  transitionHasArguments,
  isTransitionToResult,
  isSpawnResult,
  isCedeResult,
  isSuspendResult,
} from "./transitions.js";

// State
export type { StateUpdateResult } from "./state.js";
export { shallowMerge } from "./state.js";

// Node
export type {
  Node,
  NodeConfig,
  NodeToolEntry,
  OutputConfig,
  WorkerNode,
  WorkerNodeConfig,
} from "./node.js";
export { isNode, isWorkerNode } from "./node.js";

// Instance
export type { Instance, NodeState, ActiveLeafInfo, SuspendInfo } from "./instance.js";
export {
  createInstance,
  isInstance,
  isWorkerInstance,
  isSuspendedInstance,
  getActiveInstance,
  getInstancePath,
  getAllInstances,
  getActiveLeaves,
  getChildren,
  getSuspendedInstances,
  findInstanceById,
  createSuspendInfo,
  clearSuspension,
} from "./instance.js";

// Charter
export type { Charter, CharterConfig } from "./charter.js";

// Messages
export type {
  Message,
  MessageMetadata,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  OutputBlock,
} from "./messages.js";
export {
  userMessage,
  assistantMessage,
  toolResult,
  getMessageText,
  isOutputBlock,
} from "./messages.js";

// Machine
export type {
  Machine,
  MachineConfig,
  SerializedMachine,
  SerializedInstance,
  SerializedSuspendInfo,
} from "./machine.js";

// Pack
export type {
  Pack,
  PackConfig,
  PackToolDefinition,
  PackToolContext,
  AnyPackToolDefinition,
  PackCommandContext,
  PackCommandDefinition,
  PackCommandResult,
  AnyPackCommandDefinition,
} from "./pack.js";
export { isPack, isPackToolDefinition } from "./pack.js";

// Commands
export type {
  CommandContext,
  CommandDefinition,
  AnyCommandDefinition,
  CommandResult,
  ValueResult,
  ResumeResult,
  CommandInfo,
  CommandExecutionResult,
  Command,
  Resume,
  SuspendOptions,
} from "./commands.js";
export { isValueResult, commandValue, commandResume, isCommand, isResume, isResumeResult } from "./commands.js";

// Client
export type {
  CommandMeta,
  NodeCommands,
  DryClientNode,
  ClientNode,
  DryClientInstance,
  ClientInstance,
} from "./client.js";
