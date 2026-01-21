"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

interface ThinkingIndicatorProps {
  sessionId: Id<"sessions">;
  startTime: number;
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
      <div className="max-w-[85%] rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-gray-100 dark:bg-gray-800 dark:ring-gray-700">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <span className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.3s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.15s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-blue-500" />
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            Thinking...
          </span>
        </div>

        {recentSteps && recentSteps.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3 dark:border-gray-700">
            {recentSteps.map((step) => (
              <div
                key={step._id}
                className="flex items-start gap-2 text-xs"
              >
                <StepIcon yieldReason={step.yieldReason} />
                <div className="flex-1">
                  <span className="font-medium text-gray-600 dark:text-gray-400">
                    Step {step.stepNumber}
                  </span>
                  <span className="ml-1 text-gray-400 dark:text-gray-500">
                    {formatYieldReason(step.yieldReason)}
                  </span>
                  {step.response && (
                    <p className="mt-0.5 text-gray-500 dark:text-gray-400 line-clamp-2">
                      {step.response.slice(0, 100)}
                      {step.response.length > 100 ? "..." : ""}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StepIcon({ yieldReason }: { yieldReason: string }) {
  const className = "h-4 w-4 flex-shrink-0";

  switch (yieldReason) {
    case "tool_use":
      return (
        <svg className={`${className} text-purple-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    case "end_turn":
      return (
        <svg className={`${className} text-green-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      );
    case "cede":
      return (
        <svg className={`${className} text-orange-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      );
    default:
      return (
        <svg className={`${className} text-gray-400`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
  }
}

function formatYieldReason(reason: string): string {
  switch (reason) {
    case "tool_use":
      return "using tool";
    case "end_turn":
      return "completed";
    case "cede":
      return "yielding";
    case "max_tokens":
      return "max tokens";
    default:
      return reason;
  }
}
