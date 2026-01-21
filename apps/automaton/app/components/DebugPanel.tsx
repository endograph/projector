"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

interface DebugPanelProps {
  turnId: Id<"machineTurns">;
  onClose: () => void;
}

type TabType = "steps" | "instance" | "messages";

export function DebugPanel({ turnId, onClose }: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>("steps");
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  const turn = useQuery(api.machineTurns.get, { id: turnId });
  const steps = useQuery(api.machineSteps.getByTurn, { turnId });

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const tabs: { id: TabType; label: string; count?: number }[] = [
    { id: "steps", label: "Steps", count: steps?.length },
    { id: "instance", label: "Instance" },
    { id: "messages", label: "Messages", count: turn?.messages?.length },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">
              Debug Panel
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Turn: {turnId.slice(0, 8)}...
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200 px-4 dark:border-gray-700">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-blue-500 text-blue-600 dark:text-blue-400"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-700">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "steps" && (
            <StepsTab steps={steps ?? []} expandedStep={expandedStep} setExpandedStep={setExpandedStep} />
          )}
          {activeTab === "instance" && (
            <InstanceTab instance={turn?.instance} />
          )}
          {activeTab === "messages" && (
            <MessagesTab messages={turn?.messages ?? []} />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 px-6 py-3 dark:border-gray-700">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Press <kbd className="rounded bg-gray-200 px-1 dark:bg-gray-700">Esc</kbd> or click outside to close
          </p>
        </div>
      </div>
    </div>
  );
}

interface StepsTabProps {
  steps: Array<{
    _id: string;
    stepNumber: number;
    yieldReason: string;
    response: string;
    done: boolean;
    messages: unknown[];
    instance: unknown;
    activeNodeInstructions: string;
  }>;
  expandedStep: string | null;
  setExpandedStep: (id: string | null) => void;
}

function StepsTab({ steps, expandedStep, setExpandedStep }: StepsTabProps) {
  if (steps.length === 0) {
    return <p className="text-gray-500 dark:text-gray-400">No steps found.</p>;
  }

  return (
    <div className="space-y-3">
      {steps.map((step) => (
        <div
          key={step._id}
          className="rounded-lg border border-gray-200 dark:border-gray-700"
        >
          <button
            onClick={() => setExpandedStep(expandedStep === step._id ? null : step._id)}
            className="flex w-full items-center justify-between p-4 text-left"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm font-medium dark:bg-gray-700">
                {step.stepNumber}
              </span>
              <div>
                <span className="font-medium text-gray-900 dark:text-white">
                  {step.yieldReason}
                </span>
                {step.done && (
                  <span className="ml-2 rounded bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900/30 dark:text-green-400">
                    final
                  </span>
                )}
              </div>
            </div>
            <svg
              className={`h-5 w-5 text-gray-400 transition-transform ${expandedStep === step._id ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {expandedStep === step._id && (
            <div className="border-t border-gray-200 p-4 dark:border-gray-700">
              {step.response && (
                <div className="mb-4">
                  <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Response:</h4>
                  <pre className="whitespace-pre-wrap rounded-lg bg-gray-100 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                    {step.response}
                  </pre>
                </div>
              )}

              <div className="mb-4">
                <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Active Node:</h4>
                <p className="rounded-lg bg-gray-100 p-3 font-mono text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-400">
                  {step.activeNodeInstructions}...
                </p>
              </div>

              <details className="group">
                <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                  View messages ({step.messages?.length ?? 0})
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-gray-100 p-3 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                  {JSON.stringify(step.messages, null, 2)}
                </pre>
              </details>

              <details className="group mt-3">
                <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                  View instance snapshot
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-gray-100 p-3 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                  {JSON.stringify(step.instance, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function InstanceTab({ instance }: { instance: unknown }) {
  if (!instance) {
    return <p className="text-gray-500 dark:text-gray-400">No instance data.</p>;
  }

  return (
    <pre className="overflow-auto rounded-lg bg-gray-100 p-4 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
      {JSON.stringify(instance, null, 2)}
    </pre>
  );
}

function MessagesTab({ messages }: { messages: unknown[] }) {
  if (messages.length === 0) {
    return <p className="text-gray-500 dark:text-gray-400">No messages.</p>;
  }

  return (
    <div className="space-y-3">
      {messages.map((msg, i) => (
        <div
          key={i}
          className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
        >
          <pre className="overflow-auto text-xs text-gray-800 dark:text-gray-200">
            {JSON.stringify(msg, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
