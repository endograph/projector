"use client";

import Link from "next/link";

export function DevIndicator() {
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  return (
    <Link
      href="/dev/overview"
      className="fixed bottom-4 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-gray-800 text-white shadow-lg transition-transform hover:scale-110 hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-800 dark:hover:bg-gray-300"
      title="Open Dev Panel (Option+D)"
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
    </Link>
  );
}
