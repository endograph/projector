import { normalizeStateDescriptor } from "./create.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  AnyAction,
  Charter,
  CharterConfig,
  HistoryProjectionFunction,
  Node,
  NormalizedStateDescriptor,
  ProjectionFunction,
  StateDescriptor,
} from "./types.ts";

export function createCharter<TDataContent = never>(
  config: CharterConfig<TDataContent>,
): Charter<TDataContent> {
  return {
    key: config.key,
    version: config.version,
    executor: config.executor,
    nodes: registryFrom(config.nodes, "node", (node) => node.key),
    tools: registryFrom(config.tools, "tool", (tool) => tool.name),
    commands: registryFrom(config.commands, "command", (command) => command.name),
    states: registryFrom(
      config.states.map((state) => normalizeCharterStateDescriptor(state)),
      "state",
      (state) => state.key,
    ),
    projections: projectionRegistryFrom(config.projections),
    historyProjections: registryFrom(
      config.historyProjections ?? [],
      "history projection function",
      (projection) => projection.name,
      { refWord: false },
    ),
  };
}

type CharterRegistryValue<TDataContent> =
  | Node<TDataContent>
  | AnyAction
  | StateDescriptor
  | NormalizedStateDescriptor
  | ProjectionFunction<TDataContent>
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

function projectionRegistryFrom<TDataContent>(
  values: readonly ProjectionFunction<TDataContent>[],
): Record<string, ProjectionFunction<TDataContent>> {
  const registry: Record<string, ProjectionFunction<TDataContent>> = {};
  for (const projection of values) {
    const ref = projection.name;
    assertProjectorIdentifier(ref, "Projection function ref");
    const existing = registry[ref];
    if (!existing) {
      registry[ref] = projection;
      continue;
    }
    if (existing.method !== projection.method) {
      throw new Error(`Duplicate projection function "${ref}" with different methods`);
    }
  }
  return registry;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeCharterStateDescriptor(
  state: StateDescriptor,
): NormalizedStateDescriptor {
  if (
    state.scope !== undefined &&
    state.onInitConflict !== undefined &&
    state.projection !== undefined
  ) {
    return state as NormalizedStateDescriptor;
  }
  return normalizeStateDescriptor(state);
}
