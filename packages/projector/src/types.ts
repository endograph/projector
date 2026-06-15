import type { z } from "zod";

export type ProjectionMode = "hidden" | "augment" | "replace";

export type StaticProjection = {
  mode?: ProjectionMode;
  instructions?: "system" | "dynamic" | "hidden";
  tools?: "provider-static" | "hidden";
};

export type Ref = string;
export type ProjectionFunctionRef = Ref;
export type StateDescriptorRef = Ref;

export type ProjectionContext = {
  runtimeInstanceId: RuntimeInstanceId;
  instanceId: InstanceId;
  node: Node;
};

export type ProjectionFunction = (ctx: ProjectionContext) => StaticProjection;

export type Projection = StaticProjection | ProjectionFunctionRef | ProjectionFunction;

export type HistoryProjectionFunctionRef = Ref;

export type HistoryProjectionContext = {
  target: Generator;
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  trigger: RuntimeTrigger;
  history: Frame[];
  states: Record<StateKey, unknown>;
};

export type HistoryProjectionFunction = (
  ctx: HistoryProjectionContext,
) => ActorMessage[];

export type ActorHistoryProjection = { type: "actor" };
export type HistoryProjection =
  | ActorHistoryProjection
  | HistoryProjectionFunctionRef
  | HistoryProjectionFunction;

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

export type RuntimeTrigger =
  | { type: "spawn" }
  | { type: "actor-frame" }
  | { type: "parent-activation" }
  | { type: "parent-completion" };

export type RuntimeConcurrency = "serial" | "parallel";
export type ActivationHistory = "live" | "snapshot";
export type MessageDelivery = "immediate" | "queued";

export type TriggeredRuntimeOptions = {
  trigger: RuntimeTrigger;
  concurrency?: RuntimeConcurrency;
  activationHistory?: ActivationHistory;
  historyProjection?: HistoryProjection;
};

export type ComponentRuntime = { type: "component" };
export type PrimaryRuntime = {
  type: "primary";
  boundaryProjection: Projection;
} & TriggeredRuntimeOptions;
export type WorkerRuntime = {
  type: "worker";
  boundaryProjection: Projection;
} & TriggeredRuntimeOptions;

export type Runtime =
  | { type?: "component" }
  | ({
      type: "primary";
      boundaryProjection?: Projection;
    } & TriggeredRuntimeOptions)
  | ({
      type: "worker";
      boundaryProjection?: Projection;
    } & TriggeredRuntimeOptions);

export type NormalizedRuntime = ComponentRuntime | PrimaryRuntime | WorkerRuntime;

type DryTriggeredRuntimeOptions = Omit<
  TriggeredRuntimeOptions,
  "historyProjection"
> & {
  historyProjection?: DryHistoryProjection;
};

export type DryProjection = StaticProjection | Ref;

export type DryHistoryProjection = ActorHistoryProjection | Ref;

export type DryRuntime =
  | { type?: "component" }
  | ({
      type: "primary";
      boundaryProjection?: DryProjection;
    } & DryTriggeredRuntimeOptions)
  | ({
      type: "worker";
      boundaryProjection?: DryProjection;
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

type ActionStateContext<S> = IsAny<S> extends true
  ? {
      state?: S;
      patchState?(patch: StatePatch<S>): void;
      replaceState?(value: S): void;
    }
  : [S] extends [undefined]
  ? {
      state?: undefined;
      patchState?: undefined;
      replaceState?: undefined;
    }
  : {
      state?: S;
      patchState?(patch: StatePatch<S>): void;
      replaceState?(value: S): void;
    };

export type ActionContext<S = undefined> = {
  getState?: (address: InferenceStateAddress) => unknown;
} & ActionStateContext<S>;

export type Action<
  S = undefined,
  I = unknown,
  O = unknown,
  TName extends string = string,
> = {
  state: StateDescriptor<S> | null;
  name: TName;
  description?: string;
  inputSchema?: z.ZodType<I>;
  run?: (input: I, ctx: ActionContext<S>) => O | Promise<O>;
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

export type NodeConfig = {
  key?: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  tools?: ActionConfigEntry[];
  commands?: ActionConfigEntry[];
  state?: StateDescriptor;
  members?: Node[];
  output?: AnyOutputConfig;
  projection?: Projection;
  runtime?: Runtime;
};

export type Node = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  toolBindings: ActionBindings;
  toolRefs: ActionRef[];
  commandBindings: ActionBindings;
  commandRefs: ActionRef[];
  state?: NormalizedStateDescriptor;
  members: Node[];
  output?: AnyOutputConfig;
  projection: Projection;
  runtime: NormalizedRuntime;
};

export type Instance = {
  id: string;
  node: Node;
  states?: Record<string, StateContainer>;
  children?: Instance[];
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

export type SerializedNodeRef = DryNode | Ref;

/**
 * Durable instance messages use serialized node refs. Hydrated Node objects belong
 * in the live machine tree, not in frames that may be persisted and resumed.
 */
export type SpawnChild = {
  id?: InstanceId;
  node: SerializedNodeRef;
  states?: Record<StateKey, unknown>;
  children?: SpawnChild[];
};

export type InstanceMessage =
  | {
      type: "instance";
      kind: "state.patch";
      instanceId: InstanceId;
      stateKey: StateKey;
      patch: Record<string, unknown>;
    }
  | {
      type: "instance";
      kind: "state.replace";
      instanceId: InstanceId;
      stateKey: StateKey;
      value: unknown;
    }
  | {
      type: "instance";
      kind: "transition";
      instanceId: InstanceId;
      node: SerializedNodeRef;
      states?: Record<StateKey, unknown>;
    }
  | {
      type: "instance";
      kind: "spawn";
      parentInstanceId: InstanceId;
      children: SpawnChild[];
    }
  | {
      type: "instance";
      kind: "attach";
      parentInstanceId: InstanceId;
      children: SerializedInstance[];
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

export type FrameMessage = (
  | ActorMessage
  | CommandMessage
  | InstanceMessage
  | WorkMessage
) &
  Record<string, unknown>;

export type FrameDraft = {
  generatorId?: string;
  runtimeInstanceId?: RuntimeInstanceId;
  activationId?: string;
  inert?: boolean;
  messages: FrameMessage[];
  metadata?: Record<string, unknown>;
};

export type Frame = FrameDraft & {
  id: string;
};

/**
 * Output configuration for implicit LLM text responses.
 * @typeParam M - The application message type this output maps to.
 */
export type OutputConfig<M = AssistantMessage> = {
  audience?: Audience;
  schema?: z.ZodType<M>;
  mapTextBlock?: (text: string) => M;
};

export type AnyOutputConfig = OutputConfig<any>;

export type EnqueueFrame = (frame: FrameDraft) => Frame | Promise<Frame>;

export type ExecutorRunRequest = {
  generatorId: string;
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
  inference: CompiledInference;
  enqueueFrame: EnqueueFrame;
  createActionContext?: (action: AnyAction) => ActionContext<unknown>;
  output?: AnyOutputConfig;
  signal?: AbortSignal;
};

export type ExecutorRunResult = {
  completionReason: CompletionReason;
  value?: string;
  frames?: Array<FrameDraft | Frame>;
};

export type ProjectorExecutor = {
  run(request: ExecutorRunRequest): ExecutorRunResult | Promise<ExecutorRunResult>;
};

export type Executor = ProjectorExecutor;

export type Charter = {
  key?: string;
  version?: string;
  executor: ProjectorExecutor;
  nodes: Record<string, Node>;
  tools: Record<string, AnyAction>;
  commands: Record<string, AnyAction>;
  states: Record<string, NormalizedStateDescriptor>;
  projections: Record<string, ProjectionFunction>;
  historyProjections?: Record<string, HistoryProjectionFunction>;
};

export type UserMessage = {
  type: "user";
  text: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type AssistantMessage = {
  type: "assistant";
  text: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type ToolMessage = {
  type: "tool";
  name: string;
  text?: string;
  value?: unknown;
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type ActorMessage = UserMessage | AssistantMessage | ToolMessage;

export type CompiledInference = {
  systemParts: string[];
  history: ActorMessage[];
  dynamicParts: string[];
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

export type DryNode = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  tools?: DryAction[];
  commands?: DryAction[];
  state?: SerializedStateDescriptor | Ref;
  members?: Array<DryNode | Ref>;
  output?: SerializedOutputConfig;
  projection?: DryProjection;
  runtime?: DryRuntime;
};

export type SerializedInstance = {
  id: InstanceId;
  node: DryNode | Ref;
  states?: Record<StateKey, StateContainer>;
  children?: SerializedInstance[];
};

export type SerializedOutputConfig = {
  audience?: Audience;
  schema?: unknown;
};
