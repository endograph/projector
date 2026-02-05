"use client";

interface DevTabProps {
  onResetSession: () => void;
  onResetToFoo: () => void;
}

export function DevTab({ onResetSession, onResetToFoo }: DevTabProps) {
  return (
    <div className="h-full overflow-auto">
      <div className="space-y-4">
        <div className="text-terminal-green-dim text-xs uppercase tracking-wider mb-2">
          Session Controls
        </div>

        <div className="flex gap-2">
          <button
            onClick={onResetSession}
            className="px-4 py-2 border border-terminal-green text-terminal-green hover:bg-terminal-green hover:text-terminal-bg transition-colors font-mono text-sm"
          >
            [Reset Session]
          </button>

          <button
            onClick={onResetToFoo}
            className="px-4 py-2 border border-terminal-green text-terminal-green hover:bg-terminal-green hover:text-terminal-bg transition-colors font-mono text-sm"
          >
            [Reset to Foo]
          </button>
        </div>

        <p className="text-terminal-green-dim text-xs mt-2">
          Starts a fresh session with a new instance tree.
        </p>
      </div>
    </div>
  );
}
