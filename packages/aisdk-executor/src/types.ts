import type { generateText, streamText, LanguageModel, ToolSet } from "ai";
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
  streamState: "streaming" | "complete" | "cancelled" | "error";
  streamSeq: number;
  error?: string;
};

/**
 * Lowers deferred-exposure tools to the provider's idiomatic tool-search
 * mechanism. Receives the deferred actions plus `buildTool` (the same
 * action→AI-SDK-tool conversion used for native tools, execution wiring
 * included) and returns the ToolSet entries to add — e.g. the provider's
 * search tool plus deferred definitions in provider format.
 *
 * Configuring this overrides the built-in lowerings: Anthropic and OpenAI
 * (Responses) models get provider tool search automatically (deferred tools
 * marked `deferLoading` plus the provider's search tool). Deferred tools on
 * a model with no built-in or configured lowering are an error — the compiled
 * prompt promises tool search, so an executor that cannot honor it must not
 * run.
 */
export type AiSdkDeferredToolsLowering<
  TDataContent = never,
> = (input: {
  deferred: AnyAction[];
  buildTool: (action: AnyAction) => ToolSet[string];
  request: ExecutorRunRequest<TDataContent>;
}) => ToolSet;

/**
 * Anthropic prompt-cache lowering for the system prompt. Enabled by default
 * on Anthropic providers: the preamble's stable prefix (everything before the
 * first volatile part, per the IR's slot stamps) becomes a cached system
 * block with one `cacheControl` breakpoint. `false` disables the split;
 * `ttl` extends the cache lifetime. Non-Anthropic providers always get the
 * single-string system prompt.
 */
export type AiSdkPromptCacheConfig = false | { ttl?: "5m" | "1h" };

/**
 * Node-level executor config, carried on `node.executorConfig.aisdk` in the
 * charter (plain JSON) and delivered per activation via
 * `ExecutorRunRequest.config`. Overrides the executor-level defaults.
 */
export type AiSdkExecutorNodeConfig = {
  maxOutputTokens?: number;
  maxSteps?: number;
  temperature?: number;
};

declare module "@projectors/core" {
  interface ExecutorConfigRegistry {
    aisdk: AiSdkExecutorNodeConfig;
  }
}

export type AiSdkExecutorConfig<
  TDataContent = never,
> = {
  model: LanguageModel;
  promptCache?: AiSdkPromptCacheConfig;
  generateText?: AiSdkGenerateText;
  streamText?: AiSdkStreamText;
  debug?: boolean;
  stream?: boolean | ((request: ExecutorRunRequest<TDataContent>) => boolean);
  onStreamUpdate?: (update: AiSdkStreamUpdate<TDataContent>) => unknown | Promise<unknown>;
  messageToModelMessage?: (message: ActorMessage<TDataContent>) => import("ai").ModelMessage | undefined;

  deferredTools?: AiSdkDeferredToolsLowering<TDataContent>;

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
