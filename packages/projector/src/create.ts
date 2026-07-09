import type {
  ActionConfigEntry,
  AnyAction,
  BoundaryProjection,
  MemberEntry,
  Node,
  NodeConfig,
  NormalizedRuntime,
  NormalizedStateDescriptor,
  Part,
  Runtime,
  StateDescriptor,
} from "./types.ts";
import { command, normalizePartEntries, text, tool } from "./parts.ts";
import { isComputedMemberDef } from "./computed-parts.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import {
  emptyParamsSchema,
  normalizeParamsSchema,
  type AnyParamsSchema,
  type EnsureParamsSatisfy,
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

export type ValidateAttachedActionParams<TConfig, TKey extends "tools" | "commands"> =
  [InferActions<TConfig, TKey>[number]] extends [never]
    ? unknown
    : InferActions<TConfig, TKey>[number] extends infer TEntry
      ? TEntry extends string
        ? unknown
        : EnsureParamsSatisfy<InferParamsSchema<TConfig>, ActionEntryParams<TEntry>>
      : unknown;

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

export type ValidateNodeTreeParams<
  TSuper extends AnyParamsSchema,
  TNode,
> =
  EnsureParamsSatisfy<TSuper, NodeParamsSchemaOf<TNode>>
  & (
    TNode extends { __config: infer TConfig }
      ? TConfig extends { members: readonly (infer TMember)[] }
        ? ValidateNodeTreeParams<TSuper, TMember>
        : unknown
      : unknown
  );

export type CreatedNode<
  TDataContent,
  TConfig extends NodeConfig<TDataContent>,
> = Node<TDataContent, InferParamsSchema<TConfig>> & {
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

  return {
    ...runtime,
    type: "generator",
    concurrency: runtime.concurrency ?? "serial",
    activationHistory: runtime.activationHistory ?? "live",
    boundaryProjection: normalizeBoundaryProjection(runtime.boundaryProjection),
  };
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

export function createNode<
  TDataContent = never,
  const TConfig extends NodeConfig<TDataContent> = NodeConfig<TDataContent>,
>(
  config: TConfig
    & ValidateAttachedActionParams<TConfig, "tools">
    & ValidateAttachedActionParams<TConfig, "commands">,
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
