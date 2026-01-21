"use client";

import type { Doc } from "../../convex/_generated/dataModel";

interface SidebarProps {
  goals: Doc<"goals">[];
  reminders: Doc<"reminders">[];
  onClose: () => void;
  onNewSession: () => void;
}

export function Sidebar({ goals, reminders, onClose, onNewSession }: SidebarProps) {
  return (
    <aside className="flex w-80 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h2 className="font-semibold text-gray-900 dark:text-white">Dashboard</h2>
        <div className="flex gap-1">
          <button
            onClick={onNewSession}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            title="New session"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            title="Hide sidebar (Option+B)"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Goals Section */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <svg className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-sm font-medium text-gray-900 dark:text-white">
              Active Goals ({goals.length})
            </h3>
          </div>
          {goals.length > 0 ? (
            <ul className="space-y-2">
              {goals.map((goal) => (
                <GoalItem key={goal._id} goal={goal} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No active goals. Chat with Automaton to set one!
            </p>
          )}
        </section>

        {/* Reminders Section */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <svg className="h-4 w-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-sm font-medium text-gray-900 dark:text-white">
              Pending Reminders ({reminders.length})
            </h3>
          </div>
          {reminders.length > 0 ? (
            <ul className="space-y-2">
              {reminders.map((reminder) => (
                <ReminderItem key={reminder._id} reminder={reminder} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No pending reminders.
            </p>
          )}
        </section>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-200 p-4 dark:border-gray-700">
        <p className="text-xs text-gray-400 dark:text-gray-500">
          Powered by Markov Machines
        </p>
      </div>
    </aside>
  );
}

function GoalItem({ goal }: { goal: Doc<"goals"> }) {
  const milestonesComplete = goal.milestones.filter((m) => m.completed).length;
  const milestonesTotal = goal.milestones.length;
  const progress = milestonesTotal > 0 ? (milestonesComplete / milestonesTotal) * 100 : 0;

  return (
    <li className="rounded-lg bg-gray-50 p-3 dark:bg-gray-700/50">
      <div className="mb-1 flex items-start justify-between">
        <h4 className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">
          {goal.title}
        </h4>
        {goal.deadline && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {formatDate(goal.deadline)}
          </span>
        )}
      </div>
      {milestonesTotal > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>Progress</span>
            <span>{milestonesComplete}/{milestonesTotal}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-600">
            <div
              className="h-1.5 rounded-full bg-blue-500 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </li>
  );
}

function ReminderItem({ reminder }: { reminder: Doc<"reminders"> }) {
  const isOverdue = reminder.dueAt && reminder.dueAt < Date.now();

  return (
    <li className={`rounded-lg p-3 ${isOverdue ? "bg-red-50 dark:bg-red-900/20" : "bg-gray-50 dark:bg-gray-700/50"}`}>
      <div className="flex items-start gap-2">
        <svg
          className={`mt-0.5 h-4 w-4 flex-shrink-0 ${isOverdue ? "text-red-500" : "text-gray-400"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        <div className="flex-1 min-w-0">
          <h4 className={`text-sm font-medium line-clamp-1 ${isOverdue ? "text-red-700 dark:text-red-400" : "text-gray-900 dark:text-white"}`}>
            {reminder.title}
          </h4>
          {reminder.dueAt && (
            <p className={`text-xs ${isOverdue ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>
              {isOverdue ? "Overdue: " : "Due: "}
              {formatDateTime(reminder.dueAt)}
            </p>
          )}
          {reminder.recurrence && (
            <span className="mt-1 inline-block rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-600 dark:text-gray-300">
              {reminder.recurrence.type}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
