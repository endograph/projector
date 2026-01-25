"use client";

import { forwardRef, useCallback, KeyboardEvent } from "react";
import type { VoiceConnectionStatus } from "@/src/atoms";

interface TerminalInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
  // Voice mode props
  isLiveMode?: boolean;
  voiceConnectionStatus?: VoiceConnectionStatus;
  voiceAgentConnected?: boolean;
  onToggleLiveMode?: () => void;
}

export const TerminalInput = forwardRef<HTMLTextAreaElement, TerminalInputProps>(
  function TerminalInput(
    { value, onChange, onSend, isLoading, isLiveMode, voiceConnectionStatus, voiceAgentConnected, onToggleLiveMode },
    ref
  ) {
    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
          e.currentTarget.blur();
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSend();
        }
      },
      [onSend]
    );

    // Microphone button styling based on state
    const getMicButtonClass = () => {
      const base = "px-2 py-1 font-mono text-sm transition-all duration-200 focus:outline-none";
      if (!onToggleLiveMode) return `${base} hidden`;

      if (isLiveMode) {
        if (voiceConnectionStatus === "connecting") {
          return `${base} text-terminal-green-dim animate-pulse`;
        }
        if (voiceConnectionStatus === "connected" && !voiceAgentConnected) {
          // Connected but no agent - warning state
          return `${base} text-yellow-500 animate-pulse`;
        }
        return `${base} text-terminal-green terminal-glow`;
      }
      return `${base} text-terminal-green-dim hover:text-terminal-green`;
    };

    const getMicIcon = () => {
      if (voiceConnectionStatus === "connecting") {
        return "○ ..."; // Connecting
      }
      if (isLiveMode && voiceConnectionStatus === "connected") {
        if (!voiceAgentConnected) {
          return "◎ WAIT"; // Connected but waiting for agent
        }
        return "◉ LIVE"; // Active with agent
      }
      return "○ MIC"; // Inactive
    };

    return (
      <div className="sticky bottom-0 mt-4 pt-4 pb-4 bg-terminal-bg border-t border-terminal-green-dimmer">
        <div className="flex items-start gap-2">
          <span className="text-terminal-green-dim py-1">&gt;</span>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || isLiveMode}
            placeholder={
              isLiveMode
                ? "Voice mode active..."
                : isLoading
                  ? "Thinking..."
                  : "Type a message..."
            }
            rows={1}
            className="flex-1 bg-transparent text-terminal-green font-mono focus:outline-none terminal-glow resize-none min-h-[24px] max-h-[200px]"
            style={{
              height: "auto",
              minHeight: "24px",
            }}
          />
          {onToggleLiveMode && (
            <button
              type="button"
              onClick={onToggleLiveMode}
              disabled={isLoading || voiceConnectionStatus === "connecting"}
              className={getMicButtonClass()}
              aria-pressed={isLiveMode}
              title={isLiveMode ? "Disable voice mode" : "Enable voice mode"}
            >
              {getMicIcon()}
            </button>
          )}
        </div>
      </div>
    );
  }
);
