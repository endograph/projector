"use client";

interface TerminalMessageProps {
  role: "user" | "assistant";
  content: string;
}

export function TerminalMessage({ role, content }: TerminalMessageProps) {
  if (role === "user") {
    return (
      <div className="terminal-glow-strong text-terminal-green mb-2">
        <span className="text-terminal-green-dim mr-2">&gt;</span>
        {content}
      </div>
    );
  }

  return (
    <div className="text-terminal-green-dim mb-4 whitespace-pre-wrap pl-4">
      {content}
    </div>
  );
}
