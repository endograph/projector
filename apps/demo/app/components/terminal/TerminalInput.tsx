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
      const base = "px-2 py-1 font-mono text-sm focus:outline-none";
      if (!onToggleLiveMode) return `${base} hidden`;

      if (isLiveMode) {
        if (voiceConnectionStatus === "connecting") {
          return `${base} text-terminal-green-dim animate-pulse`;
        }
        if (voiceConnectionStatus === "connected" && !voiceAgentConnected) {
          // Connected but no agent - warning state
          return `${base} text-yellow-500 animate-pulse`;
        }
        return `${base} mic-live`;
      }
      return `${base} text-terminal-green-dim hover:text-terminal-green transition-all duration-200`;
    };

    const MicIcon = ({ filled }: { filled?: boolean }) => (
      <svg className="w-4 h-4" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" fill={filled ? "currentColor" : "none"} />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    );

    return (
      <div className="sticky bottom-0 mt-4 pt-4 pb-4 bg-terminal-bg border-t border-terminal-green-dimmer">
        <div className="flex items-start gap-2">
          <span className={`py-1 ${voiceAgentConnected ? "text-terminal-green-dim" : "text-yellow-500"}`}>&gt;</span>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLiveMode}
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
              <MicIcon filled={isLiveMode && voiceConnectionStatus === "connected"} />
            </button>
          )}
        </div>
      </div>
    );
  }
);
