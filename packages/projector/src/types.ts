import type { z } from "zod";
import type { AnyParamsSchema, JsonObject } from "./params.ts";

export type Ref = string;

/**
 * Compile-internal placement tags carried by projection parts. Assigned when
 * a node's parts render into the draft; consumed by the layout render in
 * finalizeSections, which re-stamps compiled output parts with their resolved
 * slot identity and volatility (`CompiledPart`). `partDepth` never leaves
 * compile.
 */
export type PartPlacement = {
  /** Slot name this part is addressed to; absent = the region's default slot. */
  slot?: string;
  /** Region this part is addressed to (region-addressed parts carry no slot). */
  region?: LayoutRegionName;
  /** Contributor depth (ancestor count) for deterministic LWW ordering. */
  partDepth?: number;
};

export type TextContentPart = { type: "text"; text: string } & PartPlacement;

export type ImageContentPart = {
  type: "image";
  data: string | Uint8Array | ArrayBuffer | URL;
  mediaType: string;
  label?: string;
} & PartPlacement;

export type DataContentPart<TDataContent = never> = {
  type: "data";
  data: TDataContent;
  label?: string;
} & PartPlacement;

export type ContentPart<TDataContent = never> =
  | TextContentPart
  | ImageContentPart
  | DataContentPart<TDataContent>;

export type ProjectionStatePart = {
  type: "state";
  /** Slot the rendered value addresses; absent = region default. */
  slot?: string;
  /** Region the rendered value addresses (region-addressed projections carry no slot). */
  region?: LayoutRegionName;
  /** Absent = native. Deferred renders an availability note + getState access. */
  exposure?: Exposure;
  render?: (value: unknown) => string;
  note?: (address: string) => string;
  stateKey: string;
  target: StateAddress;
  value: unknown;
};

export type ProjectionPart<TDataContent = never> =
  | ContentPart<TDataContent>
  | ProjectionStatePart;

export type ProjectionIR<TDataContent = never> = {
  preamble: ProjectionPart<TDataContent>[];
  recency: ProjectionPart<TDataContent>[];
  tools: AnyAction[];
  states: ProjectionStatePart[];
};

/**
 * How a child generator's compiled surface crosses its boundary into an
 * ancestor's document. `hidden` (default): nothing crosses — the child is a
 * private sub-machine. `augment`: every part the child compiles (content,
 * tools, state projections) forwards to the parent document as-is.
 */
export type BoundaryProjection = "hidden" | "augment";

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

export type TriggeredRuntimeOptions = {
  trigger: RuntimeTrigger;
  concurrency?: RuntimeConcurrency;
  activationHistory?: ActivationHistory;
  boundaryProjection?: BoundaryProjection;
  outputAudienceDefault?: "self" | "broadcast";
};

export type ComponentRuntime = { type: "component" };
export type GeneratorRuntime = {
  type: "generator";
  boundaryProjection: BoundaryProjection;
} & TriggeredRuntimeOptions;

export type Runtime =
  | { type?: "component" }
  | ({
      type?: "generator";
    } & TriggeredRuntimeOptions);

export type NormalizedRuntime =
  | ComponentRuntime
  | GeneratorRuntime;

export type DryRuntime =
  | { type?: "component" }
  | ({ type: "generator" } & TriggeredRuntimeOptions);

/**
 * How the generator encounters a projected thing. `native`: fully present on
 * the surface. `deferred`: discoverable/loadable on demand — state defers via
 * the reserved getState tool; tools defer via the executor's provider-
 * idiomatic tool-search lowering. An executor with no lowering for its model
 * errors rather than degrades: the compiled availability note promises tool
 * search, so a surface that cannot honor it must not run.
 */
export type Exposure = "native" | "deferred";

/**
 * How (and whether) a state's value participates in the projection. Absent =
 * hidden (declaration/binding only). One declaration carries both the state
 * and its projection config — no separate registration. Distinct from
 * `Projection` (a whole-surface projection function): this is per-state
 * declaration-side config the compile consumes.
 */
export type StateProjection = {
  /** Slot the rendered value (or deferred-availability note) addresses; absent = region default (preamble). */
  slot?: SlotAddress;
  exposure?: Exposure;
  /** Custom value rendering (native exposure). Code — registered descriptors only; never serializes. */
  render?: (value: unknown) => string;
  /** Custom deferred-availability note, given the getState address. Code — registered descriptors only. */
  note?: (address: string) => string;
};

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
  // Tree operations accept Node<any>: action contexts cannot thread the
  // charter's TDataContent, and data-content variance is irrelevant to
  // instance surgery (spawned nodes serialize into instance messages).
  spawn(
    node: Node<any>,
    options?: {
      states?: Record<StateKey, unknown>;
      children?: SpawnChild<TDataContent>[];
    },
  ): void;
  cede(node?: Node<any>): void;
  transition(
    node: Node<any>,
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

/**
 * Who operates an action. `generator` actions compile into the inference tool
 * surface; `external` actions are dispatched by hosts/clients via
 * executeCommand and surface in client snapshots; `any` is both. Enforcement
 * for the generator is capability-by-construction (presence on the compiled
 * surface is the grant); for external callers the transport authenticates —
 * this field declares intent there, it is not an ACL.
 */
export type ActionCaller = "generator" | "external" | "any";

// --- Parts: a node's configuration as an ordered list of typed, addressed
// contributions. `instructions`/`tools`/`commands` on NodeConfig are authoring
// sugar that desugars into parts at createNode. Contributions are additive-
// only; all variation is expressed by the owning node via computed parts
// (select/when are sugar lowering to computeds). ---

export type SlotDef = {
  kind: "slot";
  name: string;
  /** Rendered heading; omitted = bare content. */
  title?: string;
  /** How appended text parts combine within the slot. */
  merge: "block" | "list";
  /** Computed parts may only target volatile slots (prompt-cache hygiene). */
  volatile: boolean;
  /** Anonymous/unslotted parts land in the region's default slot. */
  default: boolean;
};

export type LayoutRegionName = "preamble" | "recency";

/**
 * A layout-independent address: "this region's default slot, whatever the
 * active layout names it". The graduation-safe way to say preamble-vs-recency
 * without declaring a layout — parts written against a region keep working
 * when a charter later registers its own layout. Address via the `preamble`/
 * `recency` sentinels, never inline literals.
 */
export type RegionAddress = {
  kind: "region";
  region: LayoutRegionName;
};

export type SlotAddress = SlotDef | string | RegionAddress;

export type LayoutDef = {
  kind: "layout";
  name: string;
  /** Unknown slot names become compile errors instead of overflow. */
  strict: boolean;
  regions: Record<LayoutRegionName, SlotDef[]>;
  /**
   * How frames render into the document's history. Layout-owned (history is
   * wire-structural; the layout picks WHICH named policy, never placement);
   * there are no per-node overrides. Default: { type: "messages" }.
   */
  historyProjection?: HistoryProjection<any>;
};

export type DiscriminatorEnv = {
  /** Resolved value of the discriminator's declared state (or its init). */
  state: unknown;
  params: JsonObject;
};

export type Discriminator<TValue extends string = string> = {
  kind: "discriminator";
  name: string;
  values: readonly TValue[];
  state: StateDescriptor | null;
  derive: (env: DiscriminatorEnv) => TValue;
};

export type AnyDiscriminator = Discriminator<string>;

export type ComputedPartEnv = {
  params: JsonObject;
  /** Resolved value of a declared state descriptor (or its init). */
  state: (descriptor: StateDescriptor) => unknown;
  /**
   * Evaluates a discriminator at this contributor through the canonical path:
   * contributor-relative state resolution, memo write, vocabulary validation
   * (throw on out-of-set derive). String refs resolve against the charter at
   * evaluation time. Per-instance evaluation semantics — nothing is pinned.
   */
  discriminator: (discriminator: AnyDiscriminator | Ref) => string;
};

/**
 * What a compute closure may return alongside plain content: compiled-style
 * content parts (type-tagged), authoring text parts (kind-tagged, slot
 * addressed), and action parts built with tool()/command() — caller and
 * exposure ride the part. Select parts and nested computed parts are rejected
 * at compile: variation nests through data, never through closures.
 */
export type ComputedReturnPart<TDataContent = never> =
  | ContentPart<TDataContent>
  | TextPart
  | ActionPart;

/**
 * Sugar provenance for a part computed produced by select/when: the
 * declarative subset stays walkable data. The runtime ignores it — compile
 * evaluates the compute; ref-lookup consults the auto-derived registry — but
 * static analysis (walkAllParts), charter validation, serialization (the
 * select wire shape), tooling, and the future closed-variation lint read it.
 */
export type PartSelectMetadata<TDataContent = never> = {
  discriminator: AnyDiscriminator | Ref;
  partial: boolean;
  branches: Record<string, Part<TDataContent>[] | null>;
};

export type ComputedPartDef<TDataContent = never> = {
  kind: "computedPart";
  name: string;
  /**
   * Default placement for returned parts that carry no address of their own.
   * Required (and volatile-validated) for authored computeds; absent on
   * sugar-lowered defs (select/when), whose returns keep their own slot
   * addresses — unaddressed returns land in the node's default placement,
   * exactly as the old SelectPart branch parts did.
   */
  slot?: SlotAddress;
  /**
   * Local candidates for ref resolution of returned action parts (the first
   * tier of the scoped chain; Node entries are reserved for computed members).
   * The registry is walkable data: listing an inline action here is what makes
   * it a declared identity (closure rule) and what static analysis and
   * serialized bare-ref recovery consult — closures stay opaque.
   */
  registry?: ReadonlyArray<AnyAction | Node<TDataContent>>;
  /** Present only on sugar-produced computeds (select/when). */
  metadata?: PartSelectMetadata<TDataContent>;
  compute: (env: ComputedPartEnv) => string | ComputedReturnPart<TDataContent>[];
};

export type AnyComputedPartDef = ComputedPartDef<any>;

export type TextPart = {
  kind: "text";
  slot?: SlotAddress;
  text: string;
};

export type ActionPart = {
  kind: "action";
  caller: ActionCaller;
  /** Default native. Deferred tools lower to provider tool search (see Exposure). */
  exposure?: Exposure;
  action: ActionConfigEntry;
  /**
   * Companion prose owned by this action contribution: ordinary slot-addressed
   * text parts emitted whenever the action is contributed, so a select that
   * swaps the tool swaps its guidance atomically. Emitted regardless of
   * caller — an external command's guidance is typically model-facing (it
   * tells the generator what external surfaces can do).
   */
  guidance?: TextPart[];
};

export type ComputedPartRef<TDataContent = never> = {
  kind: "computed";
  part: ComputedPartDef<TDataContent> | Ref;
};

export type Part<TDataContent = never> =
  | TextPart
  | ActionPart
  | ComputedPartRef<TDataContent>;

export type PartEntry<TDataContent = never> =
  | Part<TDataContent>
  | ComputedPartDef<TDataContent>;

/**
 * Sugar provenance for a member computed produced by selectMember/whenMember:
 * the declarative subset stays walkable data. The runtime ignores it —
 * ref-lookup and validation walk the registry — but serialization, tooling,
 * and the future closed-variation lint read it.
 */
export type MemberSelectMetadata<TDataContent = never> = {
  discriminator: AnyDiscriminator | Ref;
  partial: boolean;
  branches: Record<string, Node<TDataContent>[] | null>;
};

/** What a member compute closure may return: registered nodes (by identity or
 * charter key ref); null contributes nothing. */
export type ComputedMemberReturn<TDataContent = never> =
  | Node<TDataContent>
  | Ref
  | Array<Node<TDataContent> | Ref>
  | null;

/**
 * A named computed member entry: the open-variation form of member derivation.
 * Computeds evaluate to plain registered Nodes — nothing about a node changes
 * because it arrived via a computed. Returned nodes obey the closure rule
 * (computed-local registry → charter.nodes); a compute closure never mints
 * node identities. The registry is walkable data: it is what the "all" member
 * view, executor-config validation, and charter-build state walks consult —
 * closures stay opaque.
 */
export type ComputedMemberDef<TDataContent = never> = {
  kind: "computedMember";
  name: string;
  /** Local node candidates for return resolution (closure-rule tier 1). */
  registry?: ReadonlyArray<Node<TDataContent>>;
  /** Present only on sugar-produced computeds (selectMember/whenMember). */
  metadata?: MemberSelectMetadata<TDataContent>;
  compute: (env: ComputedPartEnv) => ComputedMemberReturn<TDataContent>;
};

export type AnyComputedMemberDef = ComputedMemberDef<any>;

export type MemberEntry<TDataContent = never> =
  | Node<TDataContent>
  | ComputedMemberDef<TDataContent>;

export type CompileDiagnostic = {
  severity: "warning" | "error";
  code:
    | "unknown-slot"
    | "shadowed-action"
    | "volatile-order"
    | "invalid-discriminator-value";
  message: string;
};

export type NodeConfig<TDataContent = never> = {
  key?: string;
  sourceNodeKey?: string;
  name?: string;
  params?: AnyParamsSchema;
  /** Sugar: an anonymous text part in the preamble region's default slot. */
  instructions?: string;
  /** Sugar: action parts with caller "generator". */
  tools?: ActionConfigEntry[];
  /** Sugar: action parts with caller "external". */
  commands?: ActionConfigEntry[];
  parts?: PartEntry<TDataContent>[];
  states?: StateDescriptor[];
  members?: MemberEntry<TDataContent>[];
  output?: OutputConfig<TDataContent>;
  runtime?: Runtime;
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
  parts: Part<TDataContent>[];
  states: NormalizedStateDescriptor[];
  memberEntries: MemberEntry<TDataContent>[];
  output?: OutputConfig<TDataContent>;
  runtime: NormalizedRuntime;
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
  /**
   * App/runner-owned channel, complementary to framework-owned `provenance`:
   * hosts stamp correctness-bearing linkage here (e.g. durable-queue item ids
   * completed transactionally with frame persistence, transport/turn routing
   * markers). The framework never reads or writes it; unlike provenance,
   * persistence must NOT drop it.
   */
  metadata?: Record<string, unknown>;
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
  /** Unified action registry; tools and commands share one namespace. */
  actions: Record<string, AnyAction>;
  states: Record<string, NormalizedStateDescriptor>;
  slots: Record<string, SlotDef>;
  layouts: Record<string, LayoutDef>;
  computedParts: Record<string, AnyComputedPartDef>;
  discriminators: Record<string, AnyDiscriminator>;
  defaultLayout: LayoutDef;
  historyProjections: Record<string, HistoryProjectionFunction<TDataContent>>;
};

export type CharterConfig<TDataContent = never> = {
  key?: string;
  version?: string;
  params?: AnyParamsSchema;
  nodes: readonly Node<TDataContent>[];
  /** Sugar: registered into `actions` alongside `commands`. */
  tools?: readonly AnyAction[];
  /** Sugar: registered into `actions` alongside `tools`. */
  commands?: readonly AnyAction[];
  actions?: readonly AnyAction[];
  states?: readonly StateDescriptor[];
  slots?: readonly SlotDef[];
  layouts?: readonly LayoutDef[];
  computedParts?: readonly AnyComputedPartDef[];
  discriminators?: readonly AnyDiscriminator[];
  historyProjections?: readonly HistoryProjectionFunction<TDataContent>[];
};

/**
 * Slot identity + volatility stamped on every compiled region part by the
 * layout render. Executors key caching (cache breakpoints at the first
 * volatile part) and session sync (slot-granular diffing) off these; draft
 * placement (`region`, `partDepth`) never leaves compile.
 */
export type CompiledPart<TDataContent = never> = ContentPart<TDataContent> & {
  /** Owning slot name. Unknown (pseudo-)slots keep their name; untagged
   * tail parts in a default-less region carry UNSLOTTED_PART_SLOT. */
  slot: string;
  /** From SlotDef.volatile. Unknown slots and the untagged tail stamp
   * volatile — they render at the region tail and must never extend the
   * stable prefix. */
  volatile: boolean;
};

export type CompiledInference<TDataContent = never> = {
  /** The rendered `preamble` region: durable framing, stable-first. */
  preamble: CompiledPart<TDataContent>[];
  history: FrameMessage<TDataContent>[];
  /** The rendered `recency` region: attention-adjacent freshness. */
  recency: CompiledPart<TDataContent>[];
  tools: AnyAction[];
  retrievableStates: RetrievableState[];
  diagnostics?: CompileDiagnostic[];
};

export type ProjectionAddress =
  | { type: "instance"; instanceId: string }
  | { type: "member"; ownerInstanceId: string; memberPath: string[] };

export type SerializedStateDescriptor = {
  key: string;
  scope?: "hoist" | "local";
  onInitConflict?: "error" | "replace";
  projection?: { slot?: string; region?: LayoutRegionName; exposure?: Exposure };
  init?: unknown;
  schema: unknown;
};

export type DryAction = Ref;

export type DryPart =
  | { kind: "text"; slot?: string; region?: LayoutRegionName; text: string }
  | {
      kind: "action";
      caller: ActionCaller;
      exposure?: Exposure;
      ref: DryAction;
      guidance?: Array<{ slot?: string; region?: LayoutRegionName; text: string }>;
    }
  | { kind: "computed"; ref: Ref }
  // The wire shape of a sugar-lowered select (a metadata-bearing computed
  // part): stable across the SelectPart-kind deletion, so old stored payloads
  // hydrate through the sugar unchanged.
  | {
      kind: "select";
      discriminator: Ref;
      partial: boolean;
      branches: Record<string, DryPart[] | null>;
    };

export type DryMemberSelect<TDataContent = never> = {
  kind: "select";
  discriminator: Ref;
  partial: boolean;
  branches: Record<string, Array<DryNode<TDataContent> | Ref> | null>;
};

export type DryMemberEntry<TDataContent = never> =
  | DryNode<TDataContent>
  | Ref
  | DryMemberSelect<TDataContent>;

export type DryNode<TDataContent = never> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  params?: unknown;
  parts?: DryPart[];
  states?: Array<SerializedStateDescriptor | Ref>;
  members?: Array<DryMemberEntry<TDataContent>>;
  output?: SerializedOutputConfig;
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
