import type { CompiledProjectionTree } from "@projectors/core";
import type { ClientInstance, MachineClientSnapshot } from "@projectors/core/client";

export type DemoClientInstance = ClientInstance;
export type DemoClientSnapshot = MachineClientSnapshot<DemoClientInstance | null> & {
  projectionTree?: CompiledProjectionTree;
};

export type DemoAttachment = {
  storageId: string;
  url: string | null;
  dataUrl?: string;
  name: string;
  contentType: string;
  size: number;
  kind: "image" | "file";
};

export type DemoMessage = {
  _id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  frameId: string;
  mode?: "text" | "voice";
  attachments?: DemoAttachment[];
};
