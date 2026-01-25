"use client";

import { forwardRef, useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { shiftHeldAtom, isLiveModeAtom, voiceConnectionStatusAtom, voiceAgentConnectedAtom } from "@/src/atoms";
import { TerminalMessage } from "./TerminalMessage";
import { TerminalInput } from "./TerminalInput";
import { ScanlinesToggle } from "./Scanlines";

interface Message {
  _id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  mode?: "text" | "voice";
}

interface TerminalPaneProps {
  messages: Message[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
}

export const TerminalPane = forwardRef<HTMLTextAreaElement, TerminalPaneProps>(
  function TerminalPane(
    { messages, input, onInputChange, onSend, isLoading },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const shiftHeld = useAtomValue(shiftHeldAtom);
    const [isLiveMode, setIsLiveMode] = useAtom(isLiveModeAtom);
    const voiceConnectionStatus = useAtomValue(voiceConnectionStatusAtom);
    const voiceAgentConnected = useAtomValue(voiceAgentConnectedAtom);

    const handleToggleLiveMode = () => {
      setIsLiveMode((prev) => !prev);
    };

    useEffect(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    }, [messages]);

    return (
      <div
        tabIndex={0}
        className="h-full flex flex-col bg-terminal-bg relative z-0 pane-focus"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-green-dimmer">
          <h1 className="text-terminal-green terminal-glow text-sm font-bold">
            {shiftHeld ? <u>M</u> : "M"}ESSAGES
          </h1>
          <ScanlinesToggle />
        </div>

        {/* Messages area with sticky input */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-4 pb-0 terminal-scrollbar"
        >
          {messages.length === 0 ? (
            <div className="text-terminal-green-dimmer italic">
              Waiting for input...
            </div>
          ) : (
            messages.map((msg) => (
              <TerminalMessage
                key={msg._id}
                role={msg.role}
                content={msg.content}
              />
            ))
          )}
          {isLoading && (
            <div className="text-terminal-green-dim animate-pulse">
              Processing<span className="terminal-cursor">_</span>
            </div>
          )}

          {/* Sticky input inside scrollable area */}
          <TerminalInput
            ref={ref}
            value={input}
            onChange={onInputChange}
            onSend={onSend}
            isLoading={isLoading}
            isLiveMode={isLiveMode}
            voiceConnectionStatus={voiceConnectionStatus}
            voiceAgentConnected={voiceAgentConnected}
            onToggleLiveMode={handleToggleLiveMode}
          />
        </div>
      </div>
    );
  }
);
