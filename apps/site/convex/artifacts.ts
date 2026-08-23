// Generative UI artifacts: immutable, versioned rows holding agent-authored
// TSX. writeAppSurface commits the artifact inside the tool call and returns
// success only after this durable mutation completes. State-schema evolution
// can therefore never lose a surface, and an LLM-led migration only has to
// walk this table.

import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { restoreConvexJson } from "./convexJson";
import { siteCharter } from "../src/agent/charter";
import { recordSessionArtifacts } from "./sessionEphemera";
import { assertRunnerLease } from "./runnerShared";

type DbCtx = MutationCtx | QueryCtx;

export type SurfaceArtifact = { version: number; title: string; source: string };

const surfaceValidator = v.object({
  version: v.number(),
  title: v.string(),
  source: v.string(),
});

const agentArtifactValidator = v.object({
  id: v.id("artifacts"),
  kind: v.literal("surface"),
  version: v.number(),
  title: v.string(),
  source: v.string(),
  frameId: v.optional(v.id("frames")),
  charterVersion: v.optional(v.string()),
  createdAt: v.number(),
});

const agentArtifactPageValidator = v.object({
  session: v.union(
    v.null(),
    v.object({
      id: v.id("sessions"),
      title: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
  artifacts: v.union(v.null(), paginationResultValidator(agentArtifactValidator)),
});

export async function getLatestSurfaceArtifact(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"artifacts"> | null> {
  return await ctx.db
    .query("artifacts")
    .withIndex("by_session_kind_version", (q) =>
      q.eq("sessionId", sessionId).eq("kind", "surface"),
    )
    .order("desc")
    .first();
}

export async function getSurfaceArtifact(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  version: number,
): Promise<Doc<"artifacts"> | null> {
  return await ctx.db
    .query("artifacts")
    .withIndex("by_session_kind_version", (q) =>
      q.eq("sessionId", sessionId).eq("kind", "surface").eq("version", version),
    )
    .unique();
}

export function readAppSurfaceSelection(serialized: unknown): {
  latestVersion: number;
  activeVersion: number | null;
} | null {
  const instance = serialized as {
    states?: Record<string, { value?: unknown }>;
    children?: unknown[];
  } | null;
  if (!instance || typeof instance !== "object") return null;

  const value = instance.states?.appSurface?.value as
    | { version?: unknown; activeVersion?: unknown }
    | undefined;
  if (typeof value?.version === "number") {
    return {
      latestVersion: value.version,
      activeVersion:
        typeof value.activeVersion === "number" ? value.activeVersion : value.version || null,
    };
  }

  for (const child of instance.children ?? []) {
    const found = readAppSurfaceSelection(child);
    if (found) return found;
  }
  return null;
}

export async function getActiveSurfaceArtifact(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"artifacts"> | null> {
  const session = await ctx.db.get(sessionId);
  if (session?.activeSurfaceVersion !== undefined) {
    return await getSurfaceArtifact(ctx, sessionId, session.activeSurfaceVersion);
  }

  const latestInstance = await ctx.db
    .query("projectorInstanceLog")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .first();
  const selection = latestInstance
    ? readAppSurfaceSelection(restoreConvexJson(latestInstance.instance))
    : null;
  return selection?.activeVersion
    ? await getSurfaceArtifact(ctx, sessionId, selection.activeVersion)
    : await getLatestSurfaceArtifact(ctx, sessionId);
}

export const activeSurfaceSource = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.union(v.null(), surfaceValidator),
  handler: async (ctx, { sessionId }) => {
    const artifact = await getActiveSurfaceArtifact(ctx, sessionId);
    return artifact
      ? { version: artifact.version, title: artifact.title, source: artifact.source }
      : null;
  },
});

// The write itself is the tool side effect. The AI SDK tool call id makes it
// idempotent across runner retries; a mutation failure throws through the tool
// invocation, so no successful tool result is emitted.
export const writeSurface = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    generation: v.number(),
    callId: v.string(),
    title: v.string(),
    source: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, { sessionId, generation, callId, title, source }) => {
    await assertRunnerLease(ctx, sessionId, generation);
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_session_and_call_id", (q) =>
        q.eq("sessionId", sessionId).eq("callId", callId),
      )
      .unique();
    if (existing) {
      if (existing.title !== title || existing.source !== source) {
        throw new Error("Tool call id was reused with different surface input");
      }
      return { version: existing.version };
    }

    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    const latest = await getLatestSurfaceArtifact(ctx, sessionId);
    const version = (latest?.version ?? 0) + 1;
    await ctx.db.insert("artifacts", {
      sessionId,
      kind: "surface",
      version,
      title,
      source,
      callId,
      charterVersion: siteCharter.version,
      createdAt: Date.now(),
    });
    await ctx.db.patch(sessionId, { activeSurfaceVersion: version });
    await recordSessionArtifacts(ctx, sessionId, 1);
    return { version };
  },
});

// Agent-only reader for artifacts belonging to a known public session. Newest
// versions come first; callers can continue with the returned opaque cursor.
export const pageForAgent = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    paginationOpts: paginationOptsValidator,
  },
  returns: agentArtifactPageValidator,
  handler: async (ctx, { sessionId, paginationOpts }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return { session: null, artifacts: null };

    const artifactPage = await ctx.db
      .query("artifacts")
      .withIndex("by_session_kind_version", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .paginate(paginationOpts);
    return {
      session: {
        id: session._id,
        ...(session.title !== undefined ? { title: session.title } : {}),
        createdAt: session._creationTime,
      },
      artifacts: {
        ...artifactPage,
        page: artifactPage.page.map((artifact) => ({
          id: artifact._id,
          kind: artifact.kind,
          version: artifact.version,
          title: artifact.title,
          source: artifact.source,
          ...(artifact.frameId !== undefined ? { frameId: artifact.frameId } : {}),
          ...(artifact.charterVersion !== undefined
            ? { charterVersion: artifact.charterVersion }
            : {}),
          createdAt: artifact.createdAt,
        })),
      },
    };
  },
});

type FrameEntry = { frameId?: Id<"frames">; messages: readonly unknown[] };
type SurfaceWrite = {
  title: string;
  source: string;
  version?: number;
  frameId?: Id<"frames">;
};

// The machine emits one message per frame, so a writeAppSurface's request,
// its state.update (which stamps the version), and its result land in
// SEPARATE frames — pairing must happen across the whole appended sequence,
// never per frame. Versions pair with writes positionally, and only when the
// counts agree (a failed write can leave a stray state.update behind).
export function collectSurfaceWrites(entries: readonly FrameEntry[]): SurfaceWrite[] {
  const requests = new Map<string, { title: string; source: string }>();
  const results: Array<{ callId: string; frameId?: Id<"frames"> }> = [];
  const versions: number[] = [];

  for (const { frameId, messages } of entries) {
    for (const raw of messages) {
      const message = raw as Record<string, unknown>;
      if (message.type === "action" && message.name === "writeAppSurface") {
        if (message.kind === "request" && typeof message.callId === "string") {
          const input = message.input as { title?: unknown; source?: unknown } | undefined;
          if (typeof input?.title === "string" && typeof input?.source === "string") {
            requests.set(message.callId, { title: input.title, source: input.source });
          }
        }
        if (
          message.kind === "result" &&
          message.success === true &&
          typeof message.callId === "string"
        ) {
          results.push({ callId: message.callId, frameId });
        }
      }
      if (
        message.type === "instance" &&
        message.kind === "state.update" &&
        message.stateKey === "appSurface"
      ) {
        const update = message.update as { value?: { version?: unknown } } | undefined;
        if (typeof update?.value?.version === "number") versions.push(update.value.version);
      }
    }
  }

  const writes: SurfaceWrite[] = [];
  for (const result of results) {
    const request = requests.get(result.callId);
    if (request) writes.push({ ...request, frameId: result.frameId });
  }
  if (versions.length === writes.length) {
    for (const [index, write] of writes.entries()) write.version = versions[index];
  }
  return writes;
}

export async function recordSurfaceArtifacts(
  ctx: MutationCtx,
  {
    sessionId,
    entries,
  }: {
    sessionId: Id<"sessions">;
    entries: readonly FrameEntry[];
  },
): Promise<void> {
  const writes = collectSurfaceWrites(entries);
  if (writes.length === 0) return;

  const latest = await getLatestSurfaceArtifact(ctx, sessionId);
  let fallbackVersion = latest?.version ?? 0;
  let activeVersion: number | undefined;
  let insertedCount = 0;
  for (const write of writes) {
    const version = write.version ?? ++fallbackVersion;
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_session_kind_version", (q) =>
        q.eq("sessionId", sessionId).eq("kind", "surface").eq("version", version),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("artifacts", {
      sessionId,
      kind: "surface",
      version,
      title: write.title,
      source: write.source,
      ...(write.frameId !== undefined ? { frameId: write.frameId } : {}),
      charterVersion: siteCharter.version,
      createdAt: Date.now(),
    });
    insertedCount += 1;
    activeVersion = version;
  }
  if (activeVersion !== undefined) {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    await ctx.db.patch(sessionId, {
      activeSurfaceVersion: activeVersion,
    });
    await recordSessionArtifacts(ctx, sessionId, insertedCount);
  }
}

// Sessions written before the artifacts table kept the source in the (now
// removed) appSurfaceSource machine state. Their latest instance snapshots
// still carry that container as raw JSON; read it straight off the serialized
// tree so old surfaces keep rendering without a backfill.
export function readLegacySurface(serialized: unknown): SurfaceArtifact | null {
  const instance = serialized as {
    states?: Record<string, { value?: unknown }>;
    children?: unknown[];
  } | null;
  if (!instance || typeof instance !== "object") return null;

  const sourceValue = instance.states?.appSurfaceSource?.value as
    | { source?: unknown }
    | undefined;
  if (typeof sourceValue?.source === "string" && sourceValue.source) {
    const meta = instance.states?.appSurface?.value as
      | { version?: unknown; title?: unknown }
      | undefined;
    return {
      version: typeof meta?.version === "number" ? meta.version : 1,
      title: typeof meta?.title === "string" ? meta.title : "",
      source: sourceValue.source,
    };
  }

  for (const child of instance.children ?? []) {
    const found = readLegacySurface(child);
    if (found) return found;
  }
  return null;
}

// One-shot recovery: replay every session's frame log through the same
// collector the live path uses (recovering full version history — the
// request inputs carry the source), then fall back to the legacy in-state
// snapshot for anything the frames didn't yield. Idempotent: existing
// (session, version) rows are kept. Run with
// `npx convex run artifacts:backfillSurfaceArtifacts`.
export const backfillSurfaceArtifacts = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const sessions = await ctx.db.query("sessions").take(1000);
    let created = 0;
    for (const session of sessions) {
      const before = await countSurfaceArtifacts(ctx, session._id);

      const indexRows = await ctx.db
        .query("frameIndex")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .take(2000);
      const entries: FrameEntry[] = [];
      for (const row of indexRows) {
        const frame = await ctx.db.get(row.frameId);
        if (!frame) continue;
        entries.push({
          frameId: frame._id,
          messages: restoreConvexJson(frame.messages) as unknown[],
        });
      }
      await recordSurfaceArtifacts(ctx, { sessionId: session._id, entries });

      if ((await countSurfaceArtifacts(ctx, session._id)) === 0) {
        const logs = await ctx.db
          .query("projectorInstanceLog")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .order("desc")
          .take(20);
        const legacy = logs
          .map((log) => readLegacySurface(restoreConvexJson(log.instance)))
          .find((surface) => surface !== null);
        if (legacy) {
          await ctx.db.insert("artifacts", {
            sessionId: session._id,
            kind: "surface",
            version: legacy.version,
            title: legacy.title,
            source: legacy.source,
            createdAt: Date.now(),
          });
          await recordSessionArtifacts(ctx, session._id, 1);
        }
      }

      created += (await countSurfaceArtifacts(ctx, session._id)) - before;
    }
    return created;
  },
});

async function countSurfaceArtifacts(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<number> {
  const rows = await ctx.db
    .query("artifacts")
    .withIndex("by_session_kind_version", (q) =>
      q.eq("sessionId", sessionId).eq("kind", "surface"),
    )
    .take(500);
  return rows.length;
}
