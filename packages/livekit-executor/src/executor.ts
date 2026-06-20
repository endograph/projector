import { llm } from "@livekit/agents";
import {
  createUnboundActionContext,
  GET_STATE_ACTION_NAME,
  ROOT_RUNTIME_INSTANCE_ID,
  isActorMessage,
  textContent,
} from "@projectors/core";
import type {
  ActionContext,
  ActorMessage,
  AnyAction,
  CompiledInference,
  ContentPart,
  ExecutorRealizedPrompt,
  ExecutorRealizePromptRequest,
  RuntimeSyncContext,
} from "@projectors/core";
import { z } from "zod";
import type {
  ExecutorRunRequest,
  ExecutorRunResult,
  Frame,
  FrameDraft,
  FrameMessage,
  LiveKitAgentLike,
  LiveKitAssistantTranscriptUpdate,
  LiveKitExecutorConfig,
  LiveKitEventNames,
  LiveKitFunctionTool,
  LiveKitRealtimeSessionLike,
  LiveKitTextOutputLike,
  LiveKitToolContext,
  LiveKitToolDefinition,
  LiveKitUserTranscriptUpdate,
  ProjectorExecutor,
  RunActionInput,
} from "./types.ts";

export const REALTIME_GENERATOR_ID = ROOT_RUNTIME_INSTANCE_ID;

const ASSISTANT_TRANSCRIPT_OUTPUT_OWNER = Symbol("livekitExecutorAssistantTranscriptOutputOwner");

const DEFAULT_EVENT_NAMES: LiveKitEventNames = {
  userInputTranscribed: "user_input_transcribed",
  userStateChanged: "user_state_changed",
  conversationItemAdded: "conversation_item_added",
  dataReceived: "data_received",
};

export class LiveKitExecutor<
  TDataContent = never,
> implements ProjectorExecutor<TDataContent> {
  readonly type = "livekit";

  readonly connection: LiveKitConnection<TDataContent>;

  constructor(readonly config: LiveKitExecutorConfig<TDataContent>) {
    this.connection = new LiveKitConnection(this, config);
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  async run(request: ExecutorRunRequest<TDataContent>): Promise<ExecutorRunResult<TDataContent>> {
    if (request.runtimeInstanceId !== this.realtimeRuntimeInstanceId()) {
      return this.config.discreteExecutor.run(request);
    }

    if (!this.connection.isRealtimeActive()) {
      return this.config.discreteExecutor.run(request);
    }

    return { completionReason: "delegated" };
  }

  async realizePrompt(
    request: ExecutorRealizePromptRequest<TDataContent>,
  ): Promise<ExecutorRealizedPrompt> {
    if (request.runtimeInstanceId !== this.realtimeRuntimeInstanceId()) {
      return await this.config.discreteExecutor.realizePrompt(request);
    }

    if (!this.connection.isRealtimeActive()) {
      return await this.config.discreteExecutor.realizePrompt(request);
    }

    return realizeLiveKitPrompt(request.inference, this.config.messageToText);
  }

  async syncRuntime(context: RuntimeSyncContext<TDataContent>): Promise<void> {
    if (context.runtimeInstanceId !== this.realtimeRuntimeInstanceId()) return;
    await this.connection.syncRuntime(context);
  }

  realtimeRuntimeInstanceId(): string {
    return this.config.realtimeRuntimeInstanceId ?? ROOT_RUNTIME_INSTANCE_ID;
  }

  getTool(name: string): AnyAction | undefined {
    return this.connection.getTool(name);
  }

  executeTool(name: string, input: unknown, liveKitContext?: unknown): Promise<unknown> {
    return this.connection.executeTool(name, input, liveKitContext);
  }

  log(message: string, details?: unknown): void {
    if (!this.config.debug) return;
    if (details === undefined) {
      console.log(`[LiveKitExecutor] ${message}`);
    } else {
      console.log(`[LiveKitExecutor] ${message}`, details);
    }
  }
}

export class LiveKitConnection<TDataContent = never> {
  private readonly eventNames: LiveKitEventNames;
  private readonly handlers: Array<{
    target: "session" | "room";
    event: string;
    handler: (...args: unknown[]) => void;
  }> = [];
  private disconnected = false;
  private syncTail: Promise<void> = Promise.resolve();
  private currentSyncContext?: RuntimeSyncContext<TDataContent>;
  private currentInference?: CompiledInference<TDataContent>;
  private currentInstructions = "";
  private currentTools: LiveKitToolContext = {};
  private toolRegistry = new Map<string, AnyAction>();
  private readonly forwardedInputFrameIds = new Set<string>();
  private readonly assistantTranscripts = new AssistantTranscriptStream<TDataContent>(this);
  private readonly userTranscripts = new UserTranscriptEnvelope<TDataContent>(this);

  constructor(
    private readonly executor: LiveKitExecutor<TDataContent>,
    readonly config: LiveKitExecutorConfig<TDataContent>,
  ) {
    this.eventNames = {
      ...DEFAULT_EVENT_NAMES,
      ...config.eventNames,
    };
    this.installEventHandlers();
  }

  get inference(): CompiledInference<TDataContent> | undefined {
    return this.currentInference;
  }

  get instructions(): string {
    return this.currentInstructions;
  }

  get tools(): LiveKitToolContext {
    return this.currentTools;
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.assistantTranscripts.restore();
    this.userTranscripts.reset();
    for (const { target, event, handler } of this.handlers.splice(0)) {
      if (target === "session") {
        this.config.session.off?.(event, handler);
      } else {
        this.config.room?.off?.(event, handler);
      }
    }
  }

  isRealtimeActive(context: RuntimeSyncContext<TDataContent> | undefined = this.currentSyncContext): boolean {
    const enabled = this.executor.config.realtime?.enabled;
    if (typeof enabled === "function") {
      return context ? enabled(context) : false;
    }
    if (enabled !== undefined) return enabled;

    return !!this.getRealtimeSession();
  }

  syncRuntime(context: RuntimeSyncContext<TDataContent>): Promise<void> {
    const job = this.syncTail
      .catch(() => undefined)
      .then(async () => {
        await this.syncNow(context);
        await this.forwardVisibleInput(context);
      });
    this.syncTail = job;
    return job;
  }

  getTool(name: string): AnyAction | undefined {
    return this.toolRegistry.get(name);
  }

  async executeTool(
    name: string,
    input: unknown,
    liveKitContext?: unknown,
  ): Promise<unknown> {
    const action = this.toolRegistry.get(name);
    if (!action) {
      throw new Error(`No LiveKit tool named "${name}" is registered in the current projection`);
    }

    await this.enqueueToolFrame(name, { phase: "call", input });
    const context: ActionContext<unknown, TDataContent> =
      this.currentSyncContext?.createActionContext(action) ??
      createUnboundActionContext() as ActionContext<unknown, TDataContent>;
    if (action.name === GET_STATE_ACTION_NAME) {
      context.getState ??= (address) => this.getRetrievableState(address);
    }
    const runAction = this.config.runAction;
    const runInput: RunActionInput<TDataContent> = { action, input, context, liveKitContext };
    const value = runAction
      ? await runAction(runInput)
      : action.run
        ? await action.run(input, context)
        : undefined;
    await this.enqueueToolFrame(name, { phase: "result", value });
    return value;
  }

  private async getRetrievableState(address: string): Promise<unknown> {
    const state = this.currentInference?.retrievableStates.find(
      (entry) => entry.address === address,
    );
    if (!state) {
      throw new Error(`Unknown retrievable state address "${address}"`);
    }

    const getState = this.config.getState;
    if (!getState) {
      throw new Error("No getState handler is available for this inference");
    }

    return getState({ address, state });
  }

  async enqueueAssistantTranscript(
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<Frame<TDataContent>> {
    return this.enqueueFrame({
      generatorId: this.executor.realtimeRuntimeInstanceId(),
      runtimeInstanceId: this.executor.realtimeRuntimeInstanceId(),
      inert: true,
      metadata: { mode: "voice", transport: "livekit", transcript: true },
      messages: [
        {
          ...metadata,
          type: "assistant",
          content: [textContent(text)],
          text,
          audience: "self",
          source: { external: true },
        } satisfies FrameMessage<TDataContent>,
      ],
    });
  }

  async enqueueUserTranscript(
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<Frame<TDataContent>> {
    return this.enqueueFrame({
      generatorId: this.executor.realtimeRuntimeInstanceId(),
      runtimeInstanceId: this.executor.realtimeRuntimeInstanceId(),
      inert: true,
      metadata: { mode: "voice", transport: "livekit", transcript: true },
      messages: [
        {
          ...metadata,
          type: "user",
          content: [textContent(text)],
          text,
          audience: "broadcast",
          source: { external: true },
        } satisfies FrameMessage<TDataContent>,
      ],
    });
  }

  private async syncNow(input: CompiledInference<TDataContent> | RuntimeSyncContext<TDataContent>): Promise<void> {
    if (this.disconnected) return;

    let nextInference: CompiledInference<TDataContent> | undefined;
    if (isRuntimeSyncContext(input)) {
      this.currentSyncContext = input;
      nextInference = input.inference;
    } else {
      nextInference = input;
    }
    if (!nextInference) return;

    this.currentInference = nextInference;
    this.currentInstructions = buildLiveKitInstructions(nextInference, this.config.messageToText);
    this.toolRegistry = buildToolRegistry(nextInference.tools);
    this.currentTools = buildLiveKitToolContext(nextInference, this);

    if (this.isRealtimeActive(isRuntimeSyncContext(input) ? input : undefined)) {
      const realtimeSession = this.getRealtimeSession();
      await realtimeSession?.updateInstructions?.(this.currentInstructions);
      await realtimeSession?.updateTools?.(this.currentTools);

      await this.config.session.updateInstructions?.(this.currentInstructions);
      await this.config.session.updateTools?.(this.currentTools);
    }

    this.updateAgentSnapshot(this.config.agent, this.currentInstructions, this.currentTools);
    // RoomIO can replace session.output.transcription after session.start(),
    // so install the wrapper after each sync, not only at connect time.
    this.assistantTranscripts.install();
  }

  private async forwardVisibleInput(context: RuntimeSyncContext<TDataContent>): Promise<void> {
    if (!this.isRealtimeActive(context)) return;
    for (const { frameId, text } of userTextsFromFrames(context.visibleFrames, this.config.messageToText)) {
      if (this.forwardedInputFrameIds.has(frameId)) continue;
      this.forwardedInputFrameIds.add(frameId);
      await this.sendTextToRealtimeSession(text);
    }
  }

  private async sendTextToRealtimeSession(userInput: string): Promise<void> {
    if (this.config.session.generateReply) {
      this.config.session.generateReply(
        userInput ? { userInput } : { instructions: this.currentInstructions },
      );
      return;
    }

    const realtimeSession = this.getRealtimeSession();
    if (userInput && realtimeSession?.sendInput) {
      await realtimeSession.sendInput(userInput);
      return;
    }

    if (realtimeSession?.generateReply) {
      await realtimeSession.generateReply(userInput ?? this.currentInstructions);
      return;
    }

    const activity = this.config.agent?._agentActivity;
    if (activity?.generateReply) {
      activity.generateReply({ instructions: this.currentInstructions });
      return;
    }

    throw new Error("No LiveKit realtime input method is available");
  }

  private getRealtimeSession(): LiveKitRealtimeSessionLike | undefined {
    return (
      this.config.agent?._agentActivity?.realtimeLLMSession ??
      this.config.agent?._agentActivity?.realtimeSession ??
      this.config.session.realtimeLLMSession ??
      this.config.session.realtimeSession
    );
  }

  private updateAgentSnapshot(
    agent: LiveKitAgentLike | undefined,
    instructions: string,
    tools: LiveKitToolContext,
  ): void {
    if (!agent) return;
    agent._instructions = instructions;
    agent._tools = tools;
  }

  private installEventHandlers(): void {
    const onUserStateChanged = (event: unknown) => {
      if (readString(event, "newState") !== "speaking") return;
      this.userTranscripts.begin();
    };

    const onUserInputTranscribed = (event: unknown) => {
      const transcript = readString(event, "transcript");
      if (!transcript || readBoolean(event, "isFinal") !== true) return;
      void this.userTranscripts.complete(transcript, eventMetadata(event)).catch((error) => {
        this.executor.log("Failed to enqueue user transcript", error);
      });
    };

    const onConversationItemAdded = (event: unknown) => {
      if (this.assistantTranscripts.isInstalled()) return;

      const item = readObject(event, "item");
      if (!item || readString(item, "role") !== "assistant") return;

      const text = extractConversationItemText(item);
      if (!text) return;

      const metadata: Record<string, unknown> = eventMetadata(event);
      const itemId = readString(item, "id");
      if (itemId) metadata.messageId = itemId;

      void this.enqueueAssistantTranscript(text, metadata).catch((error) => {
        this.executor.log("Failed to enqueue assistant transcript", error);
      });
    };

    const onDataReceived = (
      payload: unknown,
      participant?: unknown,
      kind?: unknown,
      topic?: unknown,
    ) => {
      if (!(payload instanceof Uint8Array)) return;
      const parsedTopic = typeof topic === "string" ? topic : undefined;
      const input = this.executor.config.input;
      if (!input?.parseDataMessage) return;
      if (input.messageTopic && parsedTopic && parsedTopic !== input.messageTopic) return;
      const text = input.parseDataMessage(payload, {
        participant,
        kind,
        topic: parsedTopic,
      });
      if (!text) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      this.enqueueExternalUserMessage(trimmed).catch((error) => {
        this.executor.log("Failed to enqueue LiveKit data message", error);
      });
    };

    this.onSession(this.eventNames.userStateChanged, onUserStateChanged);
    this.onSession(this.eventNames.userInputTranscribed, onUserInputTranscribed);
    this.onSession(this.eventNames.conversationItemAdded, onConversationItemAdded);
    this.onRoom(this.eventNames.dataReceived, onDataReceived);
  }

  logTranscriptError(message: string, error: unknown): void {
    this.executor.log(message, error);
  }

  emitAssistantTranscriptUpdate(update: LiveKitAssistantTranscriptUpdate): void {
    const onAssistantTranscriptUpdate =
      this.config.onAssistantTranscriptUpdate;
    if (!onAssistantTranscriptUpdate) return;
    void Promise.resolve()
      .then(() => onAssistantTranscriptUpdate(update))
      .catch((error) => {
        this.executor.log("LiveKit assistant transcript update failed", error);
      });
  }

  emitUserTranscriptUpdate(update: LiveKitUserTranscriptUpdate): void {
    const onUserTranscriptUpdate =
      this.config.onUserTranscriptUpdate;
    if (!onUserTranscriptUpdate) return;
    void Promise.resolve()
      .then(() => onUserTranscriptUpdate(update))
      .catch((error) => {
        this.executor.log("LiveKit user transcript update failed", error);
      });
  }

  private onSession(event: string, handler: (...args: unknown[]) => void): void {
    this.config.session.on?.(event, handler);
    this.handlers.push({ target: "session", event, handler });
  }

  private onRoom(event: string, handler: (...args: unknown[]) => void): void {
    this.config.room?.on?.(event, handler);
    this.handlers.push({ target: "room", event, handler });
  }

  private async enqueueExternalUserMessage(text: string): Promise<Frame<TDataContent>> {
    return this.enqueueFrame({
      metadata: { mode: "text", transport: "livekit" },
      messages: [
        {
          type: "user",
          content: [textContent(text)],
          text,
          audience: "broadcast",
          source: { external: true, transport: "livekit" },
        } satisfies FrameMessage<TDataContent>,
      ],
    });
  }

  private async enqueueToolFrame(name: string, value: unknown): Promise<Frame<TDataContent>> {
    return this.enqueueFrame({
      generatorId: this.executor.realtimeRuntimeInstanceId(),
      runtimeInstanceId: this.executor.realtimeRuntimeInstanceId(),
      inert: true,
      messages: [
        {
          type: "tool",
          name,
          value,
          audience: "self",
          source: { external: true },
        } as FrameMessage<TDataContent>,
      ],
    });
  }

  private async enqueueFrame(frame: FrameDraft<TDataContent>): Promise<Frame<TDataContent>> {
    const result = this.currentSyncContext?.machine.enqueueFrame(frame);
    if (!result) {
      throw new Error("LiveKitConnection cannot enqueue a frame before runtime sync");
    }
    return result;
  }
}

class AssistantTranscriptStream<TDataContent> {
  private messageId?: string;
  private text = "";
  private seq = 0;

  constructor(private readonly connection: LiveKitConnection<TDataContent>) {}

  install(): void {
    const output = this.connection.config.session.output;
    const current = output?.transcription;
    if (!output || !current) return;
    if (isAssistantTranscriptOutputWrapper(current, this)) return;

    const wrapper = new AssistantTranscriptOutputWrapper(this, current);
    output.transcription = wrapper;
  }

  restore(): void {
    const output = this.connection.config.session.output;
    const current = output?.transcription;
    if (output && current && isAssistantTranscriptOutputWrapper(current, this)) {
      output.transcription = current.inner;
    }
    this.reset();
  }

  isInstalled(): boolean {
    const current = this.connection.config.session.output?.transcription;
    return Boolean(current && isAssistantTranscriptOutputWrapper(current, this));
  }

  captureDelta(delta: string): void {
    if (!delta) return;
    if (!this.messageId) {
      this.messageId = crypto.randomUUID();
      this.text = "";
      this.seq = 0;
      this.connection.emitAssistantTranscriptUpdate({
        messageId: this.messageId,
        text: this.text,
        streamState: "streaming",
        streamSeq: this.seq,
      });
    }

    this.text += delta;
    this.seq += 1;
    this.connection.emitAssistantTranscriptUpdate({
      messageId: this.messageId,
      text: this.text,
      delta,
      streamState: "streaming",
      streamSeq: this.seq,
    });
  }

  async flush(): Promise<void> {
    const messageId = this.messageId;
    if (!messageId) return;
    const text = this.text;
    const streamSeq = this.seq + 1;
    this.reset();
    await this.connection.enqueueAssistantTranscript(text, {
      messageId,
      streamState: "complete",
      streamSeq,
    });
  }

  logTranscriptError(message: string, error: unknown): void {
    this.connection.logTranscriptError(message, error);
  }

  private reset(): void {
    this.messageId = undefined;
    this.text = "";
    this.seq = 0;
  }
}

class UserTranscriptEnvelope<TDataContent> {
  private messageId?: string;
  private seq = 0;

  constructor(private readonly connection: LiveKitConnection<TDataContent>) {}

  begin(): void {
    if (this.messageId) return;
    this.messageId = crypto.randomUUID();
    this.seq = 0;
    this.connection.emitUserTranscriptUpdate({
      messageId: this.messageId,
      text: "",
      streamState: "streaming",
      streamSeq: this.seq,
    });
  }

  async complete(transcript: string, metadata: Record<string, unknown>): Promise<void> {
    const messageId = this.messageId ?? crypto.randomUUID();
    const streamSeq = this.seq + 1;
    this.reset();
    await this.connection.enqueueUserTranscript(transcript, {
      ...metadata,
      messageId,
      streamState: "complete",
      streamSeq,
    });
    this.connection.emitUserTranscriptUpdate({
      messageId,
      text: transcript,
      streamState: "complete",
      streamSeq,
    });
  }

  reset(): void {
    this.messageId = undefined;
    this.seq = 0;
  }
}

class AssistantTranscriptOutputWrapper implements LiveKitTextOutputLike {
  readonly [ASSISTANT_TRANSCRIPT_OUTPUT_OWNER]: AssistantTranscriptStream<any>;

  constructor(
    owner: AssistantTranscriptStream<any>,
    readonly inner: LiveKitTextOutputLike,
  ) {
    this[ASSISTANT_TRANSCRIPT_OUTPUT_OWNER] = owner;
  }

  async captureText(text: string): Promise<void> {
    this[ASSISTANT_TRANSCRIPT_OUTPUT_OWNER].captureDelta(text);
    await this.inner.captureText(text);
  }

  flush(): void {
    const flushed = this[ASSISTANT_TRANSCRIPT_OUTPUT_OWNER].flush().catch((error) => {
      this[ASSISTANT_TRANSCRIPT_OUTPUT_OWNER].logTranscriptError(
        "Failed to flush assistant transcript",
        error,
      );
    });
    this.inner.flush();
    void flushed;
  }

  onAttached(): void {
    this.inner.onAttached?.();
  }

  onDetached(): void {
    this.inner.onDetached?.();
  }
}

function isAssistantTranscriptOutputWrapper(
  output: LiveKitTextOutputLike,
  owner: AssistantTranscriptStream<any>,
): output is AssistantTranscriptOutputWrapper {
  return (output as Partial<Record<typeof ASSISTANT_TRANSCRIPT_OUTPUT_OWNER, AssistantTranscriptStream<any>>>)[
    ASSISTANT_TRANSCRIPT_OUTPUT_OWNER
  ] === owner;
}

export function buildLiveKitInstructions<TDataContent = never>(
  inference: CompiledInference<TDataContent>,
  messageToText?: (message: ActorMessage<TDataContent>) => string | undefined,
): string {
  return [
    renderSection("System", inference.systemParts),
    renderSection("Dynamic Context", inference.dynamicParts),
    renderHistory(inference.history, messageToText),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function realizeLiveKitPrompt<TDataContent = never>(
  inference: CompiledInference<TDataContent>,
  messageToText?: (message: ActorMessage<TDataContent>) => string | undefined,
): ExecutorRealizedPrompt {
  return {
    provider: "livekit",
    input: {
      instructions: buildLiveKitInstructions(inference, messageToText),
      tools: buildLiveKitToolDefinitions(inference),
    },
  };
}

function isRuntimeSyncContext<TDataContent>(
  input: CompiledInference<TDataContent> | RuntimeSyncContext<TDataContent>,
): input is RuntimeSyncContext<TDataContent> {
  return Boolean(
    input &&
      typeof input === "object" &&
      "machine" in input &&
      "inference" in input,
  );
}

export function buildLiveKitToolDefinitions(
  inference: CompiledInference<any>,
): LiveKitToolDefinition[] {
  const definitions = new Map<string, LiveKitToolDefinition>();

  for (const action of inference.tools) {
    definitions.set(action.name, {
      type: "function",
      name: action.name,
      description: action.description ?? "",
      parameters: action.inputSchema
        ? z.toJSONSchema(action.inputSchema)
        : { type: "object", properties: {}, additionalProperties: false },
    });
  }

  return [...definitions.values()];
}

export function buildLiveKitToolContext<TDataContent = never>(
  inference: CompiledInference<TDataContent>,
  connection: LiveKitConnection<TDataContent>,
): LiveKitToolContext {
  const tools: LiveKitToolContext = {};

  for (const action of inference.tools) {
    tools[action.name] = createLiveKitTool({
      description: action.description ?? "",
      parameters: action.inputSchema ?? z.object({}),
      execute: (input, liveKitContext) => connection.executeTool(action.name, input, liveKitContext),
    });
  }

  return tools;
}

function createLiveKitTool({
  description,
  parameters,
  execute,
}: {
  description: string;
  parameters: unknown;
  execute: (input: unknown, context?: unknown) => unknown | Promise<unknown>;
}): LiveKitFunctionTool {
  return (llm.tool as (tool: {
    description: string;
    parameters: unknown;
    execute: (input: unknown, context?: unknown) => unknown | Promise<unknown>;
  }) => unknown)({ description, parameters, execute }) as LiveKitFunctionTool;
}

function buildToolRegistry(actions: AnyAction[]): Map<string, AnyAction> {
  const registry = new Map<string, AnyAction>();
  for (const action of actions) {
    registry.set(action.name, action);
  }
  return registry;
}

function renderSection(title: string, parts: readonly ContentPart<any>[]): string {
  const body = renderContentPartsForText(parts);
  return body ? `## ${title}\n\n${body}` : "";
}

function renderHistory<TDataContent>(
  history: FrameMessage<TDataContent>[],
  messageToText?: (message: ActorMessage<TDataContent>) => string | undefined,
): string {
  const lines = history
    .filter(isActorMessage<TDataContent>)
    .map((message) => renderHistoryMessage(message, messageToText))
    .filter(Boolean);
  return lines.length > 0 ? `## Conversation\n\n${lines.join("\n")}` : "";
}

function renderHistoryMessage<TDataContent>(
  message: ActorMessage<TDataContent>,
  messageToText?: (message: ActorMessage<TDataContent>) => string | undefined,
): string {
  if (message.type === "user") return `User: ${renderActorText(message, messageToText)}`;
  if (message.type === "assistant") return `Assistant: ${renderActorText(message, messageToText)}`;
  const value = message.text ?? stringifyValue(message.value);
  return value ? `Tool ${message.name}: ${value}` : "";
}

function userTextsFromFrames<TDataContent>(
  frames: readonly Frame<TDataContent>[],
  messageToText?: (message: ActorMessage<TDataContent>) => string | undefined,
): Array<{ frameId: string; text: string }> {
  const texts: Array<{ frameId: string; text: string }> = [];
  for (const frame of frames) {
    for (const message of frame.messages) {
      if (!isActorMessage<TDataContent>(message) || message.type !== "user") continue;
      const text = renderActorText(message, messageToText);
      if (!text.trim()) continue;
      texts.push({ frameId: frame.id, text });
    }
  }
  return texts;
}

function renderActorText<TDataContent>(
  message: ActorMessage<TDataContent>,
  messageToText?: (message: ActorMessage<TDataContent>) => string | undefined,
): string {
  const rendered = messageToText?.(message);
  if (rendered !== undefined) return rendered;
  if (message.type === "tool") {
    const renderedContent = message.content?.length
      ? renderContentPartsForText(message.content)
      : "";
    const value = message.text ?? (renderedContent || stringifyValue(message.value));
    return value ? `Tool ${message.name}: ${value}` : `Tool ${message.name}`;
  }
  if (message.content?.length) {
    return renderContentPartsForText(message.content);
  }
  if (message.text !== undefined) {
    return message.text;
  }
  throw new Error(
    `Cannot render ${message.type} message with non-string content. Provide messageToText or text.`,
  );
}

function renderContentPartsForText(parts: readonly ContentPart<any>[]): string {
  return parts
    .map(renderContentPartForText)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function renderContentPartForText(part: ContentPart<any>): string {
  if (part.type === "text") return part.text;
  if (part.type === "data") {
    const label = part.label ? `${part.label}: ` : "";
    return `${label}${stringifyValue(part.data)}`;
  }
  const label = part.label ? `${part.label}; ` : "";
  return `[Image content unavailable in LiveKit text prompt: ${label}mediaType=${part.mediaType}; data=${describeImageData(part.data)}]`;
}

function describeImageData(data: Extract<ContentPart<any>, { type: "image" }>["data"]): string {
  if (data instanceof URL) return data.toString();
  if (typeof data === "string") {
    if (data.startsWith("data:")) return "data URL";
    return data.length > 120 ? `${data.slice(0, 120)}...` : data;
  }
  if (data instanceof Uint8Array) return `${data.byteLength} bytes`;
  return `${data.byteLength} bytes`;
}

function extractConversationItemText(item: Record<string, unknown>): string | undefined {
  const textContent = readString(item, "textContent");
  if (textContent) return textContent;

  const content = item["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }

    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const text = readString(record, "text") ?? readString(record, "transcript");
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function eventMetadata(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object") return {};
  const record = event as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  const createdAt = record["createdAt"];
  if (createdAt !== undefined) metadata.createdAt = createdAt;
  const speakerId = record["speakerId"];
  if (speakerId !== undefined) metadata.speakerId = speakerId;
  const language = record["language"];
  if (language !== undefined) metadata.language = language;
  return metadata;
}

function readObject(source: unknown, key: string): Record<string, unknown> | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(source: unknown, key: string): boolean | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringifyValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
