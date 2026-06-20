# Projector Master Plan

This is a breaking rewrite of `@projectors/core`. There is no backwards
compatibility requirement.

- Remove packs entirely.
- Replace contexts with states.
- Rewrite public API and internal types as needed.
- Delete old tests.
- Add only focused tests for algorithmic behavior, especially projection frame
  ordering, `augment`, `replace`, required children ordering, and state
  initialization/validation.

## Core Types

```ts
type ProjectionMode = "hidden" | "augment" | "replace";

type Ref = string;
type ProjectionFunctionRef = Ref;
type StateDescriptorRef = Ref;
type HistoryProjectionFunctionRef = Ref;

type StaticProjection = {
  mode?: ProjectionMode;
  instructions?: "system" | "dynamic" | "hidden";
  tools?: "provider-static" | "hidden";
};

type StaticBoundaryProjection = {
  mode?: ProjectionMode;
};

type ProjectionTextPart = { type: "text"; value: string };

type ProjectionStatePart = {
  type: "state";
  section: "system" | "dynamic" | "retrieval";
  stateKey: string;
  target: StateAddress;
  value: unknown;
};

type ProjectionPart = ProjectionTextPart | ProjectionStatePart;

type ProjectionDraft = {
  systemParts: ProjectionPart[];
  dynamicParts: ProjectionPart[];
  tools: Action[];
  states: ProjectionStatePart[];
};

type ProjectionSource = {
  readonly instructions?: string;
  readonly systemParts: readonly ProjectionPart[];
  readonly dynamicParts: readonly ProjectionPart[];
  readonly tools: readonly Action[];
  readonly states: readonly ProjectionStatePart[];
};

type ProjectionCallSite = "node" | "boundary";

type ProjectionContext<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  callSite: ProjectionCallSite;
  runtimeInstanceId: RuntimeInstanceId;
  address: RuntimeAddress;
  target?: Generator;
  node: Node<TActorMessage>;
};

type ProjectionFunctionMethod<TActorMessage extends AnyActorMessage = DefaultActorMessage> = (
  ctx: ProjectionContext<TActorMessage>,
  draft: ProjectionDraft,
  source: ProjectionSource,
) => void;

type ProjectionFunction<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  kind: "projection";
  name: string;
  method: ProjectionFunctionMethod<TActorMessage>;
};

type Projection =
  | StaticProjection
  | ProjectionFunctionRef
  | ProjectionFunction;

type BoundaryProjection =
  | StaticBoundaryProjection
  | ProjectionFunctionRef
  | ProjectionFunction;
```

Projection defaults:

- `node.projection` defaults to
  `{ mode: "augment", instructions: "system", tools: "provider-static" }`.
- `runtime.boundaryProjection` defaults to `{ mode: "hidden" }` for primary and
  worker runtimes.
- `StateDescriptor.projection` defaults to `"hidden"`.

Static node projection controls node-local instructions, projected state, and
node tools. Static boundary projection intentionally supports only `mode`:
`hidden`, `augment`, or `replace`. A static boundary `augment` or `replace`
exports the child runtime aggregate as compiled, preserving system parts,
dynamic parts, tools, and retrievable state metadata. Selective boundary export
belongs in a projection function.

Projection functions are low-level compile-time hooks. They receive the current
destination draft and a normalized source, then mutate the draft directly. The
draft intentionally exposes the projection IR instead of flattened strings so
state metadata can survive until final render and retrieval alias generation.
Finalization treats state parts in `systemParts` and `dynamicParts` as projected
state metadata, so projection functions can move prompt parts between sections
without separately maintaining `draft.states`. A function may still push directly
to `draft.states` for metadata-only retrieval exposure.

Projection functions follow the same charter ref rules as other registered
objects. If registered in `charter.projections`, they serialize by ref. Inline
projection functions are executable in memory but are not serializable;
serialization should throw if an unregistered projection function is encountered.
Static boundary projections with `instructions` or `tools` must be rejected
during construction or hydration.

```ts
type GeneratorId = string;
type RuntimeInstanceId = string; // encoded RuntimeAddress
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

type AudienceTarget = RuntimeAddress;

type Audience = "self" | "broadcast" | AudienceTarget | AudienceTarget[];

type UserMessage<TContent = string> = {
  type: "user";
  content?: TContent;
  text?: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

type AssistantMessage<TContent = string> = {
  type: "assistant";
  content?: TContent;
  text?: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

type ToolMessage = {
  type: "tool";
  name: string;
  text?: string;
  value?: unknown;
  audience?: Audience;
  delivery?: MessageDelivery;
};

type ActorMessage<
  TAssistantContent = string,
  TUserContent = string,
> = UserMessage<TUserContent> | AssistantMessage<TAssistantContent> | ToolMessage;

type AnyActorMessage = ActorMessage<any, any>;
type DefaultActorMessage = ActorMessage<string>;

type AssistantContentOf<TActorMessage> =
  Extract<TActorMessage, { type: "assistant" }> extends { content?: infer C }
    ? C
    : never;

type OutputConfig<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  audience?: Audience;
  schema?: z.ZodType<AssistantContentOf<TActorMessage>>;
  mapTextBlock?: (text: string) => AssistantContentOf<TActorMessage>;
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

type HistoryProjection<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | ActorHistoryProjection
  | MessageHistoryProjection // default
  | HistoryProjectionFunctionRef
  | HistoryProjectionFunction<TActorMessage>;

type HistoryProjectionContext<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  target: Generator;
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  trigger: RuntimeTrigger;
  history: Frame<TActorMessage>[];
  states: Record<StateKey, unknown>;
};

type HistoryProjectionFunctionMethod<TActorMessage extends AnyActorMessage = DefaultActorMessage> = (
  ctx: HistoryProjectionContext<TActorMessage>,
) => FrameMessage<TActorMessage>[];

type HistoryProjectionFunction<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  kind: "historyProjection";
  name: string;
  method: HistoryProjectionFunctionMethod<TActorMessage>;
};

type TriggeredRuntimeOptions<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  trigger: RuntimeTrigger;
  concurrency?: RuntimeConcurrency; // default "serial"
  activationHistory?: ActivationHistory; // default "live"
  historyProjection?: HistoryProjection<TActorMessage>; // default { type: "messages" }
};

type Runtime<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | { type?: "component" } // default
  | ({
      type: "primary";
      boundaryProjection?: BoundaryProjection; // default { mode: "hidden" }
    } & TriggeredRuntimeOptions<TActorMessage>)
  | ({
      type: "worker";
      boundaryProjection?: BoundaryProjection; // default { mode: "hidden" }
    } & TriggeredRuntimeOptions<TActorMessage>);
```

App-supplied user and assistant actor messages may be text-only, content-only,
or both. `text` is the portable rendering fallback. `content` is app-owned rich
message content and is optional even when the content type parameter is
specified.

`node.output` controls how implicit LLM text output is shaped after executor
completion. `output.schema`, when present, is passed to the executor as the
runtime's structured-output schema and is type-checked against the configured
assistant content type. `output.mapTextBlock`, when present, maps the executor's
returned text block into that assistant content type before schema validation. If
no mapper is provided, returned text becomes the assistant content. The framework
then wraps the content in an `AssistantMessage` with `content` set and `text`
preserved as the raw LLM text. `output.audience` is applied when the implicit
assistant message does not already carry an explicit audience.
Fully formed frames or messages emitted by tools, actions, or executors keep
their own audience or use their message-type default.

`runtime.activationHistory` controls whether an open activation accepts newly
visible actor messages while it is still running. `"live"` activations compile
history from the current frame log before each inference frame. `"snapshot"`
activations compile from the history visible when the activation opened, plus
messages produced by that same activation. This is especially useful for
parallel workers whose mid-loop context should not be steered by unrelated
frames arriving after the activation starts.

`runtime.historyProjection` controls how a runtime converts its visible frame
history into `CompiledInference.history`. The default `{ type: "messages" }`
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
type StateDescriptor<S = unknown> = {
  key: string;
  schema: Schema<S>;
  init?: S | (() => S);
  scope?: "top" | "local"; // default "top"
  onInitConflict?: "error" | "replace"; // default "replace"
  projection?: "system" | "dynamic" | "retrieval" | "hidden"; // default "hidden"
};

type StateContainer<S = unknown> = {
  value: S;
};

type Instance<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id: string;
  node: Node<TActorMessage>;
  states?: Record<string, StateContainer>;
  children?: Instance<TActorMessage>[]; // removable runtime children
};
```

State rules:

- `scope: "local"` stores on the current concrete instance.
- `scope: "top"` walks parentage upward from the current concrete instance
  until the next parent would be stateless, or until the machine tree root is
  reached.
- Stateless nodes cannot declare state and are skipped as top-state ownership
  anchors. They may still participate in projection, runtime scheduling, and
  traversal.
- Each node may attach at most one state descriptor through `node.state`.
- The same `StateDescriptor.key` may still appear on multiple nodes. It means
  shared access to the same resolved state container.
- State containers are resolved by target instance plus state key.
- If traversal encounters multiple descriptors for the same resolved target
  instance plus state key, those descriptors must be compatible. They must agree
  on `scope`, and each descriptor schema must validate the reused state value.
  Incompatible descriptors throw.
- If a state must be initialized and multiple compatible descriptors are visible,
  conflicting non-equivalent `init` values throw. Equivalent `init` values are
  allowed. For concrete values, equivalence uses `Object.is` for primitives and
  stable JSON equality for JSON-serializable values. For `init` functions,
  equivalence means the same function reference; different function references
  conflict.
- If multiple compatible descriptors are visible, `onInitConflict` merges by
  strictest policy: `"error"` takes precedence over `"replace"`.
- If multiple compatible descriptors are visible, `projection` is view-level
  policy and uses latest-wins in `ProjectionFrame` traversal order.
- Top-scoped state projects from its resolved target instance's projection frame,
  even when the latest descriptor contribution came from a member or worker
  boundary. Local state projects from the descriptor's source frame.
- Existing state validation and invalid-state conflict handling use the effective
  descriptor after compatibility has been checked.
- If an existing value validates against the descriptor schema, reuse it.
- If validation fails, apply `onInitConflict`: `"replace"` resets to `init`,
  `"error"` throws.
- Default state projection is `"hidden"`.

State descriptors follow the same charter ref and inline serialization rules as
nodes. If registered in `charter.states`, serialize by ref. Otherwise serialize
inline. Inline state descriptors use `z.toJSONSchema` and `z.fromJSONSchema` so
their schemas can round-trip through serialized machines.

The internal state model is always plural and keyed. Runtime state containers are
stored by state key, and every durable state mutation message must include the
target `stateKey` even when a public helper infers that key.

## Node

```ts
type ActionRef = string;
type ActionConfigEntry = Action | ActionRef;
type ActionBindings = Record<string, Action>;

type NodeConfig<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key?: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  stateless?: boolean;
  tools?: ActionConfigEntry[];
  commands?: ActionConfigEntry[];
  state?: StateDescriptor;
  members?: Node<TActorMessage>[]; // required/static compositional members
  output?: OutputConfig<TActorMessage>;
  projection?: Projection;
  runtime?: Runtime<TActorMessage>;
};

type Node<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  stateless: boolean;
  toolBindings: ActionBindings;
  toolRefs: ActionRef[];
  commandBindings: ActionBindings;
  commandRefs: ActionRef[];
  state?: StateDescriptor;
  members: Node<TActorMessage>[];
  output?: OutputConfig<TActorMessage>;
  projection: Projection;
  runtime: Runtime<TActorMessage>;
};
```

`key` and `id` encode different concepts and should both remain:

- `Node.key` is the stable node definition identity used for registry and
  serialization.
- `Instance.id` is the concrete runtime instance identity.

`projection` is optional in `NodeConfig`, but required on normalized `Node`.

Members are direct nodes. A member's stable path segment is its `Node.key`, and
duplicate sibling member keys are an error. If an app needs the same logical
node twice under one parent, it should create distinct wrapper nodes with unique
keys.

Only keep `createNode<TActorMessage>(config)` for the first pass. A node may
attach at most one state descriptor through `config.state`. Do not add
`createSkillNode`, `createWorkerNode`, or `createPrimaryNode` initially. Most
apps should anchor the actor message type at `createCharter<TActorMessage>()`;
`createNode<TActorMessage>()` is available when a node is authored away from that
charter context or needs its `output.schema` checked locally.

## Charter

The charter is the executable registry for all ref-addressable runtime values.
Refs are dry, stable identifiers that hydrate through a compatible charter.

```ts
type Charter<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key?: string;
  version?: string;
  executor: Executor<TActorMessage>;
  nodes: Record<string, Node<TActorMessage>>;
  tools: Record<string, Action>;
  commands: Record<string, Action>;
  states: Record<string, StateDescriptor>;
  projections: Record<string, ProjectionFunction<TActorMessage>>;
  historyProjections: Record<string, HistoryProjectionFunction<TActorMessage>>;
};

type CharterConfig<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key?: string;
  version?: string;
  executor: Executor<TActorMessage>;
  nodes: readonly Node<TActorMessage>[];
  tools: readonly Action[];
  commands: readonly Action[];
  states: readonly StateDescriptor[];
  projections: readonly ProjectionFunction<TActorMessage>[];
  historyProjections?: readonly HistoryProjectionFunction<TActorMessage>[];
};
```

`createCharter<TActorMessage>()` is the primary type anchor for an application.
The charter's actor message type flows into registered nodes, runtime history
projections, executor requests, output configuration, frames, and machine
instances. Apps that only need structured assistant output can use
`ActorMessage<TAssistantContent>`, which leaves user content as `string`.
Apps that need rich user and assistant content can use
`ActorMessage<TAssistantContent, TUserContent>` or define a full actor-message
union and pass that as `TActorMessage`.

`createCharter(config)` accepts array inputs for executable registries, validates
unique names/keys, and normalizes the hydrated charter to record registries for
field-specific ref lookup.

Refs are compact, plain strings. They are resolved by field context rather than
by a generic namespaced grammar:

```ts
"checkout" // node field
"search" // tool field
"approve" // command field
"thread" // state field
"summary" // projection field
"memory" // historyProjection field
```

Hydration should use field-specific helpers, not a context-free ref resolver.
Unknown refs in the relevant registry must throw.

Action refs use the same compact strings but resolve at runtime in this order:

1. the current node's local binding;
2. the registered `sourceNodeKey` node's local binding;
3. the charter's top-level `tools` or `commands` registry.

For the first implementation pass, an action ref is also the action name:
`ref === action.name`. Hydration must reject a tool or command ref if it resolves
to an action with a different `name`. Aliasing refs to differently named actions
is future work.

## Projection Frames And Runtime Frames

`createRoot(instances: Instance[])` is a helper API for idiomatic application
composition. It returns a stateless root `Instance` with id `"root"` and a
hidden primary runtime. The id `"root"` is not globally reserved; it is only the
id this helper chooses for the root instance it creates.

The helper is especially useful when an app wants to merge multiple independent
durable instances into one machine tree. A common split is an `agentInstance`
that owns agent behavior and an independent `threadInstance` that owns
conversation/thread state:

```ts
const root = createRoot([agentInstance, threadInstance]);
```

After this normalization there is still no separate wrapper type, but the
helper root's node is marked `stateless`. Traversal, runtime ancestry,
projection, and scheduling see the returned root as an ordinary instance.
State ownership skips it: `scope: "top"` state beneath `agentInstance` targets
`agentInstance`, and `scope: "top"` state beneath `threadInstance` targets
`threadInstance`, unless a descriptor uses `scope: "local"`.

`ProjectionFrame` is the traversal unit used by the projection compiler. It is
distinct from durable runtime `Frame` entries in the message/work log.

ProjectionFrame order is pre-order, left-to-right:

```txt
current instance
node.members, left to right
instance.children, left to right
```

Example:

```ts
createRoot([instanceA, instanceB]);
// root.node.members = []
// instanceA.node.members = [criticNode]
// instanceA.children = [instanceFoo, instanceBar]
```

ProjectionFrame order:

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

Members always participate in traversal and cannot be removed via runtime child
mutation. They may still be superseded by a later `replace` projection.

Members must not be materialized as durable child instances during serialization
or deserialization. This distinction is intentional: members represent current
node-definition composition, so changes to registered member definitions in a
future app release automatically apply to existing persisted instances when those
instances are reloaded against the updated charter. Runtime `children` represent
durable conversation state and should preserve the exact children that were
spawned or attached during execution.

Members can still have `primary` or `worker` runtimes. The runtime gives each
member projection frame a virtual runtime address derived from the nearest
concrete owner instance and the stable member node key path:

```ts
type RuntimeAddress =
  | { type: "instance"; instanceId: string }
  | { type: "member"; ownerInstanceId: string; memberPath: string[] };
```

The encoded runtime address is usable anywhere the work model needs runtime
identity, including `runtimeInstanceId`, generator IDs, activation IDs,
concurrency keys, explicit audience targets, and parent-generator lookup. In the
rest of this document, `runtimeInstanceId` may refer either to a concrete
`Instance.id` or to an encoded virtual member runtime address.

Example virtual addresses:

```txt
instance:abc
member:abc/critic
member:abc/research/retriever
```

Virtual member addresses are recomputed from current registered node definitions
on load. They are not serialized as durable children. Reordering members does
not change a virtual address as long as member node keys stay the same.
Duplicate sibling member node keys are an error.

Runtime `Frame`s must be stored and supplied to the runtime in stable durable
append order. The core framework does not require a dense global sequence field.

## Compile Projection

The projection compiler produces an executor-neutral shape:

```ts
type CompiledInference<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  systemParts: string[];
  history: FrameMessage<TActorMessage>[];
  dynamicParts: string[];
  tools: Action[];
  retrievableStates: RetrievableState[];
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

The alias map is scoped to one compiled inference. It must not be serialized into
durable frames, exposed through client state mutation APIs, or accepted anywhere
except the inference `getState` tool. `retrievableStates` contains only the alias
entries that `getState` may retrieve. The `target` field is runtime metadata and
must not be rendered into prompts or provider tool schemas. The runtime treats
aliases as exact map keys; it does not parse arbitrary model-supplied strings
into state targets. If generated aliases collide, projection compilation throws.

Projection compilation uses an internal `ProjectionDraft` IR. `CompiledInference`
still renders executor-facing prompt parts to `string[]` after aliases and
retrievable states are finalized.

Compilation rule for projection-owned sections:

```ts
const history = compileVisibleHistory(frames, targetGenerator);
const sectionRoot =
  targetGenerator
    ? findRuntimeFrame(root, targetGenerator.runtimeInstanceId) ?? root
    : root;
const draft =
  targetGenerator && isPrimaryOrWorkerBoundary(sectionRoot)
    ? compileTargetGeneratorProjection(sectionRoot, targetGenerator)
    : compileProjectionSubtree(sectionRoot, targetGenerator);

return finalizeProjectionDraft(draft, history);

function compileTargetGeneratorProjection(frame, targetGenerator) {
  return compileOwnedGeneratorProjection(frame, targetGenerator);
}

function compileBoundaryGeneratorProjection(frame) {
  return compileOwnedGeneratorProjection(frame, generatorForFrame(frame));
}

function compileOwnedGeneratorProjection(frame, targetGenerator) {
  const draft = emptyProjectionDraft();
  applyProjection(
    draft,
    compileNodeProjectionSource(frame),
    frame.node.projection,
    projectionContext(frame, "node", targetGenerator),
  );
  for (const child of collectDirectProjectionChildren(frame)) {
    visitProjectionFrame(draft, child, targetGenerator);
  }
  return draft;
}

function compileProjectionSubtree(frame, targetGenerator) {
  const draft = emptyProjectionDraft();
  visitProjectionFrame(draft, frame, targetGenerator);
  return draft;
}

function visitProjectionFrame(draft, frame, targetGenerator) {
  if (
    isPrimaryOrWorkerBoundary(frame) &&
    !belongsToGenerator(frame, targetGenerator)
  ) {
    const exported = compileBoundaryGeneratorProjection(frame);
    applyBoundaryProjection(
      draft,
      readonlyProjectionSource(exported),
      frame.runtime.boundaryProjection ?? { mode: "hidden" },
      projectionContext(frame, "boundary"),
    );
    return; // do not directly traverse descendants across a runtime boundary
  }

  applyProjection(
    draft,
    compileNodeProjectionSource(frame),
    frame.node.projection,
    projectionContext(frame, "node"),
  );

  for (const child of collectDirectProjectionChildren(frame)) {
    visitProjectionFrame(draft, child, targetGenerator);
  }
}
```

`compileTargetGeneratorProjection` preserves the scheduler-supplied
`Generator.id`, which may be activation-specific for parallel runtimes.
`compileBoundaryGeneratorProjection` deliberately synthesizes a generator from
the runtime frame because boundary aggregate compilation is an internal
ownership pass, not a real activation target.

`sectionRoot` is the target runtime frame when compiling a primary or worker
generator. For a `createRoot(...)` tree, the root primary is just the projection
frame for the returned root instance.

Primary and worker runtimes are projection boundaries. When compiling a
generator outside that runtime boundary, the compiler must not traverse the
boundary's descendants directly. It first compiles the boundary's owned
projection using that runtime's own `node.projection`, then applies
`runtime.boundaryProjection ?? { mode: "hidden" }` to the resulting aggregate
before adding it to the parent compilation.

When compiling a specific primary or worker target generator, that runtime's
projection frame is the root of the projection section pass. Ancestor runtime
boundaries are not traversed through to reach the target, and ancestor
instructions/tools do not implicitly project downward into the child generator.
A child generator's fully compiled projection projects upward to its nearest
owning generator only through that child's `boundaryProjection` policy.

A runtime's owned projection includes that runtime's own projection frame plus
its member and child descendants until another primary or worker runtime
boundary is reached. Nested runtime boundaries are exported to the owning runtime
through their own `boundaryProjection` policy using the same rule.

State projection follows state ownership before runtime boundary traversal:
top-scoped state is grouped under the resolved target instance frame, while
local state is grouped under the descriptor's source frame. A member inside a
worker runtime can contribute a descriptor for top-scoped state owned by the
app-level top instance; that state may project from that owner without exporting
the worker runtime's aggregate. Hidden boundaries still hide the worker's own
instructions, tools, local state, and descendant aggregate.

Static node projection applies to a node source: node instructions, projected
state parts, and node tools. Static boundary projection applies to a child
runtime source that has already been compiled. Boundary static policy therefore
supports only `mode`. `mode: "hidden"` drops the child runtime aggregate.
`mode: "augment"` merges it as compiled. `mode: "replace"` clears the parent
draft before merging it as compiled. Child system parts remain system parts,
child dynamic parts remain dynamic parts, and child tools/retrievable state
metadata are exported. If a boundary needs to export prompt without tools,
re-channel system parts to dynamic, filter retrieval metadata, summarize, or
otherwise transform the aggregate, use a projection function.

`replace` clears all previously accumulated instructions, dynamic parts, tools,
rendered states, and retrievable states at that call site. Projection traversal
is still node-before-children, so a node `replace` clears projections accumulated
before that node and then that node's children still apply afterward. A boundary
`replace` clears the parent draft accumulated before that child boundary and
later siblings still apply afterward. `replace` does not delete, hide, reorder,
or otherwise affect history. History is compiled independently from durable
frames by the generator history policy.

History compilation is a separate pass from projection section compilation:

```ts
const visibleFrames = compileVisibleFrameHistory(frames, targetGenerator);
const history = applyHistoryProjection(
  targetRuntime.historyProjection ?? { type: "messages" },
  {
    target: targetGenerator,
    runtimeInstanceId: targetRuntimeInstanceId,
    activationId,
    trigger: targetRuntime.trigger,
    history: visibleFrames,
    states: currentStateValues,
  },
);
```

The built-in `{ type: "messages" }` history projection preserves all visible
frame messages in durable frame/message order. The built-in `{ type: "actor" }`
history projection extracts only actor messages from that visible frame history.
Executors are responsible for rendering `CompiledInference.history` into the
provider-visible conversation format they need; most LLM executors will filter
to actor messages before rendering. Custom history projection output is not
durable runtime state; it is recomputed for the compiled inference.

Core should provide small helper functions for common history projections, such
as `messages(ctx)`, `actorMessages(ctx)`, `messagesSinceLastCompletion(ctx)`,
and `messagesBeforeLastCompletion(ctx)`. These helpers are pure views over the
filtered frame history supplied in `HistoryProjectionContext`.

Duplicate tool names are intentionally supported as an override mechanism. When
an executor assembles provider tool definitions from the compiled `tools` list,
the last tool with a given name wins.

Runtime projection resolution:

- `component`: use `node.projection`.
- `primary`/`worker` when compiling parent inference: compile the runtime's owned
  projection aggregate, then export it through
  `runtime.boundaryProjection ?? { mode: "hidden" }`.
- `primary`/`worker` when compiling its own inference: use `node.projection`.

All primary inference points are equal and can receive user input when their
configured trigger matches the user frame. Typical agents only have the de-facto
root primary; multiple primary nodes run as multiple user-addressable inference
points. Multiple primaries are in scope for the first pass because generator
identity, audience filtering, activation routing, and history compilation need
to be designed around independent inference points from the start. The first-pass
routing policy may be broad, but the abstraction must not assume a single
primary generator.

## Executor Contract

Executors receive the compiled sections and own provider-specific assembly:

```ts
executor.run({
  systemParts,
  history,
  dynamicParts,
  tools,
  retrievableStates,
  output,
});
```

Executors decide how to serialize system/dynamic content and provider tool
configuration. Work messages are runtime metadata and should be filtered out of
executor-visible history unless a future explicit projection policy allows them.
Commands are host/client actions, not executor-visible inference tools. They
should stay out of `CompiledInference` until a future explicit command projection
policy is designed.

Executor output returns through the normal frame path:

```ts
type EnqueueFrame<TActorMessage extends AnyActorMessage = DefaultActorMessage> = (
  frame: FrameDraft<TActorMessage>,
) => Frame<TActorMessage> | Promise<Frame<TActorMessage>>;

type ExecutorRunRequest<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  generatorId: GeneratorId;
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
  inference: CompiledInference<TActorMessage>;
  enqueueFrame: EnqueueFrame<TActorMessage>;
  createActionContext?: (action: AnyAction) => ActionContext<unknown, TActorMessage>;
  output?: OutputConfig<TActorMessage>;
  signal?: AbortSignal;
};

type ExecutorRunResult<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  completionReason: CompletionReason;
  value?: string; // implicit LLM text output
  frames?: Array<FrameDraft<TActorMessage> | Frame<TActorMessage>>; // fully formed executor-produced frames
};

type ExecutorRealizePromptRequest<TActorMessage extends AnyActorMessage = DefaultActorMessage> = Pick<
  ExecutorRunRequest<TActorMessage>,
  "generatorId" | "activationId" | "runtimeInstanceId" | "inference" | "output"
>;

type ExecutorRealizedPrompt = {
  provider: string;
  input: unknown;
};

type Executor<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  run(
    request: ExecutorRunRequest<TActorMessage>,
  ): ExecutorRunResult<TActorMessage> | Promise<ExecutorRunResult<TActorMessage>>;
  realizePrompt(
    request: ExecutorRealizePromptRequest<TActorMessage>,
  ): ExecutorRealizedPrompt | Promise<ExecutorRealizedPrompt>;
};
```

When an executor returns `frames`, the framework enqueues them in result order,
applying the current generator, runtime, and activation metadata where omitted.
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

State rendering and state-access notes should not expose node mechanics to the
model. The prompt should address the model as the actor. For any projected state,
append a short note to the relevant instruction text, such as:

```txt
You have access to state at address `<stateAddress>` if you need it.
```

For `projection: "retrieval"`, mention that the model can call `getState` with
that exact address string. For `system` and `dynamic`, render the inference
state address and JSON in the corresponding compiled section so duplicate state
keys on different instances remain distinguishable without exposing structured
runtime targets.

Actions use singular public state ergonomics in the first pass. A node-local tool
or command automatically binds to its owner node's `state`, if present, and
receives a typed `ctx.state` and `ctx.updateState(update)` API for that state.
Conventional updates are constructed with helpers such as
`replaceState(value)`, `patchState(patch)`, and `appendState(...values)`. If the
owner node has no state, the action receives no state binding. State projection
does not affect mutation access.

Type safety flows from the action's declared state requirement. A stateful action
declares the descriptor it expects, and `createNode({ state, tools, commands })`
keeps the action handle typed from that declaration. Machine creation and
projection compilation validate that the action's declared state is compatible
with the owner node's state before execution. Stateless actions use
`state: null` and receive no mutation helpers.

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

Commands are app-executed, not `runMachine`-executed. A command message is a
durable FYI/event frame that records an accepted command request. It is not a
replay instruction, and folding or replaying a frame log must not execute command
code.

```ts
type CommandMessage = {
  type: "command";
  name: string;
  input: unknown;
  target?: RuntimeAddress;
  clientId?: string;
};

type ClientMachineMessage = CommandMessage; // first pass

type ExecuteCommandResult<T = unknown> =
  | {
      success: true;
      value?: T;
      clientId?: string;
    }
  | {
      success: false;
      error: string;
      clientId?: string;
    };

function executeCommand<T = unknown>(
  machine: Machine,
  message: CommandMessage,
): Promise<ExecuteCommandResult<T>>;
```

The app owns receiving command requests from clients or hosts and calling
`executeCommand(machine, commandMessage)` explicitly. The helper owns command
message passing:

1. Resolve the command against the hydrated machine.
2. Validate command input.
3. Enqueue a frame containing the `CommandMessage`.
4. Execute the command with the same action context semantics as tools.
5. Synchronously enqueue and fold any frames produced by context helpers such as
   `ctx.updateState(...)` as those helpers are called.
6. When the command returns, enqueue any returned actor or instance messages as
   frame(s), preserving result order.
7. Return a structured success or failure result to the app.

`executeCommand` uses the same synchronous `machine.enqueueFrame` path as
`runMachine`-produced frames. The helper is not itself a durable persistence
boundary. When a `MachineRun` is actively draining the machine, command-produced
frames flow through that run in append order and are persisted by the normal
host run loop. If no `MachineRun` is actively draining, command-produced frames
remain in the machine's in-memory frame log until a later run drains them. Apps
should not persist command-produced frames through a separate per-command
result path in the normal case.

If `target` is omitted, command resolution scans visible commands in
`ProjectionFrame` traversal order and picks the last command with the requested
name. This gives duplicate command names the same override shape as projection
sections and provider tool definitions: later/rightmost/deeper entries win. If
`target` is provided, resolution is restricted to that runtime address and the
command name is still read from the top-level `CommandMessage.name`.

If target resolution or input validation fails before the command is accepted,
`executeCommand` returns `success: false` and does not enqueue the command FYI
frame. If execution throws after the command has been accepted, the helper
returns `success: false`; any frames already enqueued by synchronous context
helpers remain in the frame log. Durable command-error frames are out of scope
for the first pass; apps can report the returned error through their own
transport.

`runMachine` should ignore `CommandMessage`s for execution. Command messages are
also not executor-visible actor history. They may be exposed through client or
inspection read models as command residue/audit metadata.

## Generators, Work, And Frames

The runtime may contain multiple independent inference points. Call each
inference point a generator.

Generators are created by:

- Serial primary activations created from runtime addresses whose node runtime is
  `{ type: "primary" }`.
- Parallel primary activations created from runtime addresses whose node runtime
  is `{ type: "primary" }`.
- Worker activations created from runtime addresses whose node runtime is
  `{ type: "worker" }`.

Primary and worker runtime addresses define work that can be triggered by
frames. The address may point to a concrete durable instance or to a virtual
member runtime address. The trigger creates an activation. A runtime's
`concurrency` policy controls whether activations for that runtime are processed
serially or in parallel:

- `serial`: default. Activations share a concurrency key and only the earliest
  incomplete activation for that key is runnable.
- `parallel`: each incomplete activation is independently runnable.

For serial runtimes, `concurrencyKey` defaults to the encoded runtime address.
For parallel runtimes, `concurrencyKey` defaults to the activation ID.

Primary generator IDs are stable and tied to their primary runtime address when
the primary runs serially. The root primary created by `createRoot(...)` uses the
same normal address encoding as every other instance runtime: `instance:root`.
Parallel primary activations should use activation-specific generator IDs
derived from the primary runtime address and activation ID.

Worker generator IDs are deterministic runner identities. Serial workers may use
the encoded worker runtime address as their generator ID. Parallel workers should
use activation-specific generator IDs derived from the worker runtime address and
activation ID.

Activation IDs distinguish individual durable units of work for both primary and
worker runtimes.

Generators do not synchronize at the old step/turn boundary. Each generator
advances independently and emits durable frames. A frame is the unit of runtime
work that is enqueued back onto the machine.

```ts
type GeneratorKind = "primary" | "worker";

type Generator = {
  id: GeneratorId;
  kind: GeneratorKind;
  runtimeInstanceId: RuntimeInstanceId;
};

type FrameDraft<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  generatorId?: GeneratorId;
  runtimeInstanceId?: RuntimeInstanceId;
  activationId?: string;
  inert?: boolean; // default false
  messages: FrameMessage<TActorMessage>[];
  metadata?: Record<string, unknown>;
};

type Frame<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  FrameDraft<TActorMessage> & { id: string };

type MessageDelivery = "immediate" | "queued";

type FrameMessage<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | TActorMessage
  | CommandMessage
  | InstanceMessage<TActorMessage>
  | WorkMessage;

type PublicNodeRef<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | Node<TActorMessage>
  | Ref;
type SerializedNodeRef<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | DryNode<TActorMessage>
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

type InstanceMessage<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
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
      node: SerializedNodeRef<TActorMessage>;
      states?: Record<StateKey, unknown>;
    }
  | {
      type: "instance";
      kind: "spawn";
      parentInstanceId: InstanceId;
      children: SpawnChild<TActorMessage>[];
    }
  | {
      type: "instance";
      kind: "attach";
      parentInstanceId: InstanceId;
      children: SerializedInstance<TActorMessage>[];
    }
  | {
      type: "instance";
      kind: "remove";
      instanceId: InstanceId;
      reason?: "removed" | "cede" | "cancelled";
    };

type SpawnChild<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id?: InstanceId;
  node: SerializedNodeRef<TActorMessage>;
  states?: Record<StateKey, unknown>;
  children?: SpawnChild<TActorMessage>[];
};

type SerializedInstance<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id: InstanceId;
  node: SerializedNodeRef<TActorMessage>;
  states?: Record<StateKey, StateContainer>;
  children?: SerializedInstance<TActorMessage>[];
};

type WorkMessage =
  | {
      type: "work";
      kind: "activation";
      activationId: string;
      runtimeInstanceId: RuntimeInstanceId;
      generatorId: GeneratorId;
      sourceFrameId: string;
      concurrencyKey: string;
      concurrency: "serial" | "parallel";
    }
  | {
      type: "work";
      kind: "completion";
      activationId: string;
      sourceFrameId?: string;
      reason: "end-turn" | "done" | "cancelled" | "delegated";
    };
```

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
to removed runtime addresses, reconciliation should append completion work frames
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
- `AudienceTarget` or `AudienceTarget[]`: visible to the listed runtime
  addresses. A runtime address target is visible to every generator owned by
  that runtime address, including serial generators and activation-specific
  parallel generators that may not exist yet when the message is enqueued.

If `audience` is omitted, the default depends on the message type:

- `UserMessage`: defaults to `"broadcast"`.
- `AssistantMessage` and `ToolMessage`: default to `"self"`.
- `CommandMessage`, `InstanceMessage`, and `WorkMessage`: have no audience.

A generator's audience can see a message when:

- The resolved message audience is `"broadcast"`.
- The resolved message audience includes a runtime address target matching the
  generator's owning runtime address.
- The resolved message audience is `"self"` and the message is in a frame
  produced by that generator.

`"self"` resolves to the `generatorId` on the frame containing the message. A
message with audience `"self"` in a frame without a `generatorId` has no
generator-visible audience. User messages avoid this by defaulting to
`"broadcast"`. For parallel primary or worker activations, `"self"` resolves to
the activation-specific generator ID that produced the frame.

Audience does not imply activation. It only controls which messages are visible
to a generator before delivery and activation-history policy are applied. Runtime
triggers decide which generators receive new activations.

Helpers may be added to compute common audiences, such as a parent runtime
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
  inference frame.
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

`completion.reason` records why the activation closed. Primary `end_turn`,
worker completion, cancellation, and delegation all mean the current activation
is closed and should not run again. `delegated` means framework-owned execution
for the activation was handed to an external runtime or provider, and the
framework should not expect the executor to emit ordinary completion output for
that activation. If future blocked/retry behavior is needed, it should be added
as a separate non-terminal work message with deterministic wake conditions.

Activation IDs must be deterministic. Activation messages are emitted in their
own frames, but each activation records the source frame that triggered it. A
typical activation ID should be derived from the machine identity, runtime
instance identity, trigger identity, and source frame identity.

```ts
activationId = hash(machineId, runtimeInstanceId, triggerKey, sourceFrameId)
```

Work frames are appended by framework reconciliation, not by mutating the frame
that caused the work. Enqueueing a frame assigns its identity and appends it to
the log. Reconciliation folds the log, evaluates frames against runtime
triggers, and appends any missing deterministic activation or completion work
frames after their source frame has been persisted.

A non-inert frame matching primary or worker runtime triggers will be followed
by separate activation work frames for those runtimes. Work frames may themselves
be trigger sources for `parent-activation` and `parent-completion`;
`actor-frame` triggers ignore inert frames and work-only frames.

Reconciliation must be idempotent. Replaying the same frame log should never
append duplicate work frames because activation IDs are derived from durable
inputs and there is at most one terminal completion for a given activation ID.
The exact frame IDs may come from storage, but the semantic work identity must be
stable.

Reconciliation must also be deterministic:

- Process source frames in stable durable append order.
- For each source frame, derive candidate work frames in `ProjectionFrame`
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
dispatchers can enforce exclusivity when needed.

### Generator Discovery And Projection

Generators should be discoverable deterministically from the machine tree and
work log before readiness or projection compilation. This is an indexing pass,
not an inference pass.

```ts
syncGenerators(machine):
  for each ProjectionFrame in traversal order:
    if frame.node.runtime.type === "primary" and concurrency is serial:
      ensure primary generator exists

  fold work messages to discover open parallel primary activations
  fold work messages to discover open worker activations
```

Projection compilation is separate from generator discovery. A generator can
exist while idle and uncompiled. `runMachine` should compile only activations
that are runnable.

Compiling the root primary does not require compiling child primary or worker
generators first. For any primary or worker target, the projection section pass
starts at that target runtime frame. Within any section pass, if a
`ProjectionFrame` belongs to the target generator, the compiler uses that
frame's `node.projection`; if a non-target projection frame is a primary or
worker runtime, the compiler compiles that runtime's generator projection and
exports it through `runtime.boundaryProjection ?? { mode: "hidden" }`.

For the first pass, every generator receives the frame log filtered by message
audience, message delivery, runtime activation history, and runtime metadata
visibility. The target runtime's `historyProjection` then converts that filtered
frame history into the executor-visible `CompiledInference.history`.

For the first pass, user input creates deterministic activations for all primary
runtimes whose configured trigger matches the user frame. The root primary
created by `createRoot(...)` uses `{ type: "actor-frame" }` and `serial`
concurrency through its normal node runtime. More precise routing and explicit
broadcast behavior are future work.

Authored primary runtimes must explicitly configure `trigger`. There is no
authored-primary trigger default. `createRoot(...)` supplies a concrete root node
with an explicit actor-frame trigger.

Primary and worker runtimes are triggered only by scoped runtime events:

- `spawn`: activates once when an `InstanceMessage` frame creates or attaches
  the runtime address through `kind: "spawn"` or `kind: "attach"`. Static
  runtime members present at machine bootstrap do not trigger `spawn`.
- `actor-frame`: activates when any frame contains at least one actor message
  whose audience is visible to the runtime address. Broadcast messages and
  explicit runtime address targets can trigger parallel runtimes before an
  activation-specific generator exists. Message `delivery` does not affect
  trigger matching; it affects only whether the actor message is eligible
  history for a particular activation.
- `parent-activation`: activates when a work `activation` message opens work for
  the runtime's nearest ancestor generator.
- `parent-completion`: activates when a work `completion` message closes work
  for the runtime's nearest ancestor generator, regardless of completion reason.

For `parent-activation` and `parent-completion`, the nearest ancestor generator
is the closest primary or worker generator above the runtime address in the
ProjectionFrame tree. Those triggers do not observe unrelated generators by
default.

### Self-Trigger Exclusion

Triggers never match frames produced by the triggered runtime's own generators.
A frame does not trigger a runtime if the frame's `generatorId` resolves to a
generator owned by that runtime's address. The exclusion is keyed by runtime
address, not exact generator ID: it covers serial generators with stable IDs and
activation-specific parallel generator IDs alike, so a parallel activation's
output cannot spawn fresh activations of its own runtime. Generator IDs must
remain resolvable to their owning runtime address through the work log's
activation messages.

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

Runtime triggers are independent from message audience. A primary or worker does
not become runnable merely because a message is addressed to it; its configured
trigger must match. Audience alone is not a runtime wake-up rule.

### Running Work

`runMachine` should reconcile the frame log, discover runnable activations, and
optionally schedule executor work.

```ts
type RunMachineOptions = {
  scheduleWork?: boolean; // default true
};

type MachineRun<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  AsyncIterable<Frame<TActorMessage>> & {
    stopSchedulingWork(): void;
    hasStarted(): boolean;
    isDraining(): boolean;
  };

function runMachine<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  machine: Machine<TActorMessage>,
  options?: RunMachineOptions,
): MachineRun<TActorMessage>;
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
  reconcile deterministic work frames from yielded source frames
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

End-turn semantics are per-activation, not global. When a primary generator
declares end turn, the framework appends a completion work frame for the current
activation with `reason: "end-turn"`. The primary is not runnable again until a
future user frame creates a new activation.

Workers follow the same rule: when a worker finishes its triggered work, the
framework appends a completion work frame for that activation with
`reason: "done"`. For serial workers, the next incomplete activation with the
same concurrency key becomes runnable. For parallel workers, other incomplete
activations can already be runnable.

The machine-level concept is quiescence: no activations are runnable under the
current work log and host policy. Quiescence can be used by applications as the
replacement for the old global end-turn boundary, but the core runtime should
not assume a single continuous, well-ordered turn timeline.

## Client Integration

The client integration boundary should be a realized public read model, not the
durable frame log. Applications may keep the frame log private, noisy, or
server-only. A browser or other client should subscribe to fully realized client
instances plus small synchronization metadata:

```ts
type MachineClientSnapshot<TInstances = unknown> = {
  instances: TInstances;
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
- public member/projection children with stable runtime addresses;
- visible state values and their state addresses;
- state schema metadata for visible or form-bindable states;
- command metadata, command input schemas, and optional runtime target addresses.

The exact client instance shape may evolve, but it must preserve stable runtime
addresses for optional command targeting and stable `StateAddress` values for
state operations. Member projection frames should be addressable through
`RuntimeAddress` without being serialized as durable child instances.

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
const setLiveMode = createCommand({
  name: "setLiveMode",
  input: z.object({ enabled: z.boolean() }),
  execute: async (input, ctx) => {
    ctx.updateState(patchState({ liveMode: input.enabled }));
  },
});

const agentNode = createNode({
  key: "agent",
  state: agentState,
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
matching command. Targeted lookup can narrow by `RuntimeAddress` when the target
is known in the client instance type.

### Lightweight Typed Command Messages

The effigy APIs are the ergonomic integration path for subscribed clients, but
they should not be required just to create a typed command message. The client
package should also expose a small helper for applications that already know
which command they want to send and own their transport directly:

```ts
import type { SetLiveModeCommand } from "./agent";
import { createCommandMessage } from "@projectors/core/client";

const message = createCommandMessage<SetLiveModeCommand>(
  "setLiveMode",
  { enabled: true },
);

await sendMessage(message);
```

The helper should type-check the command name and input from the imported
command type, generate a `clientId` by default, and return the same
transport-ready `ClientMachineMessage` shape used by effigy command handles.

```ts
function createCommandMessage<TCommand extends AnyCommandDefinition>(
  name: ClientCommandDefinitionName<TCommand>,
  input: ClientCommandDefinitionInput<TCommand>,
  options?: {
    target?: RuntimeAddress;
    clientId?: string;
  },
): ClientMachineMessage;
```

This mode intentionally does not check whether the command is currently
available on any subscribed instance, infer a target from a client tree, apply
optimistic updates, or retire optimism from residue. It is only a type-safe
message constructor. The server still resolves the command against the hydrated
machine and validates the input before executing it.

To support this mode, `createCommand` must preserve literal command names and
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
      target?: RuntimeAddress;
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

- generate a local command ID for every command message;
- include that ID in the outbound command message as `clientId`;
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
reflected in the client snapshot, the server includes the command's `clientId`
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

- a current, already-materialized root instance snapshot; and
- a durable frame log in stable append order.

`createMachine({ root, frames })` treats `root` as the current canonical machine
view supplied by the host. It preserves `frames` for projection history and work
reconstruction, but it does not replay historical `InstanceMessage`s into
`root`. Replaying arbitrary instance mutations into a current snapshot would be
unsafe because the framework cannot know which mutations are already reflected in
that snapshot.

If an application wants replay-from-initial semantics, it must provide an initial
root snapshot and a frame log whose instance mutations have not yet been applied,
or introduce explicit snapshot cursor metadata and replay only frames after that
cursor. That mode is out of scope for the first pass.

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
serialization encounters a function, closure, schema, projection function, action
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
type PublicNodeRef<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | Node<TActorMessage>
  | Ref;
type SerializedNodeRef<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | DryNode<TActorMessage>
  | Ref;
```

Before a frame is appended to the durable frame log, any hydrated node, state,
action, or projection references in `InstanceMessage`s must be canonicalized into
`SerializedNodeRef` or another dry ref form. The frame log must not contain live
`Node`, `Action`, `StateDescriptor`, or projection function objects.

This applies to:

- `SerializedInstance.node`
- `InstanceMessage.kind: "transition".node`
- `SpawnChild.node`
- attached serialized subtrees
- any queued or emitted framework message that contains node/state/action/projection refs

### Inline Definitions

Registered nodes serialize as refs by default:

```ts
"checkout"
```

Inlining is allowed, and inline nodes must be executable after hydration. An
inline node may contain serial data directly, but executable children must be
refs.

```ts
type DryProjection = StaticProjection | Ref;
type DryBoundaryProjection = StaticBoundaryProjection | Ref;

type DryRuntime =
  | { type?: "component" }
  | ({
      type: "primary";
      boundaryProjection?: DryBoundaryProjection;
    } & DryTriggeredRuntimeOptions)
  | ({
      type: "worker";
      boundaryProjection?: DryBoundaryProjection;
    } & DryTriggeredRuntimeOptions);

type DryNode<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  stateless?: boolean;
  tools?: Ref[];
  commands?: Ref[];
  state?: DryStateDescriptor | Ref;
  members?: Array<DryNode<TActorMessage> | Ref>;
  output?: SerializedOutputConfig;
  projection?: DryProjection;
  runtime?: DryRuntime;
};
```

`sourceNodeKey` records the registered node an inline node was derived from, when
one exists. This is important when a registered node is force-inlined for edits
but still wants to reuse node-local tools or commands from the original
registered node. Inline node action refs then stay compact names and resolve via
`sourceNodeKey`.

`forceInline` only changes the node serialization boundary. It does not permit
dropping unregistered executable values. If a force-inlined node contains an
unregistered action, projection function, state init function, or schema that
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

### States, Schemas, And Projection Functions

State descriptors follow the same rule as nodes:

- Registered descriptors serialize by ref.
- Inline descriptors may serialize inline only if their schema and init behavior
  can round-trip.
- Zod schemas may serialize with `z.toJSONSchema` and hydrate with
  `z.fromJSONSchema`.
- `init` functions are executable values and must serialize by ref or throw.

Projection functions are executable values. Registered projection functions
serialize by ref from both `projection` and `boundaryProjection` fields. Inline
projection functions may execute in memory, but machine serialization must throw
if one is encountered. Static `boundaryProjection` values serialize as
`StaticBoundaryProjection`; hydration must reject static boundary projections
that contain `instructions` or `tools`.

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

- action and command refs
- state descriptors and schemas
- member nodes
- node projection refs
- runtime boundary projection refs
- runtime history projection refs

After hydration, the machine must be executable without consulting the original
live objects that produced the snapshot.

Hosts should persist a `charterKey` and `charterVersion` alongside machine
snapshots. Refs only have meaning against a compatible charter.

## Tests

Keep tests sparse and scenario-based. Prefer tests that prove traversal,
projection, resumability, state conflict handling, work scheduling, or another
critical behavior. Avoid tests that only restate a type shape, constructor
default, or one field assignment unless that detail changes runtime behavior.

Add focused tests for:

- Projection compiler behavior: `ProjectionFrame` traversal is pre-order and
  left-to-right, members project before runtime children, `augment` accumulates
  sections, `replace` clears previously accumulated projection sections, and
  `replace` does not affect compiled history. A node `replace` still allows that
  node's children to project afterward.
- Runtime projection boundaries: primary and worker runtimes default
  `boundaryProjection` to hidden, hidden boundaries prevent descendant leakage,
  static boundary projection only supports `mode`, and an explicit static
  boundary projection exports the runtime's whole owned aggregate as compiled.
- State projection ownership: top-scoped state contributed behind a runtime
  boundary projects from the owner instance without exporting the hidden runtime
  aggregate, while local state remains behind that boundary.
- Stateless top ownership: `createRoot(...)` creates a stateless helper root,
  top-scoped state below each direct app instance is owned by that app instance,
  and stateless nodes cannot declare state.
- Projection functions: node and boundary projection functions receive
  `(ctx, draft, source)`, can mutate the IR draft directly, can append dynamic
  text parts from closure state, and can selectively export child runtime prompt
  while filtering tools.
- Member semantics: members are not serialized as durable children, reload uses
  current registered member definitions, member node keys produce deterministic
  virtual runtime addresses, duplicate sibling member node keys throw, member
  runtimes create work identities from those addresses, and member state or spawn
  operations resolve to the nearest concrete owner instance.
- State descriptor resolution and conflicts: `top` state hoists to the machine's
  real root instance, duplicate state keys reuse valid existing
  values, incompatible `scope`, schema, or non-equivalent `init` values throw,
  `onInitConflict` merges with `"error"` taking precedence, projection policy is
  latest-wins in traversal order, and `"replace"` resets invalid existing state.
- Durable state mutation behavior: `ctx.updateState(...)` synchronously enqueues
  durable mutations with explicit `stateKey`, updates `ctx.state` before
  returning, symbolic targets are canonicalized to concrete instance IDs,
  `state.update` replace operations validate replacement values, patch
  operations shallow-merge and validate the full result, and append operations
  append to arrays and validate the full result.
- Command execution: `executeCommand` resolves and validates commands explicitly
  at the app boundary, enqueues an accepted `CommandMessage` FYI frame, executes
  the command once, enqueues returned actor and instance messages, does not
  return command frames as a separate persistence path, returns structured errors
  without requiring durable error frames, and `runMachine` ignores
  `CommandMessage`s for execution and executor-visible history.
- Durable instance mutation behavior: related mutations apply in
  `Frame.messages` order, `transition` preserves the target instance ID and
  durable children, `spawn` initializes child state from descriptors plus
  overrides, `attach` preserves supplied subtrees, and `remove` removes the
  target subtree.
- Serialization and hydration safety: registered executable values hydrate by
  ref, inline Zod state schemas round-trip, force-inlined registered nodes keep
  executable node-local tools through `sourceNodeKey`, durable frames
  canonicalize hydrated node/action/state/projection inputs before persistence,
  projection and history projection functions serialize by ref or throw, unknown
  refs throw, and unregistered executable inline values throw instead of being
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
- Work reconciliation: primary and worker triggers append deterministic
  activation work frames separate from the source frame, activation messages
  record `sourceFrameId`, reconciliation processes source frames in durable
  append order and derives work in projection traversal order, work-only and
  instance-only frames do not trigger `actor-frame`, nearest-ancestor rules apply
  to parent activation/completion triggers, a serial runtime's own assistant and
  tool frames derive no new activations for that runtime, a parallel
  activation's output derives no new activations for the same runtime address,
  the first durable terminal completion wins, and removed instances cancel open
  activations.
- Concurrency and dispatch: serial primary and worker runtimes expose only the
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
- Client integration smoke coverage, if included in the first implementation
  pass: client snapshots expose realized instances plus command residue without
  public frame-log synchronization, command and state addresses are stable for
  concrete instances and member projection frames, recent command residue remains
  machine-level sync metadata, optimistic overlays retire and rebase by residue,
  and typed command helpers are covered by compile-time type tests rather than
  runtime shape assertions.

## Future Work

- Discoverable tools: support tools that are not sent as provider-static tool
  definitions and must be discovered through a catalog/search mechanism.
- Polymorphic tool invocation: support a stable invoker tool that can dispatch
  to hidden node tools by name or namespace.
- Richer projection policies for commands if the model or client needs explicit
  awareness of command availability.
- State bindings: support per-attachment state options or projection overrides
  when a descriptor's global defaults are not enough.
- Additional generator history policies beyond runtime `historyProjection` if
  generators need declarative scoped or summarized history instead of custom
  projection functions.
- User-input routing for multiple primary generators, including explicit
  broadcast.
- Opt-in state conflict handling beyond last-write-wins shallow merge patching.
- Non-terminal blocked/retry work messages with deterministic wake conditions.
- An explicit self-wake mechanism for runtimes that need to schedule their own
  future activations. The self-trigger exclusion means self-addressed messages,
  including `delivery: "queued"` ones, never create activations on their own.
- Activation identity for multiple same-runtime trigger events within one source
  frame. The first pass may treat activations as at most one per runtime,
  trigger, and source frame, but a future design should add a per-trigger-event
  semantic key if multiple actor/work messages in one frame need to create
  distinct activations for the same runtime.
- Optional host-side indexes or work-state caches for applications that do not
  want to fold the full frame log.
- Persisted runtime sync cursors for long-lived realtime executors. The first
  LiveKit pass can keep this simple and drop old visible messages on reconnect,
  but a future design should track which frame IDs have already been forwarded
  to an external realtime session so reconnects can update instructions/tools
  without replaying or losing unsent user input.
- First-class distributed leases are out of scope for the core framework; if
  needed later, design them as an optional layer over deterministic activations.
