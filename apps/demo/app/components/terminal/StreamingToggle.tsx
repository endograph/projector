"use client";

import type { DisplayInstance } from "@/src/types/display";
import type { OptimisticPatch } from "@/src/hooks";
import { findCommand } from "markov-machines/client";
import { demoContract } from "demo-agent/src/agent/contract";

const setStreamingEnabled = demoContract.commands.agentControls.setStreamingEnabled;

interface StreamingToggleProps {
  displayInstance?: DisplayInstance | null;
  executeCommand: (
    commandName: string,
    input: Record<string, unknown>,
    optimistic?: OptimisticPatch,
  ) => Promise<{ success: boolean; value?: unknown; error?: string }>;
}

export function StreamingToggle({ displayInstance, executeCommand }: StreamingToggleProps) {
  if (!displayInstance) return null;

  // Only show toggle if the setStreamingEnabled command is available
  const cmd = findCommand(displayInstance, setStreamingEnabled);
  if (!cmd) return null;

  // Read current streaming state from root pack states
  const packStates = displayInstance.packStates as Record<string, any> | undefined;
  const agentControls = packStates?.agentControls;
  const enabled = agentControls?.enableStreaming ?? true;

  const handleToggle = () => {
    const next = !enabled;
    executeCommand(cmd.name, { enabled: next }, {
      packState: { agentControls: { enableStreaming: next } },
    });
  };

  return (
    <button
      onClick={handleToggle}
      className="text-xs text-terminal-green-dim hover:text-terminal-green transition-colors"
    >
      [{enabled ? "x" : " "}] Streaming
    </button>
  );
}
