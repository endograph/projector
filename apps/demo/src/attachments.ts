import type { DemoAttachment } from "./types/display";

export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function isImageContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("image/");
}

export function attachmentKind(contentType: string): DemoAttachment["kind"] {
  return isImageContentType(contentType) ? "image" : "file";
}

export function attachmentSummary(attachments: readonly Pick<DemoAttachment, "name">[]): string {
  return `Attached: ${attachments.map((attachment) => attachment.name).join(", ")}`;
}

export function normalizeFileContentType(file: File): string {
  return file.type || "application/octet-stream";
}
