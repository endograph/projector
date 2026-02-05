"use client";

import { memo, useMemo } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { streamBuffersAtom } from "@/src/atoms";

interface TerminalMessageProps {
  role: "user" | "assistant";
  content: string;
  idempotencyKey?: string;
}

export const TerminalMessage = memo(function TerminalMessage({
  role,
  content,
  idempotencyKey,
}: TerminalMessageProps) {
  // Fine-grained stream subscription: only re-renders when THIS message's buffer changes.
  // selectAtom uses Object.is equality, so deltas for other messages don't trigger re-renders.
  const bufferAtom = useMemo(
    () =>
      selectAtom(
        streamBuffersAtom,
        (bufs) => bufs[idempotencyKey ?? ""]?.content ?? ""
      ),
    [idempotencyKey]
  );
  const streamContent = useAtomValue(bufferAtom);

  // Convex content takes priority; fall back to stream buffer while streaming.
  const displayContent = content || streamContent;

  if (role === "user") {
    return (
      <div className="terminal-glow-strong text-terminal-green mb-2">
        <span className="text-terminal-green-dim mr-2">&gt;</span>
        {displayContent}
      </div>
    );
  }

  return (
    <div className="text-terminal-green-dim mb-4 whitespace-pre-wrap pl-4">
      {displayContent}
    </div>
  );
});
