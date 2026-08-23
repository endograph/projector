import { DAY, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { anonymousActor, authenticatedUser } from "./actors";
import type { MessageActor } from "./messageActor";

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

// The one definition of "this caller holds the session's guest secret" —
// shared by write authorization and viewer attribution so the two can never
// disagree.
export async function guestSecretMatches(
  session: Doc<"sessions">,
  guestSecret: string | undefined,
): Promise<boolean> {
  return (
    guestSecret !== undefined &&
    isValidGuestSecret(guestSecret) &&
    session.guestSecretHash !== undefined &&
    (await hashGuestSecret(guestSecret)) === session.guestSecretHash
  );
}

export async function authorizeSessionWrite(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  guestSecret?: string,
): Promise<MessageActor> {
  const user = await authenticatedUser(ctx);

  // Public demo sessions are collaborative: authentication is sufficient to
  // write, regardless of who created the session. Preserve ownerUserId only
  // as creator metadata for a guest who later signs in.
  if (user) {
    if (
      session.ownerUserId === undefined &&
      (await guestSecretMatches(session, guestSecret))
    ) {
      await ctx.db.patch(session._id, {
        ownerUserId: user.userId,
        guestSecretHash: undefined,
      });
    }
    return user.actor;
  }

  if (session.ownerUserId !== undefined) {
    throw new ConvexError(ACCESS_ERROR.authRequired);
  }

  if (!(await guestSecretMatches(session, guestSecret))) {
    throw new ConvexError(ACCESS_ERROR.authRequired);
  }

  return anonymousActor(session._id);
}

export async function consumeAnonymousTurn(
  ctx: MutationCtx,
  session: Doc<"sessions">,
): Promise<void> {
  if (session.ownerUserId !== undefined || session.anonymousTurnUsedAt !== undefined) {
    throw new ConvexError(ACCESS_ERROR.authRequired);
  }
  await ctx.db.patch(session._id, { anonymousTurnUsedAt: Date.now() });
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

  await consumeAnonymousTurn(ctx, session);
}
