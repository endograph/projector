import { z } from "zod";
import type {
  Action,
  ActionContext,
  AnyAction,
  Node,
  RuntimeInstanceId,
  StatePath,
  StateDescriptor,
  StateUpdate,
} from "./types.ts";

const ACTION_BINDING = Symbol.for("projector.actionBinding");
export const GET_STATE_ACTION_NAME = "getState";

export type ActionBinding = {
  runtimeInstanceId: RuntimeInstanceId;
};

export type BoundAction<TAction extends AnyAction = AnyAction> = TAction & {
  [ACTION_BINDING]?: ActionBinding;
};

type InputOf<TSchema> = TSchema extends z.ZodType<infer TInput> ? TInput : unknown;
type StateOf<TState> = TState extends StateDescriptor<infer S> ? S : undefined;

type ActionStateRequirement = StateDescriptor<any> | null;

type ActionConfig<
  TState extends ActionStateRequirement,
  I,
  O,
  TName extends string,
  TDataContent,
> = {
  state: TState;
  name: TName;
  description?: string;
  run?: (input: I, ctx: ActionContext<StateOf<TState>, TDataContent>) => O | Promise<O>;
};

type CreatedAction<
  TState extends ActionStateRequirement,
  I,
  O,
  TName extends string,
  TDataContent,
> = Action<StateOf<TState>, I, O, TName, TDataContent> & {
  state: TState;
};

type ActionWithSchema<
  TState extends ActionStateRequirement,
  TSchema extends z.ZodType,
  O,
  TName extends string,
  TDataContent,
> = CreatedAction<TState, InputOf<TSchema>, O, TName, TDataContent> & {
  inputSchema: TSchema;
};

export function createAction<
  const TName extends string,
  const TState extends ActionStateRequirement,
  const TSchema extends z.ZodType,
  O = unknown,
  TDataContent = never,
>(
  action: ActionConfig<TState, InputOf<TSchema>, O, TName, TDataContent> & { inputSchema: TSchema },
): ActionWithSchema<TState, TSchema, O, TName, TDataContent>;
export function createAction<
  const TName extends string,
  const TState extends ActionStateRequirement,
  O = unknown,
  TDataContent = never,
>(
  action: ActionConfig<TState, unknown, O, TName, TDataContent>,
): CreatedAction<TState, unknown, O, TName, TDataContent>;
export function createAction(action: AnyAction): AnyAction {
  return action;
}

export function createTool<
  const TName extends string,
  const TState extends ActionStateRequirement,
  const TSchema extends z.ZodType,
  O = unknown,
  TDataContent = never,
>(
  action: ActionConfig<TState, InputOf<TSchema>, O, TName, TDataContent> & { inputSchema: TSchema },
): ActionWithSchema<TState, TSchema, O, TName, TDataContent>;
export function createTool<
  const TName extends string,
  const TState extends ActionStateRequirement,
  O = unknown,
  TDataContent = never,
>(
  action: ActionConfig<TState, unknown, O, TName, TDataContent>,
): CreatedAction<TState, unknown, O, TName, TDataContent>;
export function createTool(action: AnyAction): AnyAction {
  return action;
}

export function createCommand<
  const TName extends string,
  const TState extends ActionStateRequirement,
  const TSchema extends z.ZodType,
  O = unknown,
  TDataContent = never,
>(
  action: ActionConfig<TState, InputOf<TSchema>, O, TName, TDataContent> & { inputSchema: TSchema },
): ActionWithSchema<TState, TSchema, O, TName, TDataContent>;
export function createCommand<
  const TName extends string,
  const TState extends ActionStateRequirement,
  O = unknown,
  TDataContent = never,
>(
  action: ActionConfig<TState, unknown, O, TName, TDataContent>,
): CreatedAction<TState, unknown, O, TName, TDataContent>;
export function createCommand(action: AnyAction): AnyAction {
  return action;
}

export function bindAction<TAction extends AnyAction>(
  action: TAction,
  binding: ActionBinding,
): TAction {
  return {
    ...action,
    [ACTION_BINDING]: binding,
  } as TAction;
}

export function getActionBinding(action: AnyAction): ActionBinding | undefined {
  return (action as BoundAction)[ACTION_BINDING];
}

export function replaceState<S>(value: S): StateUpdate<S> {
  return { op: "replace", value };
}

export function patchState<const TPatch extends Record<string, unknown>>(
  value: TPatch,
  options: { path?: StatePath } = {},
): {
  op: "patch";
  value: TPatch;
  path?: StatePath;
} {
  return {
    op: "patch",
    value,
    ...(options.path ? { path: options.path } : {}),
  };
}

export function appendState(
  options: { path?: StatePath },
  ...values: [unknown, ...unknown[]]
): {
  op: "append";
  path?: StatePath;
  values: unknown[];
};
export function appendState(
  ...values: [unknown, ...unknown[]]
): {
  op: "append";
  values: unknown[];
};
export function appendState(
  first: unknown | { path?: StatePath },
  ...rest: unknown[]
): {
  op: "append";
  path?: StatePath;
  values: unknown[];
} {
  const hasOptions = rest.length > 0 && isAppendStateOptions(first);
  const options = hasOptions ? first : {};
  const values = hasOptions ? rest : [first, ...rest];
  return {
    op: "append",
    values,
    ...(options.path ? { path: options.path } : {}),
  };
}

function isAppendStateOptions(value: unknown): value is { path?: StatePath } {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "path" in value,
  );
}
export function createUnboundActionContext<
  TDataContent = never,
>(
  getState?: ActionContext["getState"],
): ActionContext<unknown, TDataContent> {
  const fail = (): never => {
    throw new Error("Action has no source instance");
  };
  return {
    ...(getState ? { getState } : {}),
    instance: {
      runtimeInstanceId: "",
      address: { type: "instance", instanceId: "" },
      ownerInstanceId: "",
      spawn: fail,
      cede: fail,
      transition: fail,
    },
  };
}

export function assertNodeActionStateCompatibility(
  action: AnyAction,
  node: Node<any>,
  kind: "tool" | "command",
): void {
  if (action.state === null) {
    return;
  }

  if (!node.state) {
    throw new Error(
      `Node "${node.key}" ${kind} "${action.name}" requires state "${action.state.key}" but the node has no state`,
    );
  }

  if (action.state.key !== node.state.key) {
    throw new Error(
      `Node "${node.key}" ${kind} "${action.name}" requires state "${action.state.key}" but the node owns state "${node.state.key}"`,
    );
  }

  const actionScope = action.state.scope ?? "top";
  if (actionScope !== node.state.scope) {
    throw new Error(
      `Node "${node.key}" ${kind} "${action.name}" requires ${actionScope} state "${action.state.key}" but the node owns ${node.state.scope} state`,
    );
  }

  if (action.state.schema !== node.state.schema) {
    throw new Error(
      `Node "${node.key}" ${kind} "${action.name}" requires a different schema for state "${action.state.key}"`,
    );
  }
}

export function createGetStateAction(
): Action<
  undefined,
  unknown,
  unknown,
  typeof GET_STATE_ACTION_NAME
> {
  const inputSchema = z.object({
    address: z.string(),
  });
  return {
    state: null,
    name: GET_STATE_ACTION_NAME,
    description: "Retrieve a projected state value by exact address.",
    inputSchema: inputSchema as z.ZodType<unknown>,
    run: (input, ctx) => {
      if (!ctx.getState) {
        throw new Error("No getState handler is available for this action context");
      }
      const { address } = inputSchema.parse(input);
      return ctx.getState(address);
    },
  };
}
