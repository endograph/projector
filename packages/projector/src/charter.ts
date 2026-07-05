import {
  normalizeStateDescriptor,
  type ValidateNodeTreeParams,
} from "./create.ts";
import { assertProjectorIdentifier } from "./identifiers.ts";
import {
  emptyParamsSchema,
  normalizeParamsSchema,
  type AnyParamsSchema,
  type EnsureParamsSatisfy,
} from "./params.ts";
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
  const tools = config.tools as readonly AnyAction[];
  const commands = config.commands as readonly AnyAction[];
  const states = config.states as readonly StateDescriptor[];
  const projections = config.projections as readonly ProjectionFunction<TDataContent>[];
  const historyProjections = (config.historyProjections ?? []) as readonly HistoryProjectionFunction<TDataContent>[];
  const charter = {
    key: config.key,
    version: config.version,
    params,
    nodes: registryFrom(nodes, "node", (node) => node.key),
    tools: registryFrom(tools, "tool", (tool) => tool.name),
    commands: registryFrom(commands, "command", (command) => command.name),
    states: registryFrom(
      states.map((state) => normalizeCharterStateDescriptor(state)),
      "state",
      (state) => state.key,
    ),
    projections: projectionRegistryFrom(projections),
    historyProjections: registryFrom(
      historyProjections,
      "history projection function",
      (projection) => projection.name,
      { refWord: false },
    ),
  };
  return charter;
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
