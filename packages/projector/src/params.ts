import { z } from "zod";
import type { AnyAction, Instance, Node } from "./types.ts";

export const emptyParamsSchema = z.object({});

export type JsonObject = Record<string, unknown>;
export type AnyParamsSchema = z.ZodObject<any>;
type ParamsSchemaKeys<TSchema extends AnyParamsSchema> = keyof TSchema["shape"];

export type InferParams<TSchema> = TSchema extends AnyParamsSchema
  ? z.output<TSchema>
  : {};

export type InputParams<TSchema> = TSchema extends AnyParamsSchema
  ? z.input<TSchema>
  : {};

/**
 * never = compatible; otherwise a diagnostic object validators intersect into
 * the config parameter so the assignability failure names the mismatch.
 * Compares the provider's resolved output against the consumer's INPUT: the
 * consumer re-parses what it picks (resolveActionParams), so a key its schema
 * can default or treat as optional need not be provided.
 */
export type ParamsSatisfyError<
  TSuper extends AnyParamsSchema,
  TSub extends AnyParamsSchema,
> = ParamsSchemaKeys<TSub> extends never
  ? never
  : z.output<TSuper> extends z.input<TSub>
  ? never
  : {
      readonly __paramCompatibilityError: "params do not satisfy required schema";
      readonly expected: z.input<TSub>;
      readonly received: z.output<TSuper>;
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
  return schema ?? emptyParamsSchema;
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
  return schema.parse(picked) as JsonObject;
}

export function resolveActionParams(
  action: AnyAction,
  nodeParams: JsonObject,
): JsonObject {
  const schema = normalizeParamsSchema(action.params);
  const picked = pickDeclaredParamKeys(nodeParams, schema);
  return schema.parse(picked) as JsonObject;
}

/**
 * Bind-time mirror of the type-level params check, for everything types cannot
 * see (string refs, computed-closure returns, hydrated dry nodes, JS callers).
 * Every param key the action's schema cannot resolve without (no optional/
 * default) must be declared by the node: resolveNodeParams filters effective
 * params down to the node's declared keys before resolveActionParams picks
 * from them, so an undeclared key can never reach the action at runtime.
 */
export function assertNodeActionParamsCompatibility(
  action: AnyAction,
  node: Node<any>,
  kind: string,
): void {
  if (!action.params) {
    return;
  }
  const nodeSchema = normalizeParamsSchema(node.params);
  for (const [key, field] of Object.entries(action.params.shape)) {
    if (key in nodeSchema.shape) {
      continue;
    }
    if ((field as z.ZodType).safeParse(undefined).success) {
      continue;
    }
    const declared = Object.keys(nodeSchema.shape).join(", ") || "none";
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
  for (const key of Object.keys(schema.shape)) {
    if (key in params) {
      picked[key] = params[key];
    }
  }
  return picked;
}
