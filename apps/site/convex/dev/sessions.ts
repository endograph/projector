import { v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import type { SerializedInstance } from "@projectors/core";
import { createSiteClientSnapshot } from "../../src/agent/charter";
import { query } from "../_generated/server";
import { restoreConvexJson, stripClientSchemas } from "../convexJson";
import { requireAdmin } from "./access";

const adminSessionValidator = v.object({
  id: v.id("sessions"),
  title: v.string(),
  createdAt: v.number(),
  lastActivityAt: v.number(),
  messageCount: v.number(),
  artifactCount: v.number(),
  ownerGithubLogin: v.optional(v.string()),
});

export const listAll = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(adminSessionValidator),
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);

    const result = await ctx.db
      .query("sessionEphemera")
      .withIndex("by_last_activity_at")
      .order("desc")
      .paginate(paginationOpts);
    const sessions = await Promise.all(
      result.page.map((ephemera) => ctx.db.get(ephemera.sessionId)),
    );
    const owners = await Promise.all(
      sessions.map((session) =>
        session?.ownerUserId ? ctx.db.get(session.ownerUserId) : null,
      ),
    );

    return {
      ...result,
      page: result.page.flatMap((ephemera, index) => {
        const session = sessions[index];
        if (!session) return [];
        return [{
          id: session._id,
          title: session.title?.trim() || "untitled conversation",
          createdAt: session._creationTime,
          lastActivityAt: ephemera.lastActivityAt,
          messageCount: ephemera.messageCount,
          artifactCount: ephemera.artifactCount,
          ...(owners[index]?.name ? { ownerGithubLogin: owners[index].name } : {}),
        }];
      }),
    };
  },
});

export const instanceTree = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { sessionId }) => {
    await requireAdmin(ctx);

    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const latest = await ctx.db
      .query("projectorInstanceLog")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    if (!latest) return null;

    const serialized = restoreConvexJson(latest.instance) as SerializedInstance;
    return stripClientSchemas(createSiteClientSnapshot(serialized).instance);
  },
});
