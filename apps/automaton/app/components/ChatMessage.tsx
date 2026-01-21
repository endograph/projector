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
    }, 500);
  };

  const handlePressEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Parse and format the content
  const formattedContent = formatMessageContent(content);

  return (
    <div
      className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          role === "user"
            ? "bg-blue-600 text-white"
            : "bg-white text-gray-900 shadow-sm ring-1 ring-gray-100 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700"
        } ${devMode && turnId ? "cursor-pointer select-none" : ""}`}
        onMouseDown={handlePressStart}
        onMouseUp={handlePressEnd}
        onMouseLeave={handlePressEnd}
        onTouchStart={handlePressStart}
        onTouchEnd={handlePressEnd}
      >
        <div className="prose prose-sm dark:prose-invert max-w-none">
          {formattedContent}
        </div>
        {devMode && turnId && (
          <p className="mt-2 text-xs opacity-50">Long-press for debug info</p>
        )}
      </div>
    </div>
  );
}

function formatMessageContent(content: string) {
  // Split by code blocks and format
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, i) => {
    if (part.startsWith("```")) {
      // Code block
      const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
      if (match) {
        const [, lang, code] = match;
        return (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-lg bg-gray-100 p-3 text-sm dark:bg-gray-900"
          >
            {lang && (
              <div className="mb-1 text-xs text-gray-500">{lang}</div>
            )}
            <code>{code.trim()}</code>
          </pre>
        );
      }
    }

    // Regular text - handle line breaks and lists
    return (
      <div key={i} className="whitespace-pre-wrap">
        {formatInlineContent(part)}
      </div>
    );
  });
}

function formatInlineContent(text: string) {
  // Handle bold, italic, code
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);

  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-gray-100 px-1 py-0.5 text-sm dark:bg-gray-700"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}
