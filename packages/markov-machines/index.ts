// Re-export Zod v4 for consumers to use compatible schemas
export { z } from 'zod'

// Core functions
export { createCharter } from "./src/core/charter";
export { createNode, createWorkerNode } from "./src/core/node";
export { createMachine } from "./src/core/machine";
export { createTransition } from "./src/core/transition";
export { cede, spawn, suspend } from "./src/helpers/cede-spawn";
export type { TransitionConfig } from "./src/core/transition";
export { runMachine, runMachineToCompletion, drainQueue, applyInstanceMessages } from "./src/core/run";
export type { LeafResult, DrainResult } from "./src/core/run";
export { createPack } from "./src/core/pack";
export { getAvailableCommands, runCommand, createCommand } from "./src/core/commands";
export type { CommandConfig } from "./src/core/commands";
export { createMachineContract, assertMachineContract } from "./src/core/contract";
export { findCommand } from "./src/core/client-helpers";

// Client
export {
  createDryClientNode,
  createDryClientInstance,
  createDryClientPack,
  hydrateClientNode,
  hydrateClientInstance,
  hydrateClientPack,
} from "./src/core/client";

// Executors
export { StandardExecutor, createStandardExecutor } from "./src/executor/standard";
export type {
  Executor,
  StandardExecutorConfig,
  StandardNodeConfig,
  RunOptions,
  RunResult,
  MachineStep,
  YieldReason,
  SuspendedInstanceInfo,
  EnqueueFn,
} from "./src/executor/types";

// Tools
export { generateToolDefinitions } from "./src/tools/index";

// Serialization
export { serializeNode, serializeInstance, serializeMachine } from "./src/serialization/serialize";
export type { SerializeNodeOptions } from "./src/serialization/serialize";
export { deserializeMachine, deserializeInstance, deserializeNode } from "./src/serialization/deserialize";
export {
  serializeInstanceForDisplay,
  serializeNodeForDisplay,
  serializePackForDisplay,
} from "./src/serialization/serialize-display";

// JSON Schema helpers
export { escapeSchemaKeys, restoreSchemaKeys, toSafeJsonSchema, fromSafeJsonSchema } from "./src/helpers/json-schema";

// Ref resolution
export { resolveNodeRef } from "./src/runtime/transition-executor";

// Types
export type {
  // Charter
  Charter,
  CharterConfig,
  // Node
  Node,
  NodeConfig,
  NodeToolEntry,
  WorkerNode,
  WorkerNodeConfig,
  // Instance
  Instance,
  NodeState,
  SuspendInfo,
  ActiveLeafInfo,
  // Machine
  Machine,
  MachineConfig,
  OnMessageEnqueue,
  SerializedMachine,
  SerializedInstance,
  SerializedSuspendInfo,
  // Refs
  Ref,
  SerialNode,
  SerialTransition,
  JSONSchema,
  // Transitions
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
  // Tools
  ToolContext,
  ToolDefinition,
  AnyToolDefinition,
  AnthropicToolDefinition,
  AnthropicBuiltinTool,
  ToolReply,
  // Messages
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
  FileBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  OutputBlock,
  // Streaming
  MessageStreamEvent,
  MessageStreamDelta,
  MessageStreamError,
  // Instance payloads
  InstancePayload,
  StateUpdatePayload,
  PackStateUpdatePayload,
  TransitionPayload,
  SpawnPayload,
  CedePayload,
  SuspendPayload,
  // Pack
  Pack,
  PackConfig,
  PackToolDefinition,
  PackToolContext,
  AnyPackToolDefinition,
  // Commands
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
  // Client
  CommandMeta,
  NodeCommands,
  DryClientNode,
  ClientNode,
  DryClientInstance,
  ClientInstance,
  DryClientPack,
  ClientPack,
  // Display
  DisplayCommand,
  DisplayInstance,
  DisplayNode,
  DisplayPack,
  // Contract
  CommandHandle,
  ContractCommandEntry,
  MachineContract,
  MachineContractConfig,
  BuildCommands,
  // Externalize
  ExternalScope,
  ExternalStateMutationEvent,
  ExternalSetStateOptions,
  ExternalStateHandlerContext,
  ExternalStateHandler,
  ExternalizeStateConfig,
  ExternalizeRuntime,
  // Tracer
  Tracer,
  Span,
  SpanOptions,
} from "./src/types/index";

// Type guards and helpers
export {
  isRef,
  isSerialNode,
  isSerialTransition,
  isNode,
  isWorkerNode,
  isInstance,
  isWorkerInstance,
  createInstance,
  getActiveInstance,
  getInstancePath,
  getAllInstances,
  getActiveLeaves,
  getSuspendedInstances,
  findInstanceById,
  isSuspendedInstance,
  createSuspendInfo,
  clearSuspension,
  isCodeTransition,
  isGeneralTransition,
  transitionHasArguments,
  transitionTo,
  isTransitionToResult,
  isSpawnResult,
  isCedeResult,
  isSuspendResult,
  isPack,
  isPackToolDefinition,
  isAnthropicBuiltinTool,
  isToolReply,
  toolReply,
  isCommandValueResult,
  commandResult,
  commandResume,
  isCommand,
  isResume,
  isResumeResult,
} from "./src/types/index";

// Message helpers
export {
  userMessage,
  assistantMessage,
  commandMessage,
  systemMessage,
  instanceMessage,
  ephemeralMessage,
  toolResult,
  getMessageText,
  isConversationMessage,
  isEphemeralMessage,
  isInstanceMessage,
  isModelMessage,
} from "./src/types/messages";

// System prompt helpers
export type { SystemPromptOptions } from './src/runtime/system-prompt';
export { buildSystemPrompt, buildDefaultSystemPrompt } from './src/runtime/system-prompt';

// Tool pipeline (for custom executors like LiveKitExecutor)
export { runToolPipeline } from './src/runtime/tool-pipeline';
export type { ToolPipelineContext, ToolPipelineResult } from './src/runtime/tool-pipeline';
export type { ToolCall } from './src/runtime/tool-call-processor';

// State helpers
export { shallowMerge } from "./src/types/state";
