import type {
  CommandMeta,
  DryClientPack,
  JSONSchema,
  SerializedSuspendInfo,
  StandardNodeConfig,
} from "markov-machines/client";

export type DisplayCommand = CommandMeta;
export type DisplayPack = DryClientPack;

export interface DisplayNode {
  name: string;
  instructions: string;
  validator: JSONSchema;
  tools: string[];
  transitions: Record<string, string>;
  commands: Record<string, DisplayCommand>;
  initialState?: unknown;
  packNames?: string[];
  worker?: boolean;
}

export interface DisplayInstance {
  id: string;
  node: DisplayNode;
  state: unknown;
  children?: DisplayInstance[];
  packs?: DisplayPack[];
  executorConfig?: StandardNodeConfig;
  suspended?: SerializedSuspendInfo;
}
