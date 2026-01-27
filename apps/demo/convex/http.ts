import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

/**
 * Voice Agent Transcript Endpoint
 * ================================
 *
 * POST /voice/transcript
 *
 * Called by the LiveKit voice agent to persist transcripts.
 * Requires VOICE_AGENT_SECRET header for authentication.
 *
 * Body:
 * {
 *   roomName: string,
 *   role: "user" | "assistant",
 *   content: string,
 *   segmentId: string  // unique ID for this transcript segment
 * }
 */
http.route({
  path: "/voice/transcript",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Validate agent secret
    const agentSecret = request.headers.get("x-voice-agent-secret");
    const expectedSecret = process.env.VOICE_AGENT_SECRET;

    if (!expectedSecret) {
      return new Response(JSON.stringify({ error: "Server not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (agentSecret !== expectedSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse body
    let body: {
      roomName: string;
      role: "user" | "assistant";
      content: string;
      segmentId: string;
    };

    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { roomName, role, content, segmentId } = body;

    if (!roomName || !role || !content || !segmentId) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Look up session by room name
    const session = await ctx.runQuery(internal.livekitAgent.getSessionByRoom, { roomName });
    if (!session) {
      return new Response(JSON.stringify({ error: "Room not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Build idempotency key: room:segmentId:role
    const idempotencyKey = `${roomName}:${segmentId}:${role}`;

    // Append transcript with idempotency
    const messageId = await ctx.runMutation(internal.livekitAgent.appendTranscript, {
      sessionId: session._id,
      role,
      content,
      idempotencyKey,
    });

    return new Response(JSON.stringify({ success: true, messageId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
