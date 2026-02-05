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
  liveClientAtom,
  voiceAgentConnectedAtom,
  streamBuffersAtom,
  streamPresenceAtom,
  pruneStreamBuffersAtom,
  type AgentTab,
} from "@/src/atoms";
import { useSessionId, useOptimisticCommands } from "@/src/hooks";
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
  const setLiveClient = useSetAtom(liveClientAtom);
  const voiceAgentConnected = useAtomValue(voiceAgentConnectedAtom);
  const streamPresence = useAtomValue(streamPresenceAtom);
  const setStreamBuffers = useSetAtom(streamBuffersAtom);
  const setStreamPresence = useSetAtom(streamPresenceAtom);
  const pruneStreamBuffers = useSetAtom(pruneStreamBuffersAtom);
  const liveClient = useAtomValue(liveClientAtom);

  const terminalInputRef = useRef<HTMLTextAreaElement>(null);
  const agentPaneRef = useRef<HTMLDivElement>(null);
  const liveClientRef = useRef<LiveVoiceClientHandle>(null);

  // Optimistic pending message for instant feedback
  const [pendingMessage, setPendingMessage] = useState<{ id: string; content: string } | null>(
    null
  );

  // Expose liveClient to atom when ref is set (via callback ref pattern)
  const handleLiveClientRef = useCallback((handle: LiveVoiceClientHandle | null) => {
    (liveClientRef as React.MutableRefObject<LiveVoiceClientHandle | null>).current = handle;
    setLiveClient(handle);
  }, [setLiveClient]);

  const createSession = useAction(api.sessionActions.createSession);
  const createSessionAtFoo = useAction(api.sessionActions.createSessionAtFoo);

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

  // Per-command optimistic tracking — overlays are kept until the server confirms
  // each command's clientId in recentCommandResidue.
  const optimistic = useOptimisticCommands(
    session?.displayInstance,
    session?.recentCommandResidue,
    liveClient,
  );
  const effectiveDisplayInstance = optimistic.instance;

  // Derive voice/camera state from effective (optimistic) display instance
  const effectivePackStates = effectiveDisplayInstance?.packStates as Record<string, any> | undefined;
  const voiceEnabled = (effectivePackStates?.agentControls?.voiceEnabled as boolean) ?? false;
  const cameraEnabled = (effectivePackStates?.agentControls?.cameraEnabled as boolean) ?? false;

  // Clear pending message when we see it in the server messages
  useEffect(() => {
    if (pendingMessage && serverMessages) {
      const found = serverMessages.some(
        (msg) => msg.role === "user" && msg.content === pendingMessage.content
      );
      if (found) {
        setPendingMessage(null);
      }
    }
  }, [serverMessages, pendingMessage]);

  // Best-effort: once Convex has the final message, drop the local stream buffer
  // so Convex remains the only source of truth.
  useEffect(() => {
    if (!serverMessages) return;
    const finalizedIds = serverMessages
      .filter((m) => m.role === "assistant" && m.idempotencyKey &&
        (m.streamState === "complete" || (!m.streamState && m.content.length > 0)))
      .map((m) => m.idempotencyKey!) as string[];
    if (finalizedIds.length > 0) {
      pruneStreamBuffers(finalizedIds);
    }
  }, [serverMessages, pruneStreamBuffers]);

  // Combine server messages with pending optimistic message.
  // Stream content overlay is handled per-message in TerminalMessage via selectAtom,
  // so this useMemo only depends on streamPresence (changes on start/end) not on every delta.
  const messages = useMemo(() => {
    const base = serverMessages ?? [];

    // Streaming overlay is disabled while previewing history to avoid mixing branches/timelines.
    const shouldOverlayStreaming = !isPreviewing;

    const messageIdsInBase = shouldOverlayStreaming
      ? new Set(base.map((m) => m.idempotencyKey).filter(Boolean) as string[])
      : new Set<string>();

    // Ephemeral entries for streams not yet persisted in Convex.
    // Content is empty here — TerminalMessage fills it from the stream buffer.
    const ephemeralStreamingMessages = shouldOverlayStreaming
      ? Object.entries(streamPresence)
        .filter(([id]) => !messageIdsInBase.has(id))
        .map(([id, meta]) => ({
          _id: `stream-${id}`,
          role: "assistant" as const,
          content: "",
          createdAt: meta.startedAt,
          idempotencyKey: id,
        }))
      : [];

    const pending = pendingMessage
      ? [
        {
          _id: pendingMessage.id,
          role: "user" as const,
          content: pendingMessage.content,
          createdAt: Date.now(), // local ordering only; server message will replace
        },
      ]
      : [];

    return [...base, ...ephemeralStreamingMessages, ...pending].sort(
      (a, b) => a.createdAt - b.createdAt
    );
  }, [serverMessages, pendingMessage, streamPresence, isPreviewing]);

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

  // Clear any in-flight streaming state when switching sessions.
  useEffect(() => {
    setStreamBuffers({});
    setStreamPresence({});
  }, [sessionId, setStreamBuffers, setStreamPresence]);

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
    setPendingMessage({
      id: `pending-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now()}`,
      content: message,
    }); // Optimistic update - show immediately

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

  const handleResetToFoo = useCallback(() => {
    // Create a new session starting at fooNode with { name: "Foo" }
    createSessionAtFoo().then(setSessionId);
  }, [createSessionAtFoo, setSessionId]);

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
      <LiveVoiceClient
        ref={handleLiveClientRef}
        sessionId={sessionId}
        voiceEnabled={voiceEnabled}
        cameraEnabled={cameraEnabled}
      />

      <div className="h-screen flex">
        {/* Left side - Terminal pane */}
        <div className="w-1/2 h-full border-r border-terminal-green-dimmer relative">
          {scanlinesEnabled && <div className="terminal-scanlines absolute inset-0" />}
          <TerminalPane
            ref={terminalInputRef}
            sessionId={sessionId}
            displayInstance={effectiveDisplayInstance}
            messages={messages ?? []}
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            isLoading={isLoading}
            executeCommand={optimistic.executeCommand}
          />
        </div>

        {/* Right side - Agent pane */}
        <div className="w-1/2 h-full relative">
          {scanlinesEnabled && <div className="terminal-scanlines absolute inset-0" />}
          <AgentPane
            ref={agentPaneRef}
            sessionId={sessionId}
            instance={session?.instance}
            displayInstance={effectiveDisplayInstance}
            systemPrompt={session?.systemPrompt}
            onResetSession={handleResetSession}
            onResetToFoo={handleResetToFoo}
          />
        </div>
      </div>
    </ThemeProvider>
  );
}
