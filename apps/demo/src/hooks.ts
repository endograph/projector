import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Cookies from "js-cookie";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandExecutionResult } from "markov-machines/client";
import type { DisplayInstance } from "@/src/types/display";
import type { LiveClientHandle } from "@/src/atoms";

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

// ---------------------------------------------------------------------------
// Optimistic command tracking
// ---------------------------------------------------------------------------

export interface OptimisticPatch {
  packState?: Record<string, Record<string, unknown>>;
}

/**
 * Manages optimistic state overlays for commands.
 * Each command is tagged with a clientId. The overlay is applied until the
 * server confirms the command (its clientId appears in `recentCommandResidue`).
 */
export function useOptimisticCommands(
  instance: DisplayInstance | undefined,
  recentCommandResidue: string[] | undefined,
  liveClient: LiveClientHandle | null,
): {
  instance: DisplayInstance | undefined;
  executeCommand: (
    commandName: string,
    input: Record<string, unknown>,
    optimistic?: OptimisticPatch,
  ) => Promise<CommandExecutionResult>;
} {
  const [pending, setPending] = useState<Record<string, OptimisticPatch>>({});

  // Reconcile: remove pending entries that the server has confirmed
  useEffect(() => {
    if (!recentCommandResidue || recentCommandResidue.length === 0) return;
    const residueSet = new Set(recentCommandResidue);
    setPending((prev) => {
      let changed = false;
      const next: Record<string, OptimisticPatch> = {};
      for (const [id, patch] of Object.entries(prev)) {
        if (residueSet.has(id)) {
          changed = true;
        } else {
          next[id] = patch;
        }
      }
      return changed ? next : prev;
    });
  }, [recentCommandResidue]);

  const executeCommand = useCallback(
    async (
      commandName: string,
      input: Record<string, unknown>,
      optimistic?: OptimisticPatch,
    ): Promise<CommandExecutionResult> => {
      const clientId = crypto.randomUUID();

      // Apply optimistic patch immediately
      if (optimistic) {
        setPending((prev) => ({ ...prev, [clientId]: optimistic }));
      }

      if (!liveClient) {
        // Rollback — no transport available
        if (optimistic) {
          setPending((prev) => {
            const { [clientId]: _, ...rest } = prev;
            return rest;
          });
        }
        return { success: false, error: "Not connected to agent" };
      }

      const result = await liveClient.executeCommand(commandName, input, clientId);

      // Rollback on failure
      if (!result.success && optimistic) {
        setPending((prev) => {
          const { [clientId]: _, ...rest } = prev;
          return rest;
        });
      }

      return result;
    },
    [liveClient],
  );

  // Merge all pending patches onto the server instance
  const mergedInstance = useMemo(() => {
    const pendingEntries = Object.values(pending);
    if (!instance || pendingEntries.length === 0) return instance;

    const base = { ...instance };
    const basePS = (base.packStates as Record<string, any>) ?? {};
    let merged = { ...basePS };

    for (const patch of pendingEntries) {
      if (patch.packState) {
        for (const [packName, fields] of Object.entries(patch.packState)) {
          merged[packName] = { ...(merged[packName] ?? {}), ...fields };
        }
      }
    }

    base.packStates = merged;
    return base;
  }, [instance, pending]);

  return { instance: mergedInstance, executeCommand };
}
