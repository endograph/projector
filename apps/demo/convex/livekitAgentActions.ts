"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ParticipantInfo_Kind } from "@livekit/protocol";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";

const AGENT_NAME = "demo-agent";
const DISPATCH_LOCK_TTL_MS = 20_000;
const DISPATCH_STALE_GRACE_MS = 10_000;
const DISPATCH_BACKOFF_BASE_MS = DISPATCH_STALE_GRACE_MS;
const DISPATCH_BACKOFF_MAX_MS = 60_000;

type ListedAgentDispatch = Awaited<ReturnType<AgentDispatchClient["listDispatch"]>>[number];
type ListedParticipant = Awaited<ReturnType<RoomServiceClient["listParticipants"]>>[number];

export const getToken = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }): Promise<{ token: string; roomName: string; url: string }> => {
    const session = await ctx.runQuery(internal.livekitAgent.getSession, { sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
      throw new Error("LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL are required");
    }

    const roomName = `demo-${sessionId}`;
    const token = new AccessToken(apiKey, apiSecret, {
      identity: `user-${sessionId}-${crypto.randomUUID()}`,
      ttl: "15m",
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    await ctx.runMutation(internal.livekitAgent.upsertAgentWorkerRoom, { sessionId, roomName });
    await ensureAgentDispatchedImpl(ctx, {
      apiKey,
      apiSecret,
      liveKitUrl: url,
      sessionId,
      roomName,
      reason: "token_request",
    });

    return {
      token: await token.toJwt(),
      roomName,
      url,
    };
  },
});

export const ensureAgentDispatched = action({
  args: { sessionId: v.id("sessions"), reason: v.optional(v.string()) },
  handler: async (ctx, { sessionId, reason }): Promise<void> => {
    const session = await ctx.runQuery(internal.livekitAgent.getSession, { sessionId });
    if (!session) throw new Error("Session not found");

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
      throw new Error("LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL are required");
    }

    const roomName = `demo-${sessionId}`;
    await ctx.runMutation(internal.livekitAgent.upsertAgentWorkerRoom, { sessionId, roomName });
    await ensureAgentDispatchedImpl(ctx, {
      apiKey,
      apiSecret,
      liveKitUrl: url,
      sessionId,
      roomName,
      reason: reason ?? "reconcile",
    });
  },
});

async function ensureAgentDispatchedImpl(
  ctx: any,
  {
    apiKey,
    apiSecret,
    liveKitUrl,
    sessionId,
    roomName,
    reason,
  }: {
    apiKey: string;
    apiSecret: string;
    liveKitUrl: string;
    sessionId: string;
    roomName: string;
    reason: string;
  },
): Promise<void> {
  const snapshot = await ctx.runQuery(internal.livekitAgent.getAgentDispatchSnapshot, { sessionId });
  const now = Date.now();
  if (!snapshot?.hasLiveWorkerLease && snapshot?.agentNextDispatchAt && snapshot.agentNextDispatchAt > now) {
    return;
  }

  const lock = await ctx.runMutation(internal.livekitAgent.claimAgentDispatchLock, {
    sessionId,
    lockTtlMs: DISPATCH_LOCK_TTL_MS,
  });
  if (!lock) return;

  try {
    const hasLiveWorkerAfterLock = await ctx.runQuery(internal.livekitAgent.hasLiveAgentWorkerLease, { sessionId });

    const now = Date.now();
    const httpUrl = liveKitUrl.replace("wss://", "https://").replace("ws://", "http://");
    const dispatchClient = new AgentDispatchClient(httpUrl, apiKey, apiSecret);
    const roomService = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    let activeDispatches = await listActiveDispatches(dispatchClient, roomName);
    activeDispatches = await dedupeActiveDispatches(dispatchClient, roomName, activeDispatches);

    if (hasLiveWorkerAfterLock) {
      await removeDuplicateAgentParticipants(roomService, roomName, activeDispatches);
      return;
    }

    const { hasAgent, removedAgent } = await reconcileAgentParticipants(roomService, roomName, now, lock.agentDispatchCreatedAt, activeDispatches);

    if (activeDispatches.length > 0) {
      const dispatchAgeMs = lock.agentDispatchCreatedAt ? now - lock.agentDispatchCreatedAt : Number.POSITIVE_INFINITY;
      if (hasAgent && !removedAgent) {
        const active = activeDispatches[0];
        if (active && lock.agentDispatchId !== active.id) {
          await ctx.runMutation(internal.livekitAgent.recordAgentDispatch, {
            agentWorkerRoomId: lock.agentWorkerRoomId,
            agentDispatchId: active.id,
            agentDispatchCreatedAt: now,
            nextDispatchAt: nextDispatchAt(now, lock.agentReconnectAttempt ?? 0),
            reconnectAttempt: lock.agentReconnectAttempt ?? 0,
          });
        }
        return;
      }

      if (dispatchAgeMs < DISPATCH_STALE_GRACE_MS) {
        return;
      }

      for (const stale of activeDispatches) {
        await deleteDispatchBestEffort(dispatchClient, roomName, stale.id);
      }
      await ctx.runMutation(internal.livekitAgent.clearAgentDispatch, {
        agentWorkerRoomId: lock.agentWorkerRoomId,
      });
    }

    const reconnectAttempt = (lock.agentReconnectAttempt ?? 0) + 1;
    const dispatch = await dispatchClient.createDispatch(roomName, AGENT_NAME, {
      metadata: JSON.stringify({ sessionId, dispatchedAt: now, reason, reconnectAttempt }),
    });
    await ctx.runMutation(internal.livekitAgent.recordAgentDispatch, {
      agentWorkerRoomId: lock.agentWorkerRoomId,
      agentDispatchId: dispatch.id,
      agentDispatchCreatedAt: now,
      nextDispatchAt: nextDispatchAt(now, reconnectAttempt),
      reconnectAttempt,
    });
  } catch (error) {
    const attempt = (lock.agentReconnectAttempt ?? 0) + 1;
    await ctx.runMutation(internal.livekitAgent.recordAgentDispatchFailure, {
      agentWorkerRoomId: lock.agentWorkerRoomId,
      error: error instanceof Error ? error.message : "Unable to dispatch LiveKit agent",
      nextDispatchAt: now + backoffDelayMs(attempt),
      reconnectAttempt: attempt,
    });
  } finally {
    await ctx.runMutation(internal.livekitAgent.releaseAgentDispatchLock, {
      agentWorkerRoomId: lock.agentWorkerRoomId,
    });
  }
}

async function dedupeActiveDispatches(
  dispatchClient: AgentDispatchClient,
  roomName: string,
  activeDispatches: ListedAgentDispatch[],
): Promise<ListedAgentDispatch[]> {
  if (activeDispatches.length <= 1) return activeDispatches;

  activeDispatches.sort((a, b) => compareBigIntDesc(a.state?.createdAt ?? 0n, b.state?.createdAt ?? 0n));
  const [keep, ...duplicates] = activeDispatches;
  for (const duplicate of duplicates) {
    await deleteDispatchBestEffort(dispatchClient, roomName, duplicate.id);
  }
  return keep ? [keep] : [];
}

async function reconcileAgentParticipants(
  roomService: RoomServiceClient,
  roomName: string,
  now: number,
  lastDispatchAt: number | null,
  activeDispatches: ListedAgentDispatch[],
): Promise<{ hasAgent: boolean; removedAgent: boolean }> {
  try {
    const participants = await roomService.listParticipants(roomName);
    const agents = orderedAgentParticipants(participants, activeDispatches);
    if (agents.length === 0) return { hasAgent: false, removedAgent: false };

    const [keep, ...duplicates] = agents;
    for (const duplicate of duplicates) {
      await removeParticipantBestEffort(roomService, roomName, duplicate.identity);
    }

    const agentAgeMs = lastDispatchAt ? now - lastDispatchAt : Number.POSITIVE_INFINITY;
    if (keep && agentAgeMs >= DISPATCH_STALE_GRACE_MS) {
      await removeParticipantBestEffort(roomService, roomName, keep.identity);
      return { hasAgent: false, removedAgent: true };
    }

    return { hasAgent: Boolean(keep), removedAgent: false };
  } catch (error) {
    console.warn(`[livekit] Failed to list participants for room ${roomName}:`, error);
    return { hasAgent: false, removedAgent: false };
  }
}

async function removeDuplicateAgentParticipants(
  roomService: RoomServiceClient,
  roomName: string,
  activeDispatches: ListedAgentDispatch[],
): Promise<void> {
  try {
    const participants = await roomService.listParticipants(roomName);
    const agents = orderedAgentParticipants(participants, activeDispatches);
    const [, ...duplicates] = agents;
    for (const duplicate of duplicates) {
      await removeParticipantBestEffort(roomService, roomName, duplicate.identity);
    }
  } catch (error) {
    console.warn(`[livekit] Failed to reconcile duplicate agents for room ${roomName}:`, error);
  }
}

function orderedAgentParticipants(
  participants: ListedParticipant[],
  activeDispatches: ListedAgentDispatch[],
): ListedParticipant[] {
  const agents = participants.filter((participant) => participant.kind === ParticipantInfo_Kind.AGENT);
  const preferredIdentities = new Set(
    activeDispatches
      .flatMap((dispatch) => dispatch.state?.jobs ?? [])
      .map((job) => job.participant?.identity)
      .filter((identity): identity is string => Boolean(identity)),
  );

  return agents.sort((a, b) => {
    const aPreferred = preferredIdentities.has(a.identity);
    const bPreferred = preferredIdentities.has(b.identity);
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    return compareBigIntDesc(a.joinedAtMs || a.joinedAt, b.joinedAtMs || b.joinedAt);
  });
}

async function listActiveDispatches(dispatchClient: AgentDispatchClient, roomName: string) {
  try {
    const dispatches = await dispatchClient.listDispatch(roomName);
    return dispatches.filter((dispatch) => dispatch.agentName === AGENT_NAME && (dispatch.state?.deletedAt ?? 0n) === 0n);
  } catch (error) {
    console.warn(`[livekit] Failed to list dispatches for room ${roomName}:`, error);
    return [];
  }
}

async function deleteDispatchBestEffort(dispatchClient: AgentDispatchClient, roomName: string, dispatchId: string) {
  try {
    await dispatchClient.deleteDispatch(dispatchId, roomName);
  } catch (error) {
    console.warn(`[livekit] Failed to delete dispatch ${dispatchId} for room ${roomName}:`, error);
  }
}

async function removeParticipantBestEffort(roomService: RoomServiceClient, roomName: string, identity: string) {
  try {
    await roomService.removeParticipant(roomName, identity);
  } catch (error) {
    console.warn(`[livekit] Failed to remove agent participant ${identity} from room ${roomName}:`, error);
  }
}

function nextDispatchAt(now: number, reconnectAttempt: number): number {
  return now + backoffDelayMs(reconnectAttempt);
}

function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(DISPATCH_BACKOFF_MAX_MS, DISPATCH_BACKOFF_BASE_MS * 2 ** exponent);
}

function compareBigIntDesc(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}
