import type { CompiledProjectionTree } from "@projectors/core";
import type { ClientInstance, MachineClientSnapshot } from "@projectors/core/client";

export type SandboxClientInstance = ClientInstance;
export type SandboxClientSnapshot = MachineClientSnapshot<SandboxClientInstance | null> & {
  projectionTree?: CompiledProjectionTree;
};

export type SandboxAttachment = {
  storageId: string;
  url: string | null;
  dataUrl?: string;
  name: string;
  contentType: string;
  size: number;
  kind: "image" | "file";
};

export type SandboxMessage = {
  _id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  frameId: string;
  mode?: "text" | "voice";
  attachments?: SandboxAttachment[];
};
