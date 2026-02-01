import type { JSONSchema } from "./refs.js";
import type { SerializedSuspendInfo } from "./machine.js";
import type { StandardNodeConfig } from "../executor/types.js";

export interface DisplayCommand {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DisplayPack {
  name: string;
  description: string;
  state: unknown;
  validator: Record<string, unknown>;
  commands: Record<string, DisplayCommand>;
}

export interface DisplayNode {
  name: string;
  instructions: string;
  validator: JSONSchema;
  tools: string[];
  transitions: Record<string, string>;
  commands: Record<string, DisplayCommand>;
  initialState?: unknown;
  packNames?: string[];
  packs?: DisplayPack[];
  worker?: boolean;
}

export interface DisplayInstance {
  id: string;
  node: DisplayNode;
  state: unknown;
  children?: DisplayInstance[];
  packs?: DisplayPack[];
  packStates?: Record<string, unknown>;
  executorConfig?: StandardNodeConfig;
  suspended?: SerializedSuspendInfo;
}
