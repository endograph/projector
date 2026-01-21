"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

interface ThinkingIndicatorProps {
  sessionId: Id<"sessions">;
  startTime: number; // Only show steps created after this time
}

export function ThinkingIndicator({ sessionId, startTime }: ThinkingIndicatorProps) {
  const currentTurnSteps = useQuery(api.machineSteps.getCurrentTurnSteps, {
    sessionId,
  });
  // Filter to steps from this send, show only last 3
  const recentSteps = currentTurnSteps
    ?.filter((step) => step.createdAt > startTime)
    .slice(-3);

  return (
    <div className="flex justify-start">
      <div className="rounded-lg bg-gray-200 px-4 py-2 dark:bg-gray-700">
        <p className="text-gray-500 dark:text-gray-400">Thinking...</p>
        {recentSteps && recentSteps.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-gray-300 pt-2 dark:border-gray-600">
            {recentSteps.map((step) => (
              <div
                key={step._id}
                className="text-xs text-gray-400 dark:text-gray-500"
              >
                <span className="font-mono">
                  Step {step.stepNumber}: {step.yieldReason}
                </span>
                {step.response && (
                  <span className="ml-1 italic">
                    - &quot;{step.response.slice(0, 50)}
                    {step.response.length > 50 ? "..." : ""}&quot;
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
