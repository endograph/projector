import {
  jsonSchemaProperties,
  jsonSchemaRequired,
  normalizeSchema,
  schemaFromJsonSchema,
  type InferSchemaValue,
  type Schema,
} from "./schema.ts";
import type { AnyAction, Instance, Node } from "./types.ts";

export type JsonObject = Record<string, unknown>;
/** A params schema: any Standard Schema over an object. */
export type AnyParamsSchema = Schema<JsonObject>;
export const emptyParamsSchema = schemaFromJsonSchema<{}>({
  type: "object",
  properties: {},
  additionalProperties: false,
});
type ParamsSchemaKeys<TSchema extends AnyParamsSchema> = keyof InferSchemaValue<TSchema>;

export type InferParams<TSchema> = TSchema extends AnyParamsSchema
  ? InferSchemaValue<TSchema>
  : {};

export type InputParams<TSchema> = TSchema extends AnyParamsSchema
  ? InferSchemaValue<TSchema>
  : {};

/**
 * never = compatible; otherwise a diagnostic object validators intersect into
 * the config parameter so the assignability failure names the mismatch.
 * Compares the value supplied by the provider with the value accepted by the
 * consumer. The consumer revalidates the keys selected by resolveActionParams.
 */
export type ParamsSatisfyError<
  TSuper extends AnyParamsSchema,
  TSub extends AnyParamsSchema,
> = ParamsSchemaKeys<TSub> extends never
  ? never
  : InferSchemaValue<TSuper> extends InferSchemaValue<TSub>
  ? never
  : {
      readonly __paramCompatibilityError: "params do not satisfy required schema";
      readonly expected: InferSchemaValue<TSub>;
      readonly received: InferSchemaValue<TSuper>;
    };

export type InferNodeParams<N> =
  N extends Node<any, infer TParams> ? InferParams<TParams> : {};

export type InferActionParams<A> =
  A extends AnyAction<infer TParams> ? InferParams<TParams> : {};

export type InferCharterParams<C> =
  C extends { params: infer TParams } ? InferParams<TParams> : {};

export type InputCharterParams<C> =
  C extends { params: infer TParams } ? InputParams<TParams> : {};

export function normalizeParamsSchema(
  schema: AnyParamsSchema | undefined,
): AnyParamsSchema {
  const resolved = schema ?? emptyParamsSchema;
  normalizeSchema(resolved);
  return resolved;
}

export function resolveEffectiveParams(instancePath: readonly Instance<any>[]): JsonObject {
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

export function resolveNodeParams(
  node: Node<any>,
  effectiveParams: JsonObject,
): JsonObject {
  const schema = normalizeParamsSchema(node.params);
  const picked = pickDeclaredParamKeys(effectiveParams, schema);
  normalizeSchema(schema).assert(picked);
  return picked;
}

export function resolveActionParams(
  action: AnyAction,
  nodeParams: JsonObject,
): JsonObject {
  const schema = normalizeParamsSchema(action.params);
  const picked = pickDeclaredParamKeys(nodeParams, schema);
  normalizeSchema(schema).assert(picked);
  return picked;
}

/**
 * Bind-time mirror of the type-level params check, for everything types cannot
 * see (string refs, computed-closure returns, hydrated dry nodes, JS callers).
 * Every param key the action's schema cannot resolve without (required on the
 * input side of its JSON Schema) must be declared by the node:
 * resolveNodeParams filters effective params down to the node's declared keys
 * before resolveActionParams picks from them, so an undeclared key can never
 * reach the action at runtime.
 */
export function assertNodeActionParamsCompatibility(
  action: AnyAction,
  node: Node<any>,
  kind: string,
): void {
  if (!action.params) {
    return;
  }
  const nodeKeys = declaredParamKeys(normalizeParamsSchema(node.params));
  const actionInput = normalizeSchema(action.params).jsonSchema();
  const required = jsonSchemaRequired(actionInput);
  for (const key of jsonSchemaProperties(actionInput)) {
    if (nodeKeys.includes(key) || !required.has(key)) {
      continue;
    }
    const declared = nodeKeys.join(", ") || "none";
    throw new Error(
      `Node "${node.key}" ${kind} "${action.name}" requires param "${key}" but the node declares: ${declared}`,
    );
  }
}

export function pickDeclaredParamKeys(
  params: JsonObject,
  schema: AnyParamsSchema,
): JsonObject {
  const picked: JsonObject = {};
  for (const key of declaredParamKeys(schema)) {
    if (key in params) {
      picked[key] = params[key];
    }
  }
  return picked;
}

function declaredParamKeys(schema: AnyParamsSchema): string[] {
  return jsonSchemaProperties(normalizeSchema(schema).jsonSchema());
}
