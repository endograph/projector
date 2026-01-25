"use client";

import { useCallback, useEffect, useRef } from "react";
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
  type AgentTab,
} from "@/src/atoms";
import { useSessionId } from "@/src/hooks";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { AgentPane } from "./components/agent/AgentPane";
import { ThemeProvider } from "./components/ThemeProvider";
import { LiveVoiceClient } from "@/src/voice/LiveVoiceClient";

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

  const terminalInputRef = useRef<HTMLTextAreaElement>(null);
  const agentPaneRef = useRef<HTMLDivElement>(null);

  const createSession = useAction(api.chat.createSession);
  const sendMessage = useAction(api.chat.send);

  // Query the previewed step to get its turnId for filtering messages
  const previewedStep = useQuery(
    api.machineSteps.getById,
    selectedStepId ? { stepId: selectedStepId } : "skip"
  );

  // Determine which turnId to filter messages by
  const effectiveTurnId =
    isPreviewing && previewedStep?.turnId ? previewedStep.turnId : undefined;

  // Use turn-aware messages query for time travel support
  const messages = useQuery(
    api.messages.listForTurnPath,
    sessionId ? { sessionId, upToTurnId: effectiveTurnId } : "skip"
  );
  const session = useQuery(api.sessions.get, sessionId ? { id: sessionId } : "skip");

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
      // Skip if typing in an input/textarea (except for M which focuses the input)
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      // M - focus left pane (terminal input)
      if (e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
    if (!sessionId || !input.trim() || isLoading) return;

    const message = input.trim();
    setInput("");
    setIsLoading(true);

    try {
      await sendMessage({ sessionId, message });
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetSession = useCallback(() => {
    // Clear session - useEffect will create a new one
    setSessionId(null);
  }, [setSessionId]);

  // Extract theme from session instance pack states
  const theme = session?.instance?.packStates?.theme as
    | { hue: number; saturation: number; animated: boolean; gradient: boolean }
    | undefined;

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
      {/* Voice mode client - manages LiveKit connection */}
      <LiveVoiceClient sessionId={sessionId} />

      <div className="h-screen flex">
        {/* Left side - Terminal pane */}
        <div className="w-1/2 h-full border-r border-terminal-green-dimmer relative">
          {scanlinesEnabled && <div className="terminal-scanlines absolute inset-0" />}
          <TerminalPane
            ref={terminalInputRef}
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
