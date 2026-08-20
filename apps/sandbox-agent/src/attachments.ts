import {
  dataContent,
  imageContent,
  textContent,
  type ContentPart,
} from "@projectors/core";

export type SandboxAttachmentKind = "image" | "file";

export type SandboxAttachmentData = {
  storageId: string;
  name: string;
  contentType: string;
  size: number;
  kind: SandboxAttachmentKind;
  url: string | null;
  dataUrl?: string;
};

export type StoredSandboxAttachmentData = Omit<SandboxAttachmentData, "url" | "dataUrl">;

export function attachmentSummary(attachments: readonly Pick<StoredSandboxAttachmentData, "name">[]): string {
  return `Attached: ${attachments.map((attachment) => attachment.name).join(", ")}`;
}

export function userContentPartsForAttachments(
  content: string,
  attachments: readonly SandboxAttachmentData[],
): ContentPart<SandboxAttachmentData>[] {
  const parts: ContentPart<SandboxAttachmentData>[] = [];
  const trimmed = content.trim();
  if (trimmed) parts.push(textContent(trimmed));
  for (const attachment of attachments) {
    const { dataUrl: _dataUrl, ...attachmentMetadata } = attachment;
    parts.push(dataContent(attachmentMetadata, { label: "Attachment" }));
    const imageData = attachment.kind === "image" ? attachment.dataUrl ?? attachment.url : null;
    if (imageData) {
      parts.push(imageContent(imageData, {
        mediaType: attachment.contentType,
        label: attachment.name,
      }));
    }
  }
  return parts;
}

export function storedAttachmentsFromContentParts(
  parts: readonly ContentPart<SandboxAttachmentData>[] | undefined,
): StoredSandboxAttachmentData[] {
  if (!parts?.length) return [];
  const attachments: StoredSandboxAttachmentData[] = [];
  for (const part of parts) {
    if (part.type !== "data" || part.label !== "Attachment") continue;
    const attachment = normalizeAttachmentData(part.data);
    if (!attachment) continue;
    attachments.push({
      storageId: attachment.storageId,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      kind: attachment.kind,
    });
  }
  return attachments;
}

export function normalizeAttachmentData(value: unknown): SandboxAttachmentData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.storageId !== "string" ||
    typeof record.name !== "string" ||
    typeof record.contentType !== "string" ||
    typeof record.size !== "number"
  ) {
    return undefined;
  }
  return {
    storageId: record.storageId,
    name: record.name,
    contentType: record.contentType,
    size: record.size,
    kind: record.kind === "image" ? "image" : "file",
    url: typeof record.url === "string" && record.url ? record.url : null,
    ...(typeof record.dataUrl === "string" && record.dataUrl.startsWith("data:image/")
      ? { dataUrl: record.dataUrl }
      : {}),
  };
}
