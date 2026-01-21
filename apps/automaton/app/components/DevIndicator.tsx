"use client";

interface DevIndicatorProps {
  devMode: boolean;
  onToggle: () => void;
}

export function DevIndicator({ devMode, onToggle }: DevIndicatorProps) {
  if (process.env.NODE_ENV === "production" && !devMode) {
    return null;
  }

  return (
    <button
      onClick={onToggle}
      className={`fixed bottom-4 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full shadow-lg transition-all hover:scale-110 ${
        devMode
          ? "bg-yellow-500 text-white hover:bg-yellow-600"
          : "bg-gray-800 text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-800 dark:hover:bg-gray-300"
      }`}
      title={`${devMode ? "Disable" : "Enable"} dev mode (Option+D)`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
      >
        <path d="m18 16 4-4-4-4" />
        <path d="m6 8-4 4 4 4" />
        <path d="m14.5 4-5 16" />
      </svg>
    </button>
  );
}
