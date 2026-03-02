// Refs
export type { Ref, SerialNode, SerialTransition, SerialPack, JSONSchema } from "./refs";
export { isRef, isSerialNode, isSerialTransition, isSerialPack } from "./refs";

// Tools
export type {
  ToolContext,
  ToolDefinition,
  AnyToolDefinition,
  AnthropicToolDefinition,
  AnthropicBuiltinTool,
  ToolReply,
} from "./tools";
export { isAnthropicBuiltinTool, isToolReply, toolReply } from "./tools";

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
} from "./transitions";
export {
  transitionTo,
  isCodeTransition,
  isGeneralTransition,
  transitionHasArguments,
  isTransitionToResult,
  isSpawnResult,
  isCedeResult,
  isSuspendResult,
} from "./transitions";

// State
export type { StateUpdateResult } from "./state";
export { shallowMerge } from "./state";

// Node
export type {
  Node,
  NodeConfig,
  NodeToolEntry,
  OutputConfig,
  WorkerNode,
  WorkerNodeConfig,
} from "./node";
export { isNode, isWorkerNode } from "./node";

// Instance
export type { Instance, NodeState, ActiveLeafInfo, SuspendInfo } from "./instance";
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
} from "./instance";

// Charter
export type { Charter, CharterConfig } from "./charter";

// Messages
export type {
  MachineMessage,
  ConversationMessage,
  EphemeralMessage,
  InstanceMessage,
  MessageMetadata,
  MessageSource,
  MachineItem,
  TextBlock,
  ImageDetail,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  OutputBlock,
  // Instance payloads
  InstancePayload,
  StateUpdatePayload,
  PackStateUpdatePayload,
  TransitionPayload,
  SpawnPayload,
  CedePayload,
  SuspendPayload,
} from "./messages";
export {
  userMessage,
  assistantMessage,
  systemMessage,
  commandMessage,
  instanceMessage,
  ephemeralMessage,
  toolResult,
  getMessageText,
  isOutputBlock,
  isConversationMessage,
  isEphemeralMessage,
  isInstanceMessage,
  isModelMessage,
} from "./messages";

// Streaming
export type { MessageStreamEvent, MessageStreamDelta, MessageStreamError } from "./stream";

// Machine
export type {
  Machine,
  MachineConfig,
  OnMessageEnqueue,
  SerializedMachine,
  SerializedInstance,
  SerializedSuspendInfo,
  SerialPackInstance,
} from "./machine";

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
} from "./pack";
export { isPack, isPackToolDefinition } from "./pack";

// Commands
export type {
  CommandContext,
  CommandDefinition,
  AnyCommandDefinition,
  CommandResult,
  CommandValueResult,
  ResumeResult,
  CommandInfo,
  CommandExecutionResult,
  Command,
  Resume,
  SuspendOptions,
} from "./commands";
export { isCommandValueResult, commandResult, commandResume, isCommand, isResume, isResumeResult } from "./commands";

// Client
export type {
  CommandMeta,
  NodeCommands,
  DryClientNode,
  ClientNode,
  DryClientInstance,
  ClientInstance,
  DryClientPack,
  ClientPack,
} from "./client";

// Display
export type {
  DisplayCommand,
  DisplayInstance,
  DisplayNode,
  DisplayPack,
} from "./display";

// Contract
export type {
  CommandHandle,
  ContractCommandEntry,
  MachineContract,
  MachineContractConfig,
  BuildCommands,
} from "./contract";

// Externalize
export type {
  ExternalScope,
  ExternalStateMutationEvent,
  ExternalSetStateOptions,
  ExternalStateHandlerContext,
  ExternalStateHandler,
  ExternalizeStateConfig,
  ExternalizeRuntime,
} from "./externalize";

// Tracer
export type { Tracer, Span, SpanOptions } from "./tracer";
