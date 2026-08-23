import { v } from "convex/values";
import { getSurfaceArtifact, readAppSurfaceSelection } from "../artifacts";
import { restoreConvexJson } from "../convexJson";
import { mutation, query } from "../_generated/server";

const historyEntryValidator = v.object({
  version: v.number(),
  title: v.string(),
  createdAt: v.number(),
  frameId: v.optional(v.id("frames")),
});

export const history = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      activeVersion: v.union(v.null(), v.number()),
      latestVersion: v.union(v.null(), v.number()),
      artifacts: v.array(historyEntryValidator),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const [latestInstance, artifacts] = await Promise.all([
      ctx.db
        .query("projectorInstanceLog")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .order("desc")
        .first(),
      ctx.db
        .query("artifacts")
        .withIndex("by_session_kind_version", (q) =>
          q.eq("sessionId", sessionId).eq("kind", "surface"),
        )
        .order("desc")
        .take(50),
    ]);
    const selection = latestInstance
      ? readAppSurfaceSelection(restoreConvexJson(latestInstance.instance))
      : null;

    return {
      activeVersion: session.activeSurfaceVersion ?? selection?.activeVersion ?? null,
      latestVersion: artifacts[0]?.version ?? selection?.latestVersion ?? null,
      artifacts: artifacts.map((artifact) => ({
        version: artifact.version,
        title: artifact.title,
        createdAt: artifact.createdAt,
        ...(artifact.frameId !== undefined ? { frameId: artifact.frameId } : {}),
      })),
    };
  },
});

export const activate = mutation({
  args: { sessionId: v.id("sessions"), version: v.number() },
  returns: v.null(),
  handler: async (ctx, { sessionId, version }) => {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("Artifact version must be a positive integer");
    }
    if (!(await getSurfaceArtifact(ctx, sessionId, version))) {
      throw new Error(`Surface artifact v${version} not found`);
    }

    await ctx.db.patch(sessionId, { activeSurfaceVersion: version });
    return null;
  },
});
