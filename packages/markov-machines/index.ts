// Core functions
export { createCharter } from "./src/core/charter.js";
export { createNode, createWorkerNode } from "./src/core/node.js";
export { createMachine } from "./src/core/machine.js";
export { createTransition } from "./src/core/transition.js";
export { cede, spawn, suspend } from "./src/helpers/cede-spawn.js";
export type { TransitionConfig } from "./src/core/transition.js";
export { runMachine, runMachineToCompletion } from "./src/core/run.js";
export type { RunMachineInput } from "./src/core/run.js";
export { createPack } from "./src/core/pack.js";
export { getAvailableCommands, runCommand, createCommand } from "./src/core/commands.js";
export type { CommandConfig } from "./src/core/commands.js";

// Client
export {
  createDryClientNode,
  createDryClientInstance,
  hydrateClientNode,
  hydrateClientInstance,
} from "./src/core/client.js";

// Executors
export { StandardExecutor, createStandardExecutor } from "./src/executor/standard.js";
export type {
  Executor,
  StandardExecutorConfig,
  StandardNodeConfig,
  RunOptions,
  RunResult,
  MachineStep,
  YieldReason,
  SuspendedInstanceInfo,
} from "./src/executor/types.js";

// Serialization
export { serializeNode, serializeInstance, serializeMachine } from "./src/serialization/serialize.js";
export { deserializeMachine, deserializeInstance, deserializeNode } from "./src/serialization/deserialize.js";

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
  // Machine
  Machine,
  MachineConfig,
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
  Message,
  MessageMetadata,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  OutputBlock,
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
  ValueResult,
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
} from "./src/types/index.js";

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
  isValueResult,
  commandValue,
  commandResume,
  isCommand,
  isResume,
  isResumeResult,
} from "./src/types/index.js";

// Message helpers
export {
  userMessage,
  assistantMessage,
  toolResult,
  getMessageText,
} from "./src/types/messages.js";

// State helpers
export { shallowMerge } from "./src/types/state.js";
