import type { z } from "zod";

export type ProjectionMode = "hidden" | "augment" | "replace";

export type StaticProjection = {
  mode?: ProjectionMode;
  instructions?: "system" | "dynamic" | "hidden";
  tools?: "provider-static" | "hidden";
};

export type StaticBoundaryProjection = {
  mode?: ProjectionMode;
};

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

export type ProjectionDraft<TDataContent = never> = {
  systemParts: ProjectionPart<TDataContent>[];
  dynamicParts: ProjectionPart<TDataContent>[];
  tools: AnyAction[];
  states: ProjectionStatePart[];
};

export type ProjectionSource<TDataContent = never> = {
  readonly instructions?: string;
  readonly systemParts: readonly ProjectionPart<TDataContent>[];
  readonly dynamicParts: readonly ProjectionPart<TDataContent>[];
  readonly tools: readonly AnyAction[];
  readonly states: readonly ProjectionStatePart[];
};

export type ProjectionCallSite = "node" | "boundary";

export type ProjectionContext<TDataContent = never> = {
  callSite: ProjectionCallSite;
  runtimeInstanceId: RuntimeInstanceId;
  address: RuntimeAddress;
  target?: Generator;
  node: Node<TDataContent>;
};

export type ProjectionFunctionMethod<TDataContent = never> = {
  bivarianceHack(
    ctx: ProjectionContext<TDataContent>,
    draft: ProjectionDraft<TDataContent>,
    source: ProjectionSource<TDataContent>,
  ): void;
}["bivarianceHack"];

export type ProjectionFunction<TDataContent = never> = {
  kind: "projection";
  name: string;
  method: ProjectionFunctionMethod<TDataContent>;
};

export type Projection<TDataContent = never> =
  | StaticProjection
  | ProjectionFunctionRef
  | ProjectionFunction<TDataContent>;

export type BoundaryProjection<TDataContent = never> =
  | StaticBoundaryProjection
  | ProjectionFunctionRef
  | ProjectionFunction<TDataContent>;

export type HistoryProjectionFunctionRef = Ref;

export type HistoryProjectionContext<TDataContent = never> = {
  target: Generator;
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  trigger: RuntimeTrigger;
  history: Frame<TDataContent>[];
  states: Record<StateKey, unknown>;
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

export type GeneratorId = string;
export type RuntimeInstanceId = string;
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

export type AudienceTarget = RuntimeAddress;

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

export type ToolMessage<TDataContent = never> = {
  type: "tool";
  name: string;
  text?: string;
  content?: ContentPart<TDataContent>[];
  value?: unknown;
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type ActorMessage<TDataContent = never> =
  | UserMessage<TDataContent>
  | AssistantMessage<TDataContent>
  | ToolMessage<TDataContent>;

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
};

export type ComponentRuntime = { type: "component" };
export type PrimaryRuntime<TDataContent = never> = {
  type: "primary";
  boundaryProjection: BoundaryProjection<TDataContent>;
} & TriggeredRuntimeOptions<TDataContent>;
export type WorkerRuntime<TDataContent = never> = {
  type: "worker";
  boundaryProjection: BoundaryProjection<TDataContent>;
} & TriggeredRuntimeOptions<TDataContent>;

export type Runtime<TDataContent = never> =
  | { type?: "component" }
  | ({
      type: "primary";
      boundaryProjection?: BoundaryProjection<TDataContent>;
    } & TriggeredRuntimeOptions<TDataContent>)
  | ({
      type: "worker";
      boundaryProjection?: BoundaryProjection<TDataContent>;
    } & TriggeredRuntimeOptions<TDataContent>);

export type NormalizedRuntime<TDataContent = never> =
  | ComponentRuntime
  | PrimaryRuntime<TDataContent>
  | WorkerRuntime<TDataContent>;

type DryTriggeredRuntimeOptions = Omit<
  TriggeredRuntimeOptions,
  "historyProjection"
> & {
  historyProjection?: DryHistoryProjection;
};

export type DryProjection = StaticProjection | Ref;
export type DryBoundaryProjection = StaticBoundaryProjection | Ref;

export type DryHistoryProjection = ActorHistoryProjection | MessageHistoryProjection | Ref;

export type DryRuntime =
  | { type?: "component" }
  | ({
      type: "primary";
      boundaryProjection?: DryBoundaryProjection;
    } & DryTriggeredRuntimeOptions)
  | ({
      type: "worker";
      boundaryProjection?: DryBoundaryProjection;
    } & DryTriggeredRuntimeOptions);

export type StateProjection = "system" | "dynamic" | "retrieval" | "hidden";

export type StateDescriptor<S = unknown> = {
  key: string;
  schema: z.ZodType<S>;
  init?: S | (() => S);
  scope?: "top" | "local";
  onInitConflict?: "error" | "replace";
  projection?: StateProjection;
};

export type NormalizedStateDescriptor<S = unknown> = StateDescriptor<S> & {
  scope: "top" | "local";
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

type ActionStateContext<S> = IsAny<S> extends true
  ? {
      state?: S;
      updateState?(update: StateUpdate<S>): void;
    }
  : [S] extends [undefined]
  ? {
      state?: undefined;
      updateState?: undefined;
    }
  : {
      state?: S;
      updateState?(update: StateUpdate<S>): void;
    };

export type ActionInstanceContext<TDataContent = never> = {
  runtimeInstanceId: RuntimeInstanceId;
  address: RuntimeAddress;
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
> = {
  getState?: (address: InferenceStateAddress) => unknown;
  instance: ActionInstanceContext<TDataContent>;
} & ActionStateContext<S>;

export type Action<
  S = undefined,
  I = unknown,
  O = unknown,
  TName extends string = string,
  TDataContent = never,
> = {
  state: StateDescriptor<S> | null;
  name: TName;
  description?: string;
  inputSchema?: z.ZodType<I>;
  run?: (input: I, ctx: ActionContext<S, TDataContent>) => O | Promise<O>;
};

export type AnyAction = {
  state: StateDescriptor<any> | null;
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
  instructions?: string;
  stateless?: boolean;
  tools?: ActionConfigEntry[];
  commands?: ActionConfigEntry[];
  state?: StateDescriptor;
  members?: Node<TDataContent>[];
  output?: OutputConfig<TDataContent>;
  projection?: Projection<TDataContent>;
  runtime?: Runtime<TDataContent>;
};

export type Node<TDataContent = never> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  stateless: boolean;
  toolBindings: ActionBindings;
  toolRefs: ActionRef[];
  commandBindings: ActionBindings;
  commandRefs: ActionRef[];
  state?: NormalizedStateDescriptor;
  members: Node<TDataContent>[];
  output?: OutputConfig<TDataContent>;
  projection: Projection<TDataContent>;
  runtime: NormalizedRuntime<TDataContent>;
};

export type Instance<TDataContent = never> = {
  id: string;
  node: Node<TDataContent>;
  states?: Record<string, StateContainer>;
  children?: Instance<TDataContent>[];
};

export type CompletionReason = "done" | "cancelled" | "delegated" | "error";

export type WorkCompletionReason = "end-turn" | "done" | "cancelled" | "delegated";

export type WorkActivationMessage = {
  type: "work";
  kind: "activation";
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
  generatorId: GeneratorId;
  sourceFrameId: string;
  concurrencyKey: string;
  concurrency: RuntimeConcurrency;
};

export type WorkCompletionMessage = {
  type: "work";
  kind: "completion";
  activationId: string;
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

export type CommandMessage = {
  type: "command";
  name: string;
  input: unknown;
  target?: RuntimeAddress;
  clientId?: string;
};

export type FrameMessage<TDataContent = never> = (
  | ActorMessage<TDataContent>
  | CommandMessage
  | InstanceMessage<TDataContent>
  | WorkMessage
) &
  Record<string, unknown>;

export type FrameDraft<TDataContent = never> = {
  generatorId?: string;
  runtimeInstanceId?: RuntimeInstanceId;
  activationId?: string;
  inert?: boolean;
  messages: FrameMessage<TDataContent>[];
  metadata?: Record<string, unknown>;
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
) => Frame<TDataContent> | Promise<Frame<TDataContent>>;

export type ExecutorRunRequest<TDataContent = never> = {
  generatorId: string;
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
  inference: CompiledInference<TDataContent>;
  enqueueFrame: EnqueueFrame<TDataContent>;
  createActionContext?: (action: AnyAction) => ActionContext<unknown, TDataContent>;
  output?: OutputConfig<TDataContent>;
  signal?: AbortSignal;
};

export type ExecutorRunResult<TDataContent = never> = {
  completionReason: CompletionReason;
  value?: string;
  frames?: Array<FrameDraft<TDataContent> | Frame<TDataContent>>;
};

export type ExecutorRealizePromptRequest<TDataContent = never> = Pick<
  ExecutorRunRequest<TDataContent>,
  "generatorId" | "activationId" | "runtimeInstanceId" | "inference" | "output"
>;

export type ExecutorRealizedPrompt = {
  provider: string;
  input: unknown;
};

export type ProjectorExecutor<TDataContent = never> = {
  run(
    request: ExecutorRunRequest<TDataContent>,
  ): ExecutorRunResult<TDataContent> | Promise<ExecutorRunResult<TDataContent>>;
  realizePrompt(
    request: ExecutorRealizePromptRequest<TDataContent>,
  ): ExecutorRealizedPrompt | Promise<ExecutorRealizedPrompt>;
};

export type Executor<TDataContent = never> =
  ProjectorExecutor<TDataContent>;

export type Charter<TDataContent = never> = {
  key?: string;
  version?: string;
  executor: ProjectorExecutor<TDataContent>;
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
  executor: ProjectorExecutor<TDataContent>;
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

export type RuntimeAddress =
  | { type: "instance"; instanceId: string }
  | { type: "member"; ownerInstanceId: string; memberPath: string[] };

export type GeneratorKind = "primary" | "worker";

export type Generator = {
  id: GeneratorId;
  kind: GeneratorKind;
  runtimeInstanceId: RuntimeInstanceId;
};

export type SerializedStateDescriptor = {
  key: string;
  scope?: "top" | "local";
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
  instructions?: string;
  stateless?: boolean;
  tools?: DryAction[];
  commands?: DryAction[];
  state?: SerializedStateDescriptor | Ref;
  members?: Array<DryNode<TDataContent> | Ref>;
  output?: SerializedOutputConfig;
  projection?: DryProjection;
  runtime?: DryRuntime;
};

export type SerializedInstance<TDataContent = never> = {
  id: InstanceId;
  node: DryNode<TDataContent> | Ref;
  states?: Record<StateKey, StateContainer>;
  children?: SerializedInstance<TDataContent>[];
};

export type SerializedOutputConfig = {
  audience?: Audience;
  schema?: unknown;
};
