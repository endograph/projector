import type {
  ActionConfigEntry,
  ActionPart,
  AnyAction,
  BoundaryProjection,
  ComputedMemberDef,
  ComputedPartDef,
  ComputedPartRef,
  MemberEntry,
  Node,
  NodeConfig,
  NormalizedRuntime,
  NormalizedStateDescriptor,
  Part,
  Runtime,
  RuntimeTrigger,
  StateDescriptor,
  TriggeredRuntimeOptions,
} from "./types.ts";
import { command, normalizePartEntries, text, tool } from "./parts.ts";
import { isComputedMemberDef } from "./computed-parts.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import {
  emptyParamsSchema,
  normalizeParamsSchema,
  type AnyParamsSchema,
  type ParamsSatisfyError,
} from "./params.ts";

export type InferActions<TConfig, TKey extends "tools" | "commands"> = TConfig extends Record<
  TKey,
  infer TActions extends readonly ActionConfigEntry[]
>
  ? TActions
  : [];

type ActionEntryMeta<TEntry> = TEntry extends AnyAction
  ? TEntry
  : TEntry extends string
    ? AnyAction & { name: TEntry }
    : never;

type InferActionMetas<TConfig, TKey extends "tools" | "commands"> = ActionEntryMeta<
  InferActions<TConfig, TKey>[number]
>;

type InferParamsSchema<TConfig> = TConfig extends { params: infer TParams extends AnyParamsSchema }
  ? TParams
  : typeof emptyParamsSchema;

export type ActionEntryParams<TEntry> = TEntry extends AnyAction<infer TParams>
  ? TParams
  : typeof emptyParamsSchema;

/**
 * The action types a part entry carries: inline action parts, plus computed
 * entries' registry actions (select/when sugar auto-derives its registry from
 * branch actions, so branches are covered through it). String refs and
 * compute-closure returns are type-opaque — the charter-build runtime
 * backstop covers those.
 */
type PartActionEntryOf<TPart> = TPart extends ActionPart<infer TAction>
  ? TAction
  : TPart extends ComputedPartRef<any, infer TAction>
    ? TAction
    : TPart extends ComputedPartDef<any, infer TAction>
      ? TAction
      : never;

type NodeActionEntries<TConfig> =
  | InferActions<TConfig, "tools">[number]
  | InferActions<TConfig, "commands">[number]
  | (TConfig extends { parts: readonly (infer TPart)[] } ? PartActionEntryOf<TPart> : never);

/**
 * The data content an entry's phantom brand implies (see CreatedAction).
 * keyof-guarded: unbranded entries (plain AnyAction, string refs, hydrated
 * actions) contribute never rather than unknown.
 */
export type ImpliedDataContentOf<TEntry> = TEntry extends unknown
  ? "__dataContent" extends keyof TEntry
    ? Exclude<TEntry["__dataContent"], undefined>
    : never
  : never;

/**
 * The data-content vocabulary every action attached to the node implies
 * through its result messages. Folded into the created node's TDataContent,
 * so the charter's NoInfer vocabulary check covers node-attached actions by
 * plain node covariance — tools need no charter registration to be held to
 * the charter's declared dataContent.
 */
export type NodeActionDataContent<TConfig> = ImpliedDataContentOf<NodeActionEntries<TConfig>>;

type NodeActionParamErrors<TConfig> = NodeActionEntries<TConfig> extends infer TEntry
  ? TEntry extends AnyAction
    ? ParamsSatisfyError<InferParamsSchema<TConfig>, ActionEntryParams<TEntry>> extends infer TError
      ? [TError] extends [never]
        ? never
        : TError & { readonly action: TEntry["name"] }
      : never
    : never
  : never;

/**
 * Every action attached to the node — tools/commands sugar, action parts,
 * and computed registries alike — must have its param requirements satisfied
 * by the node's own params schema. never-on-pass error collection: a union
 * of per-action diagnostics (one satisfied action must never mask another's
 * failure, which a union of `unknown | error` would).
 */
export type ValidateNodeActionParams<TConfig> =
  [NodeActionParamErrors<TConfig>] extends [never] ? unknown : NodeActionParamErrors<TConfig>;

export type NodeParamsSchemaOf<TNode> =
  TNode extends Node<any, infer TParams> ? TParams : typeof emptyParamsSchema;

export type NodeMemberParamsSchema<TNode> =
  TNode extends { __config: infer TConfig }
    ? TConfig extends { members: readonly (infer TMember)[] }
      ? NodeParamsSchemaOf<TMember> | NodeMemberParamsSchema<TMember>
      : never
    : never;

export type NodeTreeParamsSchema<TNode> =
  NodeParamsSchemaOf<TNode> | NodeMemberParamsSchema<TNode>;

type NodeKeyOf<TNode> = TNode extends { key: infer TKey extends string } ? TKey : string;

/**
 * never-on-pass error collection over a created node and its member tree
 * (inline members and computed-member registries alike): every node's params
 * schema must be satisfiable by TSuper (the charter's params). Nodes created
 * with a broad config (hydration, JS callers) have no `__config` and
 * contribute nothing — the runtime path owns those.
 */
export type NodeTreeParamErrors<TSuper extends AnyParamsSchema, TNode> =
  // Distribute first: an empty nodes tuple infers TNode = never, which must
  // vanish rather than reach ParamsSatisfyError as a degenerate schema.
  TNode extends unknown
    ?
        | (ParamsSatisfyError<TSuper, NodeParamsSchemaOf<TNode>> extends infer TError
            ? [TError] extends [never]
              ? never
              : TError & { readonly node: NodeKeyOf<TNode> }
            : never)
        | (TNode extends { __config: infer TConfig }
            ? TConfig extends { members: readonly (infer TMember)[] }
              ? MemberEntryParamErrors<TSuper, TMember>
              : never
            : never)
    : never;

type MemberEntryParamErrors<TSuper extends AnyParamsSchema, TMember> =
  TMember extends ComputedMemberDef<any, infer TNode>
    ? NodeTreeParamErrors<TSuper, TNode>
    : NodeTreeParamErrors<TSuper, TMember>;

export type CreatedNode<
  TDataContent,
  TConfig extends NodeConfig<TDataContent>,
> = Node<TDataContent | NodeActionDataContent<TConfig>, InferParamsSchema<TConfig>> & {
  __tools?: InferActionMetas<TConfig, "tools">;
  __commands?: InferActionMetas<TConfig, "commands">;
  __config: TConfig;
};

const NODE_BRAND: unique symbol = Symbol.for("projector.node") as never;

/**
 * True for hydrated Node objects produced by createNode, as opposed to dry
 * (serialized) node data or refs.
 */
export function isNode<TDataContent = never>(value: unknown): value is Node<TDataContent> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { [NODE_BRAND]?: unknown })[NODE_BRAND] === true,
  );
}

/**
 * Declares a state descriptor: validates the key and applies scope and
 * onInitConflict defaults. Inline object literals on nodes/actions/charters
 * remain valid; this exists for parity with the other create helpers and for
 * descriptors shared across declarations (action-state binding compares
 * schemas by reference, so sharing one created descriptor is the way to
 * satisfy it).
 */
export function createState<S>(
  descriptor: StateDescriptor<S>,
): NormalizedStateDescriptor<S> {
  return normalizeStateDescriptor(descriptor);
}

/**
 * Memoized per input object: every declaration site sharing one raw descriptor
 * resolves to one normalized identity. The charter-wide one-descriptor-per-key
 * validation compares descriptors by reference, so normalization must never
 * mint a second identity for the same declaration.
 */
const normalizedStateDescriptors = new WeakMap<object, NormalizedStateDescriptor<any>>();

export function normalizeStateDescriptor<S>(
  descriptor: StateDescriptor<S>,
): NormalizedStateDescriptor<S> {
  assertProjectorIdentifier(descriptor.key, "State key");
  const scope = descriptor.scope ?? "hoist";
  const onInitConflict = descriptor.onInitConflict ?? "replace";
  if (descriptor.scope === scope && descriptor.onInitConflict === onInitConflict) {
    return descriptor as NormalizedStateDescriptor<S>;
  }

  const cached = normalizedStateDescriptors.get(descriptor);
  if (cached) {
    return cached as NormalizedStateDescriptor<S>;
  }

  const normalized = {
    ...descriptor,
    scope,
    onInitConflict,
  };
  normalizedStateDescriptors.set(descriptor, normalized);
  return normalized;
}

export function normalizeRuntime(
  runtime: Runtime | undefined,
): NormalizedRuntime {
  if (!runtime || runtime.type === "component" || !("trigger" in runtime)) {
    return { type: "component" };
  }

  assertValidTriggers(runtime.trigger);
  return {
    ...runtime,
    type: "generator",
    concurrency: runtime.concurrency ?? "serial",
    activationHistory: runtime.activationHistory ?? "live",
    boundaryProjection: normalizeBoundaryProjection(runtime.boundaryProjection),
  };
}

/**
 * The declared trigger(s) as a list — singular declarations are sugar for a
 * one-element union of stimuli. The declared shape is kept on the runtime
 * (serialization passes it through untouched); read sites normalize here.
 */
export function runtimeTriggers(
  runtime: Pick<TriggeredRuntimeOptions, "trigger">,
): readonly RuntimeTrigger[] {
  return Array.isArray(runtime.trigger) ? runtime.trigger : [runtime.trigger];
}

/**
 * At most one trigger of each type per runtime: duplicate types are
 * meaningless (same match), so they are an authoring error.
 */
function assertValidTriggers(trigger: RuntimeTrigger | RuntimeTrigger[]): void {
  const triggers = runtimeTriggers({ trigger });
  if (triggers.length === 0) {
    throw new Error("Generator runtime requires at least one trigger");
  }
  const seen = new Set<string>();
  for (const entry of triggers) {
    if (seen.has(entry.type)) {
      throw new Error(`Duplicate trigger type "${entry.type}" declared on one runtime`);
    }
    seen.add(entry.type);
  }
}

function normalizeBoundaryProjection(
  value: BoundaryProjection | undefined,
): BoundaryProjection {
  if (value === undefined) {
    return "hidden";
  }
  if (value !== "hidden" && value !== "augment") {
    throw new Error(`Boundary projection must be "hidden" or "augment", got "${String(value)}"`);
  }
  return value;
}

/**
 * TConfig is deliberately the FIRST type parameter and TDataContent is
 * inferred from the config (output schema, parts, members): TypeScript has no
 * partial type-argument inference, so an explicit argument would silently
 * replace TConfig with its broad default and disable every config-level
 * check. With this order, a legacy `createNode<MyData>({...})` call fails the
 * NodeConfig constraint loudly instead. Data-content-agnostic nodes infer
 * `Node<never>` and compose covariantly into typed charters/members.
 */
export function createNode<
  const TConfig extends NodeConfig<TDataContent>,
  TDataContent = never,
>(
  config: TConfig & NodeConfig<TDataContent> & ValidateNodeActionParams<TConfig>,
): CreatedNode<TDataContent, TConfig> {
  const key = config.key ?? config.name;
  if (!key) {
    throw new Error("Node requires key or name");
  }
  assertProjectorIdentifier(key, "Node key");

  return {
    [NODE_BRAND]: true,
    key,
    sourceNodeKey: config.sourceNodeKey,
    name: config.name,
    params: normalizeParamsSchema(config.params),
    parts: desugarParts<TDataContent>(config),
    states: normalizeStates(config),
    memberEntries: normalizeMemberEntries(config.members ?? []),
    output: config.output,
    runtime: normalizeRuntime(config.runtime),
    executorConfig: config.executorConfig,
  } as unknown as CreatedNode<TDataContent, TConfig>;
}

/**
 * Desugars the sugar fields into the parts list: `instructions` becomes an
 * anonymous text part in the preamble default slot, `tools`/`commands` become
 * action parts with their respective callers, followed by explicit `parts`.
 */
function desugarParts<TDataContent>(config: NodeConfig<TDataContent>): Part<TDataContent>[] {
  const parts: Part<TDataContent>[] = [];
  if (config.instructions) {
    parts.push(text(config.instructions));
  }
  for (const entry of config.tools ?? []) {
    assertActionEntry(entry);
    parts.push(tool(entry));
  }
  for (const entry of config.commands ?? []) {
    assertActionEntry(entry);
    parts.push(command(entry));
  }
  parts.push(...normalizePartEntries(config.parts ?? []));
  return parts;
}

/**
 * One declaration carries both the state and its projection config: `states`
 * normalize into the node's declarations, deduped by key (same key twice on
 * one node is an authoring error).
 */
function normalizeStates<TDataContent>(config: NodeConfig<TDataContent>): NormalizedStateDescriptor[] {
  const keys = new Set<string>();
  return (config.states ?? []).map((descriptor) => {
    if (keys.has(descriptor.key)) {
      throw new Error(`Duplicate state "${descriptor.key}" declared on one node`);
    }
    keys.add(descriptor.key);
    return normalizeStateDescriptor(descriptor);
  });
}

function assertActionEntry(entry: ActionConfigEntry): void {
  if (typeof entry === "string") {
    assertProjectorIdentifier(entry, "Action ref");
    return;
  }
  assertProjectorIdentifier(entry.name, "Action name");
}

function normalizeMemberEntries<TDataContent>(
  entries: MemberEntry<TDataContent>[],
): MemberEntry<TDataContent>[] {
  const keys = new Set<string>();
  const claim = (key: string) => {
    if (keys.has(key)) {
      throw new Error(`Duplicate member key "${key}"`);
    }
    keys.add(key);
  };

  for (const entry of entries) {
    if (isComputedMemberDef(entry)) {
      // A computed's registry is its walkable candidate set (a sugar entry's
      // branches may reuse one key across branches — that is the point);
      // distinct entries may not claim the same key. Bare charter-registered
      // returns are opaque here by design.
      for (const key of new Set((entry.registry ?? []).map((node) => node.key))) {
        claim(key);
      }
      continue;
    }
    claim(entry.key);
  }

  return entries;
}
