import { useAtom } from "jotai";
import Cookies from "js-cookie";
import type { Id } from "../convex/_generated/dataModel";
import { sessionIdAtom, devModeAtom, sidebarOpenAtom, showNodeTreeAtom } from "./atoms";
import { useCallback, useEffect, useState } from "react";

const SESSION_COOKIE_KEY = "automaton-sessionId";

function getStoredSessionId(): Id<"sessions"> | null {
  const stored = Cookies.get(SESSION_COOKIE_KEY);
  return stored ? (stored as Id<"sessions">) : null;
}

export function useSessionId(initialSessionId: Id<"sessions"> | null) {
  const [sessionId, setSessionIdAtom] = useAtom(sessionIdAtom);

  // Sync with cookie storage
  const setSessionId = useCallback(
    (id: Id<"sessions"> | null) => {
      if (id) {
        Cookies.set(SESSION_COOKIE_KEY, id, { expires: 365 });
      } else {
        Cookies.remove(SESSION_COOKIE_KEY);
      }
      setSessionIdAtom(id);
    },
    [setSessionIdAtom]
  );

  // Initialize from cookie or prop
  useEffect(() => {
    const storedId = getStoredSessionId();
    if (storedId && !sessionId) {
      setSessionIdAtom(storedId);
    } else if (initialSessionId && !sessionId) {
      setSessionId(initialSessionId);
    }
  }, [initialSessionId, sessionId, setSessionId, setSessionIdAtom]);

  return [sessionId, setSessionId] as const;
}

export function useDevMode(): [boolean, (value: boolean) => void] {
  return useAtom(devModeAtom);
}

export function useSidebarOpen(): [boolean, (value: boolean) => void] {
  return useAtom(sidebarOpenAtom);
}

export function useShowNodeTree(): [boolean, (value: boolean) => void] {
  return useAtom(showNodeTreeAtom);
}

// Format timestamp for display
export function useFormattedTime(timestamp: number | undefined): string {
  const [formatted, setFormatted] = useState<string>("");

  useEffect(() => {
    if (!timestamp) {
      setFormatted("");
      return;
    }
    const date = new Date(timestamp);
    setFormatted(
      date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    );
  }, [timestamp]);

  return formatted;
}

// Keyboard shortcut hook
export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  options: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.code === key &&
        (!options.alt || e.altKey) &&
        (!options.ctrl || e.ctrlKey) &&
        (!options.meta || e.metaKey) &&
        (!options.shift || e.shiftKey)
      ) {
        // Ignore if in input or textarea
        if (
          document.activeElement?.tagName === "INPUT" ||
          document.activeElement?.tagName === "TEXTAREA"
        ) {
          return;
        }
        e.preventDefault();
        callback();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [key, callback, options.alt, options.ctrl, options.meta, options.shift]);
}
