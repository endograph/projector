import type { generateText, streamText, LanguageModel } from "ai";
import type { ActionContext, AnyAction, ExecutorRunRequest } from "@projectors/core";

export type AiSdkGenerateText = typeof generateText;
export type AiSdkStreamText = typeof streamText;

export type AiSdkRunActionInput = {
  action: AnyAction;
  input: unknown;
  context: ActionContext<unknown>;
  request: ExecutorRunRequest;
  aiSdkContext?: unknown;
};

export type AiSdkStreamUpdate = {
  request: ExecutorRunRequest;
  messageId: string;
  text: string;
  delta?: string;
  streamState: "streaming" | "complete" | "error";
  streamSeq: number;
  error?: string;
};

export type AiSdkExecutorConfig = {
  model: LanguageModel;
  generateText?: AiSdkGenerateText;
  streamText?: AiSdkStreamText;
  debug?: boolean;
  stream?: boolean | ((request: ExecutorRunRequest) => boolean);
  onStreamUpdate?: (update: AiSdkStreamUpdate) => unknown | Promise<unknown>;

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

  runAction?: (input: AiSdkRunActionInput) => unknown | Promise<unknown>;
};
