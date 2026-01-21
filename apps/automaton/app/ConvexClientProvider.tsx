"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

  const convex = useMemo(() => {
    if (!convexUrl) return null;
    return new ConvexReactClient(convexUrl);
  }, [convexUrl]);

  if (!convex) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-8">
        <div className="max-w-lg text-center space-y-6">
          <h1 className="text-3xl font-bold text-purple-400">
            Automaton Setup Required
          </h1>
          <div className="text-gray-300 space-y-4 text-left">
            <p>
              To use Automaton, you need to configure Convex. Run the following
              command:
            </p>
            <pre className="bg-gray-800 p-4 rounded-lg text-sm overflow-x-auto">
              <code>cd apps/automaton && bunx convex dev</code>
            </pre>
            <p>
              This will create a <code className="text-purple-300">.env.local</code>{" "}
              file with your Convex deployment URL. Then restart the dev server.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
