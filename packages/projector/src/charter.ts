import {
  normalizeStateDescriptor,
  type ValidateNodeTreeParams,
} from "./create.ts";
import { isMemberSelect, resolveDiscriminatorRef } from "./discriminators.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import { defaultSlotForRegion, implicitDefaultLayout, layoutSlot, lintLayoutVolatileOrder, type CreatedLayout } from "./layouts.ts";
import { isRegionAddress } from "./regions.ts";
import {
  emptyParamsSchema,
  normalizeParamsSchema,
  type AnyParamsSchema,
} from "./params.ts";
import { walkAllParts } from "./parts.ts";
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

type ValidateCharterNodeParams<TConfig> =
  TConfig extends { nodes: readonly (infer TNode)[] }
    ? TNode extends unknown
      ? ValidateNodeTreeParams<InferCharterParamsSchema<TConfig>, TNode>
      : unknown
    : unknown;

export function createCharter<
  TDataContent = never,
  const TConfig extends CharterConfig<TDataContent> = CharterConfig<TDataContent>,
>(
  config: TConfig & ValidateCharterNodeParams<TConfig>,
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
 * Build-time validation over the closed vocabularies: computed parts must
 * target volatile slots, non-partial selects must be exhaustive over their
 * discriminator's values, discriminator/computed refs in registered nodes
 * must resolve, and layouts get the volatile-ordering lint (as an error at
 * build — it is always fixable at authoring time).
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
  }
}

function validateNodeSelects<TDataContent>(
  node: Node<TDataContent>,
  charter: Charter<TDataContent>,
): void {
  walkAllParts(node.parts, (part) => {
    if (part.kind === "select") {
      assertSelectExhaustive(part.discriminator, part.partial, Object.keys(part.branches), charter, node.key);
    }
    if (part.kind === "computed" && typeof part.part === "string" && !charter.computedParts[part.part]) {
      throw new Error(`Unknown computed part ref "${part.part}" in node "${node.key}"`);
    }
  });
  for (const entry of node.memberEntries) {
    if (isMemberSelect(entry)) {
      assertSelectExhaustive(entry.discriminator, entry.partial, Object.keys(entry.branches), charter, node.key);
      for (const branch of Object.values(entry.branches)) {
        for (const member of branch ?? []) {
          validateNodeSelects(member, charter);
        }
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
