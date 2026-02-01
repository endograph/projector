"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  inputAtom,
  isLoadingAtom,
  scanlinesEnabledAtom,
  selectedStepIdAtom,
  isPreviewingAtom,
  activeAgentTabAtom,
  shiftHeldAtom,
  isLiveModeAtom,
  liveClientAtom,
  voiceAgentConnectedAtom,
  type AgentTab,
} from "@/src/atoms";
import { useSessionId } from "@/src/hooks";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { AgentPane } from "./components/agent/AgentPane";
import { ThemeProvider } from "./components/ThemeProvider";
import { LiveVoiceClient, type LiveVoiceClientHandle } from "@/src/voice/LiveVoiceClient";

// Note: All messages are now sent via LiveKit RPC to the agent.
// The agent handles both live (voice) and non-live (text) modes.

export function HomeClient({
  initialSessionId,
}: {
  initialSessionId: Id<"sessions"> | null;
}) {
  const [sessionId, setSessionId] = useSessionId(initialSessionId);
  const [input, setInput] = useAtom(inputAtom);
  const [isLoading, setIsLoading] = useAtom(isLoadingAtom);
  const scanlinesEnabled = useAtomValue(scanlinesEnabledAtom);
  const selectedStepId = useAtomValue(selectedStepIdAtom);
  const isPreviewing = useAtomValue(isPreviewingAtom);
  const setActiveTab = useSetAtom(activeAgentTabAtom);
  const setShiftHeld = useSetAtom(shiftHeldAtom);
  const isLiveMode = useAtomValue(isLiveModeAtom);
  const setLiveClient = useSetAtom(liveClientAtom);
  const voiceAgentConnected = useAtomValue(voiceAgentConnectedAtom);

  const terminalInputRef = useRef<HTMLTextAreaElement>(null);
  const agentPaneRef = useRef<HTMLDivElement>(null);
  const liveClientRef = useRef<LiveVoiceClientHandle>(null);

  // Optimistic pending message for instant feedback
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  // Expose liveClient to atom when ref is set (via callback ref pattern)
  const handleLiveClientRef = useCallback((handle: LiveVoiceClientHandle | null) => {
    (liveClientRef as React.MutableRefObject<LiveVoiceClientHandle | null>).current = handle;
    setLiveClient(handle);
  }, [setLiveClient]);

  const createSession = useAction(api.sessionActions.createSession);

  // Query the previewed step to get its turnId for filtering messages
  const previewedStep = useQuery(
    api.machineSteps.getById,
    selectedStepId ? { stepId: selectedStepId } : "skip"
  );

  // Determine which turnId to filter messages by
  const effectiveTurnId =
    isPreviewing && previewedStep?.turnId ? previewedStep.turnId : undefined;

  // Use turn-aware messages query for time travel support
  const serverMessages = useQuery(
    api.messages.listForTurnPath,
    sessionId ? { sessionId, upToTurnId: effectiveTurnId } : "skip"
  );
  const session = useQuery(api.sessions.get, sessionId ? { id: sessionId } : "skip");

  // Clear pending message when we see it in the server messages
  useEffect(() => {
    if (pendingMessage && serverMessages) {
      const found = serverMessages.some(
        (msg) => msg.role === "user" && msg.content === pendingMessage
      );
      if (found) {
        setPendingMessage(null);
      }
    }
  }, [serverMessages, pendingMessage]);

  // Combine server messages with pending optimistic message
  const messages = useMemo(() => {
    const base = serverMessages ?? [];
    if (!pendingMessage) return base;
    return [
      ...base,
      {
        _id: `pending-${Date.now()}`,
        role: "user" as const,
        content: pendingMessage,
        createdAt: Date.now(),
      },
    ];
  }, [serverMessages, pendingMessage]);

  // Create session on mount if none exists or if stale
  useEffect(() => {
    // Wait for session query to resolve
    if (sessionId && session === undefined) return; // Still loading

    // If we have a sessionId but session is null, it's stale - clear it
    if (sessionId && session === null) {
      setSessionId(null);
      return;
    }

    // If no sessionId, create a new session
    if (!sessionId) {
      createSession().then(setSessionId);
    }
  }, [sessionId, session, createSession, setSessionId]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in an input/textarea/contenteditable
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // M - focus left pane (terminal input)
      if (e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTyping) return;
        e.preventDefault();
        terminalInputRef.current?.focus();
        return;
      }

      // Skip other shortcuts if typing
      if (isTyping) return;

      // A - focus right pane (agent pane)
      if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        agentPaneRef.current?.focus();
        return;
      }

      // Tab shortcuts (T/S/H/C/D)
      const tabMap: Record<string, AgentTab> = {
        t: "tree",
        s: "state",
        h: "history",
        c: "commands",
        d: "dev",
      };
      const tab = tabMap[e.key.toLowerCase()];
      if (tab && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setActiveTab(tab);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setActiveTab]);

  // Track shift key for showing hotkey hints
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    // Also reset on blur in case shift is released while window unfocused
    const handleBlur = () => setShiftHeld(false);

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [setShiftHeld]);

  const handleSend = async () => {
    if (!sessionId || !input.trim()) return;

    // Check agent connection before clearing input
    if (!voiceAgentConnected) {
      alert("No agent is connected. Please try again later.");
      return;
    }

    const message = input.trim();
    setInput("");
    setPendingMessage(message); // Optimistic update - show immediately

    try {
      if (!liveClientRef.current?.isConnected()) {
        console.error("Not connected to agent - cannot send message");
        setPendingMessage(null); // Clear optimistic message on error
        return;
      }

      // Send via RPC to the agent (agent handles persistence)
      await liveClientRef.current.sendMessage(message);
    } catch (error) {
      console.error("Failed to send message:", error);
      setPendingMessage(null); // Clear optimistic message on error
    }
  };

  const handleResetSession = useCallback(() => {
    // Clear session - useEffect will create a new one
    setSessionId(null);
  }, [setSessionId]);

  // Extract theme from session instance packs (supports array or keyed map)
  const theme = (() => {
    type ThemeState = { hue: number; saturation: number; animated: boolean; gradient: boolean };
    const getThemeFromInstance = (instance: unknown): ThemeState | undefined => {
      if (!instance || typeof instance !== "object") return undefined;
      const packs = (instance as { packs?: unknown }).packs;
      if (!packs) return undefined;

      if (Array.isArray(packs)) {
        const themePack = packs.find((p) => (p as { name?: string })?.name === "theme");
        return (themePack as { state?: ThemeState } | undefined)?.state;
      }

      if (typeof packs === "object") {
        const themePack = (packs as Record<string, unknown>)["theme"];
        if (!themePack || typeof themePack !== "object") return undefined;
        return ("state" in themePack
          ? (themePack as { state?: ThemeState }).state
          : (themePack as ThemeState));
      }

      return undefined;
    };

    return (
      getThemeFromInstance(session?.instance) ??
      getThemeFromInstance(session?.displayInstance) ??
      ((session as { instance?: { packStates?: Record<string, unknown> } })?.instance?.packStates
        ?.theme as ThemeState | undefined)
    );
  })();

  if (!sessionId) {
    return (
      <ThemeProvider theme={theme}>
        <div className="h-screen flex items-center justify-center">
          <div className="terminal-glow">Initializing session...</div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      {/* Live mode client - manages LiveKit connection for voice and text */}
      <LiveVoiceClient ref={handleLiveClientRef} sessionId={sessionId} />

      <div className="h-screen flex">
        {/* Left side - Terminal pane */}
        <div className="w-1/2 h-full border-r border-terminal-green-dimmer relative">
          {scanlinesEnabled && <div className="terminal-scanlines absolute inset-0" />}
          <TerminalPane
            ref={terminalInputRef}
            sessionId={sessionId}
            messages={messages ?? []}
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            isLoading={isLoading}
          />
        </div>

        {/* Right side - Agent pane */}
        <div className="w-1/2 h-full relative">
          {scanlinesEnabled && <div className="terminal-scanlines absolute inset-0" />}
          <AgentPane
            ref={agentPaneRef}
            sessionId={sessionId}
            instance={session?.instance}
            displayInstance={session?.displayInstance}
            onResetSession={handleResetSession}
          />
        </div>
      </div>
    </ThemeProvider>
  );
}
