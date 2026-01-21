"use client";

import { useRef } from "react";
import type { Id } from "../../convex/_generated/dataModel";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  turnId?: Id<"machineTurns">;
  devMode?: boolean;
  onLongPress?: (turnId: Id<"machineTurns">) => void;
}

export function ChatMessage({
  role,
  content,
  turnId,
  devMode,
  onLongPress,
}: ChatMessageProps) {
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);

  const handlePressStart = () => {
    if (!devMode || !turnId || !onLongPress) return;
    longPressTimer.current = setTimeout(() => {
      onLongPress(turnId);
    }, 500); // 500ms long press
  };

  const handlePressEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <div
      className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2 ${
          role === "user"
            ? "bg-blue-600 text-white"
            : "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
        } ${devMode && turnId ? "cursor-pointer select-none" : ""}`}
        onMouseDown={handlePressStart}
        onMouseUp={handlePressEnd}
        onMouseLeave={handlePressEnd}
        onTouchStart={handlePressStart}
        onTouchEnd={handlePressEnd}
      >
        <p className="whitespace-pre-wrap">{content}</p>
        {devMode && turnId && (
          <p className="mt-1 text-xs opacity-50">Long-press for debug</p>
        )}
      </div>
    </div>
  );
}
