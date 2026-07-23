import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  ActionPart,
  AnyAction,
  AnyComputedMemberDef,
  AnyComputedPartDef,
  Charter,
  ComputedMemberDef,
  ComputedMemberReturn,
  ComputedPartDef,
  ComputedPartEnv,
  ComputedReturnPart,
  IncludePart,
  Node,
  Ref,
  SlotAddress,
} from "./types.ts";

export type ComputedPartConfig<TDataContent = never> = {
  name: string;
  slot: SlotAddress;
  /** Local action (and, later, member-node) candidates for ref resolution. */
  registry?: ReadonlyArray<AnyAction | Node<TDataContent>>;
  compute: (env: ComputedPartEnv) => string | ComputedReturnPart<TDataContent>[];
};

/** The action candidates a config's literal registry type declares. */
export type RegistryActionsOf<TConfig> = TConfig extends {
  registry: ReadonlyArray<infer TEntry>;
}
  ? Extract<TEntry, AnyAction>
  : never;

/** The node candidates a config's literal registry type declares. */
export type RegistryNodesOf<TConfig, TDataContent> = TConfig extends {
  registry: ReadonlyArray<infer TEntry>;
}
  ? Extract<TEntry, Node<TDataContent>>
  : Node<TDataContent>;

/**
 * A named, charter-registered computed contribution: the sanctioned form of
 * dynamism in a node's content. Naming is mandatory — identity is what diffs,
 * memoization, provenance, and serialization key on; the compute function is
 * code and never serializes. Must target a volatile slot (validated at
 * charter build). The returned def carries the registry's action types, so
 * createNode can check their param requirements against the owning node —
 * the type-level twin of the closure rule (registries are walkable, closures
 * are opaque).
 */
export function createComputedPart<
  const TConfig extends ComputedPartConfig<TDataContent>,
  TDataContent = never,
>(
  config: TConfig & ComputedPartConfig<TDataContent>,
): ComputedPartDef<TDataContent, RegistryActionsOf<TConfig>> {
  assertProjectorIdentifier(config.name, "Computed part name");
  return {
    kind: "computedPart",
    name: config.name,
    slot: config.slot,
    ...(config.registry ? { registry: config.registry } : {}),
    compute: config.compute,
  } as ComputedPartDef<TDataContent, RegistryActionsOf<TConfig>>;
}

export type ComputedMemberConfig<TDataContent = never> = {
  name: string;
  /** Local node candidates for return resolution (closure-rule tier 1). */
  registry?: ReadonlyArray<Node<TDataContent>>;
  compute: (env: ComputedPartEnv) => ComputedMemberReturn<TDataContent>;
};

/**
 * A named computed member entry: the sanctioned form of dynamism in a node's
 * membership. Same env as computed parts (params + declared-state reader with
 * init fallback); returns registered Nodes only — the closure rule (local
 * registry → charter.nodes) bounds the universe, enforced at evaluation. The
 * returned def carries the registry's node types, so charter-tier param
 * validation walks computed members like inline ones.
 */
export function createComputedMember<
  const TConfig extends ComputedMemberConfig<TDataContent>,
  TDataContent = never,
>(
  config: TConfig & ComputedMemberConfig<TDataContent>,
): ComputedMemberDef<TDataContent, RegistryNodesOf<TConfig, TDataContent>> {
  assertProjectorIdentifier(config.name, "Computed member name");
  return {
    kind: "computedMember",
    name: config.name,
    ...(config.registry ? { registry: config.registry } : {}),
    compute: config.compute,
  } as ComputedMemberDef<TDataContent, RegistryNodesOf<TConfig, TDataContent>>;
}

export function isComputedMemberDef(value: unknown): value is AnyComputedMemberDef {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "computedMember" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { compute?: unknown }).compute === "function",
  );
}

export function isComputedPartDef(value: unknown): value is AnyComputedPartDef {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "computedPart" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { compute?: unknown }).compute === "function",
  );
}

export function resolveComputedPartRef<TDataContent>(
  part: ComputedPartDef<TDataContent> | Ref,
  charter: Charter<TDataContent> | undefined,
): AnyComputedPartDef {
  if (typeof part !== "string") {
    return part;
  }
  const resolved = charter?.computedParts[part];
  if (!resolved) {
    throw new Error(`Unknown computed part ref "${part}"`);
  }
  return resolved;
}

/**
 * Lenient ref resolution for static walks (validation, registries, bare-ref
 * recovery): an unresolvable ref yields undefined instead of throwing — the
 * charter-build lint owns rejecting unknown refs on registered nodes.
 */
export function computedPartDefinition<TDataContent>(
  part: ComputedPartDef<TDataContent> | Ref,
  charter: Charter<TDataContent> | undefined,
): AnyComputedPartDef | undefined {
  return typeof part === "string" ? charter?.computedParts[part] : part;
}

/** A compute return element carrying an action contribution (tool/command). */
export function isComputedActionReturn(
  part: ComputedReturnPart<any>,
): part is ActionPart {
  return "kind" in part && part.kind === "action";
}

/** A compute return element carrying an include contribution. */
export function isComputedIncludeReturn(
  part: ComputedReturnPart<any>,
): part is IncludePart<any> {
  return "kind" in part && part.kind === "include";
}

/** Per-compile cache of normalized compute returns, keyed on (name, contributor). */
export type ComputedReturnMemo = Map<string, ComputedReturnPart<any>[]>;

/**
 * The dev-mode stability check runs everywhere except explicit production
 * (bundlers substitute NODE_ENV; a missing process counts as dev).
 */
const STABILITY_CHECK_ENABLED: boolean = (() => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env?.NODE_ENV !== "production";
})();

/**
 * Evaluates a compute closure and normalizes its return: a string becomes one
 * text content part; select parts and nested computed parts are rejected.
 *
 * When a memo is passed (the compile path), the normalized return is cached
 * per (computed name, contributor) and — outside production — the closure is
 * re-run once to assert its returned action-name set is stable. Structure must
 * derive from env (params/state) alone: tool-surface flicker from ambient
 * reads is prompt-cache churn from byte zero, so it fails loudly in dev.
 * Memo-less callers (executeCommand dispatch) evaluate fresh and agree,
 * because correctness never depends on the memo.
 */
export function evaluateComputedPartReturn(
  definition: AnyComputedPartDef,
  env: ComputedPartEnv,
  memo?: { key: string; store: ComputedReturnMemo },
): ComputedReturnPart<any>[] {
  const cached = memo?.store.get(memo.key);
  if (cached) {
    return cached;
  }
  const parts = normalizeComputedReturn(definition, definition.compute(env));
  if (memo) {
    memo.store.set(memo.key, parts);
    if (STABILITY_CHECK_ENABLED) {
      assertStableActionReturn(
        definition,
        parts,
        normalizeComputedReturn(definition, definition.compute(env)),
      );
    }
  }
  return parts;
}

function normalizeComputedReturn(
  definition: AnyComputedPartDef,
  returned: string | ComputedReturnPart<any>[],
): ComputedReturnPart<any>[] {
  if (typeof returned === "string") {
    return returned ? [{ type: "text", text: returned }] : [];
  }
  for (const part of returned) {
    const kind = (part as { kind?: unknown }).kind;
    if (kind === "computed" || kind === "computedPart") {
      throw new Error(
        `Computed part "${definition.name}" returned a computed part (select/when sugar included); computed parts cannot nest through closures — return the inner parts directly`,
      );
    }
  }
  return returned;
}

function assertStableActionReturn(
  definition: AnyComputedPartDef,
  first: ComputedReturnPart<any>[],
  second: ComputedReturnPart<any>[],
): void {
  const firstNames = computedActionNames(first);
  const secondNames = computedActionNames(second);
  if (
    firstNames.size === secondNames.size &&
    [...firstNames].every((name) => secondNames.has(name))
  ) {
    return;
  }
  throw new Error(
    `Computed part "${definition.name}" is unstable within one compile: the first evaluation returned actions [${[...firstNames].join(", ")}] but a re-evaluation returned [${[...secondNames].join(", ")}]. Action structure must derive from env (params/state) only, never from ambient reads.`,
  );
}

function computedActionNames(parts: ComputedReturnPart<any>[]): Set<string> {
  const names = new Set<string>();
  for (const part of parts) {
    if (isComputedActionReturn(part)) {
      names.add(typeof part.action === "string" ? part.action : part.action.name);
    }
  }
  return names;
}

/** Per-compile cache of resolved member-compute returns, keyed on (name, contributor). */
export type ComputedMemberMemo = Map<string, Node<any>[]>;

/**
 * Evaluates a member compute closure and resolves its return through the
 * closure rule: each returned node must BE a declared identity — listed in the
 * computed's own registry (by reference) or charter-registered (string key
 * ref, or the registered object itself). Unresolvable returns are a compile
 * error naming the computed; closures never mint node identities.
 *
 * Memo and dev-mode stability semantics mirror evaluateComputedPartReturn:
 * memoized per (computed name, contributor) on the compile path, with a dev
 * re-evaluation asserting the returned node-key set is stable (membership
 * must derive from env alone); memo-less callers (dispatch, contributor-by-id
 * lookup) evaluate fresh and agree.
 */
export function evaluateComputedMemberNodes<TDataContent>(
  definition: ComputedMemberDef<TDataContent>,
  env: ComputedPartEnv,
  charter: Charter<TDataContent> | undefined,
  memo?: { key: string; store: ComputedMemberMemo },
): Node<TDataContent>[] {
  const cached = memo?.store.get(memo.key);
  if (cached) {
    return cached as Node<TDataContent>[];
  }
  const nodes = resolveComputedMemberReturn(definition, definition.compute(env), charter);
  if (memo) {
    memo.store.set(memo.key, nodes);
    if (STABILITY_CHECK_ENABLED) {
      assertStableMemberReturn(
        definition,
        nodes,
        resolveComputedMemberReturn(definition, definition.compute(env), charter),
      );
    }
  }
  return nodes;
}

function resolveComputedMemberReturn<TDataContent>(
  definition: ComputedMemberDef<TDataContent>,
  returned: ComputedMemberReturn<TDataContent>,
  charter: Charter<TDataContent> | undefined,
): Node<TDataContent>[] {
  const entries = returned === null ? [] : Array.isArray(returned) ? returned : [returned];
  return entries.map((entry) => {
    if (typeof entry === "string") {
      const resolved = charter?.nodes[entry];
      if (!resolved) {
        throw new Error(
          `Computed member "${definition.name}" returned unknown node ref "${entry}"; node refs resolve against the charter's registered nodes`,
        );
      }
      return resolved;
    }
    const declared =
      definition.registry?.includes(entry) || charter?.nodes[entry.key] === entry;
    if (!declared) {
      throw new Error(
        `Computed member "${definition.name}" returned node "${entry.key}" with no declared identity; list it in the computed's registry or register it on the charter — identities are never minted inside a compute closure`,
      );
    }
    return entry;
  });
}

function assertStableMemberReturn(
  definition: AnyComputedMemberDef,
  first: Node<any>[],
  second: Node<any>[],
): void {
  const firstKeys = new Set(first.map((node) => node.key));
  const secondKeys = new Set(second.map((node) => node.key));
  if (
    firstKeys.size === secondKeys.size &&
    [...firstKeys].every((key) => secondKeys.has(key))
  ) {
    return;
  }
  throw new Error(
    `Computed member "${definition.name}" is unstable within one compile: the first evaluation returned nodes [${[...firstKeys].join(", ")}] but a re-evaluation returned [${[...secondKeys].join(", ")}]. Membership must derive from env (params/state) only, never from ambient reads.`,
  );
}
