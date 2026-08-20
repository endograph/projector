const GUEST_COOKIE = "projector_guest";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function getGuestSecret(): string {
  const existing = readCookie(GUEST_COOKIE);
  if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing;

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${GUEST_COOKIE}=${secret}; Path=/; Max-Age=${GUEST_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  return secret;
}

export async function sendAnonymousMessage(
  actionsUrl: string,
  args: { sessionId: string; text: string; guestSecret: string },
): Promise<void> {
  const response = await fetch(`${actionsUrl.replace(/\/$/, "")}/api/anonymous/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Projector-Guest": args.guestSecret,
    },
    body: JSON.stringify({ sessionId: args.sessionId, text: args.text }),
  });
  if (response.ok) return;

  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "MESSAGE_FAILED";
  throw new AnonymousMessageError(code, response.status);
}

export class AnonymousMessageError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
