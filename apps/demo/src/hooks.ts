import { useCallback, useEffect, useState } from "react";
import Cookies from "js-cookie";
import type { Id } from "@/convex/_generated/dataModel";

const SESSION_COOKIE_KEY = "demo-sessionId";

function getStoredSessionId(): Id<"sessions"> | null {
  const stored = Cookies.get(SESSION_COOKIE_KEY);
  return stored ? (stored as Id<"sessions">) : null;
}

export function useSessionId(initialSessionId: Id<"sessions"> | null) {
  const [sessionId, setSessionIdState] = useState<Id<"sessions"> | null>(
    () => initialSessionId ?? getStoredSessionId(),
  );

  const setSessionId = useCallback((id: Id<"sessions"> | null) => {
    if (id) {
      Cookies.set(SESSION_COOKIE_KEY, id, { expires: 365 });
    } else {
      Cookies.remove(SESSION_COOKIE_KEY);
    }
    setSessionIdState(id);
  }, []);

  return [sessionId, setSessionId] as const;
}

export function useKeyboardFocus(
  messageRef: React.RefObject<HTMLElement | null>,
  agentRef: React.RefObject<HTMLElement | null>,
  onAgentShortcut?: () => void,
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        messageRef.current?.focus();
      }
      if (event.key.toLowerCase() === "a") {
        event.preventDefault();
        if (onAgentShortcut) {
          onAgentShortcut();
        } else {
          agentRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [agentRef, messageRef, onAgentShortcut]);
}
