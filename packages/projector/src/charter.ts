import {
  normalizeStateDescriptor,
  type ImpliedDataContentOf,
  type NodeTreeParamErrors,
} from "./create.ts";
import { resolveDiscriminatorRef } from "./discriminators.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import { defaultSlotForRegion, implicitDefaultLayout, layoutSlot, lintLayoutVolatileOrder, type CreatedLayout } from "./layouts.ts";
import { isRegionAddress } from "./regions.ts";
import {
  assertNodeActionParamsCompatibility,
  emptyParamsSchema,
  normalizeParamsSchema,
  type AnyParamsSchema,
} from "./params.ts";
import { computedPartDefinition, isComputedMemberDef } from "./computed-parts.ts";
import { walkAllParts } from "./parts.ts";
import { computedRegistryActions, computedRegistryNodes } from "./scoped-actions.ts";
import { slotName } from "./slots.ts";
import type {
  AnyAction,
  AnyComputedPartDef,
  AnyDiscriminator,
  Charter,
  CharterConfig,
  HistoryProjectionFunction,
  LayoutDef,
  Node,
  NormalizedStateDescriptor,
  SlotDef,
  StateDescriptor,
} from "./types.ts";

type InferCharterParamsSchema<TConfig> =
  TConfig extends { params: infer TParams extends AnyParamsSchema }
    ? TParams
    : typeof emptyParamsSchema;

type CharterNodeParamErrors<TConfig> =
  TConfig extends { nodes: readonly (infer TNode)[] }
    ? NodeTreeParamErrors<InferCharterParamsSchema<TConfig>, TNode>
    : never;

/**
 * never-on-pass error collection over every registered node tree: one
 * satisfied node must never mask another's failure (a union with `unknown`
 * absorbs to `unknown`, silently passing — the shape the previous validator
 * had).
 */
type ValidateCharterNodeParams<TConfig> =
  [CharterNodeParamErrors<TConfig>] extends [never]
    ? unknown
    : CharterNodeParamErrors<TConfig>;

type CharterActionEntries<TConfig> =
  | (TConfig extends { actions: readonly (infer TEntry)[] } ? TEntry : never)
  | (TConfig extends { tools: readonly (infer TEntry)[] } ? TEntry : never)
  | (TConfig extends { commands: readonly (infer TEntry)[] } ? TEntry : never);

/**
 * Node-attached actions are held to the vocabulary through the created node's
 * TDataContent fold (see NodeActionDataContent) and plain node covariance.
 * Charter-REGISTERED actions never pass through a node's type — string refs
 * are opaque — so their implied data content is checked here, at the
 * registration point. never-on-pass, same shape as the params validators.
 */
type CharterActionDataErrors<TConfig, TDataContent> =
  CharterActionEntries<TConfig> extends infer TEntry
    ? TEntry extends { name: string }
      ? ImpliedDataContentOf<TEntry> extends infer TImplied
        ? [TImplied] extends [TDataContent]
          ? never
          : {
              readonly __dataContentError: "action result messages carry data content outside the charter's declared vocabulary";
              readonly action: TEntry["name"];
              readonly implied: TImplied;
              readonly declared: TDataContent;
            }
        : never
      : never
    : never;

type ValidateCharterActionDataContent<TConfig, TDataContent> =
  [CharterActionDataErrors<TConfig, TDataContent>] extends [never]
    ? unknown
    : CharterActionDataErrors<TConfig, TDataContent>;

/**
 * TConfig first, TDataContent inferred from the config — same rationale as
 * createNode. `dataContent` is the vocabulary anchor: nodes stay
 * data-content-agnostic and compose covariantly; a node whose output schema
 * falls outside the declared vocabulary fails the CharterConfig constraint
 * here, at charter assembly.
 */
export function createCharter<
  const TConfig extends CharterConfig<TDataContent>,
  TDataContent = never,
>(
  config: TConfig
    & CharterConfig<TDataContent>
    & ValidateCharterNodeParams<TConfig>
    & ValidateCharterActionDataContent<TConfig, TDataContent>,
): Charter<TDataContent, InferCharterParamsSchema<TConfig>> {
  const params = normalizeParamsSchema(config.params) as InferCharterParamsSchema<TConfig>;
  const nodes = config.nodes as readonly Node<TDataContent>[];
  // tools/commands arrays are registration sugar: caller lives on the part
  // contribution, so the charter registry holds undifferentiated definitions
  // in one namespace.
  const actions = [
    ...((config.actions ?? []) as readonly AnyAction[]),
    ...((config.tools ?? []) as readonly AnyAction[]),
    ...((config.commands ?? []) as readonly AnyAction[]),
  ];
  const states = (config.states ?? []) as readonly StateDescriptor[];
  const slots = (config.slots ?? []) as readonly SlotDef[];
  const layouts = (config.layouts ?? []) as readonly CreatedLayout[];
  const computedParts = (config.computedParts ?? []) as readonly AnyComputedPartDef[];
  const discriminators = (config.discriminators ?? []) as readonly AnyDiscriminator[];
  const historyProjections = (config.historyProjections ?? []) as readonly HistoryProjectionFunction<TDataContent>[];

  const layoutRegistry = registryFrom(layouts, "layout", (layout) => layout.name);
  const defaultLayout = layouts.find((layout) => layout.default) ?? layouts[0] ?? implicitDefaultLayout;

  const charter = {
    key: config.key,
    version: config.version,
    params,
    dataContent: config.dataContent,
    nodes: registryFrom(nodes, "node", (node) => node.key),
    actions: registryFrom(actions, "action", (action) => action.name),
    states: registryFrom(
      states.map((state) => normalizeCharterStateDescriptor(state)),
      "state",
      (state) => state.key,
    ),
    slots: registryFrom(slots, "slot", (slot) => slot.name),
    layouts: layoutRegistry,
    computedParts: registryFrom(computedParts, "computed part", (part) => part.name, { refWord: false }),
    discriminators: registryFrom(discriminators, "discriminator", (discriminator) => discriminator.name, { refWord: false }),
    defaultLayout,
    historyProjections: registryFrom(
      historyProjections,
      "history projection function",
      (projection) => projection.name,
      { refWord: false },
    ),
  };

  validateCharter(charter);
  return charter;
}

/**
 * Build-time validation over the closed vocabularies: registered computed
 * parts must target volatile slots, sugar-lowered selects must use registered
 * discriminators with valid (and, when non-partial, exhaustive) branches,
 * discriminator/computed refs in registered nodes must resolve, and layouts
 * get the volatile-ordering lint (as an error at build — it is always fixable
 * at authoring time).
 *
 * The volatile-slot requirement deliberately does NOT apply to sugar-produced
 * defs (select/when): they are slot-less and never registered in
 * charter.computedParts, so the loop below never sees them. Their variation
 * axis is a declared discriminator — branch prose is exactly as static as the
 * old SelectPart branches were — not the ambient dynamism the volatile rule
 * exists to quarantine.
 */
function validateCharter<TDataContent>(charter: Charter<TDataContent>): void {
  const layouts = [charter.defaultLayout, ...Object.values(charter.layouts)];
  for (const layout of layouts) {
    for (const diagnostic of lintLayoutVolatileOrder(layout)) {
      throw new Error(diagnostic.message);
    }
  }

  for (const part of Object.values(charter.computedParts)) {
    if (isRegionAddress(part.slot)) {
      for (const layout of layouts) {
        const slot = defaultSlotForRegion(layout, part.slot.region);
        if (slot && !slot.volatile) {
          throw new Error(
            `Computed part "${part.name}" targets region "${part.slot.region}" whose default slot "${slot.name}" in layout "${layout.name}" is non-volatile; computed content requires a volatile slot`,
          );
        }
      }
      continue;
    }
    const name = slotName(part.slot);
    if (!name) {
      continue;
    }
    for (const layout of layouts) {
      const slot = layoutSlot(layout, name) ?? charter.slots[name];
      if (slot && !slot.volatile) {
        throw new Error(
          `Computed part "${part.name}" targets non-volatile slot "${name}"; computed content requires a volatile slot`,
        );
      }
    }
  }

  for (const node of Object.values(charter.nodes)) {
    validateNodeSelects(node, charter);
    validateNodeIncludes(node, charter);
  }

  validateNodeActionParams(charter);
  validateStateDescriptorIdentities(charter);
  validateScopeUniqueness(charter);
}

/**
 * Every included node must be charter-registered — the same law as spawn.
 * The walkAllParts sweep covers static include parts (all sugar branches
 * entered) and bare computeds' registry node candidates (the declared
 * universe a computed include chooses from). Identity check, not just key:
 * the registered instance is what serialization and the include graph key on.
 * NOTE: the include KEY-graph cycle lint is deliberately not here — charter
 * build has no warning channel and a cycle must stay a warning (mutual
 * includes are defined behavior under the once-per-document clip); the
 * compile surfaces it as a "cyclic-include" diagnostic instead.
 */
function validateNodeIncludes<TDataContent>(
  node: Node<TDataContent>,
  charter: Charter<TDataContent>,
): void {
  const assertRegistered = (target: Node<TDataContent> | string, via: string): void => {
    if (typeof target === "string") {
      if (!charter.nodes[target]) {
        throw new Error(
          `Include of unknown node ref "${target}" ${via}; include targets must be charter-registered`,
        );
      }
      return;
    }
    if (charter.nodes[target.key] !== target) {
      throw new Error(
        `Include of node "${target.key}" ${via} is not the charter-registered instance; include targets must be charter-registered`,
      );
    }
  };

  walkAllParts(node.parts, (part) => {
    if (part.kind === "include") {
      assertRegistered(part.node, `in node "${node.key}"`);
      return;
    }
    if (part.kind === "computed") {
      const definition = computedPartDefinition(part.part, charter);
      if (!definition || definition.metadata) {
        return;
      }
      for (const candidate of computedRegistryNodes(definition)) {
        assertRegistered(
          candidate,
          `in computed "${definition.name}" registry (node "${node.key}")`,
        );
      }
    }
  });
  for (const entry of node.memberEntries) {
    if (isComputedMemberDef(entry)) {
      for (const member of entry.registry ?? []) {
        validateNodeIncludes(member, charter);
      }
      continue;
    }
    validateNodeIncludes(entry as Node<TDataContent>, charter);
  }
}

/**
 * Static tier of the scope-uniqueness invariant (every document scope owns at
 * most one contributor per node key): a registered generator's walkable
 * member tree — inline members, components recursed into, generator members
 * owned as leaves — may claim each node key once, the generator's own key
 * included. Computed-member registries are skipped: their candidates
 * alternate per compile, so the mutation-time (applyInstanceMessage) and
 * compile-realization (ambiguous-include diagnostic) tiers own the realized
 * tree.
 */
function validateScopeUniqueness<TDataContent>(charter: Charter<TDataContent>): void {
  for (const node of Object.values(charter.nodes)) {
    if (node.runtime.type !== "generator") {
      continue;
    }
    const seen = new Set<string>([node.key]);
    const claim = (key: string): void => {
      if (seen.has(key)) {
        throw new Error(
          `Scope-uniqueness: node key "${key}" appears more than once in the document scope of generator "${node.key}"; a scope owns at most one contributor per node key — use distinct node keys`,
        );
      }
      seen.add(key);
    };
    const visitMembers = (owner: Node<TDataContent>): void => {
      for (const entry of owner.memberEntries) {
        if (isComputedMemberDef(entry)) {
          continue;
        }
        const member = entry as Node<TDataContent>;
        claim(member.key);
        if (member.runtime.type !== "generator") {
          visitMembers(member);
        }
      }
    };
    visitMembers(node);
  }
}

/**
 * Bind-time backstop behind the type-level params check, covering what types
 * cannot see: string refs (resolved against the charter registry — scoped
 * self-bindings are inline parts the same walk already visits), computed
 * registries, hydrated member trees, and JS callers. Mirrors the state-
 * compatibility walk: registries are walkable data, closures stay opaque.
 */
function validateNodeActionParams<TDataContent>(charter: Charter<TDataContent>): void {
  const callerKind = (caller: string): string =>
    caller === "generator" ? "tool" : caller === "external" ? "command" : "action";

  const visited = new Set<Node<TDataContent>>();
  const visitNode = (node: Node<TDataContent>): void => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    walkAllParts(node.parts, (part) => {
      if (part.kind === "action") {
        // Unresolvable refs are not this pass's concern (compile/dispatch own
        // that error); self-binding refs resolve to inline parts this walk
        // already visits directly.
        const action =
          typeof part.action === "string" ? charter.actions[part.action] : part.action;
        if (action) {
          assertNodeActionParamsCompatibility(action, node, callerKind(part.caller));
        }
        return;
      }
      if (part.kind === "computed") {
        const definition = computedPartDefinition(part.part, charter);
        for (const action of definition ? computedRegistryActions(definition) : []) {
          assertNodeActionParamsCompatibility(action, node, "action");
        }
      }
    });
    for (const entry of node.memberEntries) {
      if (isComputedMemberDef(entry)) {
        for (const member of entry.registry ?? []) {
          visitNode(member);
        }
        continue;
      }
      visitNode(entry as Node<TDataContent>);
    }
  };
  for (const node of Object.values(charter.nodes)) {
    visitNode(node);
  }
}

/**
 * One registered descriptor identity per state key, charter-wide: every state
 * key appearing anywhere (charter `states:` list, node `states:` declarations,
 * action `state:` bindings) must resolve to a single descriptor object. Lazy
 * realization depends on this — with one identity per key there is never a
 * second descriptor to merge with, so the init a read falls back to and the
 * init a write realizes with cannot diverge.
 */
function validateStateDescriptorIdentities<TDataContent>(
  charter: Charter<TDataContent>,
): void {
  const seen = new Map<string, { descriptor: NormalizedStateDescriptor; origin: string }>();
  const register = (descriptor: StateDescriptor, origin: string): void => {
    const normalized = normalizeStateDescriptor(descriptor);
    const existing = seen.get(normalized.key);
    if (!existing) {
      seen.set(normalized.key, { descriptor: normalized, origin });
      return;
    }
    if (existing.descriptor !== normalized) {
      throw new Error(
        `State key "${normalized.key}" is declared by two descriptor identities (${existing.origin} and ${origin}); share one createState(...) descriptor per key charter-wide`,
      );
    }
  };

  for (const [key, descriptor] of Object.entries(charter.states)) {
    register(descriptor, `charter states["${key}"]`);
  }
  for (const action of Object.values(charter.actions)) {
    if (action.state) {
      register(action.state, `action "${action.name}"`);
    }
  }

  const visited = new Set<Node<TDataContent>>();
  const visitNode = (node: Node<TDataContent>): void => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    for (const descriptor of node.states) {
      register(descriptor, `node "${node.key}"`);
    }
    walkAllParts(node.parts, (part) => {
      if (part.kind === "action" && typeof part.action !== "string" && part.action.state) {
        register(part.action.state, `action "${part.action.name}" on node "${node.key}"`);
      }
      // Computed registries are walkable data: their actions' state bindings
      // participate in the one-identity-per-key invariant like any inline part.
      if (part.kind === "computed") {
        const definition = computedPartDefinition(part.part, charter);
        for (const action of definition ? computedRegistryActions(definition) : []) {
          if (action.state) {
            register(
              action.state,
              `action "${action.name}" in computed "${definition!.name}" registry (node "${node.key}")`,
            );
          }
        }
      }
    });
    for (const entry of node.memberEntries) {
      if (isComputedMemberDef(entry)) {
        // A member computed's registry is walkable data; bare charter-node
        // returns are covered by the charter.nodes iteration.
        for (const member of entry.registry ?? []) {
          visitNode(member);
        }
        continue;
      }
      visitNode(entry as Node<TDataContent>);
    }
  };
  for (const node of Object.values(charter.nodes)) {
    visitNode(node);
  }
}

function validateNodeSelects<TDataContent>(
  node: Node<TDataContent>,
  charter: Charter<TDataContent>,
): void {
  // walkAllParts enters sugar metadata branches, so these checks apply to
  // nested selects and to computed refs inside branches alike. Exhaustiveness
  // is enforced at the sugar constructor for object discriminators; this
  // build-time pass re-checks it against the charter registry, covering
  // string-ref discriminators and hand-crafted metadata.
  walkAllParts(node.parts, (part) => {
    if (part.kind !== "computed") {
      return;
    }
    if (typeof part.part === "string") {
      if (!charter.computedParts[part.part]) {
        throw new Error(`Unknown computed part ref "${part.part}" in node "${node.key}"`);
      }
      return;
    }
    const metadata = part.part.metadata;
    if (metadata) {
      assertSelectExhaustive(metadata.discriminator, metadata.partial, Object.keys(metadata.branches), charter, node.key);
    }
  });
  for (const entry of node.memberEntries) {
    if (isComputedMemberDef(entry)) {
      for (const member of entry.registry ?? []) {
        validateNodeSelects(member, charter);
      }
      continue;
    }
    validateNodeSelects(entry as Node<TDataContent>, charter);
  }
}

function assertSelectExhaustive<TDataContent>(
  discriminatorRef: AnyDiscriminator | string,
  partial: boolean,
  branchKeys: string[],
  charter: Charter<TDataContent>,
  nodeKey: string,
): void {
  const discriminator = resolveDiscriminatorRef(discriminatorRef, charter);
  const registered = charter.discriminators[discriminator.name];
  if (registered !== discriminator) {
    throw new Error(
      `Discriminator "${discriminator.name}" used by node "${nodeKey}" is not the charter-registered instance`,
    );
  }
  for (const key of branchKeys) {
    if (!discriminator.values.includes(key)) {
      throw new Error(
        `Select in node "${nodeKey}" has branch "${key}" not in discriminator "${discriminator.name}" values`,
      );
    }
  }
  if (!partial) {
    for (const value of discriminator.values) {
      if (!branchKeys.includes(value)) {
        throw new Error(
          `Select in node "${nodeKey}" over "${discriminator.name}" is missing branch "${value}"`,
        );
      }
    }
  }
}

type CharterRegistryValue<TDataContent> =
  | Node<TDataContent>
  | AnyAction
  | StateDescriptor
  | NormalizedStateDescriptor
  | SlotDef
  | LayoutDef
  | AnyComputedPartDef
  | AnyDiscriminator
  | HistoryProjectionFunction<TDataContent>;

function registryFrom<TValue extends CharterRegistryValue<any>>(
  values: readonly TValue[],
  kind: string,
  refFor: (value: TValue) => string,
  options: { refWord?: boolean } = {},
): Record<string, TValue> {
  const refWord = options.refWord ?? true;
  const registry: Record<string, TValue> = {};
  for (const value of values) {
    const ref = refFor(value);
    assertProjectorIdentifier(ref, `${capitalize(kind)} ref`);
    if (registry[ref]) {
      throw new Error(`Duplicate ${kind}${refWord ? " ref" : ""} "${ref}"`);
    }
    registry[ref] = value;
  }
  return registry;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeCharterStateDescriptor(
  state: StateDescriptor,
): NormalizedStateDescriptor {
  if (state.scope !== undefined && state.onInitConflict !== undefined) {
    return state as NormalizedStateDescriptor;
  }
  return normalizeStateDescriptor(state);
}
