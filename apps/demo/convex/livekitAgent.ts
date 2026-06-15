import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { restoreConvexJson, stripClientSchemas } from "./convexJson";
import { createDemoClientSnapshot } from "@projectors/demo-agent/src/projector-demo.js";
import type { MachineSyncState } from "@projectors/core/client";

const DEFAULT_WORKER_LEASE_TTL_MS = 15_000;

export const getSession = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => await ctx.db.get(sessionId),
});

export const upsertAgentWorkerRoom = internalMutation({
  args: { sessionId: v.id("sessions"), roomName: v.string() },
  handler: async (ctx, { sessionId, roomName }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("agentWorkerRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        roomName,
        createdAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("agentWorkerRooms", { sessionId, roomName, createdAt: now });
  },
});

export const getAgentWorkerRoom = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) =>
    await ctx.db.query("agentWorkerRooms").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first(),
});

export const getAgentWorkerStatus = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const room = await ctx.db
      .query("agentWorkerRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (!room) {
      return {
        status: "idle" as const,
        ready: false,
        now: Date.now(),
      };
    }

    const now = Date.now();
    const leaseExpiresAt = room.agentWorkerLeaseExpiresAt ?? 0;
    const ready = leaseExpiresAt > now;
    const lockExpiresAt = room.agentDispatchLockExpiresAt ?? 0;
    const nextDispatchAt = room.agentNextDispatchAt ?? 0;
    const hasDispatch = Boolean(room.agentDispatchId);
    const waitingForDispatch = !ready && hasDispatch && now < nextDispatchAt;

    const status = ready
      ? "ready"
      : lockExpiresAt > now
        ? "connecting"
        : waitingForDispatch
          ? "reconnecting"
          : hasDispatch || room.agentReconnectAttempt
            ? "stale"
            : "idle";

    return {
      status,
      ready,
      now,
      sessionId: room.sessionId,
      roomName: room.roomName,
      agentDispatchId: room.agentDispatchId,
      agentDispatchCreatedAt: room.agentDispatchCreatedAt,
      agentDispatchLockExpiresAt: room.agentDispatchLockExpiresAt,
      agentReconnectAttempt: room.agentReconnectAttempt ?? 0,
      agentNextDispatchAt: room.agentNextDispatchAt,
      agentLastDispatchError: room.agentLastDispatchError,
      agentLastStatusAt: room.agentLastStatusAt,
      agentWorkerId: room.agentWorkerId,
      agentWorkerHeartbeatAt: room.agentWorkerHeartbeatAt,
      agentWorkerLeaseExpiresAt: room.agentWorkerLeaseExpiresAt,
    };
  },
});

export const getSessionIdByRoom = query({
  args: { roomName: v.string() },
  handler: async (ctx, { roomName }) => {
    const room = await ctx.db.query("agentWorkerRooms").withIndex("by_room", (q) => q.eq("roomName", roomName)).first();
    return room?.sessionId ?? null;
  },
});

export const getAgentInit = query({
  args: { roomName: v.string() },
  handler: async (ctx, { roomName }) => {
    const room = await ctx.db.query("agentWorkerRooms").withIndex("by_room", (q) => q.eq("roomName", roomName)).first();
    if (!room) return null;

    const session = await ctx.db.get(room.sessionId);
    if (!session?.headFrameId) return null;

    const logs = await ctx.db
      .query("projectorInstanceLog")
      .withIndex("by_session", (q) => q.eq("sessionId", room.sessionId))
      .collect();
    const ancestors = new Set(session.branchAncestors ?? [session.headFrameId]);
    const latestLog = logs
      .filter((entry) => !entry.frameId || ancestors.has(entry.frameId))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latestLog) return null;

    const instance = restoreConvexJson(latestLog.instance);
    const syncState = restoreConvexJson(
      session.syncState ?? { recentCommandResidue: [] },
    ) as MachineSyncState;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", room.sessionId))
      .collect();

    return {
      sessionId: room.sessionId,
      instance,
      instanceFrameId: latestLog.frameId,
      clientSnapshot: stripClientSchemas(createDemoClientSnapshot(instance, syncState)),
      syncState,
      messages,
    };
  },
});

export const claimAgentDispatchLock = internalMutation({
  args: { sessionId: v.id("sessions"), lockTtlMs: v.optional(v.number()) },
  handler: async (ctx, { sessionId, lockTtlMs }) => {
    const room = await ctx.db
      .query("agentWorkerRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (!room) return null;

    const now = Date.now();
    const expiresAt = room.agentDispatchLockExpiresAt ?? 0;
    if (expiresAt > now) return null;

    await ctx.db.patch(room._id, { agentDispatchLockExpiresAt: now + (lockTtlMs ?? 20_000) });
    return {
      agentWorkerRoomId: room._id,
      roomName: room.roomName,
      agentDispatchId: room.agentDispatchId ?? null,
      agentDispatchCreatedAt: room.agentDispatchCreatedAt ?? null,
      agentReconnectAttempt: room.agentReconnectAttempt ?? 0,
    };
  },
});

export const hasLiveAgentWorkerLease = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const room = await ctx.db
      .query("agentWorkerRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    return (room?.agentWorkerLeaseExpiresAt ?? 0) > Date.now();
  },
});

export const getAgentDispatchSnapshot = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const room = await ctx.db
      .query("agentWorkerRooms")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (!room) return null;

    const now = Date.now();
    return {
      agentWorkerRoomId: room._id,
      roomName: room.roomName,
      hasLiveWorkerLease: (room.agentWorkerLeaseExpiresAt ?? 0) > now,
      agentDispatchId: room.agentDispatchId ?? null,
      agentDispatchCreatedAt: room.agentDispatchCreatedAt ?? null,
      agentNextDispatchAt: room.agentNextDispatchAt ?? null,
      agentReconnectAttempt: room.agentReconnectAttempt ?? 0,
    };
  },
});

export const claimAgentWorkerLease = mutation({
  args: {
    roomName: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    leaseTtlMs: v.optional(v.number()),
  },
  handler: async (ctx, { roomName, workerId, leaseToken, leaseTtlMs }) => {
    const room = await ctx.db.query("agentWorkerRooms").withIndex("by_room", (q) => q.eq("roomName", roomName)).first();
    if (!room) return null;

    const now = Date.now();
    const expiresAt = room.agentWorkerLeaseExpiresAt ?? 0;
    if (expiresAt > now && room.agentWorkerLeaseToken !== leaseToken) {
      return null;
    }

    await ctx.db.patch(room._id, {
      agentWorkerId: workerId,
      agentWorkerLeaseToken: leaseToken,
      agentWorkerLeaseExpiresAt: now + (leaseTtlMs ?? 15_000),
      agentWorkerHeartbeatAt: now,
      agentReconnectAttempt: 0,
      agentNextDispatchAt: 0,
      agentLastDispatchError: undefined,
      agentLastStatusAt: now,
    });

    return {
      agentWorkerRoomId: room._id,
      sessionId: room.sessionId,
      roomName: room.roomName,
    };
  },
});

export const renewAgentWorkerLease = mutation({
  args: {
    roomName: v.string(),
    leaseToken: v.string(),
    leaseTtlMs: v.optional(v.number()),
  },
  handler: async (ctx, { roomName, leaseToken, leaseTtlMs }) => {
    const room = await ctx.db.query("agentWorkerRooms").withIndex("by_room", (q) => q.eq("roomName", roomName)).first();
    if (!room || room.agentWorkerLeaseToken !== leaseToken) return false;

    const now = Date.now();
    if ((room.agentWorkerLeaseExpiresAt ?? 0) <= now) return false;

    await ctx.db.patch(room._id, {
      agentWorkerLeaseExpiresAt: now + (leaseTtlMs ?? DEFAULT_WORKER_LEASE_TTL_MS),
      agentWorkerHeartbeatAt: now,
      agentLastStatusAt: now,
    });
    return true;
  },
});

export const releaseAgentWorkerLease = mutation({
  args: {
    roomName: v.string(),
    leaseToken: v.string(),
  },
  handler: async (ctx, { roomName, leaseToken }) => {
    const room = await ctx.db.query("agentWorkerRooms").withIndex("by_room", (q) => q.eq("roomName", roomName)).first();
    if (!room || room.agentWorkerLeaseToken !== leaseToken) return false;

    await ctx.db.patch(room._id, {
      agentWorkerId: undefined,
      agentWorkerLeaseToken: undefined,
      agentWorkerLeaseExpiresAt: 0,
      agentWorkerHeartbeatAt: Date.now(),
      agentLastStatusAt: Date.now(),
    });
    return true;
  },
});

export const releaseAgentDispatchLock = internalMutation({
  args: { agentWorkerRoomId: v.id("agentWorkerRooms") },
  handler: async (ctx, { agentWorkerRoomId }) => {
    await ctx.db.patch(agentWorkerRoomId, { agentDispatchLockExpiresAt: 0 });
  },
});

export const recordAgentDispatch = internalMutation({
  args: {
    agentWorkerRoomId: v.id("agentWorkerRooms"),
    agentDispatchId: v.string(),
    agentDispatchCreatedAt: v.number(),
    nextDispatchAt: v.optional(v.number()),
    reconnectAttempt: v.optional(v.number()),
  },
  handler: async (ctx, { agentWorkerRoomId, agentDispatchId, agentDispatchCreatedAt, nextDispatchAt, reconnectAttempt }) => {
    await ctx.db.patch(agentWorkerRoomId, {
      agentDispatchId,
      agentDispatchCreatedAt,
      agentNextDispatchAt: nextDispatchAt ?? agentDispatchCreatedAt,
      agentReconnectAttempt: reconnectAttempt ?? 0,
      agentLastDispatchError: undefined,
      agentLastStatusAt: Date.now(),
    });
  },
});

export const recordAgentDispatchFailure = internalMutation({
  args: {
    agentWorkerRoomId: v.id("agentWorkerRooms"),
    error: v.string(),
    nextDispatchAt: v.number(),
    reconnectAttempt: v.number(),
  },
  handler: async (ctx, { agentWorkerRoomId, error, nextDispatchAt, reconnectAttempt }) => {
    await ctx.db.patch(agentWorkerRoomId, {
      agentLastDispatchError: error,
      agentNextDispatchAt: nextDispatchAt,
      agentReconnectAttempt: reconnectAttempt,
      agentLastStatusAt: Date.now(),
    });
  },
});

export const clearAgentDispatch = internalMutation({
  args: { agentWorkerRoomId: v.id("agentWorkerRooms") },
  handler: async (ctx, { agentWorkerRoomId }) => {
    await ctx.db.patch(agentWorkerRoomId, {
      agentDispatchId: undefined,
      agentDispatchCreatedAt: undefined,
      agentLastStatusAt: Date.now(),
    });
  },
});
