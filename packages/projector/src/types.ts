import type { z } from "zod";
import type { AnyParamsSchema, JsonObject } from "./params.ts";

export type ProjectionMode = "hidden" | "augment" | "replace";

export type StandardProjectionConfig = {
  mode?: ProjectionMode;
  instructions?: "system" | "dynamic" | "hidden";
  tools?: "provider-static" | "hidden";
};

export type ResolvedStandardProjectionConfig = Required<StandardProjectionConfig>;

export type Ref = string;
export type ProjectionFunctionRef = Ref;
export type StateDescriptorRef = Ref;

export type TextContentPart = { type: "text"; text: string };

export type ImageContentPart = {
  type: "image";
  data: string | Uint8Array | ArrayBuffer | URL;
  mediaType: string;
  label?: string;
};

export type DataContentPart<TDataContent = never> = {
  type: "data";
  data: TDataContent;
  label?: string;
};

export type ContentPart<TDataContent = never> =
  | TextContentPart
  | ImageContentPart
  | DataContentPart<TDataContent>;

export type ProjectionTextPart = TextContentPart;
export type ProjectionImagePart = ImageContentPart;
export type ProjectionDataPart<TDataContent = never> = DataContentPart<TDataContent>;

export type ProjectionStatePart = {
  type: "state";
  section: "system" | "dynamic" | "retrieval";
  stateKey: string;
  target: StateAddress;
  value: unknown;
};

export type ProjectionPart<TDataContent = never> =
  | ContentPart<TDataContent>
  | ProjectionStatePart;

export type ProjectionIR<TDataContent = never> = {
  systemParts: ProjectionPart<TDataContent>[];
  dynamicParts: ProjectionPart<TDataContent>[];
  tools: AnyAction[];
  states: ProjectionStatePart[];
};

export type ReadonlyProjectionIR<TDataContent = never> = {
  readonly systemParts: readonly ProjectionPart<TDataContent>[];
  readonly dynamicParts: readonly ProjectionPart<TDataContent>[];
  readonly tools: readonly AnyAction[];
  readonly states: readonly ProjectionStatePart[];
};

export type ProjectionSource<TDataContent = never> = {
  readonly node?: Node<TDataContent>;
  readonly ir?: ReadonlyProjectionIR<TDataContent>;
};

export type ProjectionCallSite = "node" | "boundary";

export type ProjectionContext<TDataContent = never> = {
  callSite: ProjectionCallSite;
  generatorId: GeneratorId;
  address: ProjectionAddress;
  targetGeneratorId?: GeneratorId;
  originNode: Node<TDataContent>;
  params: JsonObject;
  createNodeIR(): ProjectionIR<TDataContent>;
};

export type ProjectionFunctionMethod<TDataContent = never> = {
  bivarianceHack(
    ctx: ProjectionContext<TDataContent>,
    draft: ProjectionIR<TDataContent>,
    source: ProjectionSource<TDataContent>,
  ): void;
}["bivarianceHack"];

export type ProjectionFunction<TDataContent = never> = {
  kind: "projection";
  name: string;
  standard?: ResolvedStandardProjectionConfig;
  method: ProjectionFunctionMethod<TDataContent>;
};

export type Projection<TDataContent = never> =
  | ProjectionFunctionRef
  | ProjectionFunction<TDataContent>;

export type HistoryProjectionFunctionRef = Ref;

export type HistoryProjectionContext<TDataContent = never> = {
  generatorId: GeneratorId;
  activationId: string;
  trigger: RuntimeTrigger;
  history: Frame<TDataContent>[];
  states: Record<StateKey, unknown>;
  params: JsonObject;
};

export type HistoryProjectionFunctionMethod<TDataContent = never> = {
  bivarianceHack(
    ctx: HistoryProjectionContext<TDataContent>,
  ): FrameMessage<TDataContent>[];
}["bivarianceHack"];

export type HistoryProjectionFunction<TDataContent = never> = {
  kind: "historyProjection";
  name: string;
  method: HistoryProjectionFunctionMethod<TDataContent>;
};

export type ActorHistoryProjection = { type: "actor" };
export type MessageHistoryProjection = { type: "messages" };
export type HistoryProjection<TDataContent = never> =
  | ActorHistoryProjection
  | MessageHistoryProjection
  | HistoryProjectionFunctionRef
  | HistoryProjectionFunction<TDataContent>;

export type ContributorId = string;
export type GeneratorId = ContributorId;
export type InstanceId = string;
export type StateKey = string;

export type StateAddress = {
  instanceId: InstanceId;
  stateKey: StateKey;
};

export type InferenceStateAddress = string;

export type RetrievableState = {
  address: InferenceStateAddress;
  target: StateAddress;
};

export type AudienceTarget = ProjectionAddress;

export type Audience = "self" | "broadcast" | AudienceTarget | AudienceTarget[];

export type MessageDelivery = "immediate" | "queued";

export type UserMessage<TDataContent = never> = {
  type: "user";
  text?: string;
  content?: ContentPart<TDataContent>[];
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type AssistantMessage<TDataContent = never> = {
  type: "assistant";
  text?: string;
  content?: ContentPart<TDataContent>[];
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type ActorMessage<TDataContent = never> =
  | UserMessage<TDataContent>
  | AssistantMessage<TDataContent>;

export type AnyActorMessage = ActorMessage<any>;

export type RuntimeTrigger =
  | { type: "spawn" }
  | { type: "actor-frame" }
  | { type: "parent-activation" }
  | { type: "parent-completion" };

export type RuntimeConcurrency = "serial" | "parallel";
export type ActivationHistory = "live" | "snapshot";

export type TriggeredRuntimeOptions<TDataContent = never> = {
  trigger: RuntimeTrigger;
  concurrency?: RuntimeConcurrency;
  activationHistory?: ActivationHistory;
  historyProjection?: HistoryProjection<TDataContent>;
  boundaryProjection?: Projection<TDataContent>;
  outputAudienceDefault?: "self" | "broadcast";
};

export type ComponentRuntime = { type: "component" };
export type GeneratorRuntime<TDataContent = never> = {
  type: "generator";
  boundaryProjection: Projection<TDataContent>;
} & TriggeredRuntimeOptions<TDataContent>;

export type Runtime<TDataContent = never> =
  | { type?: "component" }
  | ({
      type?: "generator";
    } & TriggeredRuntimeOptions<TDataContent>);

export type NormalizedRuntime<TDataContent = never> =
  | ComponentRuntime
  | GeneratorRuntime<TDataContent>;

type DryTriggeredRuntimeOptions = Omit<
  TriggeredRuntimeOptions,
  "boundaryProjection" | "historyProjection"
> & {
  historyProjection?: DryHistoryProjection;
};

export type DryHistoryProjection = ActorHistoryProjection | MessageHistoryProjection | Ref;

export type DryRuntime =
  | { type?: "component" }
  | ({
      type: "generator";
      boundaryProjection?: Ref;
      outputAudienceDefault?: "self" | "broadcast";
    } & DryTriggeredRuntimeOptions);

export type StateProjection = "system" | "dynamic" | "retrieval" | "hidden";

export type StateDescriptor<S = unknown> = {
  key: string;
  schema: z.ZodType<S>;
  init?: S | (() => S);
  scope?: "hoist" | "local";
  onInitConflict?: "error" | "replace";
  projection?: StateProjection;
};

export type NormalizedStateDescriptor<S = unknown> = StateDescriptor<S> & {
  scope: "hoist" | "local";
  onInitConflict: "error" | "replace";
  projection: StateProjection;
};

export type StateContainer<S = unknown> = {
  value: S;
};

type IsAny<T> = 0 extends (1 & T) ? true : false;

export type StatePatch<S> = IsAny<S> extends true
  ? Record<string, unknown>
  : [unknown] extends [S]
      ? Record<string, unknown>
      : S extends object
        ? Partial<S>
        : never;

export type StatePath = readonly (string | number)[];

export type StateUpdate<S = unknown> =
  | {
      op: "replace";
      value: S;
    }
  | {
      op: "patch";
      value: StatePatch<S>;
      path?: StatePath;
    }
  | {
      op: "append";
      path?: StatePath;
      values: unknown[];
    };

export type StateUpdateInput<S = unknown> =
  | StateUpdate<S>
  | ((state: S) => StateUpdate<S>);

type ActionStateContext<S> = IsAny<S> extends true
  ? {
      state?: S;
      updateState?(update: StateUpdateInput<S>): void;
    }
  : [S] extends [undefined]
  ? {
      state?: undefined;
      updateState?: undefined;
    }
  : {
      state?: S;
      updateState?(update: StateUpdateInput<S>): void;
    };

export type ActionInstanceContext<TDataContent = never> = {
  generatorId: GeneratorId;
  address: ProjectionAddress;
  ownerInstanceId: InstanceId;
  spawn(
    node: Node<TDataContent>,
    options?: {
      states?: Record<StateKey, unknown>;
      children?: SpawnChild<TDataContent>[];
    },
  ): void;
  cede(node?: Node<TDataContent>): void;
  transition(
    node: Node<TDataContent>,
    options?: { states?: Record<StateKey, unknown> },
  ): void;
};

export type ActionContext<
  S = undefined,
  TDataContent = never,
  TParams extends JsonObject = {},
> = {
  params: TParams;
  getState?: (address: InferenceStateAddress) => unknown;
  instance: ActionInstanceContext<TDataContent>;
} & ActionStateContext<S>;

export type Action<
  S = undefined,
  I = unknown,
  O = unknown,
  TName extends string = string,
  TDataContent = never,
  TParams extends AnyParamsSchema = AnyParamsSchema,
> = {
  state: StateDescriptor<S> | null;
  params?: TParams;
  name: TName;
  description?: string;
  inputSchema?: z.ZodType<I>;
  run?: (input: I, ctx: ActionContext<S, TDataContent, z.output<TParams>>) => O | Promise<O>;
};

export type AnyAction<TParams extends AnyParamsSchema = AnyParamsSchema> = {
  state: StateDescriptor<any> | null;
  params?: TParams;
  name: string;
  description?: string;
  inputSchema?: z.ZodType<any>;
  run?: (input: any, ctx: any) => any | Promise<any>;
};

export type ActionRef = string;
export type ActionConfigEntry = AnyAction | ActionRef;
export type ActionBindings = Record<string, AnyAction>;

export type NodeConfig<TDataContent = never> = {
  key?: string;
  sourceNodeKey?: string;
  name?: string;
  params?: AnyParamsSchema;
  instructions?: string;
  tools?: ActionConfigEntry[];
  commands?: ActionConfigEntry[];
  state?: StateDescriptor;
  members?: Node<TDataContent>[];
  output?: OutputConfig<TDataContent>;
  projection?: Projection<TDataContent>;
  runtime?: Runtime<TDataContent>;
  /** Per-executor config, namespaced by executor identity name. Plain JSON. */
  executorConfig?: ExecutorConfig;
};

export type Node<
  TDataContent = never,
  TParams extends AnyParamsSchema = AnyParamsSchema,
> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  params: TParams;
  instructions?: string;
  toolBindings: ActionBindings;
  toolRefs: ActionRef[];
  commandBindings: ActionBindings;
  commandRefs: ActionRef[];
  state?: NormalizedStateDescriptor;
  members: Node<TDataContent>[];
  output?: OutputConfig<TDataContent>;
  projection: Projection<TDataContent>;
  runtime: NormalizedRuntime<TDataContent>;
  executorConfig?: ExecutorConfig;
};

export type Instance<TDataContent = never> = {
  id: InstanceId;
  node: Node<TDataContent>;
  isSource?: boolean;
  params?: JsonObject;
  states?: Record<string, StateContainer>;
  children?: Instance<TDataContent>[];
};

export type CompletionReason = "done" | "cancelled" | "delegated" | "error" | "terminal-action";

export type WorkCompletionReason = "end-turn" | "done" | "cancelled" | "delegated" | "error" | "terminal-action" | "absorbed";

export type WorkActivationMessage = {
  type: "work";
  kind: "activation";
  activationId: string;
  generatorId: GeneratorId;
  sourceFrameId: string;
  concurrencyKey: string;
  concurrency: RuntimeConcurrency;
};

export type WorkCompletionMessage = {
  type: "work";
  kind: "completion";
  activationId: string;
  /**
   * The generator whose work completed. Optional for completions that pair
   * with an activation message already in the log; required to record a
   * completion for work that was never scheduled through the machine (e.g.
   * realtime turns).
   */
  generatorId?: GeneratorId;
  sourceFrameId?: string;
  reason: WorkCompletionReason;
};

export type WorkMessage = WorkActivationMessage | WorkCompletionMessage;

export type SerializedNodeRef<TDataContent = never> =
  | DryNode<TDataContent>
  | Ref;

/**
 * Durable instance messages use serialized node refs. Hydrated Node objects belong
 * in the live machine tree, not in frames that may be persisted and resumed.
 */
export type SpawnChild<TDataContent = never> = {
  id?: InstanceId;
  node: SerializedNodeRef<TDataContent>;
  states?: Record<StateKey, unknown>;
  children?: SpawnChild<TDataContent>[];
};

export type InstanceMessage<TDataContent = never> =
  | {
      type: "instance";
      kind: "state.update";
      instanceId: InstanceId;
      stateKey: StateKey;
      update: StateUpdate;
    }
  | {
      type: "instance";
      kind: "transition";
      instanceId: InstanceId;
      node: SerializedNodeRef<TDataContent>;
      states?: Record<StateKey, unknown>;
    }
  | {
      type: "instance";
      kind: "spawn";
      parentInstanceId: InstanceId;
      children: SpawnChild<TDataContent>[];
    }
  | {
      type: "instance";
      kind: "attach";
      parentInstanceId: InstanceId;
      children: SerializedInstance<TDataContent>[];
    }
  | {
      type: "instance";
      kind: "remove";
      instanceId: InstanceId;
      reason?: "removed" | "cede" | "cancelled";
    };

export type ActionKind = "command" | "tool";

export type ActionRequestMessage = {
  type: "action";
  kind: "request";
  action: ActionKind;
  name: string;
  input: unknown;
  target?: ProjectionAddress;
  callId: string;
  audience?: Audience;
};

export type ActionResultMessage<TDataContent = never> = {
  type: "action";
  kind: "result";
  action: ActionKind;
  name: string;
  callId: string;
  target?: ProjectionAddress;
  success: boolean;
  value?: unknown;
  error?: string;
  terminal?: boolean;
  outputMessageIndices?: number[];
  audience?: Audience;
};

export type ActionMessage<TDataContent = never> =
  | ActionRequestMessage
  | ActionResultMessage<TDataContent>;

export type ExecuteActionResult<T = unknown, TDataContent = never> =
  | { success: true; value?: T; messages?: FrameMessage<TDataContent>[]; terminal?: boolean; callId: string }
  | { success: false; error: string; value?: T; messages?: FrameMessage<TDataContent>[]; terminal?: boolean; callId: string };

export type FrameMessage<TDataContent = never> = (
  | ActorMessage<TDataContent>
  | ActionMessage<TDataContent>
  | InstanceMessage<TDataContent>
  | WorkMessage
) &
  Record<string, unknown>;

export type ExecutorIdentity = {
  name: string;
  version?: string;
};

/**
 * Execution facts an executor reports alongside the frames it produces —
 * latency, token usage, cost, the model that actually ran. Open-keyed so
 * executors can attach transport-specific extras (mode, provider request ids).
 */
export type ExecutionReport = {
  latencyMs?: number;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  cost?: { amount: number; currency: string };
} & Record<string, unknown>;

export type FrameProducer =
  | { executor: ExecutorIdentity }
  | { machine: string };

/**
 * Framework-owned observational channel. Written only by the framework at
 * frame-production boundaries (executors report via the enqueue report arg);
 * never read by the fold: `fold(charter, frames)` and
 * `fold(charter, stripProvenance(frames))` are identical by construction.
 * Persistence may drop it — doing so costs forensics, never correctness.
 */
export type FrameProvenance = {
  producer?: FrameProducer;
  execution?: ExecutionReport;
  /** The runner/claim that hosted production (workerId, leaseId, host…). */
  runner?: Record<string, unknown>;
};

export type FrameDraft<TDataContent = never> = {
  generatorId?: GeneratorId;
  activationId?: string;
  inert?: boolean;
  messages: FrameMessage<TDataContent>[];
  provenance?: FrameProvenance;
};

export type Frame<TDataContent = never> = FrameDraft<TDataContent> & {
  id: string;
};

/**
 * Output configuration for implicit LLM text responses.
 * @typeParam TDataContent - The application data content type this output maps to.
 */
export type OutputConfig<TDataContent = never> = {
  audience?: Audience;
  schema?: z.ZodType<TDataContent>;
  mapTextBlock?: (text: string) => TDataContent;
};

export type AnyOutputConfig = OutputConfig<any>;

export type EnqueueFrame<TDataContent = never> = (
  frame: FrameDraft<TDataContent>,
  report?: ExecutionReport,
) => Frame<TDataContent>;

export type ExecutorRunRequest<TDataContent = never> = {
  activationId: string;
  generatorId: GeneratorId;
  /** The generator node's `executorConfig` namespace for this executor. */
  config?: unknown;
  inference: CompiledInference<TDataContent>;
  enqueueFrame: EnqueueFrame<TDataContent>;
  createActionContext?: (action: AnyAction) => ActionContext<unknown, TDataContent>;
  output?: OutputConfig<TDataContent>;
  signal?: AbortSignal;
  /**
   * Re-projects the inference against the current frame log (visibility rules
   * applied, this activation's own frames excluded). Executors that support
   * multi-step runs should call this before each step; every frame returned by
   * a refresh is treated as seen by this activation and its pending work is
   * absorbed on completion.
   */
  refreshInference?: () => CompiledInference<TDataContent>;
};

export type ExecutorRunResult<TDataContent = never> = {
  completionReason: CompletionReason;
  value?: string;
  frames?: Array<FrameDraft<TDataContent> | Frame<TDataContent>>;
  /**
   * Run-level execution facts (latency, usage, cost). The machine folds these
   * into the provenance of the frames it synthesizes from this result and the
   * run's completion frame.
   */
  execution?: ExecutionReport;
};

export type ExecutorRealizePromptRequest<TDataContent = never> = Pick<
  ExecutorRunRequest<TDataContent>,
  "generatorId" | "activationId" | "config" | "inference" | "output"
>;

export type ExecutorRealizedPrompt = {
  provider: string;
  input: unknown;
};

/**
 * Executor packages register their node-level config types here via
 * declaration merging, keyed by their identity name:
 *
 *   declare module "@projectors/core" {
 *     interface ExecutorConfigRegistry { aisdk: AisdkExecutorNodeConfig }
 *   }
 *
 * A type-only import of the executor package is enough to typecheck a
 * charter's `executorConfig` — the charter stays plain serializable data.
 */
export interface ExecutorConfigRegistry {}

export type ExecutorConfig = {
  [K in keyof ExecutorConfigRegistry]?: ExecutorConfigRegistry[K];
} & Record<string, unknown>;

export type ProjectorExecutor<TDataContent = never> = {
  /**
   * Reported into frame provenance by the machine — executors never write
   * provenance directly. Anonymous executors produce unattributed frames.
   * The identity name is also the executor's `executorConfig` namespace key.
   */
  identity?: ExecutorIdentity;
  /**
   * Validates each node's `executorConfig[identity.name]` at machine creation
   * so misconfiguration fails at bind time, not mid-activation.
   */
  configSchema?: z.ZodType<unknown>;
  run(
    request: ExecutorRunRequest<TDataContent>,
  ): ExecutorRunResult<TDataContent> | Promise<ExecutorRunResult<TDataContent>>;
  realizePrompt(
    request: ExecutorRealizePromptRequest<TDataContent>,
  ): ExecutorRealizedPrompt | Promise<ExecutorRealizedPrompt>;
};

export type Executor<TDataContent = never> =
  ProjectorExecutor<TDataContent>;

export type Charter<
  TDataContent = never,
  TParams extends AnyParamsSchema = AnyParamsSchema,
> = {
  key?: string;
  version?: string;
  params: TParams;
  nodes: Record<string, Node<TDataContent>>;
  tools: Record<string, AnyAction>;
  commands: Record<string, AnyAction>;
  states: Record<string, NormalizedStateDescriptor>;
  projections: Record<string, ProjectionFunction<TDataContent>>;
  historyProjections: Record<string, HistoryProjectionFunction<TDataContent>>;
};

export type CharterConfig<TDataContent = never> = {
  key?: string;
  version?: string;
  params?: AnyParamsSchema;
  nodes: readonly Node<TDataContent>[];
  tools: readonly AnyAction[];
  commands: readonly AnyAction[];
  states: readonly StateDescriptor[];
  projections: readonly ProjectionFunction<TDataContent>[];
  historyProjections?: readonly HistoryProjectionFunction<TDataContent>[];
};

export type CompiledInference<TDataContent = never> = {
  systemParts: ContentPart<TDataContent>[];
  history: FrameMessage<TDataContent>[];
  dynamicParts: ContentPart<TDataContent>[];
  tools: AnyAction[];
  retrievableStates: RetrievableState[];
};

export type ProjectionAddress =
  | { type: "instance"; instanceId: string }
  | { type: "member"; ownerInstanceId: string; memberPath: string[] };

export type SerializedStateDescriptor = {
  key: string;
  scope?: "hoist" | "local";
  onInitConflict?: "error" | "replace";
  projection?: StateProjection;
  init?: unknown;
  schema: unknown;
};

export type DryAction = Ref;

export type DryNode<TDataContent = never> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  params?: unknown;
  instructions?: string;
  tools?: DryAction[];
  commands?: DryAction[];
  state?: SerializedStateDescriptor | Ref;
  members?: Array<DryNode<TDataContent> | Ref>;
  output?: SerializedOutputConfig;
  projection?: Ref;
  runtime?: DryRuntime;
  executorConfig?: Record<string, unknown>;
};

export type SerializedInstance<TDataContent = never> = {
  id: InstanceId;
  node: DryNode<TDataContent> | Ref;
  isSource?: boolean;
  params?: JsonObject;
  states?: Record<StateKey, StateContainer>;
  children?: SerializedInstance<TDataContent>[];
};

export type SerializedOutputConfig = {
  audience?: Audience;
  schema?: unknown;
};
