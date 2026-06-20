import type { generateText, streamText, LanguageModel } from "ai";
import type {
  ActionContext,
  ActorMessage,
  AnyAction,
  ExecutorRunRequest,
} from "@projectors/core";

export type AiSdkGenerateText = typeof generateText;
export type AiSdkStreamText = typeof streamText;

export type AiSdkRunActionInput<
  TDataContent = never,
> = {
  action: AnyAction;
  input: unknown;
  context: ActionContext<unknown, TDataContent>;
  request: ExecutorRunRequest<TDataContent>;
  aiSdkContext?: unknown;
};

export type AiSdkStreamUpdate<
  TDataContent = never,
> = {
  request: ExecutorRunRequest<TDataContent>;
  messageId: string;
  text: string;
  delta?: string;
  streamState: "streaming" | "complete" | "error";
  streamSeq: number;
  error?: string;
};

export type AiSdkExecutorConfig<
  TDataContent = never,
> = {
  model: LanguageModel;
  generateText?: AiSdkGenerateText;
  streamText?: AiSdkStreamText;
  debug?: boolean;
  stream?: boolean | ((request: ExecutorRunRequest<TDataContent>) => boolean);
  onStreamUpdate?: (update: AiSdkStreamUpdate<TDataContent>) => unknown | Promise<unknown>;
  messageToModelMessage?: (message: ActorMessage<TDataContent>) => import("ai").ModelMessage | undefined;

  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  providerOptions?: Record<string, unknown>;

  maxSteps?: number;
  toolChoice?: unknown;
  toolStrict?: boolean;

  runAction?: (input: AiSdkRunActionInput<TDataContent>) => unknown | Promise<unknown>;
};
