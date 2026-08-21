// App entry shared by the small authenticated history island and the full
// conversation UI. launch() mounts synchronously (flushSync) so a view
// transition's "new" snapshot already contains the conversation.

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { PastConversations } from "./PastConversations";

let client: ConvexReactClient | null = null;
let actionsUrl: string | undefined;
let root: Root | null = null;
let pastRoot: Root | null = null;
let openPastConversation: ((sessionId: string) => void) | null = null;

export function warm(): void {
  const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!client && url) client = new ConvexReactClient(url);
  actionsUrl =
    (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined) ??
    url?.replace(".convex.cloud", ".convex.site");
}

export function launch(opts: {
  initialMessage?: string;
  initialTopic?: string;
  sessionId?: string;
}): void {
  warm();
  const container = document.getElementById("app");
  if (!container) return;
  pastRoot?.unmount();
  pastRoot = null;
  root?.unmount();
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <StrictMode>
        <App
          client={client}
          actionsUrl={actionsUrl}
          initialMessage={opts.initialMessage}
          initialTopic={opts.initialTopic}
          sessionId={opts.sessionId}
        />
      </StrictMode>,
    );
  });
}

export function unmount(): void {
  root?.unmount();
  root = null;
  renderPastConversations();
}

export function mountPastConversations(onOpen: (sessionId: string) => void): void {
  openPastConversation = onOpen;
  renderPastConversations();
}

function renderPastConversations(): void {
  warm();
  const container = document.getElementById("past-conversations");
  if (!client || !container || !openPastConversation || pastRoot) return;
  pastRoot = createRoot(container);
  pastRoot.render(
    <StrictMode>
      <ConvexAuthProvider client={client}>
        <PastConversations onOpen={openPastConversation} />
      </ConvexAuthProvider>
    </StrictMode>,
  );
}
