"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

interface SerializedCommandInfo {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown> };
}

interface CommandsTabProps {
  sessionId: Id<"sessions">;
  commands: SerializedCommandInfo[];
}

export function CommandsTab({ sessionId, commands }: CommandsTabProps) {
  if (commands.length === 0) {
    return (
      <div className="text-terminal-green-dimmer italic">
        No commands available on the current node
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {commands.map((cmd) => (
        <CommandCard key={cmd.name} sessionId={sessionId} command={cmd} />
      ))}
    </div>
  );
}

function CommandCard({
  sessionId,
  command,
}: {
  sessionId: Id<"sessions">;
  command: SerializedCommandInfo;
}) {
  const [input, setInput] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);

  const executeCommand = useAction(api.commands.executeCommand);

  // Check if the input schema has any properties
  const hasInput = command.inputSchema.properties &&
    Object.keys(command.inputSchema.properties).length > 0;

  const handleExecute = async () => {
    setIsExecuting(true);
    setResult(null);
    setError(null);

    try {
      let parsedInput = {};
      if (hasInput) {
        try {
          parsedInput = JSON.parse(input);
        } catch {
          setError("Invalid JSON input");
          setIsExecuting(false);
          return;
        }
      }

      const res = await executeCommand({
        sessionId,
        commandName: command.name,
        input: parsedInput,
      });

      if (res.success) {
        setResult(JSON.stringify(res.value, null, 2));
      } else {
        setError(res.error || "Command failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="border border-terminal-green-dimmer rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-terminal-green font-bold">{command.name}</span>
        <button
          onClick={handleExecute}
          disabled={isExecuting}
          className={`
            px-3 py-1 text-xs rounded border
            ${
              isExecuting
                ? "border-terminal-green-dimmer text-terminal-green-dimmer"
                : "border-terminal-green text-terminal-green hover:bg-terminal-green hover:text-terminal-bg"
            }
            transition-colors
          `}
        >
          {isExecuting ? "..." : "[Execute]"}
        </button>
      </div>

      <div className="text-terminal-green-dim text-sm mb-2">
        {command.description}
      </div>

      {hasInput && (
        <div className="mb-2">
          <label className="text-terminal-green-dimmer text-xs block mb-1">
            Input (JSON):
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full bg-terminal-bg border border-terminal-green-dimmer rounded px-2 py-1 text-terminal-green font-mono text-sm resize-none"
            rows={2}
          />
        </div>
      )}

      {result && (
        <div className="mt-2 p-2 bg-terminal-bg-lighter rounded">
          <div className="text-terminal-cyan text-xs mb-1">Result:</div>
          <pre className="text-terminal-green text-sm whitespace-pre-wrap">
            {result}
          </pre>
        </div>
      )}

      {error && (
        <div className="mt-2 p-2 bg-terminal-bg-lighter rounded border border-terminal-red">
          <div className="text-terminal-red text-sm">{error}</div>
        </div>
      )}
    </div>
  );
}
