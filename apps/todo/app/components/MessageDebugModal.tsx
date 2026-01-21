"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

interface MessageDebugModalProps {
  turnId: Id<"machineTurns">;
  onClose: () => void;
}

export function MessageDebugModal({ turnId, onClose }: MessageDebugModalProps) {
  const steps = useQuery(api.machineSteps.getByTurn, { turnId });

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-6 dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">
            Turn Steps ({steps?.length ?? 0})
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {!steps ? (
          <p className="text-gray-500 dark:text-gray-400">Loading...</p>
        ) : steps.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">No steps found</p>
        ) : (
          <div className="space-y-4">
            {steps.map((step) => (
              <div
                key={step._id}
                className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                    Step {step.stepNumber}: {step.yieldReason}
                  </span>
                  {step.done && (
                    <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900/30 dark:text-green-400">
                      final
                    </span>
                  )}
                </div>

                {step.response && (
                  <div className="mb-3">
                    <p className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                      Response:
                    </p>
                    <p className="whitespace-pre-wrap rounded bg-gray-100 p-2 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                      {step.response}
                    </p>
                  </div>
                )}

                <details className="text-xs">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                    Messages ({step.messages?.length ?? 0})
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-100 p-2 text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                    {JSON.stringify(step.messages, null, 2)}
                  </pre>
                </details>

                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                    Active Node
                  </summary>
                  <p className="mt-2 rounded bg-gray-100 p-2 font-mono text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                    {step.activeNodeInstructions}...
                  </p>
                </details>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 border-t border-gray-200 pt-4 text-xs text-gray-400 dark:border-gray-700">
          Press <kbd className="rounded bg-gray-200 px-1 dark:bg-gray-700">Esc</kbd> or click outside to close
        </div>
      </div>
    </div>
  );
}
