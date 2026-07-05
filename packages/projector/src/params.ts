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

export type EnsureParamsSatisfy<
  TSuper extends AnyParamsSchema,
  TSub extends AnyParamsSchema,
> = ParamsSchemaKeys<TSub> extends never
  ? unknown
  : z.output<TSuper> extends z.output<TSub>
  ? unknown
  : {
      readonly __paramCompatibilityError: "params do not satisfy required schema";
      readonly expected: z.output<TSub>;
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
