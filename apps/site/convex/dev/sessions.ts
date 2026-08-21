import { v } from "convex/values";
import type { SerializedInstance } from "@projectors/core";
import { createSiteClientSnapshot } from "../../src/agent/charter";
import { query } from "../_generated/server";
import { restoreConvexJson, stripClientSchemas } from "../convexJson";
import { requireAdmin } from "./access";

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
