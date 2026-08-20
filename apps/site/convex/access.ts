import { DAY, RateLimiter } from "@convex-dev/rate-limiter";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  // The cookie is the primary one-free-turn boundary. The IP limit is a
  // deliberately coarse backstop for cleared cookies and private windows.
  anonymousByGuest: { kind: "fixed window", rate: 1, period: 365 * DAY },
  anonymousByIp: { kind: "fixed window", rate: 3, period: DAY },
});

export const ACCESS_ERROR = {
  authRequired: "AUTH_REQUIRED",
  forbidden: "FORBIDDEN",
  guestRateLimited: "GUEST_RATE_LIMITED",
  ipRateLimited: "IP_RATE_LIMITED",
} as const;

const GUEST_SECRET_PATTERN = /^[a-f0-9]{64}$/;

export function isValidGuestSecret(secret: string): boolean {
  return GUEST_SECRET_PATTERN.test(secret);
}

export async function hashGuestSecret(secret: string): Promise<string> {
  if (!isValidGuestSecret(secret)) throw new ConvexError(ACCESS_ERROR.forbidden);
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function authorizeSessionWrite(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  guestSecret?: string,
): Promise<"authenticated" | "guest"> {
  const userId = await getAuthUserId(ctx);

  if (session.ownerUserId !== undefined) {
    if (userId !== session.ownerUserId) {
      throw new ConvexError(ACCESS_ERROR.forbidden);
    }
    return "authenticated";
  }

  const guestMatches =
    guestSecret !== undefined &&
    isValidGuestSecret(guestSecret) &&
    session.guestSecretHash !== undefined &&
    (await hashGuestSecret(guestSecret)) === session.guestSecretHash;
  if (!guestMatches) {
    throw new ConvexError(userId ? ACCESS_ERROR.forbidden : ACCESS_ERROR.authRequired);
  }

  if (userId) {
    await ctx.db.patch(session._id, {
      ownerUserId: userId,
      guestSecretHash: undefined,
    });
    return "authenticated";
  }

  return "guest";
}

export async function reserveAnonymousTurn(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  guestSecret: string,
  ipHash: string,
): Promise<void> {
  if (session.ownerUserId !== undefined || session.anonymousTurnUsedAt !== undefined) {
    throw new ConvexError(ACCESS_ERROR.authRequired);
  }

  const guestHash = await hashGuestSecret(guestSecret);
  if (session.guestSecretHash !== guestHash) {
    throw new ConvexError(ACCESS_ERROR.forbidden);
  }

  const guestLimit = await rateLimiter.limit(ctx, "anonymousByGuest", { key: guestHash });
  if (!guestLimit.ok) throw new ConvexError(ACCESS_ERROR.guestRateLimited);

  const ipLimit = await rateLimiter.limit(ctx, "anonymousByIp", { key: ipHash });
  if (!ipLimit.ok) throw new ConvexError(ACCESS_ERROR.ipRateLimited);

  await ctx.db.patch(session._id, { anonymousTurnUsedAt: Date.now() });
}
