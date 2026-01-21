"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import { useSessionId, useDevMode, useSidebarOpen, useKeyboardShortcut } from "../src/hooks";
import { ChatMessage } from "./components/ChatMessage";
import { ChatInput } from "./components/ChatInput";
import { ThinkingIndicator } from "./components/ThinkingIndicator";
import { Sidebar } from "./components/Sidebar";
import { DebugPanel } from "./components/DebugPanel";
import { DevIndicator } from "./components/DevIndicator";
import type { Id } from "../convex/_generated/dataModel";

export function HomeClient({
  initialSessionId,
}: {
  initialSessionId: Id<"sessions"> | null;
}) {
  const [sessionId, setSessionId] = useSessionId(initialSessionId);
  const [sending, setSending] = useState(false);
  const [sendStartTime, setSendStartTime] = useState<number | null>(null);
  const [devMode, setDevMode] = useDevMode();
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen();
  const [debugTurnId, setDebugTurnId] = useState<Id<"machineTurns"> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const createSession = useAction(api.chat.createSession);
  const sendMessage = useAction(api.chat.send);
  const session = useQuery(
    api.sessions.get,
    sessionId ? { id: sessionId } : "skip"
  );
  const messages = useQuery(
    api.messages.list,
    sessionId ? { sessionId } : "skip"
  );

  // Goals and reminders for sidebar
  const goals = useQuery(
    api.goals.listActive,
    sessionId ? { sessionId } : "skip"
  );
  const reminders = useQuery(
    api.reminders.listPending,
    sessionId ? { sessionId } : "skip"
  );

  // Create session on mount if none exists or if stale
  useEffect(() => {
    if (sessionId && session === undefined) return; // Still loading

    if (sessionId && session === null) {
      setSessionId(null);
      return;
    }

    if (!sessionId) {
      async function init() {
        const id = await createSession();
        setSessionId(id);
      }
      init();
    }
  }, [sessionId, session, createSession, setSessionId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Keyboard shortcuts
  useKeyboardShortcut("KeyD", () => setDevMode(!devMode), { alt: true });
  useKeyboardShortcut("KeyB", () => setSidebarOpen(!sidebarOpen), { alt: true });

  const handleSend = async (message: string) => {
    if (!sessionId) return;
    setSendStartTime(Date.now());
    setSending(true);
    try {
      await sendMessage({ sessionId, message });
    } catch (error) {
      console.error("Error sending message:", error);
    } finally {
      setSending(false);
      setSendStartTime(null);
    }
  };

  const handleNewSession = async () => {
    setSessionId(null);
    const id = await createSession();
    setSessionId(id);
  };

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      {/* Sidebar */}
      {sidebarOpen && (
        <Sidebar
          goals={goals ?? []}
          reminders={reminders ?? []}
          onClose={() => setSidebarOpen(false)}
          onNewSession={handleNewSession}
        />
      )}

      {/* Main Chat Area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-4">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                title="Show sidebar (Option+B)"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                Automaton
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Self-assembling AI agent
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {devMode && (
              <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
                DEV
              </span>
            )}
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl space-y-4">
            {!sessionId && (
              <p className="text-center text-gray-500">Loading...</p>
            )}
            {messages?.length === 0 && sessionId && (
              <div className="py-12 text-center">
                <div className="mb-4 text-6xl">🤖</div>
                <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
                  Welcome to Automaton
                </h2>
                <p className="text-gray-500 dark:text-gray-400">
                  I&apos;m your self-assembling AI assistant. Tell me about a goal
                  you&apos;d like to achieve, and I&apos;ll help you track it.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {[
                    "Help me get strong and healthy",
                    "I want to learn a new language",
                    "Help me manage my projects",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => handleSend(suggestion)}
                      className="rounded-full border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages?.map((msg) => (
              <ChatMessage
                key={msg._id}
                role={msg.role}
                content={msg.content}
                turnId={msg.turnId}
                devMode={devMode}
                onLongPress={setDebugTurnId}
              />
            ))}
            {sending && sessionId && sendStartTime && (
              <ThinkingIndicator sessionId={sessionId} startTime={sendStartTime} />
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div className="mx-auto max-w-3xl">
            <ChatInput onSend={handleSend} disabled={!sessionId || sending} />
          </div>
        </div>
      </main>

      {/* Debug Panel */}
      {debugTurnId && (
        <DebugPanel
          turnId={debugTurnId}
          onClose={() => setDebugTurnId(null)}
        />
      )}

      {/* Dev Indicator */}
      <DevIndicator devMode={devMode} onToggle={() => setDevMode(!devMode)} />
    </div>
  );
}
