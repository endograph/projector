import type {
  HistoryProjectionFunction,
  HistoryProjectionFunctionMethod,
  ProjectionFunction,
  ProjectionFunctionMethod,
} from "./types.ts";

export function createProjectionFunction<
  TDataContent = never,
>(config: {
  name: string;
  method: ProjectionFunctionMethod<TDataContent>;
}): ProjectionFunction<TDataContent> {
  if (!config.name.trim()) {
    throw new Error("Projection function requires a name");
  }
  return {
    kind: "projection",
    name: config.name,
    method: config.method,
  };
}

export function createHistoryProjectionFunction<
  TDataContent = never,
>(config: {
  name: string;
  method: HistoryProjectionFunctionMethod<TDataContent>;
}): HistoryProjectionFunction<TDataContent> {
  if (!config.name.trim()) {
    throw new Error("History projection function requires a name");
  }
  return {
    kind: "historyProjection",
    name: config.name,
    method: config.method,
  };
}

export function isProjectionFunction<
  TDataContent = never,
>(
  value: unknown,
): value is ProjectionFunction<TDataContent> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "projection" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { method?: unknown }).method === "function",
  );
}

export function isHistoryProjectionFunction<
  TDataContent = never,
>(
  value: unknown,
): value is HistoryProjectionFunction<TDataContent> {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "historyProjection" &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { method?: unknown }).method === "function",
  );
}
