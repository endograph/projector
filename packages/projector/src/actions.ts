import { z } from "zod";
import { assertProjectorIdentifier } from "./identifiers.ts";
import type {
  Action,
  ActionRequestMessage,
  ActionResultMessage,
  ActionContext,
  ActionKind,
  AnyAction,
  ExecuteActionResult,
  Node,
  GeneratorId,
  FrameMessage,
  StatePath,
  StateDescriptor,
  StateUpdate,
} from "./types.ts";

const ACTION_BINDING: unique symbol = Symbol.for("projector.actionBinding") as never;
const ACTION_RESULT: unique symbol = Symbol.for("projector.actionResult") as never;
export const GET_STATE_ACTION_NAME = "getState";

export type ActionBinding = {
  generatorId: GeneratorId;
};

export type BoundAction<TAction extends AnyAction = AnyAction> = TAction & {
  [ACTION_BINDING]?: ActionBinding;
};

export type ActionResultEnvelope<T = unknown, TDataContent = never> = (
  | {
      success?: true;
      value?: T;
      messages?: FrameMessage<TDataContent>[];
    }
  | {
      success: false;
      error: string;
      value?: T;
      messages?: FrameMessage<TDataContent>[];
    }
) & {
  [ACTION_RESULT]: true;
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
  assertProjectorIdentifier(action.name, "Action name");
  if (action.state) {
    assertProjectorIdentifier(action.state.key, "State key");
  }
  return action;
}

export function createToolActionRequest(
  name: string,
  input: unknown,
  callId: string,
): ActionRequestMessage & { action: "tool" } {
  return {
    type: "action",
    kind: "request",
    action: "tool",
    name,
    input,
    callId,
  };
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

export function actionResult<T = unknown, TDataContent = never>(
  result:
    | {
        success?: true;
        value?: T;
        messages?: FrameMessage<TDataContent>[];
      }
    | {
        success: false;
        error: string;
        value?: T;
        messages?: FrameMessage<TDataContent>[];
      },
): ActionResultEnvelope<T, TDataContent> {
  return {
    ...result,
    [ACTION_RESULT]: true,
  } as ActionResultEnvelope<T, TDataContent>;
}

export function isActionResultEnvelope<T = unknown, TDataContent = never>(
  value: unknown,
): value is ActionResultEnvelope<T, TDataContent> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { [ACTION_RESULT]?: unknown })[ACTION_RESULT] === true,
  );
}

export type ActionInvocationOptions<T = unknown, TDataContent = never> = {
  request: ActionRequestMessage;
  run: () => unknown;
  enqueueMessages: (messages: FrameMessage<TDataContent>[]) => void;
  enqueueRequestBeforeRun?: boolean;
  throwErrors?: boolean;
};

export function executeActionInvocation<T = unknown, TDataContent = never>(
  options: ActionInvocationOptions<T, TDataContent>,
): ExecuteActionResult<T, TDataContent> | Promise<ExecuteActionResult<T, TDataContent>> {
  const enqueue = (messages: FrameMessage<TDataContent>[]) => options.enqueueMessages(messages);
  if (options.enqueueRequestBeforeRun) {
    enqueue([options.request as FrameMessage<TDataContent>]);
  }

  let pending: unknown;
  try {
    pending = options.run();
  } catch (error) {
    const result = actionErrorResult<T, TDataContent>(options.request.callId, error);
    enqueue(createActionTerminalMessages(options.request, result, options.enqueueRequestBeforeRun !== true));
    if (options.throwErrors) throw error;
    return result;
  }

  if (isPromiseLike(pending)) {
    if (!options.enqueueRequestBeforeRun) {
      enqueue([options.request as FrameMessage<TDataContent>]);
    }
    return Promise.resolve(pending).then(
      (value) => {
        const result = normalizeActionReturn<T, TDataContent>(options.request.callId, value);
        enqueue(createActionTerminalMessages(options.request, result, false));
        return result;
      },
      (error) => {
        const result = actionErrorResult<T, TDataContent>(options.request.callId, error);
        enqueue(createActionTerminalMessages(options.request, result, false));
        if (options.throwErrors) throw error;
        return result;
      },
    );
  }

  const result = normalizeActionReturn<T, TDataContent>(options.request.callId, pending);
  enqueue(createActionTerminalMessages(options.request, result, options.enqueueRequestBeforeRun !== true));
  return result;
}

export function createActionResultMessage<TDataContent = never>(
  request: ActionRequestMessage,
  result: ExecuteActionResult<unknown, TDataContent>,
  options: { outputMessageIndices?: number[] } = {},
): ActionResultMessage<TDataContent> {
  return {
    type: "action",
    kind: "result",
    action: request.action,
    name: request.name,
    callId: request.callId,
    ...(request.target ? { target: request.target } : {}),
    success: result.success,
    ...("value" in result && result.value !== undefined ? { value: result.value } : {}),
    ...(!result.success ? { error: result.error } : {}),
    ...(options.outputMessageIndices?.length ? { outputMessageIndices: options.outputMessageIndices } : {}),
  };
}

export function hasActionOutputMessages<TDataContent = never>(
  messages: readonly FrameMessage<TDataContent>[],
  request: ActionRequestMessage,
): boolean {
  return messages.some((message) =>
    !(message.type === "action" && message.action === request.action && message.callId === request.callId) ||
      (
        message.type === "action" &&
        message.kind === "result" &&
        message.action === request.action &&
        message.callId === request.callId &&
        Array.isArray(message.outputMessageIndices) &&
        message.outputMessageIndices.length > 0
      )
  );
}

export function createActionTerminalMessages<T, TDataContent>(
  request: ActionRequestMessage,
  result: ExecuteActionResult<T, TDataContent>,
  includeRequest: boolean,
): FrameMessage<TDataContent>[] {
  const outputMessages = result.messages ?? [];
  const resultIndex = includeRequest ? 1 : 0;
  const outputStart = resultIndex + 1;
  const outputMessageIndices = outputMessages.map((_, index) => outputStart + index);
  return [
    ...(includeRequest ? [request as FrameMessage<TDataContent>] : []),
    createActionResultMessage(
      request,
      result as ExecuteActionResult<unknown, TDataContent>,
      { outputMessageIndices },
    ),
    ...outputMessages,
  ];
}

function normalizeActionReturn<T, TDataContent>(
  callId: string,
  value: unknown,
): ExecuteActionResult<T, TDataContent> {
  if (isActionResultEnvelope<T, TDataContent>(value)) {
    if (value.success === false) {
      return {
        success: false,
        error: value.error,
        ...(value.value !== undefined ? { value: value.value } : {}),
        ...(value.messages !== undefined ? { messages: value.messages } : {}),
        callId,
      };
    }
    return {
      success: true,
      ...(value.value !== undefined ? { value: value.value } : {}),
      ...(value.messages !== undefined ? { messages: value.messages } : {}),
      callId,
    };
  }

  return {
    success: true,
    value: value as T,
    callId,
  };
}

function actionErrorResult<T, TDataContent>(
  callId: string,
  error: unknown,
): ExecuteActionResult<T, TDataContent> {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    callId,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function",
  );
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
      generatorId: "",
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
  kind: ActionKind,
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

  const actionScope = action.state.scope ?? "hoist";
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
