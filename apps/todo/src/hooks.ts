import { useState, useCallback } from "react";
import { useAtom } from "jotai";
import Cookies from "js-cookie";
import type { Id } from "../convex/_generated/dataModel";
import { devModeAtom } from "./atoms";

const SESSION_COOKIE_KEY = "sessionId";

function getStoredSessionId(): Id<"sessions"> | null {
  const stored = Cookies.get(SESSION_COOKIE_KEY);
  return stored ? (stored as Id<"sessions">) : null;
}

export function useSessionId(initialSessionId: Id<"sessions"> | null) {
  // Read from cookie if no initial value provided
  const [sessionId, setSessionIdState] = useState<Id<"sessions"> | null>(
    () => initialSessionId ?? getStoredSessionId()
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

export function useDevMode(): [boolean, (value: boolean) => void] {
  return useAtom(devModeAtom);
}
