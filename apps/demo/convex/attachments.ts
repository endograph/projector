import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  attachmentSummary,
  storedAttachmentsFromContentParts as storedAttachmentsFromContentPartsBase,
  userContentPartsForAttachments,
} from "@projectors/demo-agent/src/attachments.js";

export const attachmentValidator = v.object({
  storageId: v.id("_storage"),
  name: v.string(),
  contentType: v.string(),
  size: v.number(),
  kind: v.union(v.literal("image"), v.literal("file")),
});

export type StoredDemoAttachment = {
  storageId: Id<"_storage">;
  name: string;
  contentType: string;
  size: number;
  kind: "image" | "file";
};

export type ResolvedDemoAttachment = StoredDemoAttachment & {
  url: string | null;
};

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const resolveUrls = query({
  args: {
    attachments: v.array(attachmentValidator),
  },
  handler: async (ctx, { attachments }) => {
    return await resolveAttachmentUrls(ctx, attachments) ?? [];
  },
});

export function normalizeAttachment(attachment: StoredDemoAttachment): StoredDemoAttachment {
  return {
    storageId: attachment.storageId,
    name: attachment.name,
    contentType: attachment.contentType || "application/octet-stream",
    size: attachment.size,
    kind: attachment.kind === "image" ? "image" : "file",
  };
}

export async function resolveAttachmentUrls(
  ctx: { storage: { getUrl(storageId: Id<"_storage">): Promise<string | null> } },
  attachments: readonly StoredDemoAttachment[] | undefined,
): Promise<ResolvedDemoAttachment[] | undefined> {
  if (!attachments?.length) return undefined;
  return await Promise.all(
    attachments.map(async (attachment) => ({
      ...normalizeAttachment(attachment),
      url: await ctx.storage.getUrl(attachment.storageId),
    })),
  );
}

export function userContentPartsForFrame(
  content: string,
  attachments: readonly ResolvedDemoAttachment[],
): ReturnType<typeof userContentPartsForAttachments> {
  return userContentPartsForAttachments(
    content,
    attachments.map((attachment) => ({
      storageId: attachment.storageId,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      kind: attachment.kind,
      url: attachment.url,
    })),
  );
}

export function storedAttachmentsFromContentParts(
  parts: Parameters<typeof storedAttachmentsFromContentPartsBase>[0],
): StoredDemoAttachment[] {
  return storedAttachmentsFromContentPartsBase(parts).map((attachment) => ({
    ...attachment,
    storageId: attachment.storageId as Id<"_storage">,
  }));
}

export { attachmentSummary };
