import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { isValidGuestSecret } from "./access";
import { normalizeClientMessageId } from "./messageActor";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";

const http = httpRouter();
auth.addHttpRoutes(http);

http.route({
  path: "/api/anonymous/message",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const headers = corsHeaders(request);
    return headers
      ? new Response(null, { status: 204, headers })
      : jsonResponse(request, 403, { code: "ORIGIN_NOT_ALLOWED" });
  }),
});

http.route({
  path: "/api/anonymous/message",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!corsHeaders(request)) {
      return jsonResponse(request, 403, { code: "ORIGIN_NOT_ALLOWED" });
    }

    const guestSecret = request.headers.get("x-projector-guest")?.trim();
    const body = await readMessageBody(request);
    if (!guestSecret || !isValidGuestSecret(guestSecret) || !body) {
      return jsonResponse(request, 400, { code: "INVALID_REQUEST" });
    }

    const ip = clientIp(request);
    const salt = process.env.ANONYMOUS_IP_SALT;
    if (!ip || !salt) {
      console.error("Anonymous inference requires a client IP and ANONYMOUS_IP_SALT");
      return jsonResponse(request, 503, { code: "ANONYMOUS_UNAVAILABLE" });
    }

    try {
      const ipHash = await sha256(`${salt}:${ip}`);
      await ctx.runMutation(internal.sessions.reserveAnonymousTurn, {
        sessionId: body.sessionId,
        guestSecret,
        ipHash,
      });
      const { itemId } = await ctx.runMutation(internal.inbox.sendAnonymous, body);
      return jsonResponse(request, 200, { success: true, itemId });
    } catch (error) {
      const message = String(error);
      if (message.includes("AUTH_REQUIRED") || message.includes("GUEST_RATE_LIMITED")) {
        return jsonResponse(request, 401, { code: "AUTH_REQUIRED" });
      }
      if (message.includes("IP_RATE_LIMITED")) {
        return jsonResponse(request, 429, { code: "IP_RATE_LIMITED" });
      }
      if (message.includes("FORBIDDEN")) {
        return jsonResponse(request, 403, { code: "FORBIDDEN" });
      }
      console.error("Anonymous message failed", error);
      return jsonResponse(request, 500, { code: "MESSAGE_FAILED" });
    }
  }),
});

export default http;

type AnonymousMessageBody = {
  sessionId: Id<"sessions">;
  text: string;
  clientMessageId: string;
};

async function readMessageBody(request: Request): Promise<AnonymousMessageBody | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (
    typeof value.sessionId !== "string" ||
    typeof value.text !== "string" ||
    typeof value.clientMessageId !== "string"
  ) return null;
  const text = value.text.trim();
  const clientMessageId = normalizeClientMessageId(value.clientMessageId);
  if (!text || !clientMessageId) return null;
  return {
    sessionId: value.sessionId as AnonymousMessageBody["sessionId"],
    text,
    clientMessageId,
  };
}

function corsHeaders(request: Request): Headers | null {
  const origin = request.headers.get("origin");
  const siteUrl = process.env.SITE_URL;
  if (!origin || !siteUrl || origin !== new URL(siteUrl).origin) return null;
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Projector-Guest",
    Vary: "Origin",
  });
}

function jsonResponse(request: Request, status: number, body: unknown): Response {
  const headers = corsHeaders(request) ?? new Headers();
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function clientIp(request: Request): string | null {
  const direct = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip");
  if (direct?.trim()) return direct.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  return forwarded.split(",").at(-1)?.trim() || null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
