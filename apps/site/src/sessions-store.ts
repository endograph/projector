// Past conversations: a device-local index of sessions this browser has
// opened. The durable truth is the session's own frame log server-side —
// this is only the pointer list that lets a visitor find their way back.
// Shared by the marketing page (boot.ts renders the list) and the app
// (Conversation records visits), so it must stay React-free.

export type StoredSession = { id: string; title: string; at: number };

const KEY = "projector:sessions";
const CAP = 30;

export function listStoredSessions(): StoredSession[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is StoredSession =>
        !!s &&
        typeof (s as StoredSession).id === "string" &&
        typeof (s as StoredSession).title === "string" &&
        typeof (s as StoredSession).at === "number",
    );
  } catch {
    return [];
  }
}

// Upsert to the front. A title, once set, is only replaced by a non-empty
// one — revisits refresh the timestamp without blanking the label.
export function recordStoredSession(id: string, title?: string): void {
  try {
    const sessions = listStoredSessions();
    const existing = sessions.find((s) => s.id === id);
    const next: StoredSession = {
      id,
      title: (title?.trim() || existing?.title || "").slice(0, 80),
      at: Date.now(),
    };
    localStorage.setItem(
      KEY,
      JSON.stringify([next, ...sessions.filter((s) => s.id !== id)].slice(0, CAP)),
    );
  } catch {
    // Storage unavailable (private mode, quota): the list is a nicety.
  }
}

export function removeStoredSession(id: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(listStoredSessions().filter((session) => session.id !== id)),
    );
  } catch {
    // Storage unavailable: there is no local row to remove.
  }
}
