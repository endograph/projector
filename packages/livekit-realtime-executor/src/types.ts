import type {
  ActionContext,
  ActorMessage,
  AnyAction,
  CompiledInference,
  CompletionReason,
  EnqueueFrame,
  ExecutorRunRequest,
  ExecutorRunResult,
  Frame,
  FrameDraft,
  FrameMessage,
  ProjectorExecutor,
  RetrievableState,
  RuntimeSyncContext,
} from "@projectors/core";
import type { llm } from "@livekit/agents";

export type {
  CompletionReason,
  EnqueueFrame,
  ExecutorRunRequest,
  ExecutorRunResult,
  Frame,
  FrameDraft,
  FrameMessage,
  ProjectorExecutor,
  RuntimeSyncContext,
};

export type LiveKitToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
};

export type LiveKitFunctionTool = {
  type: "function";
  description: string;
  parameters?: unknown;
  execute(input: unknown, context?: unknown): unknown | Promise<unknown>;
};

export type LiveKitToolContext = Record<string, LiveKitFunctionTool>;

export type LiveKitTextOutputLike = {
  captureText(text: string): unknown | Promise<unknown>;
  flush(): void;
  onAttached?: () => void;
  onDetached?: () => void;
};

export type LiveKitRealtimeSessionLike = {
  chatCtx?: unknown;
  on?: (event: string, handler: LiveKitEventHandler) => unknown;
  off?: (event: string, handler: LiveKitEventHandler) => unknown;
  updateInstructions?: (instructions: string) => unknown | Promise<unknown>;
  updateChatCtx?: (chatCtx: llm.ChatContext) => unknown | Promise<unknown>;
  updateTools?: (tools: LiveKitToolContext) => unknown | Promise<unknown>;
  generateReply?: (instructions?: string) => unknown | Promise<unknown>;
  sendInput?: (input: string) => unknown | Promise<unknown>;
  sendEvent?: (event: unknown) => unknown | Promise<unknown>;
};

export type LiveKitEventHandler = (...args: unknown[]) => void;

export type LiveKitSessionLike = {
  on?: (event: string, handler: LiveKitEventHandler) => unknown;
  off?: (event: string, handler: LiveKitEventHandler) => unknown;
  generateReply?: (options?: {
    userInput?: string;
    instructions?: string;
    toolChoice?: unknown;
    allowInterruptions?: boolean;
  }) => unknown;
  updateInstructions?: (instructions: string) => unknown | Promise<unknown>;
  updateTools?: (tools: LiveKitToolContext) => unknown | Promise<unknown>;
  realtimeLLMSession?: LiveKitRealtimeSessionLike;
  realtimeSession?: LiveKitRealtimeSessionLike;
  output?: {
    transcription?: LiveKitTextOutputLike | null;
  };
};

export type LiveKitAgentLike = {
  instructions?: string;
  toolCtx?: LiveKitToolContext;
  chatCtx?: unknown;
  _instructions?: string;
  _tools?: LiveKitToolContext;
  _chatCtx?: unknown;
  _agentActivity?: {
    realtimeLLMSession?: LiveKitRealtimeSessionLike;
    realtimeSession?: LiveKitRealtimeSessionLike;
    generateReply?: (options: {
      userMessage?: unknown;
      instructions?: string;
      toolChoice?: unknown;
      allowInterruptions?: boolean;
      scheduleSpeech?: boolean;
    }) => unknown;
  };
};

export type LiveKitRoomLike = {
  name?: string;
  on?: (event: string, handler: LiveKitEventHandler) => unknown;
  off?: (event: string, handler: LiveKitEventHandler) => unknown;
} & Record<string, unknown>;

export type LiveKitEventNames = {
  userInputTranscribed: string;
  userStateChanged: string;
  conversationItemAdded: string;
  dataReceived: string;
};

export type RunActionInput<TDataContent = never> = {
  action: AnyAction;
  input: unknown;
  context: ActionContext<unknown, TDataContent>;
  liveKitContext?: unknown;
};

export type StateGetterInput = {
  address: string;
  state: RetrievableState;
};

export type LiveKitAssistantTranscriptUpdate = {
  messageId: string;
  text: string;
  delta?: string;
  streamState: "streaming" | "error";
  streamSeq: number;
  error?: string;
};

export type LiveKitUserTranscriptUpdate = {
  messageId: string;
  text: string;
  streamState: "streaming" | "complete" | "error";
  streamSeq: number;
  error?: string;
};

export type LiveKitRealtimeExecutorConfig<TDataContent = never> = {
  debug?: boolean;
  session: LiveKitSessionLike;
  agent?: LiveKitAgentLike;
  room?: LiveKitRoomLike;
  discreteExecutor: ProjectorExecutor<TDataContent>;
  realtimeGeneratorId?: string;
  messageToText?: (message: ActorMessage<TDataContent>) => string | undefined;
  realtime?: {
    enabled?: boolean | ((context: RuntimeSyncContext<TDataContent>) => boolean);
  };
  input?: {
    messageTopic?: string;
    parseDataMessage?: (payload: Uint8Array, context: {
      participant?: unknown;
      kind?: unknown;
      topic?: string;
    }) => string | FrameDraft<TDataContent> | undefined;
  };
  eventNames?: Partial<LiveKitEventNames>;
  runAction?: (input: RunActionInput<TDataContent>) => unknown | Promise<unknown>;
  getState?: (input: StateGetterInput) => unknown | Promise<unknown>;
  onAssistantTranscriptUpdate?: (update: LiveKitAssistantTranscriptUpdate) => unknown | Promise<unknown>;
  onUserTranscriptUpdate?: (update: LiveKitUserTranscriptUpdate) => unknown | Promise<unknown>;
};
