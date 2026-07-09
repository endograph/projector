# Projector Master Plan

This is a breaking rewrite of `@projectors/core`. There is no backwards
compatibility requirement.

Future work is tracked separately in [`FUTURE_WORK.md`](./FUTURE_WORK.md).

- Remove packs entirely.
- Replace contexts with states.
- Rewrite public API and internal types as needed.
- Delete old tests.
- Add only focused tests for algorithmic behavior, especially projection node
  ordering, `augment`, `replace`, required children ordering, and state
  initialization/validation.

## Core Types

```ts
type Ref = string;
type HistoryProjectionFunctionRef = Ref;

// --- Parts: a node's configuration is an ordered list of typed, addressed
// contributions. ---

type ActionCaller = "generator" | "external" | "any";
type Exposure = "native" | "deferred";

type SlotDef = {
  kind: "slot";
  name: string;
  title?: string; // rendered heading; omitted = bare content
  merge: "block" | "list"; // how appended text parts combine within the slot
  volatile: boolean; // computed parts may only target volatile slots
  default: boolean; // anonymous/unslotted parts land in the region's default slot
};

type LayoutRegionName = "preamble" | "recency";

type RegionAddress = { kind: "region"; region: LayoutRegionName };

type SlotAddress = SlotDef | string | RegionAddress;

type LayoutDef = {
  kind: "layout";
  name: string;
  strict: boolean; // unknown slot names error instead of overflowing
  regions: Record<LayoutRegionName, SlotDef[]>;
  historyProjection?: HistoryProjection<any>; // layout-owned; no per-node overrides
};

type Discriminator<TValue extends string = string> = {
  kind: "discriminator";
  name: string;
  values: readonly TValue[];
  state: StateDescriptor | null;
  derive: (env: { state: unknown; params: JsonObject }) => TValue;
};

type ComputedPartDef<TDataContent = never> = {
  kind: "computedPart";
  name: string;
  // Default placement for returned parts with no address of their own.
  // Required (volatile-validated) for authored computeds; absent on
  // sugar-lowered defs (select/when), whose returns keep their own slots.
  slot?: SlotAddress;
  // Local candidates for ref resolution of returned action parts / member
  // nodes (first tier of the scoped chain). Walkable data: listing an inline
  // value here is what gives it a declared identity — closures stay opaque.
  registry?: ReadonlyArray<Action | Node<TDataContent>>;
  // Present only on sugar-produced computeds (select/when): the declarative
  // { discriminator, branches } record tooling and lints read.
  metadata?: PartSelectMetadata<TDataContent>;
  compute: (env: ComputedPartEnv) => string | ComputedReturnPart<TDataContent>[];
};

type ComputedPartEnv = {
  params: JsonObject;
  state: (descriptor: StateDescriptor) => unknown; // resolved value or init
  // Canonical discriminator reader: contributor-relative state resolution,
  // memo write, vocabulary validation (throws on out-of-set derive).
  discriminator: (d: Discriminator | Ref) => string;
};

type TextPart = { kind: "text"; slot?: SlotAddress; text: string };

type ActionPart = {
  kind: "action";
  caller: ActionCaller;
  exposure?: Exposure; // default native
  action: ActionConfigEntry;
  guidance?: TextPart[]; // companion prose owned by this contribution
};

type ComputedPartRef<TDataContent = never> = {
  kind: "computed";
  part: ComputedPartDef<TDataContent> | Ref;
};

type Part<TDataContent = never> =
  | TextPart
  | ActionPart
  | ComputedPartRef<TDataContent>;
// There is no SelectPart kind: select()/when() are sugar returning a
// metadata-bearing computed part. computed is the single variation primitive.

type ComputedMemberDef<TDataContent = never> = {
  kind: "computedMember";
  name: string;
  registry?: ReadonlyArray<Action | Node<TDataContent>>;
  metadata?: MemberSelectMetadata<TDataContent>; // sugar-produced only
  compute: (env: ComputedPartEnv) => ComputedMemberReturn<TDataContent>;
};

type MemberEntry<TDataContent = never> =
  | Node<TDataContent>
  | ComputedMemberDef<TDataContent>;
// selectMember()/whenMember() are the same sugar on the member side:
// computeds evaluate to plain registered Nodes; nothing about a node changes
// because it arrived via a computed.

type TextContentPart = { type: "text"; text: string };

type ImageContentPart = {
  type: "image";
  data: string | Uint8Array | ArrayBuffer | URL;
  mediaType: string;
  label?: string;
};

type DataContentPart<TDataContent = never> = {
  type: "data";
  data: TDataContent;
  label?: string;
};

type ContentPart<TDataContent = never> =
  | TextContentPart
  | ImageContentPart
  | DataContentPart<TDataContent>;
```

Nodes are ordered lists of typed parts. `instructions`, `tools`, and
`commands` survive on `NodeConfig` as authoring sugar that desugars into parts
at `createNode`: `instructions` becomes an anonymous text part in the preamble
region's default slot, `tools` become action parts with caller `"generator"`,
and `commands` become action parts with caller `"external"`.

There is a single render path. Node-level custom projection functions are
removed — a node cannot rewrite what other nodes contributed. Contributions
are additive-only, and all variation is expressed at the owning node via
selects over charter-registered discriminators. The only remaining projection
escape hatch is the generator boundary: `runtime.boundaryProjection` is a
plain enum — `"hidden"` (default; nothing crosses the boundary) or
`"augment"` (every compiled part of the child aggregate forwards to the
parent as-is). Selective export between those poles (surface manifests,
activity digests) is future work that extends the enum with declarative data,
never arbitrary code at the boundary.

Placement is by slot. Slots are first-class charter-registered definitions
(like state descriptors and actions) that parts address by identity; bare
string slot names remain the tolerated "proposal tier" for novel or
data-loaded parts. One layout per compiled document arranges slots into two
regions — `preamble` (durable framing, cache-stable) and `recency`
(freshness) — which render directly to `CompiledInference.preamble` and
`CompiledInference.recency`, every compiled part stamped with its resolved
slot identity and volatility (`CompiledPart`). The `preambleRegion`/
`recencyRegion` sentinels are the layout-free placement API: a part addressed
to a region resolves to the active layout's default slot for that region and
stays valid across layout changes. A charter that registers no layout uses
the built-in default layout.

`computed` is the single variation primitive — for content, actions,
commands, and members. A `select` is a defunctionalized `(params, state) →
parts`; `computed` is the direct form of the same function, so the select
forms (`select`/`when`, `selectMember`/`whenMember`) keep their exact
signatures but lower to metadata-bearing computeds whose registry is
auto-derived from the branches. Runtime ignores the metadata; ref lookup
walks the registry; tooling and future closed-variation lints read the
metadata. Discriminators stay charter-defined and contributor-resolved
(`derive({ state, params })` must return one of `values`); they are a
naming/enforcement layer over computeds, reached inside a compute via the
canonical `env.discriminator(d)` reader (memo write + vocabulary validation
included). Selects still swap parts — and, through `ActionPart.guidance`, a
tool and its prose — atomically: one closure returns both.

The closure rule bounds open variation: a computed's returned action parts
and member nodes must resolve against computed-local `registry` → node →
charter; identities are never minted inside a closure, and anything
unresolvable is a compile error. Branches-as-data (sugar metadata) support
inline definitions because validation and ref recovery can walk them; bare
closures are opaque and recoverable only via their explicit registry.
Authored computeds declare a default `slot` (volatile-validated,
prompt-cache hygiene); sugar-lowered computeds' returns keep their own slot
addresses. Like all part code, computeds never serialize — an unregistered
computed in a serialized machine throws. The invariant: **state placement
follows the skeleton; state existence follows the log; state persists once
attached; surface follows the derivation.**

Action parts unify tools and commands under one registry with a `caller`
field, enforced at compile (generator surface), `executeCommand` (external
dispatch), and the client snapshot. Same-name action collisions resolve by
deterministic deepest-contributor last-write-wins with a `shadowed-action`
diagnostic. `exposure: "deferred"` keeps a tool off the always-loaded
surface: the compile emits an overridable availability note (explicit
`guidance` replaces it) and the executor lowers the deferred set to its
provider's tool-search idiom; an executor with no lowering for its model
errors rather than silently loading the tool natively. Exposure never enters
history — the log records logical actions.

```ts
type GeneratorId = string;
type InstanceId = string;
type StateKey = string;

type StateAddress = {
  instanceId: InstanceId;
  stateKey: StateKey;
};

type InferenceStateAddress = string;

type RetrievableState = {
  address: InferenceStateAddress;
  target: StateAddress;
};

type ProjectionAddress =
  | { type: "instance"; instanceId: string }
  | { type: "member"; ownerInstanceId: string; memberPath: string[] };

type AudienceTarget = ProjectionAddress;

type Audience = "self" | "broadcast" | AudienceTarget | AudienceTarget[];

type UserMessage<TDataContent = never> = {
  type: "user";
  content?: ContentPart<TDataContent>[];
  text?: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

type AssistantMessage<TDataContent = never> = {
  type: "assistant";
  content?: ContentPart<TDataContent>[];
  text?: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

type ActionKind = "command" | "tool";

type ActionRequestMessage = {
  type: "action";
  kind: "request";
  action: ActionKind;
  name: string;
  input: unknown;
  target?: ProjectionAddress;
  callId: string;
};

type ActionResultMessage<TDataContent = never> = {
  type: "action";
  kind: "result";
  action: ActionKind;
  name: string;
  callId: string;
  target?: ProjectionAddress;
  success: boolean;
  value?: unknown;
  error?: string;
  outputMessageIndices?: number[];
};

type ActorMessage<TDataContent = never> =
  | UserMessage<TDataContent>
  | AssistantMessage<TDataContent>;

type ActionMessage<TDataContent = never> =
  | ActionRequestMessage
  | ActionResultMessage<TDataContent>;

type AnyActorMessage = ActorMessage<any>;

type OutputConfig<TDataContent = never> = {
  audience?: Audience;
  schema?: z.ZodType<TDataContent>;
  mapTextBlock?: (text: string) => TDataContent;
};

type RuntimeTrigger =
  | { type: "spawn" }
  | { type: "actor-frame" }
  | { type: "parent-activation" }
  | { type: "parent-completion" };

type RuntimeConcurrency = "serial" | "parallel";
type ActivationHistory = "live" | "snapshot";

type ActorHistoryProjection = { type: "actor" };
type MessageHistoryProjection = { type: "messages" };

type HistoryProjection<TDataContent = never> =
  | ActorHistoryProjection
  | MessageHistoryProjection // default
  | HistoryProjectionFunctionRef
  | HistoryProjectionFunction<TDataContent>;

type HistoryProjectionContext<TDataContent = never> = {
  target: Generator;
  generatorId: GeneratorId;
  activationId: string;
  trigger: RuntimeTrigger;
  history: Frame<TDataContent>[];
  states: Record<StateKey, unknown>;
};

type HistoryProjectionFunctionMethod<TDataContent = never> = (
  ctx: HistoryProjectionContext<TDataContent>,
) => FrameMessage<TDataContent>[];

type HistoryProjectionFunction<TDataContent = never> = {
  kind: "historyProjection";
  name: string;
  method: HistoryProjectionFunctionMethod<TDataContent>;
};

type BoundaryProjection = "hidden" | "augment";

type TriggeredRuntimeOptions = {
  trigger: RuntimeTrigger;
  concurrency?: RuntimeConcurrency; // default "serial"
  activationHistory?: ActivationHistory; // default "live"
  boundaryProjection?: BoundaryProjection; // default "hidden"
  outputAudienceDefault?: "self" | "broadcast";
};

type Runtime =
  | { type?: "component" } // default
  | ({
      type?: "generator";
    } & TriggeredRuntimeOptions);
```

App-supplied actor messages may be text-only, content-part-only, or both.
`text` is the portable rendering fallback. `content` is app-owned rich message
content represented as `ContentPart<TDataContent>[]`. The single
`TDataContent` type parameter describes the app-owned `data` content payload
used in user, assistant, tool, projection, history, executor, charter, node, and
machine types.

`node.output` controls how implicit LLM text output is shaped after executor
completion. `output.schema`, when present, is passed to the executor as the
runtime's structured-output schema and is type-checked against `TDataContent`.
`output.mapTextBlock`, when present, maps the executor's returned text block
into `TDataContent` before schema validation. If no mapper or schema is
provided, returned text becomes a text content part. The framework then wraps the
content in an `AssistantMessage` with `content` set and `text` preserved as the
raw LLM text. `output.audience` is applied when the implicit assistant message
does not already carry an explicit audience.

`runtime.outputAudienceDefault` optionally supplies the audience for implicit
assistant messages produced from executor text output when `node.output.audience`
is not set. Explicit `node.output.audience` wins.

Fully formed frames or messages emitted by tools, actions, or executors keep
their own audience or use their message-type default.

`runtime.activationHistory` controls whether an open activation accepts newly
visible actor messages while it is still running. `"live"` activations compile
history from the current frame log before each inference frame. `"snapshot"`
activations compile from the history visible when the activation opened, plus
messages produced by that same activation. This is especially useful for
parallel generators whose mid-loop context should not be steered by unrelated
frames arriving after the activation starts.

`layout.historyProjection` owns how visible frame history converts into
`CompiledInference.history`, per compiled document. History is
wire-structural: the layout picks WHICH named policy, never placement, and
there are no per-node or per-runtime overrides (`runtime.historyProjection`
was removed outright); variation, if ever needed, is a different layout. The default `{ type: "messages" }`
projection keeps all visible `FrameMessage`s in durable frame/message order after
the normal audience, delivery, activation-history, and runtime-metadata filtering
has selected the visible frames. The built-in `{ type: "actor" }` projection is a
convenience that extracts only actor messages. A custom history projection
receives the target generator metadata, the activation id, the runtime trigger,
the filtered frame history, and current resolved state values. It returns
synthetic or filtered frame messages for executor history without mutating
durable frames or projection sections.

History projection functions follow the same charter ref rules as other
registered executable values. If registered in `charter.historyProjections`,
they serialize by ref. Inline history projection functions are executable in
memory but are not serializable; serialization should throw if an unregistered
history projection function is encountered.

## States

```ts
type StateProjection = {
  // Slot the rendered value (or deferred-availability note) addresses;
  // absent = the preamble region's default slot.
  slot?: SlotAddress;
  exposure?: Exposure; // native renders the value; deferred exposes getState
  render?: (value: unknown) => string; // code — registered descriptors only
  note?: (address: string) => string; // code — registered descriptors only
};

type StateDescriptor<S = unknown> = {
  key: string;
  schema: Schema<S>;
  init?: S | (() => S);
  scope?: "hoist" | "local"; // default "hoist"
  onInitConflict?: "error" | "replace"; // default "replace"
  projection?: StateProjection; // absent = hidden (declaration/binding only)
};

type StateContainer<S = unknown> = {
  value: S;
};

type Instance<TDataContent = never> = {
  id: string;
  node: Node<TDataContent>;
  isSource?: boolean;
  params?: JsonObject;
  states?: Record<string, StateContainer>;
  children?: Instance<TDataContent>[]; // removable runtime children
};
```

State rules:

- `scope: "local"` stores on the current concrete instance.
- `scope: "hoist"` stores on the nearest source instance in the current
  projection-node ancestry.
- Source instances are durable state ownership anchors marked with
  `isSource: true`.
- A machine tree must contain at least one source instance.
- Hoisted state resolution throws when no source instance exists for the current
  projection node.
- Nodes attach state through the plural `states: [a, b]` list; the singular
  node-level `state:` spelling was removed (action-level `state:` bindings
  are unrelated and stay).
- The same `StateDescriptor.key` may appear on multiple nodes, but it must be
  the SAME registered descriptor identity — one descriptor identity per state
  key, charter-wide, validated at charter build. Shared keys mean shared
  access to the same resolved container; descriptor-group merging and
  compatibility checking are impossible by construction.
- State containers are resolved by target instance plus state key.
- Realization is lazy — a logged write, never a read. A container comes into
  existence only via the mutation path (`ctx.updateState` in an action frame)
  or a spawn/transition `states:` seed. Reads — compile, discriminators,
  computeds, getState — fall back to the descriptor's `init` and never
  side-effect; compile stays a pure function of `(params, state)`.
- Unrealized state tracks the current code `init` across deploys (hot-updatable
  defaults, by decision); a write realizes the container at the placement the
  descriptor's `scope` dictates for the writing contributor. `getState`
  aliases derive from declarations in scope, not realized containers, so an
  address never shifts when a container realizes.
- Hoisted state projects from its resolved target instance's projection node,
  even when the descriptor contribution came from a member or generator
  boundary. Local state projects from the descriptor's source projection node.
- If an existing value validates against the descriptor schema, reuse it.
- If validation fails, apply `onInitConflict`: `"replace"` resets to `init`,
  `"error"` throws (the reset path is how schema evolution lands).
- Absent `projection` means hidden: the state exists for declaration and
  action binding only. `projection.exposure: "deferred"` replaces the old
  `"retrieval"` policy — the compile emits a getState availability note
  (overridable via `note`). One declaration carries both the state and its
  projection config, and state projections route through slots and the layout
  like all other content.

Unrealized state never serializes; hydration validates only the containers
that arrive. State descriptors follow the same charter ref and inline
serialization rules as nodes. If registered in `charter.states`, serialize by ref. Otherwise serialize
inline. Inline state descriptors use `z.toJSONSchema` and `z.fromJSONSchema` so
their schemas can round-trip through serialized machines.
`projection.render` and `projection.note` are code and never serialize;
descriptors carrying them must be registered.

The internal state model is always plural and keyed. Runtime state containers are
stored by state key, and every durable state mutation message must include the
target `stateKey` even when a public helper infers that key.

## Node

```ts
type ActionRef = string;
type ActionConfigEntry = Action | ActionRef;

type PartEntry<TDataContent = never> =
  | Part<TDataContent>
  | ComputedPartDef<TDataContent>; // inline defs normalize to computed refs

type NodeConfig<TDataContent = never> = {
  key?: string;
  sourceNodeKey?: string;
  name?: string;
  params?: AnyParamsSchema;
  instructions?: string; // sugar: anonymous preamble text part
  tools?: ActionConfigEntry[]; // sugar: action parts, caller "generator"
  commands?: ActionConfigEntry[]; // sugar: action parts, caller "external"
  parts?: PartEntry<TDataContent>[];
  states?: StateDescriptor[];
  members?: MemberEntry<TDataContent>[]; // nodes or computed members
  output?: OutputConfig<TDataContent>;
  runtime?: Runtime;
  executorConfig?: ExecutorConfig; // per-executor config, namespaced by executor identity name
};

type Node<TDataContent = never> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  params: AnyParamsSchema;
  parts: Part<TDataContent>[];
  states: NormalizedStateDescriptor[];
  memberEntries: MemberEntry<TDataContent>[];
  output?: OutputConfig<TDataContent>;
  runtime: NormalizedRuntime;
  executorConfig?: ExecutorConfig;
};
```

`key` and `id` encode different concepts and should both remain:

- `Node.key` is the stable node definition identity used for registry and
  serialization.
- `Instance.id` is the concrete runtime instance identity.

`createNode` normalizes the authoring sugar and inline part entries into the
ordered `parts` list; there is no node-level projection field.

A member entry is a direct `Node` or a computed member — including the
`selectMember`/`whenMember` sugar, whose branches are `Node | Node[] | null`
resolved against the contributing node's discriminator environment. Computed
members evaluate to plain registered nodes (effective view only — there is no
potential-members view); derived membership is a memoryless view over durable
state, and state that should die with presence uses spawn/cede instead. A
member's stable path segment is its `Node.key`, and
duplicate sibling member keys are an error. If an app needs the same logical
node twice under one parent, it should create distinct wrapper nodes with unique
keys.

Only keep `createNode<TDataContent>(config)` for the first pass. Nodes attach
state through the plural `states` list. Do not add
`createSkillNode`, `createWorkerNode`, or `createPrimaryNode` initially. Most
apps should anchor the data content type at `createCharter<TDataContent>()`;
`createNode<TDataContent>()` is available when a node is authored away from that
charter context or needs its `output.schema` checked locally.

## Charter

The charter is the executable registry for all ref-addressable runtime values.
Refs are dry, stable identifiers that hydrate through a compatible charter.

```ts
type Charter<TDataContent = never> = {
  key?: string;
  version?: string;
  params: AnyParamsSchema;
  nodes: Record<string, Node<TDataContent>>;
  actions: Record<string, Action>; // unified; tools and commands share one namespace
  states: Record<string, NormalizedStateDescriptor>;
  slots: Record<string, SlotDef>;
  layouts: Record<string, LayoutDef>;
  computedParts: Record<string, ComputedPartDef>;
  discriminators: Record<string, Discriminator>;
  defaultLayout: LayoutDef; // built-in unless the charter registers its own
  historyProjections: Record<string, HistoryProjectionFunction<TDataContent>>;
};

type CharterConfig<TDataContent = never> = {
  key?: string;
  version?: string;
  params?: AnyParamsSchema;
  nodes: readonly Node<TDataContent>[];
  tools?: readonly Action[]; // sugar: registered into `actions`
  commands?: readonly Action[]; // sugar: registered into `actions`
  actions?: readonly Action[];
  states?: readonly StateDescriptor[];
  slots?: readonly SlotDef[];
  layouts?: readonly LayoutDef[];
  computedParts?: readonly ComputedPartDef[];
  discriminators?: readonly Discriminator[];
  historyProjections?: readonly HistoryProjectionFunction<TDataContent>[];
};
```

The charter deliberately does not carry an executor. The charter is the
universe: pure definition — static, serializable, versionable. The executor is
the generator runtime — an environmental fact bound at machine creation:

```ts
createMachine({ instance, charter, executor, runner, frames });
```

`executor` is optional. A machine without one can hydrate and fold frames
(read-only replay, inspection, prompt realization tooling); scheduling
generator work throws. Type fit between charter and executor is enforced where
they meet: both are parameterized by `TDataContent` at `createMachine`.
`charter.version` therefore honestly covers fold semantics only — projections,
states, node shapes. Which executor produced a given generation is recorded
per frame as provenance, not pretended into the charter version; see Frame
Provenance.

`runner` is optional host/claim info (workerId, leaseId, host…) stamped into
the provenance of frames the machine produces. The lease record itself stays
an application-owned capability claim — "who may produce frames right now" —
and is never the canonical record of what produced existing frames.

`createCharter<TDataContent>()` is the primary type anchor for an application.
The charter's data content type flows into registered nodes, runtime history
projections, executor requests, output configuration, frame messages, and
machine instances. Apps that only need text can omit the type parameter. Apps
that need structured content should pass the app-owned data payload type and use
`ContentPart<TDataContent>[]` in actor messages.

`createCharter(config)` accepts array inputs for executable registries, validates
unique names/keys, and normalizes the hydrated charter to record registries for
field-specific ref lookup.

## Params

Params are the framework's typed environment mechanism. They are separate from
state: params are supplied by the app at instance boundaries, while state is
owned and mutated by the machine.

Zod params schemas should stay in the JSON Schema-compatible object subset:
plain object shapes, shallow top-level keys, and no transforms/refinements as a
design dependency.

```ts
type JsonObject = Record<string, unknown>;
type AnyParamsSchema = z.ZodObject<any>;
```

`Charter.params` is the external machine-level contract. It is optional in
`createCharter(config)` and defaults to `z.object({})`.

```ts
const charter = createCharter({
  params: z.object({
    userId: z.string(),
    orgId: z.string(),
  }),
  nodes: [profileNode],
  // existing charter fields...
});
```

`Node.params` is the node-local view over effective params. It is optional in
`createNode(config)` and defaults to an empty object schema. Nodes do not receive
the full machine params object; they receive only the keys declared by
`node.params`.

```ts
const profileNode = createNode({
  key: "profile",
  params: z.object({
    userId: z.string(),
  }),
});
```

`Action.params` is the action-local view over node params. It is optional in
`createAction(config)` and defaults to an empty object schema. `ctx.params` in
an action is typed from `action.params`, not from `node.params`.

```ts
const loadProfile = createAction({
  state: null,
  name: "loadProfile",
  params: z.object({
    userId: z.string(),
  }),
  run: async (_input, ctx) => {
    ctx.params.userId;
  },
});
```

Static compatibility is intentionally strict in the first pass:

- `charter.params` must satisfy every registered node's `node.params`;
- member nodes are included recursively in that type check;
- `node.params` must satisfy every inline attached action's `action.params`;
- string action refs are resolved later through the charter, so their params are
  validated when real params are parsed into action contexts rather than through
  runtime schema comparison.

The runtime does not compare params schemas to each other. Instead, it parses
real values at the points where they matter:

- `createRoot(charter, instances, params)` parses `params` with
  `charter.params`;
- `createMachine({ charter, instance })` parses the top-level instance's
  effective params with `charter.params`;
- node-local behavior parses the effective params through `node.params`;
- action contexts parse the node-local params through `action.params`.

The resolution chain is:

```txt
effective params -> node params -> action params
```

Effective params are formed by walking from the top-level machine instance to
the current concrete instance and shallowly merging `Instance.params`.

```ts
function resolveEffectiveParams(instancePath: Instance[]): JsonObject {
  const result: JsonObject = {};

  for (const instance of instancePath) {
    if (!instance.params) continue;

    for (const [key, value] of Object.entries(instance.params)) {
      if (key in result) {
        throw new Error(`Param override is not supported yet: ${key}`);
      }

      result[key] = value;
    }
  }

  return result;
}
```

Params are shallow. There is no deep merge. Any duplicate key along the path is
an unsupported override and throws, even if the value is identical.

Member nodes do not create params boundaries. Like state and runtime identity,
members fold into the nearest concrete owner instance. A member's `node.params`
is a view over the owning concrete instance's effective params.

Refs are compact, plain strings. They are resolved by field context rather than
by a generic namespaced grammar:

```ts
"checkout" // node field
"search" // action field (tools and commands share one namespace)
"thread" // state field
"context" // slot field
"chat" // layout field
"cameraSnapshot" // computedPart field
"interactionMode" // discriminator field
"memory" // historyProjection field
```

Hydration should use field-specific helpers, not a context-free ref resolver.
Unknown refs in the relevant registry must throw.

Action refs use the same compact strings but resolve at runtime in this order:

1. the current node's local binding;
2. the registered `sourceNodeKey` node's local binding;
3. the charter's unified `actions` registry.

For the first implementation pass, an action ref is also the action name:
`ref === action.name`. Hydration must reject a tool or command ref if it resolves
to an action with a different `name`. Aliasing refs to differently named actions
is future work.

## Projection Nodes And Runtime Frames

`createRoot(charter, instances, params)` is a helper API for idiomatic
application composition. It parses `params` with `charter.params`, then returns
an ordinary helper `Instance` with id `"root"`, the current synthetic root
generator node, `params` set to the parsed charter params, and `children` set to
the supplied instance array. The id `"root"` is not globally reserved; it is
only the id this helper chooses for the instance it creates.

The helper is especially useful when an app wants to merge multiple independent
durable instances into one machine tree. A common split is an `agentInstance`
that owns agent behavior and an independent `threadInstance` that owns
conversation/thread state:

```ts
const instance = createRoot(charter, [agentInstance, threadInstance], {
  userId: "user_123",
});
```

After this normalization there is still no separate root/wrapper type. Traversal,
runtime ancestry, projection, and scheduling see the returned value as an
ordinary instance. State ownership is controlled by source instances:
`scope: "hoist"` state beneath `agentInstance` targets `agentInstance` when that
instance is marked `isSource: true`, and `scope: "hoist"` state beneath
`threadInstance` targets `threadInstance` when it is marked `isSource: true`.
`scope: "local"` state still stores on the current concrete instance.

`ProjectionNode` is the traversal unit used by the projection compiler. It is
distinct from durable runtime `Frame` entries in the message/work log.

ProjectionNode order is pre-order, left-to-right:

```txt
current instance
node.members, left to right
instance.children, left to right
```

Example:

```ts
createRoot(charter, [instanceA, instanceB], params);
// root.node.members = []
// instanceA.node.members = [criticNode]
// instanceA.children = [instanceFoo, instanceBar]
```

ProjectionNode order:

```ts
[
  root,
  instanceA,
  memberNode,
  instanceFoo,
  instanceBar,
  instanceB,
]
```

`node.members` are compositional members, not runtime child instances. They
project with the same rules as an instance, but local state on a member attaches
to the current concrete instance. Members cannot have runtime children. If a
member action spawns a child, the child is spawned onto the nearest concrete
instance.

Members always participate in traversal and cannot be removed via runtime
child mutation; derived membership (computed members, including the member
select sugar) is how a member surface varies.

Members must not be materialized as durable child instances during serialization
or deserialization. This distinction is intentional: members represent current
node-definition composition, so changes to registered member definitions in a
future app release automatically apply to existing persisted instances when those
instances are reloaded against the updated charter. Runtime `children` represent
durable conversation state and should preserve the exact children that were
spawned or attached during execution.

Members can still have generator runtimes. The runtime gives each
member projection node a projection address derived from the nearest
concrete owner instance and the stable member node key path:

```ts
type ProjectionAddress =
  | { type: "instance"; instanceId: string }
  | { type: "member"; ownerInstanceId: string; memberPath: string[] };
```

The encoded projection address is the stable `GeneratorId` used anywhere the work
model needs generator identity, including activation scheduling, concurrency
keys, explicit audience targets, and parent-generator lookup.

Example generator IDs:

```txt
instance:abc
member:abc/critic
member:abc/research/retriever
```

Virtual member projection addresses are recomputed from current registered node
definitions on load. They are not serialized as durable children. Reordering
members does not change a generator ID as long as member node keys stay the same.
Duplicate sibling member node keys are an error.

Runtime `Frame`s must be stored and supplied to the runtime in stable durable
append order. The core framework does not require a dense global sequence field.

## Compile Projection

The projection compiler produces an executor-neutral shape:

```ts
type CompiledInference<TDataContent = never> = {
  /** The rendered `preamble` region: durable framing, stable-first. */
  preamble: CompiledPart<TDataContent>[];
  history: FrameMessage<TDataContent>[];
  /** The rendered `recency` region: attention-adjacent freshness. */
  recency: CompiledPart<TDataContent>[];
  tools: Action[];
  retrievableStates: RetrievableState[];
  diagnostics?: CompileDiagnostic[];
};

/**
 * Slot identity + volatility stamped on every compiled region part by the
 * layout render. Executors key caching (cache breakpoints at the first
 * volatile part) and session sync (slot-granular diffing) off these; draft
 * placement never leaves compile. The cache boundary is always INFERRED from
 * SlotDef.volatile + slot order (lint-backed), never an explicit marker part;
 * there are no content hashes in the IR — consumers diff by slot key + plain
 * equality.
 */
type CompiledPart<TDataContent = never> = ContentPart<TDataContent> & {
  slot: string;
  volatile: boolean;
};

type CompileDiagnostic = {
  severity: "warning" | "error";
  code:
    | "unknown-slot"
    | "shadowed-action"
    | "volatile-order"
    | "invalid-discriminator-value";
  message: string;
};
```

`StateAddress` is the canonical internal target for state operations.
`InferenceStateAddress` is an ephemeral model-facing alias used only in prompt
state-access hints and the `getState` retrieval tool. The compiler generates
inference aliases from the projected states visible to the current compiled
inference:

- if a projected `stateKey` is unique, use `stateKey`;
- if a projected `stateKey` appears more than once, use
  `${stateKey}:${instanceId}` for each duplicate.

The alias map is scoped to one compiled inference. It must not be serialized
into durable frames, exposed through client state mutation APIs, or accepted
anywhere except the inference `getState` tool. `retrievableStates` contains
only the alias entries that `getState` may retrieve. The `target` field is
runtime metadata and must not be rendered into prompts or provider tool
schemas. The runtime treats aliases as exact map keys; it does not parse
arbitrary model-supplied strings into state targets. If generated aliases
collide, projection compilation throws.

### The render path

Compilation is a single deterministic pass from contributed parts to rendered
sections. There are no projection functions anywhere on the path; the compile
consumes only declarative data (parts, slots, layouts, discriminators,
registered part code).

1. **Contribution.** Traverse projection nodes in pre-order (see Projection
   Nodes And Runtime Frames). Each contributor evaluates its parts: computed
   parts run their registered `compute` with the contributor's
   params/state/discriminator env — select sugar included, whose compute
   reads its discriminator through the canonical `env.discriminator` path (a
   value outside the declared `values` is an `invalid-discriminator-value`
   error); returned action parts resolve through the scoped chain
   (computed-local registry → node → charter) and bind at the computed's
   contributor and depth; state projections contribute the rendered
   value (native exposure, via `projection.render` or default JSON) or a
   deferred-availability note (deferred exposure, via `projection.note` or
   the default getState note), addressed to `projection.slot`; action parts
   contribute their action to the tool/command surface plus their `guidance`
   text parts.
2. **Placement.** Every contributed part carries a placement tag: a slot
   name, a region (resolved to the active layout's default slot for that
   region at render), or nothing (preamble region default slot). The compile
   resolves one layout per document: an explicit compile option, else the
   charter's `defaultLayout`, else the built-in implicit default. Under a
   `strict` layout, unknown slot names are `unknown-slot` errors; otherwise
   they overflow into the default slot.
3. **Render.** Each region renders its slots in layout order: parts group by
   slot, text merges per the slot's `merge` policy under the slot's optional
   `title`, and each region renders to its `CompiledInference` section
   (`preamble`/`recency`), every part stamped with its resolved slot identity
   and volatility (`CompiledPart`). Stable slots ordered after volatile slots in a
   region draw a `volatile-order` diagnostic (forfeited prompt-cache prefix
   stability).

Duplicate action names resolve by deterministic last-write-wins — the deepest
contributor in traversal order wins — with a `shadowed-action` diagnostic for
each shadowed contribution. This is the same override shape as provider tool
assembly and command resolution.

### Generator boundaries

Generator runtimes are projection boundaries. When compiling a generator
outside that boundary, the compiler does not traverse the boundary's
descendants directly; it compiles the boundary's owned aggregate, then applies
`runtime.boundaryProjection`:

```ts
function visitContributor(draft, contributor, targetGeneratorId) {
  if (
    isGeneratorBoundary(contributor) &&
    !belongsToGenerator(contributor, targetGeneratorId)
  ) {
    if (contributor.node.runtime.boundaryProjection === "augment") {
      mergeCompiledAggregate(draft, compileOwnedAggregate(contributor));
    }
    // "hidden" (default): nothing crosses the boundary.
    return;
  }

  contributeParts(draft, contributor);

  for (const child of directContributorChildren(contributor)) {
    visitContributor(draft, child, targetGeneratorId);
  }
}
```

`"hidden"` drops the child runtime aggregate. `"augment"` forwards every
compiled part as-is: child preamble parts remain preamble parts, child
recency parts remain recency parts, and child tools/retrievable state
metadata are exported. There is no `"replace"` and no boundary projection
function; selective export between the two poles is future declarative work
(export manifests, activity digests).

When compiling a specific target generator, that runtime's projection node is
the root of the projection section pass. Ancestor runtime boundaries are not
traversed through to reach the target, and ancestor parts do not implicitly
project downward into the child generator. A child generator's compiled
projection reaches its nearest owning generator only through that child's
`boundaryProjection`.

A runtime's owned projection includes that runtime's own projection node plus
its member and child descendants until another generator runtime boundary is
reached. Nested runtime boundaries are exported to the owning runtime through
their own `boundaryProjection` using the same rule.

State projection follows state ownership before runtime boundary traversal:
hoisted state is grouped under the resolved source instance projection node,
while local state is grouped under the descriptor's source projection node. A
member inside a generator runtime can contribute a descriptor for hoisted
state owned by the nearest source instance; that state may project from that
owner without exporting the generator runtime's aggregate. Hidden boundaries
still hide the generator's own parts, tools, local state, and descendant
aggregate.

### History compilation

History compilation is a separate pass from projection section compilation:

```ts
const visibleFrames = compileVisibleFrameHistory(frames, targetGenerator);
const history = applyHistoryProjection(
  layout.historyProjection ?? { type: "messages" },
  {
    target: targetGenerator,
    generatorId: targetGenerator.id,
    activationId,
    trigger: targetRuntime.trigger,
    history: visibleFrames,
    states: currentStateValues,
  },
);
```

The built-in `{ type: "messages" }` history projection preserves all visible
frame messages in durable frame/message order. The built-in `{ type: "actor" }`
history projection extracts only actor messages from that visible frame
history. Executors are responsible for rendering `CompiledInference.history`
into the provider-visible conversation format they need; most LLM executors
will filter to actor messages before rendering. Custom history projection
output is not durable runtime state; it is recomputed for the compiled
inference. Frames in `HistoryProjectionContext.history` have `provenance`
stripped: history projections are fold code, and the fold never reads
provenance.

Core should provide small helper functions for common history projections,
such as `messages(ctx)`, `actorMessages(ctx)`, `messagesSinceLastCompletion(ctx)`,
and `messagesBeforeLastCompletion(ctx)`. These helpers are pure views over the
filtered frame history supplied in `HistoryProjectionContext`.

Runtime projection resolution:

- `component`: contribute the node's parts inline.
- `generator` when compiling parent inference: compile the runtime's owned
  aggregate, then export it through `runtime.boundaryProjection`.
- `generator` when compiling its own inference: contribute the node's parts
  as the section root.

All generator inference points are equal and can receive input when their
configured trigger matches the source frame. Typical agents only have the
de-facto root generator from `createRoot(...)`, but multiple generator nodes
are in scope because generator identity, audience filtering, activation
routing, and history compilation need to be designed around independent
inference points from the start. The first-pass routing policy may be broad,
but the abstraction must not assume a single generator.

## Executor Contract

Executors receive the compiled sections and own provider-specific assembly:

```ts
executor.run({
  preamble,
  history,
  recency,
  tools,
  retrievableStates,
  output,
});
```

Executors decide how to serialize region content and provider tool
configuration, under the lowering laws: given one IR, every executor's
realization preserves part order within regions, all content, and the tool
surface — executors re-encode, never author; degradations are declared, fixed
rules. The laws are conformance (`test/conformance/lowering.test.ts`), run
against the real executor packages. Concrete lowerings shipped on them: the
aisdk executor lowers the preamble to `SystemModelMessage[]` with one
Anthropic `cacheControl` breakpoint on the last stable block (configurable
via `promptCache`; non-Anthropic providers keep the byte-identical single
string), and the realtime executor keys dynamic-context conversation items by
slot — only changed slots create/delete items, with per-slot version notes —
and skips unchanged instruction pushes. Work messages are runtime metadata and should be filtered out of
executor-visible history unless a future explicit projection policy allows them.
Commands are host/client actions, not executor-visible inference tools. They
should stay out of `CompiledInference` until a future explicit command projection
policy is designed.

Executor output returns through the normal frame path:

```ts
type EnqueueFrame<TDataContent = never> = (
  frame: FrameDraft<TDataContent>,
  report?: ExecutionReport,
) => Frame<TDataContent>;

type ExecutorRunRequest<TDataContent = never> = {
  generatorId: GeneratorId;
  activationId: string;
  config?: unknown; // the generator node's executorConfig namespace for this executor
  inference: CompiledInference<TDataContent>;
  enqueueFrame: EnqueueFrame<TDataContent>;
  createActionContext?: (action: AnyAction) => ActionContext<unknown, TDataContent>;
  output?: OutputConfig<TDataContent>;
  signal?: AbortSignal;
  refreshInference?: () => CompiledInference<TDataContent>;
};

type ExecutorRunResult<TDataContent = never> = {
  completionReason: CompletionReason;
  value?: string; // implicit LLM text output
  frames?: Array<FrameDraft<TDataContent> | Frame<TDataContent>>; // fully formed executor-produced frames
  execution?: ExecutionReport; // run-level facts, folded into synthesized-frame and completion-frame provenance
};

type ExecutorRealizePromptRequest<TDataContent = never> = Pick<
  ExecutorRunRequest<TDataContent>,
  "generatorId" | "activationId" | "config" | "inference" | "output"
>;

type ExecutorRealizedPrompt = {
  provider: string;
  input: unknown;
};

type Executor<TDataContent = never> = {
  identity?: ExecutorIdentity; // provenance attribution + executorConfig namespace key
  configSchema?: z.ZodType<unknown>; // validates node executorConfig at machine creation
  run(
    request: ExecutorRunRequest<TDataContent>,
  ): ExecutorRunResult<TDataContent> | Promise<ExecutorRunResult<TDataContent>>;
  realizePrompt(
    request: ExecutorRealizePromptRequest<TDataContent>,
  ): ExecutorRealizedPrompt | Promise<ExecutorRealizedPrompt>;
};
```

Executors never write provenance directly. The framework wraps `enqueueFrame`
at the run boundary and signs every frame the run produces with the executor's
`identity`; the optional `report` argument carries execution facts (latency,
usage, cost, transport tags) that the framework folds into that frame's
`provenance.execution`. Anonymous executors (no `identity`) produce
unattributed frames.

### Executor Node Config

Nodes may carry per-executor config as plain JSON, namespaced by executor
identity name. The config is data and belongs in the versioned charter — model
choice shapes generation — while its type is owned by the executor package.
Type-only coupling resolves this: executor packages register their config
types via declaration merging, so a type-only import is enough to typecheck a
charter and the charter stays serializable data.

```ts
// @projectors/core
interface ExecutorConfigRegistry {}

type ExecutorConfig = {
  [K in keyof ExecutorConfigRegistry]?: ExecutorConfigRegistry[K];
} & Record<string, unknown>;

// executor package
declare module "@projectors/core" {
  interface ExecutorConfigRegistry { aisdk: AiSdkExecutorNodeConfig }
}

// charter definition
createNode({
  key: "researcher",
  executorConfig: { aisdk: { maxOutputTokens: 4096 } },
});
```

Namespacing buys swap tolerance: a node can carry config for executors that
are not currently bound, and each binding reads only its own namespace. The
namespace key is naturally the executor ref if per-node executor bindings are
added later. Runtime teeth back the type-level check: machine creation
validates every reachable node's namespace against the bound executor's
`configSchema` (fail fast at bind time), and each activation delivers the
resolved namespace as `ExecutorRunRequest.config`. Declared config is intent;
`provenance.execution` records what actually ran, so fallbacks surface in the
log instead of hiding.

Multi-step executors should call `refreshInference()` before each inference
step after the first. It re-projects `CompiledInference` against the current
frame log under the running activation's normal visibility rules, so
`delivery: "immediate"` messages that arrived mid-run surface to the model on
the next step while `delivery: "queued"` messages stay hidden. The re-projected
history excludes the activation's own frames; the executor re-appends its
in-flight step messages (tool calls and results from earlier steps of the same
run) itself. Every frame returned by a refresh is recorded as consumed by the
activation and its pending work is absorbed on completion; see Mid-Generation
Messages And Absorption. Executors that never refresh simply answer the initial
inference, and messages they did not see trigger follow-up work.

When an executor returns `frames`, the framework enqueues them in result order,
applying the current generator and activation metadata where omitted.
When an executor returns `value`, the framework maps that text through
`node.output.mapTextBlock` if present; otherwise the raw text is used as
assistant content. If `node.output.schema` is present, the assistant content is
validated against the schema before enqueueing. The framework wraps that content
in an `AssistantMessage` with the raw text preserved in `text`. If
`node.output.audience` is present, it is applied to the implicit assistant
message when no explicit audience is already present. Executor result frames and
mapped text output are enqueued before the framework appends the activation
completion frame, unless the activation has already completed itself.

Add stable retrieval tool behavior:

```ts
getState({ address }: { address: InferenceStateAddress });
```

The schema of `getState` must remain stable across steps for prompt caching:
`address` is always typed as a plain string, not as an enum of currently
projected aliases. Access is runtime-checked against the compiled
`retrievableStates` alias map.

Deferred-exposure tools are the executor's side of the exposure contract. An
executor lowers `exposure: "deferred"` actions to its provider's idiomatic
tool-search mechanism — the aisdk executor ships built-in lowerings for
Anthropic (`deferLoading` + BM25 tool search) and OpenAI Responses
(`deferLoading` + `tool_search`), selected by the model's provider id and
overridable via its `deferredTools` config hook. A deferred tool an executor
cannot lower is an ERROR, never a silent native degradation — the compiled
availability note promises tool search, so a surface that cannot honor it
must not run (the realtime executor rejects deferred tools outright). The
provider search-tool names are reserved against projected action names, like
`getState`. Model-capability compat is the CHARTER's job, not an executor
toggle: a charter that must run on both search-capable and search-less models
makes deferred-tool support a param and selects exposure with a
discriminator, so prompt and surface can never disagree.

State rendering and state-access notes should not expose node mechanics to the
model. The prompt should address the model as the actor. For any projected state,
append a short note to the relevant instruction text, such as:

```txt
You have access to state at address `<stateAddress>` if you need it.
```

For `projection: { exposure: "deferred" }`, mention that the model can call
`getState` with that exact address string (the descriptor's `note` overrides
the default wording). For native exposure, render the inference state address
and value (via `projection.render` or default JSON) into the state's slot so
duplicate state keys on different instances remain distinguishable without
exposing structured runtime targets.

Actions use singular public state ergonomics in the first pass. An action
binds the state descriptor it declares (`state: descriptor`), and receives a
typed `ctx.state` and `ctx.updateState(update)` API for that state.
Conventional updates are constructed with helpers such as
`replaceState(value)`, `patchState(patch)`, and `appendState(...values)`. If the
owner node has no state, the action receives no state binding. State projection
does not affect mutation access.

Type safety flows from the action's declared state requirement. A stateful
action declares the descriptor it expects, and `createNode({ states, tools,
commands })` keeps the action handle typed from that declaration. Machine
creation and projection compilation validate that the action's declared state
is provisioned among the owner node's `states` before execution. Stateless
actions use `state: null` and receive no state context.

Actions may also declare `params`. Action contexts always include `ctx.params`,
typed from the action's own params schema. The action does not receive the full
node params object unless it declares the same keys.

```ts
type ActionContext<
  S = undefined,
  TDataContent = never,
  TParams extends JsonObject = {},
> = {
  params: TParams;
  getState?: (address: InferenceStateAddress) => unknown;
  instance: ActionInstanceContext<TDataContent>;
} & ActionStateContext<S>;

type Action<
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
  run?: (
    input: I,
    ctx: ActionContext<S, TDataContent, z.output<TParams>>,
  ) => O | Promise<O>;
};
```

The singular public API is sugar over the plural keyed runtime model. When
`ctx.updateState(update)` emits a durable mutation, the mutation must include the
resolved `stateKey`. Future plural helpers can accept structured `StateAddress`
values, such as `ctx.getState(address)` or `ctx.updateState(address, update)`,
without changing stored mutation semantics.

State mutation helpers are synchronous. `ctx.updateState(update)` immediately
constructs and enqueues a frame with a `state.update` `InstanceMessage`,
validates and folds it into the in-memory machine, and updates the action-local
`ctx.state` view before returning. The wrapped update operation may replace the
state, shallow-patch an object value, or append values to an array. If validation
fails, the helper throws synchronously. If the action later awaits and throws,
already-enqueued mutation frames remain durable runtime facts rather than being
rolled back.

For tool executions, state mutation frames carry the current generator and
activation metadata. For command executions, state mutation frames are
command-owned frames and usually have no generator ID unless the host supplies
one explicitly.

Returned actor messages are different from context mutations. They are enqueued
after the action returns, in action result order. Fully formed actor messages use
their explicit audience, or their message-type default if omitted.

### Commands

Commands are app-executed, not `runMachine`-executed. A command action request
is a durable event frame that records an accepted command request. It is not a
replay instruction, and folding or replaying a frame log must not execute command
code.

```ts
type ActionRequestMessage = {
  type: "action";
  kind: "request";
  action: "command" | "tool";
  name: string;
  input: unknown;
  target?: ProjectionAddress;
  callId: string;
};

type ActionResultMessage<TDataContent = never> = {
  type: "action";
  kind: "result";
  action: "command" | "tool";
  name: string;
  callId: string;
  target?: ProjectionAddress;
  success: boolean;
  value?: unknown;
  error?: string;
  outputMessageIndices?: number[];
};

type ClientMachineMessage = ActionRequestMessage & { action: "command" };

type ExecuteActionResult<T = unknown, TDataContent = never> =
  | {
      success: true;
      value?: T;
      messages?: FrameMessage<TDataContent>[];
      callId: string;
    }
  | {
      success: false;
      error: string;
      value?: T;
      messages?: FrameMessage<TDataContent>[];
      callId: string;
    };

function executeCommand<T = unknown>(
  machine: Machine,
  message: ActionRequestMessage & { action: "command" },
): Promise<ExecuteActionResult<T>>;
```

The app owns receiving command requests from clients or hosts and calling
`executeCommand(machine, actionRequest)` explicitly. The helper owns command
request/result framing:

1. Resolve the command against the hydrated machine.
2. Validate command input.
3. Enqueue a frame containing the command `ActionRequestMessage`.
4. Execute the command with the same action context semantics as tools.
5. Synchronously enqueue and fold any frames produced by context helpers such as
   `ctx.updateState(...)` as those helpers are called.
6. When the command returns, enqueue an `ActionResultMessage` and then spread
   any returned output messages into the same terminal frame, with
   `outputMessageIndices` pointing at those frame positions.
7. Return a structured success or failure result to the app.

`executeCommand` uses the same synchronous `machine.enqueueFrame` path as
`runMachine`-produced frames. The helper is not itself a durable persistence
boundary. When a `MachineRun` is actively draining the machine, command-produced
frames flow through that run in append order and are persisted by the normal
host run loop. If no `MachineRun` is actively draining, command-produced frames
remain in the machine's in-memory frame log until a later run drains them. Apps
should not persist command-produced frames through a separate per-command
result path in the normal case.

If `target` is omitted, command resolution scans visible commands in traversal
order and picks the last command with the requested name. This gives duplicate
command names the same override shape as projection sections and provider tool
definitions: later/rightmost/deeper entries win. If `target` is provided,
resolution is restricted to that projection address and the command name is still
read from the top-level `ActionRequestMessage.name`.

If target resolution or input validation fails before the command is accepted,
`executeCommand` returns `success: false` and enqueues an immediate request/result
frame. If execution throws after the command has been accepted, the helper
returns `success: false`; any frames already enqueued by synchronous context
helpers remain in the frame log. Failed actions may return output messages by
using `actionResult({ success: false, error, messages })`; thrown errors cannot
carry messages.

`runMachine` should ignore command action messages for execution. Action messages
are also not actor messages, though tool result messages may be rendered into
executor-visible prompt history by the executor adapter.

## Generators, Work, And Frames

The runtime may contain multiple independent inference points. Call each
inference point a generator.

Generators are discovered from projection addresses whose node runtime is
`{ type: "generator" }`. A projection address may point to a concrete durable
instance or to a virtual member generator. Matching triggers create activations.
A runtime's
`concurrency` policy controls whether activations for that runtime are processed
serially or in parallel:

- `serial`: default. Activations share a concurrency key and only the earliest
  incomplete activation for that key is runnable.
- `parallel`: each incomplete activation is independently runnable.

For serial runtimes, `concurrencyKey` defaults to the encoded projection address.
For parallel runtimes, `concurrencyKey` defaults to the activation ID.

Generator IDs are stable and tied to projection addresses. The root generator
created by `createRoot(...)` uses the same normal address encoding as every
other instance generator: `instance:root`. Parallelism is activation-level state;
parallel activations of the same generator share the same `generatorId` and have
distinct `activationId`s and concurrency keys.

Activation IDs distinguish individual durable units of work for generator
runtimes.

Generators do not synchronize at the old step/turn boundary. Each generator
advances independently and emits durable frames. A frame is the unit of runtime
work that is enqueued back onto the machine.

```ts
type Generator = {
  id: GeneratorId;
};

type ExecutorIdentity = { name: string; version?: string };

type ExecutionReport = {
  latencyMs?: number;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  cost?: { amount: number; currency: string };
} & Record<string, unknown>;

type FrameProducer =
  | { executor: ExecutorIdentity }
  | { machine: string }; // e.g. "scheduler", "state-reconciliation"

type FrameProvenance = {
  producer?: FrameProducer;
  execution?: ExecutionReport;
  runner?: Record<string, unknown>; // workerId, leaseId, host…
};

type FrameDraft<TDataContent = never> = {
  generatorId?: GeneratorId;
  activationId?: string;
  inert?: boolean; // default false
  messages: FrameMessage<TDataContent>[];
  provenance?: FrameProvenance; // framework-written, observational only
};

type Frame<TDataContent = never> =
  FrameDraft<TDataContent> & { id: string };

type MessageDelivery = "immediate" | "queued";

type FrameMessage<TDataContent = never> =
  | ActorMessage<TDataContent>
  | ActionMessage<TDataContent>
  | InstanceMessage<TDataContent>
  | WorkMessage;

type PublicNodeRef<TDataContent = never> =
  | Node<TDataContent>
  | Ref;
type SerializedNodeRef<TDataContent = never> =
  | DryNode<TDataContent>
  | Ref;

type StatePath = readonly (string | number)[];

type StateUpdate<S = unknown> =
  | {
      op: "replace";
      value: S;
    }
  | {
      op: "patch";
      value: Record<string, unknown>;
      path?: StatePath;
    }
  | {
      op: "append";
      path?: StatePath;
      values: unknown[];
    };

type InstanceMessage<TDataContent = never> =
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

type SpawnChild<TDataContent = never> = {
  id?: InstanceId;
  node: SerializedNodeRef<TDataContent>;
  states?: Record<StateKey, unknown>;
  children?: SpawnChild<TDataContent>[];
};

type SerializedInstance<TDataContent = never> = {
  id: InstanceId;
  node: SerializedNodeRef<TDataContent>;
  isSource?: boolean;
  params?: JsonObject;
  states?: Record<StateKey, StateContainer>;
  children?: SerializedInstance<TDataContent>[];
};

type WorkMessage =
  | {
      type: "work";
      kind: "activation";
      activationId: string;
      generatorId: GeneratorId;
      sourceFrameId: string;
      concurrencyKey: string;
      concurrency: "serial" | "parallel";
    }
  | {
      type: "work";
      kind: "completion";
      activationId: string;
      generatorId?: GeneratorId;
      sourceFrameId?: string;
      reason:
        | "end-turn"
        | "done"
        | "cancelled"
        | "delegated"
        | "error"
        | "terminal-action"
        | "absorbed";
    };
```

Completion detection is message-only: there is no frame-level side channel
that encodes work semantics. `completion.generatorId` is optional for
completions that pair with an activation message already in the log (the
generator is recovered by joining on `activationId`), and required to record a
completion for work that was never scheduled through the machine — e.g.
realtime voice turns, emitted as self-contained `createRuntimeTurnFrame`
frames carrying both the activation and completion messages. The
machine-written completion path always includes `generatorId` so completions
are self-describing.

### Frame Provenance

Frames carry two channels with different contracts, and there is no third bag:

- `messages` are behavioral, typed, and framework-validated — the fold's only
  input. Anything that should affect the fold must earn a typed message shape.
- `provenance` is the framework-owned observational channel: producer
  signature, execution facts, runner/claim info. The fold never reads it, by
  construction: `fold(charter, frames)` and `fold(charter,
  stripProvenance(frames))` are identical. Frames handed to history-projection
  code have provenance stripped, so app fold code cannot come to depend on it.
  Persistence may drop or relocate it — dropping costs forensics, never
  correctness (strippable is not consequence-free: an app billing off
  `execution` data must persist it).

Provenance has a single write path: the framework signs frames at the
production boundary. Provenance belongs on output, not intent — the activation
frame records that work should happen; the executor is bound at claim/run
time, so the run harness's wrapped `enqueueFrame` signs every frame the run
produces (including the completion frame and frames synthesized from
`ExecutorRunResult`) with `{ executor: identity }`, execution reports, and the
machine's `runner` info. Machine-synthesized frames sign as
`{ machine: "scheduler" }`, `{ machine: "state-reconciliation" }`, and so on.
Executors report; the framework stamps.

This shape is what makes distributed execution honest: with per-activation
runners, executor identity is a property of each production act, not of the
activation record. Each runner signs its own output, so concurrent activations
on different runners with different executors produce a log that says exactly
that. Crash honesty falls out — frames that landed before a crash are already
signed, and a supervisor's synthesized cancellation is signed with claim info
or honestly unsigned. The first signed frame of an activation is the de facto
"work initiated" marker; no extra frame kind is needed.

Resume/fork is an explicit executor choice at machine creation. Tooling may
warn (never block) on provenance mismatch when continuing a log produced by a
different executor; heterogeneous history is normal and legitimate.
`realizePrompt` plus the provenance stamp enables forensic reconstruction of
what any historical activation was prompted with.

An app-owned metadata bag is deliberately absent. Apps that need their own
frame tags should use message extension fields or their own persistence
envelope; if a shared app bag is reintroduced later, the framework never reads
or writes it and it gets no well-known keys — that slope is how metadata bags
become load-bearing.

Frame `spawn` and `transition` messages do not carry params in the first pass.
Scoped params are represented in the `Instance.params` data model, but public
spawn/transition helpers do not expose them yet. `attach` can carry params only
because it mounts already-materialized `SerializedInstance` subtrees.

Frames must be supplied to the runtime in stable durable append order. The
framework does not require a dense global sequence number. Storage adapters may
use an event-store offset, auto-increment id, commit order, ordered document id,
or the persisted frame array order.

`InstanceMessage` is framework-visible machine mutation data, not actor history.
Each `InstanceMessage` represents one machine mutation. Multiple related
mutations are represented as multiple `InstanceMessage`s in one `Frame.messages`
array and are applied in frame message order.

Durable `InstanceMessage`s should contain only resolved concrete targets and dry
refs. Public helpers may accept symbolic targets such as `$current` or hydrated
values such as `PublicNodeRef`, but the framework must resolve and canonicalize
them before appending the frame. For member callers, resolved instance targets
use the nearest concrete owner instance; for example, a member action that spawns
children emits an instance message with `kind: "spawn"` and `parentInstanceId`
set to the nearest concrete owner instance.

State mutation messages always include `stateKey`. `kind: "state.update"`
contains a wrapped update operation. `op: "replace"` validates the replacement
value. `op: "patch"` shallow-merges into the target object at `path ?? []` and
then validates the resulting full state against the resolved state's effective
descriptor. `op: "append"` appends `values` to the array at `path ?? []` and
then validates the resulting full state. State projection does not affect
mutation access.

`kind: "transition"` changes the target instance's node while preserving the
instance ID and durable children. Its optional `states` field provides explicit
state values or overrides for the new node's state descriptor; state
initialization and conflict rules still apply for missing or existing state.

`kind: "spawn"` creates new child instances from node refs. It may accept child
IDs from the host, but if an ID is omitted the framework assigns one before the
frame is persisted. Spawned child state is initialized from its node descriptor
and the optional `states` overrides.

`kind: "attach"` mounts already-materialized instance subtrees under the target
parent. It preserves the supplied child IDs, state containers, and durable
children, and is intended for imports, replication, or host-provided subtrees
rather than ordinary tool-created children.

`kind: "remove"` removes the target instance subtree. If open activations belong
to removed projection addresses, reconciliation should append completion work frames
with `reason: "cancelled"` for those activations. `reason: "cede"` is just a
removal reason; any content returned to a parent or user should be emitted as a
separate actor message with an explicit audience.

A frame may contain one message or multiple related messages. For example, a
synchronous tool call may produce a tool-call message, tool-result message, and
assistant message in one frame. An asynchronous tool flow may produce those as
separate frames. Both shapes are valid from the framework's perspective.

`Frame.inert` is durable frame metadata. It means the frame is folded into the
machine normally but is not a trigger source. Actor messages in an inert frame may
be visible to generator history according to normal audience, delivery, and
activation-history rules, `InstanceMessage`s apply state mutations, and
`WorkMessage`s update reconstructed work state. Reconciliation must not derive
activation work from an inert frame.
Normal `enqueueFrame` semantics still apply when an inert frame is newly produced:
the frame receives an id if needed, is appended to the in-memory frame log,
invokes immediate observation hooks, and is yielded by `runMachine`.

`WorkMessage` is framework-owned runtime metadata. Work messages are emitted in
their own framework-owned runtime `Frame`s, separate from actor and instance
frames. Executors should not receive work messages as LLM-visible history unless
a future explicit projection policy allows them.

### Message Audience, Delivery, And Activation History

Actor messages should include an optional `audience` field. The framework uses
audience only for generator message visibility. Applications own all
display/presentation decisions.

Audience semantics:

- `"self"`: visible to the generator that produced the frame.
- `"broadcast"`: visible to all generators.
- `AudienceTarget` or `AudienceTarget[]`: visible to the listed generator
  addresses.

If `audience` is omitted, the default depends on the message type:

- `UserMessage`: defaults to `"broadcast"`.
- `AssistantMessage`: defaults to `"self"`.
- `ActionMessage`, `InstanceMessage`, and `WorkMessage`: have no audience.

A generator's audience can see a message when:

- The resolved message audience is `"broadcast"`.
- The resolved message audience includes a projection address target matching the
  generator's address.
- The resolved message audience is `"self"` and the message is in a frame
  produced by that generator.

`"self"` resolves to the `generatorId` on the frame containing the message. A
message with audience `"self"` in a frame without a `generatorId` has no
generator-visible audience. User messages avoid this by defaulting to
`"broadcast"`.

Audience does not imply activation. It only controls which messages are visible
to a generator before delivery and activation-history policy are applied. Runtime
triggers decide which generators receive new activations.

Helpers may be added to compute common audiences, such as a parent generator
address, but persisted messages should contain explicit audience targets. The
framework should not store symbolic audiences like `"parent"` in the frame log.

`node.output.audience` is a narrow default for implicit or mapped LLM text output
only. Fully formed actor messages emitted by tools, actions, executors, or other
framework APIs use their explicit `audience`, or their message-type default if
`audience` is omitted. Work messages never use `node.output.audience`.

`InstanceMessage` is a machine mutation message, not an actor message. Audience
does not apply to instance messages or state changes. State changes are
machine-wide and immediate, subject to normal state mutation rules and later
state projection policy.

Actor messages also include optional `delivery`:

- `"immediate"`: default. The actor message is eligible history for matching
  generators as soon as its frame is in the frame log, including activations that
  were already open when the message was appended.
- `"queued"`: the actor message is durable immediately but is not eligible
  history for activations that were already open when the message was appended.
  It is eligible for later activations.

`delivery` is actor-history policy only. It does not delay `InstanceMessage`
effects, `WorkMessage` effects, state mutations, instance mutations, enqueue
observation hooks, or frame persistence. If an application wants a queued user
message, it should not put immediate machine mutations in the same frame and
expect those mutations to be queued too.

Generator history eligibility is the composition of audience, delivery, and the
target runtime's `activationHistory` policy:

```ts
include actor message M for activation A of generator G if:
  visibleByAudience(M, G)
  and visibleByDelivery(M, A)
  and visibleByActivationHistory(M, A)
```

`visibleByDelivery` uses stable durable frame order:

```ts
visibleByDelivery(M, A):
  if M.delivery !== "queued":
    true

  if M.delivery === "queued":
    frame(M) is at or before activationFrame(A)
```

`activationFrame(A)` is the durable work frame that contains the activation
`WorkMessage` for `A`. A queued message in a source frame can therefore be
visible to the activation work frame derived from that source frame, but not to
activations whose work frames already appeared earlier in durable frame order.

`runtime.activationHistory` then decides whether an open activation refreshes
history after it starts:

- `"live"`: default. Each inference frame compiles history from the current frame
  log. Immediate visible messages can steer an already-open activation's next
  inference frame. Executors realize this by calling the run request's
  `refreshInference()` before each step.
- `"snapshot"`: the activation is isolated from later external actor messages.
  It sees actor messages that were eligible at activation start, plus actor
  messages produced by that same activation.

`visibleByActivationHistory` also uses stable durable frame order and activation
identity:

```ts
visibleByActivationHistory(M, A):
  if runtime.activationHistory !== "snapshot":
    true

  if runtime.activationHistory === "snapshot":
    frame(M) is at or before activationFrame(A)
    or frame(M).activationId === A.activationId
```

The same-activation exception lets a snapshot activation retain continuity
across its own tool calls, tool results, and intermediate assistant messages.
The exception must use `activationId`, not only `generatorId`, so parallel
activations from the same runtime do not see each other's mid-loop messages.

These policies are applied only when compiling executor-visible actor history.
They do not affect projection traversal, tool availability, retrievable state
keys, work reconciliation, or the folding of instance and work messages.

### Work Log Semantics

The frame log is the semantic source of truth for work. Activations are durable
because activation messages are stored in framework-owned work frames.
Completions are durable because completion messages are stored in framework-owned
work frames. The runtime reconstructs pending work by folding the frame log.

- `activation` opens a durable unit of work.
- `completion` closes a durable unit of work.

`completion.reason` records why the activation closed. Every reason means the
activation is closed and should not run again. `delegated` means
framework-owned execution for the activation was handed to an external runtime
or provider, and the framework should not expect the executor to emit ordinary
completion output for that activation. `absorbed` means another same-generator
generation projected the activation's source frame before this activation ran,
so its work was completed by that generation instead of a redundant run.
`error` records an executor run that failed; it is a legitimate completion
reason written verbatim, not masked as `cancelled`, so parent-completion
triggers observe errored runs like any other close. If future blocked/retry
behavior is needed, it should be added as a separate non-terminal work message
with deterministic wake conditions.

Activation IDs must be deterministic. Activation messages are emitted in their
own frames, but each activation records the source frame that triggered it. A
typical activation ID should be derived from the machine identity, generator
identity, trigger identity, and source frame identity.

```ts
activationId = hash(machineId, generatorId, triggerKey, sourceFrameId)
```

Work frames are appended by framework reconciliation, not by mutating the frame
that caused the work. Enqueueing a frame assigns its identity and appends it to
the log. Reconciliation folds the full work log, then evaluates every durable
frame as a potential trigger source. A candidate activation is appended only
when no activation exists for its deterministic ID or generator/source pair and
no completion exists for that ID; the completion check keeps source frames that
were absorbed by a running generation from spawning stale activations after the
fact. Reconciliation appends any missing deterministic activation or completion
work frames after their source frame has been persisted.

A non-inert frame matching generator runtime triggers will be followed by
separate activation work frames for those runtimes. Work frames may themselves be
trigger sources for `parent-activation` and `parent-completion`; `actor-frame`
triggers ignore inert frames and work-only frames.

Reconciliation must be idempotent. Replaying the same frame log should never
append duplicate work frames because activation IDs are derived from durable
inputs and there is at most one terminal completion for a given activation ID.
The exact frame IDs may come from storage, but the semantic work identity must be
stable.

There is no scheduling cursor: reconciliation rescans the full frame log each
pass, and idempotence comes from deterministic activation IDs plus the
activation and completion existence checks. This guarantees frames appended
while a generation is running still receive durable work — either an activation
frame or an absorbed completion — instead of being silently skipped once a
later work frame lands. Cancellation is separate: open activations whose
runtime no longer exists may be completed with `reason: "cancelled"` regardless
of where their activation frame appears in history.

Reconciliation must also be deterministic:

- Process source frames in stable durable append order.
- For each source frame, derive candidate work frames in `ProjectionNode`
  traversal order.
- Append newly derived activation work frames and schedule runnable executor work
  immediately when `scheduleWork` is enabled.
- Do not use newly appended, not-yet-yielded frames as trigger sources for the
  next reconciliation batch.
- If multiple terminal completions are possible for one activation, the first
  durable completion wins.

`actor-frame` triggers ignore inert frames and frames that contain only
`WorkMessage` or `InstanceMessage` entries. All triggers ignore frames produced
by the triggered runtime's own generators; see the self-trigger exclusion in
Generator Discovery And Projection.

The framework does not own distributed lease semantics. Single-runner execution
can run pending work directly. Multi-runner systems should dispatch activations
externally and use their own queue, lease, or partitioning infrastructure. The
framework exposes deterministic activation IDs and concurrency keys so external
dispatchers can enforce exclusivity when needed. The lease/claim record is a
capability claim — who may produce frames right now — and may denormalize
executor identity for dispatch routing and live observability, but it stays
operational and overwritable. Canonical provenance is the signed frames in the
log: the host holding the claim passes `runner` info at machine creation and
the framework stamps it into produced-frame provenance, so the claim is the
promise and the signed frames are the receipt.

### Mid-Generation Messages And Absorption

Messages that arrive while a generation is running always get durable work.
Whether that work runs as a fresh generation depends on whether an existing
same-generator generation actually projected the message:

- Every activation records the frames it projected — the initial compile plus
  every `refreshInference()` call — as consumed, using the same visibility
  rules as projection compilation. A frame counts as consumed only if at least
  one of its actor messages survived visibility filtering.
- When the activation completes, the framework appends `reason: "absorbed"`
  completion messages, in the same frame as the activation's own completion,
  for pending same-generator work whose source frame was consumed. Inert
  frames, the activation's own source frame, self-produced frames, and frames
  that do not match the generator's trigger are never absorbed.
- `delivery: "immediate"` messages projected by a live activation are therefore
  absorbed and do not retrigger. Immediate messages the generation never
  projected keep their pending work and run as a new generation.
- `delivery: "queued"` messages are invisible to already-open activations, so
  they are never consumed mid-run and always produce follow-up work.
- Cancelled runs absorb nothing, so messages they projected retrigger; this is
  the crash and cancel recovery path.

Absorption is recorded per absorbed activation as an ordinary singular
completion message — a completion frame may carry several completion messages —
so folding, first-completion-wins, and per-activation reasons stay uniform. An
absorbed completion may precede its activation frame in the log; reconciliation
then skips creating the activation frame entirely.

### Generator Discovery And Projection

Generators should be discoverable deterministically from the machine tree and
work log before readiness or projection compilation. This is an indexing pass,
not an inference pass.

```ts
syncGenerators(machine):
  for each ProjectionNode in traversal order:
    if projectionNode.node.runtime.type === "generator" and concurrency is serial:
      ensure generator exists

  fold work messages to discover open parallel generator activations
```

Projection compilation is separate from generator discovery. A generator can
exist while idle and uncompiled. `runMachine` should compile only activations
that are runnable.

Compiling the root generator does not require compiling child generators first.
For any generator target, the projection section pass starts at that target
runtime projection node. Within any section pass, if a
`ProjectionNode` belongs to the target generator, the compiler contributes
that projection node's parts; if a non-target projection node is a generator
runtime, the compiler compiles that runtime's owned aggregate and exports it
through `runtime.boundaryProjection`.

For the first pass, every generator receives the frame log filtered by message
audience, message delivery, runtime activation history, and runtime metadata
visibility. The target runtime's `historyProjection` then converts that filtered
frame history into the executor-visible `CompiledInference.history`.

For the first pass, user input creates deterministic activations for all
generator runtimes whose configured trigger matches the user frame. The root
generator created by `createRoot(...)` uses `{ type: "actor-frame" }` and
`serial` concurrency through its normal node runtime. More precise routing and
explicit broadcast behavior are future work.

Authored generator runtimes must explicitly configure `trigger`. There is no
authored-generator trigger default. `createRoot(...)` supplies a concrete root
node with an explicit actor-frame trigger.

Generator runtimes are triggered only by scoped runtime events:

- `spawn`: activates once when an `InstanceMessage` frame creates or attaches
  the projection address through `kind: "spawn"` or `kind: "attach"`. Static
  runtime members present at machine bootstrap do not trigger `spawn`.
- `actor-frame`: activates when any frame contains at least one actor message
  whose audience is visible to the projection address. Message `delivery` does
  not affect trigger matching; it affects only whether the actor message is
  eligible history for a particular activation.
- `parent-activation`: activates when a work `activation` message opens work for
  the runtime's nearest ancestor generator.
- `parent-completion`: activates when a work `completion` message closes work
  for the runtime's nearest ancestor generator, regardless of completion reason.

For `parent-activation` and `parent-completion`, the nearest ancestor generator
is the closest generator above the projection address in the ProjectionNode tree.
Those triggers do not observe unrelated generators by default.

### Self-Trigger Exclusion

Triggers never match frames produced by the triggered generator. A frame does
not trigger a generator if the frame's `generatorId` equals that generator's
stable ID, so a generator's own output cannot spawn fresh activations of that
same generator.

Without this rule, default `"self"`-audience assistant and tool output would be
visible to its producing generator, match that runtime's `actor-frame` trigger,
and deterministically derive new activations forever; the machine would never
quiesce. Continuation inside an open activation is owned by the activation's
inference loop. New activations come only from frames produced outside the
runtime.

Framework-owned work frames appended by reconciliation do not carry a
frame-level `generatorId`, so the exclusion never suppresses
`parent-activation` or `parent-completion` triggers. The `generatorId` inside a
`WorkMessage` identifies the activation's generator and is not frame
provenance.

Two intentional consequences:

- Self-scheduling is foreclosed. A message emitted by a runtime's own
  activation and addressed to that same runtime never creates a new activation
  for it, even with `delivery: "queued"`. The message stays durable and becomes
  eligible history for activations created by later external triggers.
- Ping-pong loops between two different runtimes that target each other's
  audiences are not prevented. That is an authored routing choice; the host's
  frame-yield loop and budget policy are the backstop for runaway routing.

Activation messages are emitted in separate work frames and carry
`sourceFrameId`, so the source frame identifies the durable event during replay
or resume.

Runtime triggers are independent from message audience. A generator does
not become runnable merely because a message is addressed to it; its configured
trigger must match. Audience alone is not a runtime wake-up rule.

### Running Work

`runMachine` should reconcile the frame log, discover runnable activations, and
optionally schedule executor work.

```ts
type RunMachineOptions = {
  scheduleWork?: boolean; // default true
};

type MachineRun<TDataContent = never> =
  AsyncIterable<Frame<TDataContent>> & {
    stopSchedulingWork(): void;
    hasStarted(): boolean;
    isDraining(): boolean;
  };

function runMachine<TDataContent = never>(
  machine: Machine<TDataContent>,
  options?: RunMachineOptions,
): MachineRun<TDataContent>;
```

`scheduleWork: true` schedules runnable activations in parallel subject to each
generator's concurrency policy. `scheduleWork: false` reconciles durable work
frames, yields any new framework work frames, and stops without calling
executors. `runMachine` returns a cold `MachineRun`: executor scheduling and
frame emission begin only when the run is consumed through `for await` or direct
async-iterator `next()` calls. A `MachineRun` yields `Frame`s; it never returns
runnable activation objects. Runnable work is represented durably by activation
`WorkMessage`s inside yielded frames and can be discovered by folding the frame
log.

The high-level run algorithm is:

```ts
runMachine(machine, options) creates a MachineRun whose drain loop:
  syncGenerators(machine)
  yield any previously pending frames before using them as trigger sources
  reconcile deterministic work frames from the full frame log
  fold work messages to derive open and completed activations
  identify runnable activations

  if options.scheduleWork === false or scheduling has been stopped:
    yield any newly appended framework work frames
    stop without starting new executors

  compile runnable activations
  schedule runnable activations in parallel immediately
  yield newly appended framework work frames and activation-produced frames
  wait for active activations when no frames are pending
  do not reconcile activation-produced frames into the next work batch until
    those frames have been yielded
```

Every frame emitted by a `MachineRun` is yielded to the host so the application
can persist it, enforce high-level budgets, and decide whether to continue
running the machine. The yielded frame is not a patch for the host to apply back
to the machine; the machine has already been updated by `machine.enqueueFrame`.

The framework owns in-memory enqueue semantics and frame identity assignment.
The host owns durability and policy decisions around continuing execution. A
typical host loop is:

```ts
const run = runMachine(machine);

for await (const frame of run) {
  await saveFrameAndMachine(frame, machine);

  if (!(await shouldContinue(frame, machine))) {
    run.stopSchedulingWork();
  }
}

await saveMachine(machine);
```

`stopSchedulingWork()` requests a graceful scheduling stop. It prevents the run
from starting any additional executor calls after the request. Already-started
activations are allowed to finish, and frames they enqueue are still yielded
through the same `MachineRun`. Reconciliation continues to append and yield
deterministic activation work frames, but newly discovered incomplete activations
are left unscheduled. A later `runMachine(machine, { scheduleWork: true })` can
fold the frame log and schedule those incomplete activations.

`hasStarted()` and `isDraining()` are host ergonomics and development-warning
hooks. JavaScript cannot reliably detect that a returned async iterable will
never be awaited; the framework can only know whether a `MachineRun` has started
or is currently being drained.

External dispatch can use the same reconciliation path:

```ts
const run = runMachine(machine, { scheduleWork: false });

for await (const frame of run) {
  await saveFrameAndMachine(frame, machine);
}

for (const activation of collectRunnableActivations(machine)) {
  await dispatchActivation(activation);
}
```

`collectRunnableActivations(machine)` is a pure helper over the machine tree and
frame log. It is separate from `runMachine` so the run API remains frame-yielding
in both internal-runner and external-dispatch modes.

The lower-level execution API should allow a dispatcher to run one explicit
activation:

```ts
runActivation(machine, activationId)
```

### Frame Emission And Backpressure

`runMachine` should return a `MachineRun` async iterable because it gives the
host a simple control point for observing frames, applying policy, and deciding
whether to continue. The `MachineRun` should not be treated as durable state.
Durable runtime state lives in the frame log, deterministic activation IDs, and
completion work frames.

When multiple activations are running concurrently in a single `MachineRun`, the
run must distinguish immediate frame enqueue from reconciliation/scheduling of
new work. Constructed frames should be enqueued onto the machine immediately,
even if the `MachineRun` iterator is currently suspended at a `yield`.

The frame emission lifecycle is:

```ts
const frame = constructFrame(...);
const enqueued = machine.enqueueFrame(frame);
// The active MachineRun yields enqueued frames later in append order.
```

`machine.enqueueFrame(frame)` owns framework in-memory enqueue semantics. It
assigns frame identity, updates the in-memory frame log, and may notify
host-provided immediate observation listeners registered with
`machine.subscribe(listener)`. These listeners are for application-owned
reactions, such as extracting user-visible assistant messages, updating live UI,
logging, or performing optimistic/idempotent persistence keyed by frame ID.

Newly enqueued frames are also pending emission through a `MachineRun` unless
they were folded through an explicit ingestion API such as `ingestInertFrame`.
Pending emission is in-memory runtime bookkeeping, not durable state. If no
`MachineRun` is actively draining when a frame is enqueued, the frame remains
pending in memory and may be yielded by a later run before that run schedules
new executor work from it.

Immediate observation hooks are not framework-owned durable persistence. The
host owns durability. The normal durable checkpoint is the yielded frame passing
through the host's `for await` loop. If an application chooses to persist from an
immediate observation hook, that persistence is still host-owned and must be
idempotent with the later yielded frame. Work activation and completion messages
are appended later as separate framework work frames by reconciliation.

Activation execution is not blocked by pending frame yields. When reconciliation
creates an activation work frame, `runMachine` may start that activation
immediately, before yielding the activation frame to the host. The activation may
finish its current step and enqueue result or completion frames while the host is
still processing the activation frame. Those frames stay in the pending yield
queue and are yielded in stable append order when the host resumes the iterator.

In a typical host loop:

```ts
const run = runMachine(machine);

for await (const frame of run) {
  await saveFrameAndMachine(frame, machine);
}
```

the `MachineRun` iterator is suspended while the host awaits
`saveFrameAndMachine`. Concurrent activation promises may continue running and
may enqueue frames immediately. The backpressure boundary is the pending yield
queue: queued frames are not treated as trigger sources for another
reconciliation batch until they have passed through the `MachineRun` yield path.

Scheduling newly triggered work should happen from the `MachineRun` drain loop
after yielded frames have cleared the host gate. Immediate enqueue is an
observation point, not a recursive execution boundary. `enqueueFrame` should not
reconcile work, schedule newly runnable activations, or recursively start
executor work. Reconciliation may append framework work frames, but executor
work for those activation frames may start immediately once the active run has
identified them as runnable. Follow-up work caused by activation-produced frames
starts only after those frames have been yielded.

### Streaming Observation Events

Streaming is primarily an executor and host concern. Provider adapters may expose
their own streaming options and callbacks, and hosts may route partial output to
lightweight UI or telemetry paths. `runMachine` does not need to own a generic
streaming toggle before the executor API has settled.

Partial stream output must not be appended to the projector frame log, must not
trigger work, must not be included in compiled history, and must not affect
projection traversal. The durable source of truth remains the final `Frame`
containing the completed actor message.

The core framework should make executor-owned streaming easier by preserving
machine-scoped metadata on final actor messages. In particular, a final message
should be able to carry a stable logical output identity, currently expected to
be named `outputId`, plus optional stream completion metadata. Apps can map that
machine-owned `outputId` to their own message IDs or storage idempotency keys.
Core should not define an application `messageId` or database `idempotencyKey`.
Cost, latency, usage, and transport facts are not message metadata: they flow
through `ExecutionReport` into frame `provenance.execution`.

The stream side channel is a UI and telemetry convenience. It should be treated
as best-effort and should not be the only path for persisting final assistant
content. If stream transport fails, the activation may still complete normally
and emit the durable final frame.

### Inert Frame Ingestion

The machine should also expose an explicit API for folding a caller-supplied
frame into local runtime state without treating it as newly produced runtime
work:

```ts
machine.ingestInertFrame(frame)
```

`ingestInertFrame(frame)` requires `frame.inert === true`. This is intentionally
strict so local ingestion behavior cannot diverge from the frame's durable
runtime semantics. The requirement can be loosened later if a concrete use case
needs it.

An inert frame is not ignored. It is appended to the in-memory frame log in the
position supplied by the host, is deduped by `frame.id`, and is folded into the
machine exactly where ordinary frame replay would fold it. `InstanceMessage`s in
the frame apply their state mutations, `WorkMessage`s update reconstructed work
state, and actor messages may be visible to future generator history according
to normal audience, delivery, and activation-history rules.

Inert means the frame is not a trigger source. `ingestInertFrame` must not:

- assign a new frame ID;
- notify `machine.subscribe` listeners;
- yield the frame from `runMachine`;
- reconcile the frame into new activation work;
- start executor work.

This API exists for durable inert frames that should affect the local machine
view without causing local work scheduling or local production notifications.
Typical uses include importing already-observed shared instance updates from an
application subscription, applying synthetic history, or repairing local state
from an external frame log. The term "inert" describes runtime trigger behavior;
durability, commit status, storage order, and subscription semantics remain
application-owned concepts.

Hosts must call `ingestInertFrame` in stable durable append order for the
relevant frame log. The framework does not require dense numeric versions, but
replay order must be deterministic. If a future use case needs to import a frame
that should still create activations, that should be a separate active ingestion
API rather than overloading inert ingestion.

If an instance is removed while work for its generator is pending, the runtime
should enqueue completion work frames with `reason: "cancelled"` for affected
open activations. It is acceptable to accept a final frame from already
in-progress executor work, but removed instances must not create new runnable
activations.

### End-Turn Semantics

End-turn semantics are per-activation, not global. When a generator
declares end turn, the framework appends a completion work frame for the current
activation with `reason: "end-turn"`. The generator is not runnable again until
a future matching frame creates a new activation.

When a generator finishes its triggered work, the framework appends a completion
work frame for that activation with `reason: "done"`. For serial generators, the
next incomplete activation with the same concurrency key becomes runnable. For
parallel generators, other incomplete activations can already be runnable.

The machine-level concept is quiescence: no activations are runnable under the
current work log and host policy. Quiescence can be used by applications as the
replacement for the old global end-turn boundary, but the core runtime should
not assume a single continuous, well-ordered turn timeline.

## Client Integration

The client integration boundary should be a realized public read model, not the
durable frame log. Applications may keep the frame log private, noisy, or
server-only. A browser or other client should subscribe to a fully realized
client instance plus small synchronization metadata:

```ts
type MachineClientSnapshot<TInstance = unknown> = {
  instance: TInstance;
  recentCommandResidue: string[];
};
```

The subscription and transport are application concerns. For example, a Convex
query, LiveKit RPC, WebSocket feed, or HTTP poller can all deliver the same
shape. The framework's client package should not assume a storage backend or
require frame-log synchronization. Applications that do not use optimistic
commands may send an empty residue array.

### Client Instances

Client instances are public, realized views of the machine instance tree and
projection/member structure. They should contain enough metadata to render
debug UI, find commands, bind forms, and target messages, but they should not
contain executor-only behavior or private durable work details.

A client instance should include, where applicable:

- concrete instance IDs;
- node keys, names, and runtime metadata safe for display;
- durable children;
- public member/projection children with stable projection addresses;
- visible state values and their state addresses;
- state schema metadata for visible or form-bindable states;
- command metadata, command input schemas, and optional projection target addresses.

The exact client instance shape may evolve, but it must preserve stable projection
addresses for optional command targeting and stable `StateAddress` values for
state operations. Member projection nodes should be addressable through
`ProjectionAddress` without being serialized as durable child instances.

The server remains authoritative. Client-side validation and optimistic updates
are convenience behavior; every command and state mutation produced by a command
must still be validated against the hydrated server machine.

### Machine Effigy

`@projectors/core/client` should expose a small client runtime called a machine
effigy. It is a local mirror of the latest realized client instances plus a
message sender supplied by the application.

```ts
type SendMachineMessage = (message: ClientMachineMessage) => unknown | Promise<unknown>;

type MachineEffigy<TInstances = unknown> = {
  getInstances(): TInstances | undefined;
  setInstances(instances: TInstances): void;
  getRecentCommandResidue(): readonly string[];
  setRecentCommandResidue(ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  send(message: ClientMachineMessage): Promise<unknown>;
};

function createMachineEffigy<TInstances>(
  send: SendMachineMessage,
): MachineEffigy<TInstances>;
```

The effigy should stay minimal so ordinary client bundles do not pay for
inspection, form generation, or debug tooling. It owns local storage of the
authoritative subscribed instances and knows how to send client messages through
the application-provided transport.

### Typed Commands Without Explicit Contracts

The framework should not require users to author a separate client contract.
Type safety should flow from the actual machine declarations.

```ts
const setLiveMode = createAction({
  state: agentState,
  name: "setLiveMode",
  inputSchema: z.object({ enabled: z.boolean() }),
  run: async (input, ctx) => {
    ctx.updateState(patchState({ liveMode: input.enabled }));
  },
});

const agentNode = createNode({
  key: "agent",
  states: [agentState],
  commands: [setLiveMode],
});

type AgentClientInstance = ClientInstanceOf<typeof agentNode>;
type SetLiveModeCommand = typeof setLiveMode;
```

Client code can import type-only shapes inferred from the server declarations:

```ts
const effigy = createMachineEffigy<[AgentClientInstance, ThreadClientInstance]>(
  sendMessage,
);
const client = createOptimisticEffigy(effigy);

const command = client.getCommand("setLiveMode", {
  optimistic: (ctx, input) => ctx.patch({ liveMode: input.enabled }),
});

await command.run({ enabled: true });
```

`command.run({ enabled: "yes" })` should fail at compile time when the client
has an inferred type for the relevant command. Dynamic clients may still use the
runtime JSON schema metadata as a fallback.

Core should provide type helpers for extracting client-visible instance, state,
and command types from hydrated declarations:

```ts
type ClientInstanceOf<TNode> = unknown;
type ClientCommandOf<TCommand> = unknown;
type ClientStateOf<TStateDescriptor> = unknown;
type ClientCommandName<TInstances> = string;
type ClientCommandInput<TInstances, TName extends string> = unknown;

type ClientCommandHandle<TName extends string, TInput, TResult = unknown> = {
  name: TName;
  inputSchema: JSONSchema;
  run(input: TInput): Promise<TResult>;
  message(input: TInput): ClientMachineMessage;
};
```

Given `MachineEffigy<TInstances>`, command lookup should be typed from
`TInstances`:

```ts
getCommand<TName extends ClientCommandName<TInstances>>(
  name: TName,
  options?: ClientCommandOptions<TInstances, TName>,
): ClientCommandHandle<
  TName,
  ClientCommandInput<TInstances, TName>
>;
```

When multiple visible commands share a name, unqualified lookup uses the same
last-wins rule as server command execution. Static types may fall back to a union
when client instance ordering is not known precisely enough to infer the last
matching command. Targeted lookup can narrow by `ProjectionAddress` when the target
is known in the client instance type.

### Lightweight Typed Command Action Requests

The effigy APIs are the ergonomic integration path for subscribed clients, but
they should not be required just to create a typed command action request. The client
package should also expose a small helper for applications that already know
which command they want to send and own their transport directly:

```ts
import type { SetLiveModeCommand } from "./agent";
import { createCommandActionRequest } from "@projectors/core/client";

const request = createCommandActionRequest<SetLiveModeCommand>(
  "setLiveMode",
  { enabled: true },
);

await sendMessage(request);
```

The helper should type-check the command name and input from the imported
command type, generate a `callId` by default, and return the same
transport-ready `ClientMachineMessage` shape used by effigy command handles.

```ts
function createCommandActionRequest<TCommand extends AnyCommandDefinition>(
  name: ClientCommandDefinitionName<TCommand>,
  input: ClientCommandDefinitionInput<TCommand>,
  options?: {
    target?: ProjectionAddress;
    callId?: string;
  },
): ClientMachineMessage;
```

This mode intentionally does not check whether the command is currently
available on any subscribed instance, infer a target from a client tree, apply
optimistic updates, or retire optimism from residue. It is only a type-safe
message constructor. The server still resolves the command against the hydrated
machine and validates the input before executing it.

To support this mode, `createAction` must preserve literal command names and
schema-derived input types in its return type. For example, the type of
`setLiveMode.name` should remain `"setLiveMode"` rather than widening to
`string`.

Optional generated client types may be added later for applications that cannot
cleanly import type-only declarations, but generated contracts should not be
required for the ergonomic path.

### Optimistic Effigy

Optimistic behavior is client-defined. The server machine should not declare or
own optimistic patches because optimistic UI is presentation-specific and often
depends on local component needs.

`@projectors/core/client` should expose an optimistic wrapper over any readable
effigy:

```ts
type OptimisticEffigy<TInstances = unknown> = MachineEffigy<TInstances> & {
  getCommand<TName extends ClientCommandName<TInstances>>(
    name: TName,
    options?: {
      target?: ProjectionAddress;
      optimistic?: (
        ctx: OptimisticContext<TInstances>,
        input: ClientCommandInput<TInstances, TName>,
      ) => void;
    },
  ): ClientCommandHandle<TName, ClientCommandInput<TInstances, TName>>;
};

function createOptimisticEffigy<TInstances>(
  effigy: MachineEffigy<TInstances>,
): OptimisticEffigy<TInstances>;
```

The optimistic wrapper should:

- generate a local call ID for every command action request;
- include that ID in the outbound action request as `callId`;
- apply the command's client-provided optimistic updater, if present;
- expose `getInstances()` as the authoritative instances plus pending optimistic
  overlays;
- retire optimistic overlays when matching IDs appear in recent command
  residue;
- rebase remaining optimistic overlays when authoritative instances change.

The optimistic context should offer small, generic state-editing helpers. The
first pass can keep these intentionally narrow:

```ts
type OptimisticContext<TInstances = unknown> = {
  patch(patch: Record<string, unknown>): void;
  patchAt(address: StateAddress, patch: Record<string, unknown>): void;
  replaceAt(address: StateAddress, value: unknown): void;
  getInstances(): TInstances | undefined;
};
```

Applications decide whether to use optimism, what state to patch, whether to
update dependent views, and whether to define reusable command handles or
per-use-site optimistic behavior.

### Command Residue

Command residue is client synchronization metadata, not agent state. It should
not be stored on instances and should not require extra `InstanceMessage`
mutations. Storing residue on instances would make instance state larger and
semantically noisy, and it would create ambiguous ownership for commands
targeting removed or nested instances.

The framework should instead support command residue as bounded machine-level
sync metadata:

```ts
type MachineSyncState = {
  recentCommandResidue: string[];
};
```

When a client command is accepted and its immediate authoritative effects are
reflected in the client snapshot, the server includes the command's `callId`
in `recentCommandResidue`. The optimistic client retires the matching pending
overlay when it observes that ID.

Residue means "the server has observed this command and the current client
snapshot has caught up to its immediate effects." It does not mean all
downstream agent work caused by the command has completed.

The host application owns persistence and delivery of sync metadata. The
framework should provide helpers to record, bound, serialize, and consume recent
residue, but it should not require residue to live in the durable instance tree.

### Forms And Validation

Client forms should be powered by the same schemas attached to commands and
states. The client instance should include JSON Schema metadata for command
inputs and form-bindable state values. Type-aware clients can use the inferred
TypeScript types from the command and state declarations; dynamic clients can
use the JSON schemas.

Client validation is advisory. The server validates command input and resulting
state changes against the hydrated schemas before appending authoritative
effects.

### Inspection Utilities

Tree inspection and realized client instance helpers should stay on the client
integration side of the package, not on the base machine runtime. For the first
implementation pass, keep these helpers in `@projectors/core/client` instead of
adding separate `client/inspect` or `client/forms` entrypoints.

```ts
type EffigyReadable<TInstances = unknown> = {
  getInstances(): TInstances | undefined;
};

function inspectInstanceTree<TInstances>(
  source: EffigyReadable<TInstances> | TInstances,
): InspectedInstanceTree;

function inspectProjectionTree<TInstances>(
  source: EffigyReadable<TInstances> | TInstances,
): InspectedProjectionTree;
```

Passing a base effigy inspects the authoritative subscribed view. Passing an
optimistic effigy inspects the optimistic overlaid view. The inspection
functions should not need a separate `view` option. If the client bundle grows
substantially, split heavier inspection or form-generation utilities later.

## Serialization

Serialization means resumability, not just `JSON.stringify` compatibility. A
resumable machine is reconstructed from two inputs:

- a current, already-materialized top-level instance snapshot; and
- a durable frame log in stable append order.

`createMachine({ instance, charter, executor, runner, frames })` treats
`instance` as the current canonical machine view supplied by the host. It
preserves `frames` for projection history and work reconstruction, but it does
not replay historical `InstanceMessage`s into `instance`. Replaying arbitrary
instance mutations into a current snapshot would be unsafe because the
framework cannot know which mutations are already reflected in that snapshot.

The executor is never serialized: folding history never invokes an executor,
so hydrating a machine for read-only replay or inspection requires none.
Resuming with a different executor than the one that produced earlier frames
is legitimate; per-frame provenance keeps the history honest about which
runtime produced which generation. Frame `provenance` serializes as optional
passthrough — storage adapters may persist it inline, relocate it to a side
table keyed by frame id, or drop it, without affecting fold semantics.

If an application wants replay-from-initial semantics, it must provide an initial
top-level instance snapshot and a frame log whose instance mutations have not yet
been applied, or introduce explicit snapshot cursor metadata and replay only
frames after that cursor. That mode is out of scope for the first pass.

Use these terms consistently:

- Hydrated: executable runtime objects. May contain functions, closures, Zod
  schemas, SDK clients, and other non-JSON values.
- Dry: JSON-compatible data plus plain string references into a charter.
- Serialized: persisted/string form of dry data.

The charter is the executable registry for every non-serializable runtime value.
An instance snapshot may inline definitions, but every non-serializable
constituent inside an inline definition must be represented by a ref that can
hydrate back to an executable value.

Durable instance snapshots must never silently drop executable behavior. If
serialization encounters a function, closure, schema, computed part, discriminator, action
executor, or other non-serializable value that cannot be represented by a valid
ref, it must throw with a useful path to the failing field.

### Durable Versus Public Refs

Public helper APIs may accept hydrated objects for ergonomics:

```ts
transition(node);
spawn({ node });
```

Durable frames and instance snapshots must store only dry values:

```ts
type PublicNodeRef<TDataContent = never> =
  | Node<TDataContent>
  | Ref;
type SerializedNodeRef<TDataContent = never> =
  | DryNode<TDataContent>
  | Ref;
```

Before a frame is appended to the durable frame log, any hydrated node,
state, or action references in `InstanceMessage`s must be canonicalized into
`SerializedNodeRef` or another dry ref form. The frame log must not contain
live `Node`, `Action`, `StateDescriptor`, or other executable part-code
objects (computed parts, discriminators).

This applies to:

- `SerializedInstance.node`
- `InstanceMessage.kind: "transition".node`
- `SpawnChild.node`
- attached serialized subtrees
- any queued or emitted framework message that contains node/state/action/part refs

### Inline Definitions

Registered nodes serialize as refs by default:

```ts
"checkout"
```

Inlining is allowed, and inline nodes must be executable after hydration. An
inline node may contain serial data directly, but executable children must be
refs.

```ts
type DryRuntime =
  | { type?: "component" }
  | ({ type: "generator" } & TriggeredRuntimeOptions);
// boundaryProjection is a plain enum, so DryRuntime carries it as data.

type DryPart =
  | { kind: "text"; slot?: string; region?: LayoutRegionName; text: string }
  | {
      kind: "action";
      caller: ActionCaller;
      exposure?: Exposure;
      ref: Ref;
      guidance?: Array<{ slot?: string; region?: LayoutRegionName; text: string }>;
    }
  | { kind: "computed"; ref: Ref }
  | {
      kind: "select";
      discriminator: Ref;
      partial: boolean;
      branches: Record<string, DryPart[] | null>;
    };

// The wire shapes of sugar-lowered selects (metadata-bearing computeds) are
// stable across the SelectPart/MemberSelect-kind deletion: old stored
// payloads hydrate through the sugar unchanged.
type DryMemberSelect<TDataContent = never> = {
  kind: "select";
  discriminator: Ref;
  partial: boolean;
  branches: Record<string, Array<DryNode<TDataContent> | Ref> | null>;
};

type DryMemberEntry<TDataContent = never> =
  | DryNode<TDataContent>
  | Ref
  | DryMemberSelect<TDataContent>;

type DryNode<TDataContent = never> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  params?: unknown;
  parts?: DryPart[];
  states?: Array<SerializedStateDescriptor | Ref>;
  members?: DryMemberEntry<TDataContent>[];
  output?: SerializedOutputConfig;
  runtime?: DryRuntime;
  executorConfig?: Record<string, unknown>; // plain JSON, round-trips as-is
};
```

Inline and de novo nodes serialize as pure data: parts round-trip as `DryPart`
(text and guidance as literal data, actions/computed parts/discriminators as
refs), and region addresses serialize as region names that re-enter through
the `preambleRegion`/`recencyRegion` sentinels at hydration. Behavioral refs
recover branch-scoped through `sourceNodeKey` or the charter; code never
serializes.

```ts
```

`sourceNodeKey` records the registered node an inline node was derived from, when
one exists. This is important when a registered node is force-inlined for edits
but still wants to reuse node-local tools or commands from the original
registered node. Inline node action refs then stay compact names and resolve via
`sourceNodeKey`.

`forceInline` only changes the node serialization boundary. It does not permit
dropping unregistered executable values. If a force-inlined node contains an
unregistered action, computed part, discriminator, state init function, or schema that
cannot round-trip, serialization must throw.

### Actions And Commands

Actions and commands are executable values. In the first pass, executable
instance snapshots should serialize actions and commands only by ref.
Metadata-only action serialization is allowed for display/client views, but not
for executable machine persistence.

When serializing an action ref on an inline node, the serializer may keep a
compact string ref when:

1. the ref is already a string with no local binding;
2. the local binding exists in `charter.tools` or `charter.commands`, by object
   identity;
3. the local binding exists on the registered `sourceNodeKey` node's local
   `tools` or `commands`, by object identity.

If an inline node has a local action that is not globally registered and is not
available on its `sourceNodeKey` node, serialization must throw. This preserves
the ability to keep tools local to nodes without forcing every tool into the
charter's global tool registry.

Action metadata overrides on top of an action ref are out of scope for the first
pass. A ref hydrates the whole executable action, including name, description,
schema, and execute function. Hydration eagerly resolves inline node tool and
command refs through `sourceNodeKey` and the charter, and rejects refs that are
unknown or whose resolved action has `action.name !== ref`.

### States, Schemas, And Registered Part Code

State descriptors follow the same rule as nodes:

- Registered descriptors serialize by ref.
- Inline descriptors may serialize inline only if their schema and init behavior
  can round-trip.
- Zod schemas may serialize with `z.toJSONSchema` and hydrate with
  `z.fromJSONSchema`.
- `init` functions are executable values and must serialize by ref or throw.

Registered part code — computed parts and discriminators — serializes by
ref. Inline instances may execute in memory, but machine serialization must
throw if an unregistered one is encountered. `runtime.boundaryProjection` is
a plain enum and serializes as data, omitted when it is the default
`"hidden"`. `StateProjection` placement (`slot`, `region`, `exposure`)
serializes as data; `projection.render` and `projection.note` are code, never
serialize, and therefore require registered descriptors.

Part refs on inline nodes resolve branch-scoped through `sourceNodeKey`
first, then through the charter registries — the same rule as action refs.
Slots and layouts are data definitions registered in the charter; parts
reference slots by name.

History projection functions follow the same executable-value rule. Registered
history projection functions serialize by bare string ref. Inline history
projection functions may execute in memory, but machine serialization must throw
if one is encountered. The built-in message history projection is
`{ type: "messages" }`; serialized runtimes may omit it when it is the default.
The built-in actor history projection is `{ type: "actor" }` and is serialized
only when explicitly selected.

### Hydration

Hydration is strict. Unknown refs in the field's registry, refs that cannot
produce executable hydrated values, or executable inline values that cannot
round-trip must throw.

Hydrating a dry inline node must recursively hydrate:

- action refs (tools and commands, one namespace)
- state descriptors and schemas
- member entries (nodes and computed members, incl. member-select sugar)
- part refs: computed parts and select discriminators (registries walked for
  inline-value recovery)
- slot addresses (region addresses re-enter by sentinel identity)
- history projection refs (via layouts)

After hydration, the machine must be executable without consulting the original
live objects that produced the snapshot.

Hosts should persist a `charterKey` and `charterVersion` alongside machine
snapshots. Refs only have meaning against a compatible charter.

## Tests

Keep tests sparse and scenario-based. Prefer tests that prove traversal,
projection, resumability, state conflict handling, work scheduling, or another
critical behavior. Avoid tests that only restate a type shape, constructor
default, or one field assignment unless that detail changes runtime behavior.

The conformance suites under `packages/projector/test/conformance/`
(projection, layout, selects, state projections, serialization of parts,
provenance, state, and lowering — which runs against the real executor
packages) are the canonical executable form of this list.

Add focused tests for:

- Projection compiler behavior: `ProjectionNode` traversal is pre-order and
  left-to-right, members project before runtime children, parts render into
  slots per the active layout (regions rendering to `preamble`/`recency` as
  slot-stamped `CompiledPart`s), select branches resolve against the
  contributor's discriminator environment, guidance travels atomically with
  its action part, and same-name action collisions resolve deepest-wins with
  `shadowed-action` diagnostics.
- Runtime projection boundaries: generator runtimes default
  `boundaryProjection` to `"hidden"`, hidden boundaries prevent descendant
  leakage, and `"augment"` exports the runtime's whole owned aggregate as
  compiled.
- State projection ownership: hoisted state contributed behind a runtime
  boundary projects from the nearest source instance without exporting the hidden
  runtime aggregate, while local state remains behind that boundary.
- Source instance hoist ownership: machine trees require at least one
  `isSource: true` instance, `createRoot(...)` does not itself become a state
  ownership anchor, hoisted state below each direct source instance is owned by
  that source instance, and hoisted state resolution throws when no source
  instance is available.
- Parts and computeds: computed parts evaluate with the contributor's
  params/state/discriminator env; authored computeds declare a
  volatile-validated default slot while sugar returns keep their own
  addresses; returned action parts resolve through the scoped registry chain
  and unresolvable closure identities throw; select/when and
  selectMember/whenMember lower to metadata-bearing computeds with
  auto-derived registries; partial selects require `when()`/`whenMember()`.
- Member semantics: members are not serialized as durable children, reload uses
  current registered member definitions, member node keys produce deterministic
  virtual projection addresses, duplicate sibling member node keys throw, member
  runtimes create work identities from those addresses, and member state or spawn
  operations resolve to the nearest concrete owner instance.
- Params behavior: `createRoot(charter, instances, params)` parses and stores
  charter params on the synthetic top-level instance, `createMachine` validates
  real top-level params against `charter.params`, effective params shallowly
  merge down instance paths and reject overrides, node and action contexts see
  only their declared local param views, and static type tests cover charter to
  node compatibility including member descendants plus node to action
  compatibility.
- State resolution and realization: `hoist` state resolves to the nearest
  source instance, one registered descriptor identity per state key is
  validated at charter build, reads of unrealized state fall back to `init`
  without side-effecting, writes and spawn seeds realize containers at the
  scope-dictated placement, `getState` aliases derive from declarations (not
  realized containers), unrealized state does not serialize, and
  `"replace"` resets invalid existing state.
- Durable state mutation behavior: `ctx.updateState(...)` synchronously enqueues
  durable mutations with explicit `stateKey`, updates `ctx.state` before
  returning, symbolic targets are canonicalized to concrete instance IDs,
  `state.update` replace operations validate replacement values, patch
  operations shallow-merge and validate the full result, and append operations
  append to arrays and validate the full result.
- Command execution: `executeCommand` resolves and validates commands explicitly
  at the app boundary, enqueues an accepted command `ActionRequestMessage`,
  executes the command once, enqueues an `ActionResultMessage` plus returned
  output messages, does not return command frames as a separate persistence path,
  and `runMachine` ignores command action messages for execution.
- Durable instance mutation behavior: related mutations apply in
  `Frame.messages` order, `transition` preserves the target instance ID and
  durable children, `spawn` initializes child state from descriptors plus
  overrides, `attach` preserves supplied subtrees, and `remove` removes the
  target subtree.
- Serialization and hydration safety: registered executable values hydrate by
  ref, inline Zod state schemas round-trip, force-inlined registered nodes keep
  executable node-local tools through `sourceNodeKey`, durable frames
  canonicalize hydrated node/action/state/projection inputs before persistence,
  registered part code (computed parts, discriminators) and history projection
  functions serialize by ref or throw, parts round-trip as pure data
  (guidance included), unknown refs throw, and unregistered executable inline values throw instead of being
  dropped.
- Executor-visible compilation: commands stay out of compiled inference, tool
  order is preserved so provider assembly can resolve duplicate tool names with
  last-definition-wins behavior, retrieval state aliases match projected
  retrieval access, default `{ type: "messages" }` history projection preserves
  visible frame-message order, `{ type: "actor" }` extracts visible actor
  messages, and custom history projections receive filtered frame history plus
  current state values and return executor-visible frame messages.
- Audience and history filtering: user messages default to broadcast,
  assistant/tool messages default to self, broadcast and explicit runtime
  address targets are visible to the correct generators, self messages are only
  visible to the producing generator, message audience alone does not create
  activations without a matching runtime trigger, `delivery: "immediate"` makes
  visible actor messages eligible for already-open live activations,
  `delivery: "queued"` hides actor messages from already-open activations while
  keeping them visible to later activations, `activationHistory: "snapshot"`
  excludes later external actor messages during the activation, and snapshot
  activations still see actor messages produced by the same activation.
- Work reconciliation: generator triggers append deterministic
  activation work frames separate from the source frame, activation messages
  record `sourceFrameId`, reconciliation rescans the full frame log
  idempotently and derives work in projection traversal order, immediate
  messages projected mid-generation via `refreshInference` are absorbed while
  unseen immediate messages and queued messages produce follow-up generations,
  work-only and instance-only frames do not trigger `actor-frame`,
  nearest-ancestor rules apply to parent activation/completion triggers, a serial
  runtime's own assistant and tool frames derive no new activations for that
  runtime, a parallel activation's output derives no new activations for the
  same projection address, the first durable terminal completion wins, and removed
  instances cancel open activations.
- Concurrency and dispatch: serial generator runtimes expose only the
  earliest incomplete activation per concurrency key, parallel runtimes expose
  all incomplete activations as runnable, `runMachine(..., { scheduleWork: false })`
  yields reconciliation work frames without scheduling executors, and
  `enqueueFrame` observes/enqueues frames without recursively reconciling or
  scheduling newly runnable work. A `MachineRun` is cold until consumed, drains
  pending local frames in append order, and `stopSchedulingWork()` stops future
  executor scheduling while still yielding deterministic activation frames and
  already-started activation output.
- Inert ingestion: `ingestInertFrame` requires `frame.inert === true`, dedupes by
  caller-supplied frame ID, folds instance and work messages into local state,
  keeps actor messages eligible for history according to audience, delivery, and
  activation history, and does not invoke enqueue hooks, yield from `runMachine`,
  reconcile activation work, or schedule executors.
- Executor binding: machines without an executor hydrate, fold frames, and
  drain with `scheduleWork: false`, while scheduling generator work throws;
  node `executorConfig` namespaces are validated against the bound executor's
  `configSchema` at machine creation and delivered per activation as
  `ExecutorRunRequest.config`.
- Provenance: executor-produced frames are signed with executor identity,
  execution reports, and runner info; machine-synthesized frames sign with a
  machine producer; frames handed to history-projection code have provenance
  stripped; and the fold is identical with provenance removed —
  `fold(charter, frames) === fold(charter, stripProvenance(frames))`.
- Message-only completions: turn boundaries (including realtime
  `createRuntimeTurnFrame` frames) are detected from work messages alone,
  completion messages recover their generator via inline `generatorId` or the
  activation join, and no frame-level channel affects work semantics.
- Client integration smoke coverage, if included in the first implementation
  pass: client snapshots expose a realized instance plus command residue without
  public frame-log synchronization, command and state addresses are stable for
  concrete instances and member projection nodes, recent command residue remains
  machine-level sync metadata, optimistic overlays retire and rebase by residue,
  and typed command helpers are covered by compile-time type tests rather than
  runtime shape assertions.
