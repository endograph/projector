import { useCallback, useEffect, useRef, useState } from "react";
import Cookies from "js-cookie";
import type { Id } from "@/convex/_generated/dataModel";

const SESSION_COOKIE_KEY = "demo-sessionId";

function getStoredSessionId(): Id<"sessions"> | null {
  const stored = Cookies.get(SESSION_COOKIE_KEY);
  return stored ? (stored as Id<"sessions">) : null;
}

export function useSessionId(initialSessionId: Id<"sessions"> | null) {
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

export function useScrollToBottom<T extends HTMLElement>() {
  const containerRef = useRef<T>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      setIsScrolledUp(scrollHeight - scrollTop - clientHeight > 50);
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  return { containerRef, isScrolledUp, scrollToBottom };
}

export function useAutoScrollOnNewContent<T extends HTMLElement>(
  content: unknown[]
) {
  const { containerRef, isScrolledUp, scrollToBottom } = useScrollToBottom<T>();

  useEffect(() => {
    if (!isScrolledUp) {
      scrollToBottom();
    }
  }, [content, isScrolledUp, scrollToBottom]);

  return { containerRef, isScrolledUp, scrollToBottom };
}
