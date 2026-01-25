"use client";

interface DevTabProps {
  onResetSession: () => void;
}

export function DevTab({ onResetSession }: DevTabProps) {
  return (
    <div className="h-full overflow-auto">
      <div className="space-y-4">
        <div className="text-terminal-green-dim text-xs uppercase tracking-wider mb-2">
          Session Controls
        </div>

        <button
          onClick={onResetSession}
          className="px-4 py-2 border border-terminal-green text-terminal-green hover:bg-terminal-green hover:text-terminal-bg transition-colors font-mono text-sm"
        >
          [Reset Session]
        </button>

        <p className="text-terminal-green-dim text-xs mt-2">
          Starts a fresh session with a new instance tree.
        </p>
      </div>
    </div>
  );
}
