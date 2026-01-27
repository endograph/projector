"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { ParticipantInfo_Kind } from "@livekit/protocol";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";

const AGENT_NAME = "demo-agent";
const DISPATCH_LOCK_TTL_MS = 20_000;
const DISPATCH_COOLDOWN_MS = 10_000;

/**
 * Voice Mode Actions (Node.js Runtime)
 * =====================================
 *
 * Actions that require Node.js APIs (like livekit-server-sdk).
 */

// Token generation for frontend to join LiveKit room
export const getToken = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }): Promise<{ token: string; url: string; room: string }> => {
    // Verify session exists
    const session = await ctx.runQuery(internal.livekitAgent.getSession, { sessionId });
    if (!session) {
      throw new Error("Invalid session");
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !url) {
      throw new Error("LiveKit environment variables not configured");
    }

    const roomName = `voice-${sessionId}`;
    const identity = `user-${sessionId}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      ttl: "15m",
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    // Track the voice room
    await ctx.runMutation(internal.livekitAgent.upsertVoiceRoom, {
      sessionId,
      roomName,
    });

    // Dispatch agent to the room (de-duped).
    //
    // Without this, multiple rapid getToken() calls (React strict mode, reloads, multiple tabs)
    // can create multiple explicit dispatches, resulting in 4+ agents joining the same room.
    const dispatchLock = await ctx.runMutation(internal.livekitAgent.claimAgentDispatchLock, {
      sessionId,
      lockTtlMs: DISPATCH_LOCK_TTL_MS,
    });

    if (!dispatchLock) {
      // Another request is already dispatching (or just did); still return a token.
      console.log(`[getToken] Agent dispatch already in-flight for room ${roomName}`);
      return {
        token: await at.toJwt(),
        url,
        room: roomName,
      };
    }

    try {
      const httpUrl = url.replace("wss://", "https://").replace("ws://", "http://");
      const agentDispatch = new AgentDispatchClient(httpUrl, apiKey, apiSecret);

      // 1) If an agent is already in the room, don't dispatch another.
      // (This check is best-effort; if the room doesn't exist yet, it may throw.)
      let hasAgent = false;
      try {
        const roomService = new RoomServiceClient(httpUrl, apiKey, apiSecret);
        const participants = await roomService.listParticipants(roomName);
        hasAgent = participants.some((p) => p.kind === ParticipantInfo_Kind.AGENT);
      } catch (error) {
        console.warn(`[getToken] Failed to list participants for room ${roomName}:`, error);
      }

      // 2) If there's already an explicit dispatch recorded by LiveKit, don't create another.
      // Also clean up duplicates (multiple dispatches => multiple agents).
      try {
        const existing = await agentDispatch.listDispatch(roomName);
        let activeDispatches = existing.filter(
          (d) => d.agentName === AGENT_NAME && (d.state?.deletedAt ?? 0n) === 0n
        );

        if (activeDispatches.length > 1) {
          // Keep the most recently created dispatch and delete the rest.
          activeDispatches.sort((a, b) => {
            const aCreatedAt = a.state?.createdAt ?? 0n;
            const bCreatedAt = b.state?.createdAt ?? 0n;
            if (aCreatedAt === bCreatedAt) return 0;
            return aCreatedAt > bCreatedAt ? -1 : 1;
          });

          const [keep, ...duplicates] = activeDispatches;
          console.warn(
            `[getToken] Found ${activeDispatches.length} active dispatches for room ${roomName}; deleting ${duplicates.length} duplicates`
          );

          for (const dup of duplicates) {
            try {
              await agentDispatch.deleteDispatch(dup.id, roomName);
            } catch (error) {
              console.warn(
                `[getToken] Failed to delete duplicate dispatch ${dup.id} for room ${roomName}:`,
                error
              );
            }
          }

          activeDispatches = [keep];
        }

        if (activeDispatches.length > 0) {
          const active = activeDispatches[0];
          if (dispatchLock.agentDispatchId !== active.id) {
            try {
              await ctx.runMutation(internal.livekitAgent.recordAgentDispatch, {
                voiceRoomId: dispatchLock.voiceRoomId,
                agentDispatchId: active.id,
                // Use "observed now" for cooldown purposes (LiveKit's createdAt units are not guaranteed here).
                agentDispatchCreatedAt: Date.now(),
              });
            } catch (error) {
              console.warn(
                `[getToken] Failed to record existing dispatch ${active.id} for room ${roomName}:`,
                error
              );
            }
          }
          console.log(`[getToken] Existing dispatch found for room ${roomName}; skipping dispatch`);
          return {
            token: await at.toJwt(),
            url,
            room: roomName,
          };
        }
      } catch (error) {
        console.warn(`[getToken] Failed to list existing dispatches for room ${roomName}:`, error);
      }

      if (hasAgent) {
        console.log(`[getToken] Agent already present in room ${roomName}; skipping dispatch`);
        return {
          token: await at.toJwt(),
          url,
          room: roomName,
        };
      }

      // 3) If we *just* dispatched, don't dispatch again (covers the "agent hasn't joined yet" window).
      const now = Date.now();
      const lastDispatchAt = dispatchLock.agentDispatchCreatedAt ?? 0;
      if (lastDispatchAt > 0 && now - lastDispatchAt < DISPATCH_COOLDOWN_MS) {
        console.log(
          `[getToken] Skipping dispatch; last dispatch for room ${roomName} was ${now - lastDispatchAt}ms ago`
        );
        return {
          token: await at.toJwt(),
          url,
          room: roomName,
        };
      }

      // 4) Create the dispatch.
      const dispatchedAt = Date.now();
      const dispatch = await agentDispatch.createDispatch(roomName, AGENT_NAME, {
        metadata: JSON.stringify({
          reason: "user_token_request",
          sessionId,
          dispatchedAt,
        }),
      });
      await ctx.runMutation(internal.livekitAgent.recordAgentDispatch, {
        voiceRoomId: dispatchLock.voiceRoomId,
        agentDispatchId: dispatch.id,
        agentDispatchCreatedAt: dispatchedAt,
      });
      console.log(`[getToken] Dispatched agent to room ${roomName} (dispatchId=${dispatch.id})`);
    } catch (error) {
      // Log but don't fail - user can refresh to retry
      console.error(`[getToken] Failed to dispatch agent:`, error);
    } finally {
      try {
        await ctx.runMutation(internal.livekitAgent.releaseAgentDispatchLock, {
          voiceRoomId: dispatchLock.voiceRoomId,
        });
      } catch (error) {
        // Best-effort; lock will also expire via TTL.
        console.warn(`[getToken] Failed to release dispatch lock for room ${roomName}:`, error);
      }
    }

    return {
      token: await at.toJwt(),
      url,
      room: roomName,
    };
  },
});
