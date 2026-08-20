// The conversation: chat column + inspector. Same paper and ink as the
// marketing page — the visitor should feel like the page folded into an app,
// not like they navigated somewhere else.

import { ConvexAuthProvider, useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { ConvexReactClient, useAction, useMutation, useQuery } from "convex/react";
import { TextAlignStart } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  createMachineEffigy,
  createOptimisticEffigy,
  type OptimisticEffigy,
} from "@projectors/core/client";
import { recordStoredSession } from "../sessions-store";
import {
  AnonymousMessageError,
  getGuestSecret,
  sendAnonymousMessage,
} from "../guest-access";
import { EXPLAINERS } from "./explainers";
import { Inspector, PaneIcon } from "./Inspector";
import { createSurfaceApi } from "./surface/api";
import { SurfaceHost } from "./surface/Surface";

// The side panes' visibility and widths are machine state (the ui node's
// panes state in the charter). The client goes through the framework's own
// path: an optimistic effigy over the client snapshot, where cmd+j and the
// pane buttons run the setPanes command — the same action the agent holds as
// a tool — with an optimistic overlay that retires when the command's
// residue comes back in the snapshot. The command is the state change; the
// UI is just a projection of it.
type Panes = {
  app: boolean;
  inspector: boolean;
  appWidth: number;
  inspectorWidth: number;
};
const DEFAULT_PANES: Panes = { app: false, inspector: false, appWidth: 22, inspectorWidth: 26 };
const PANE_MIN_REM = 14;
const PANE_MAX_REM = 44;

type StateEntry = { value: unknown; address: unknown };

// Depth-first search for a realized state entry in the projected client
// instance tree. Unrealized states (never written) have no entry; callers
// fall back to their init-equivalent default.
function findStateEntry(value: unknown, key: string): StateEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as {
    states?: Array<{ key?: string; value?: unknown; address?: unknown }>;
    children?: unknown[];
  };
  const entry = Array.isArray(record.states)
    ? record.states.find((s) => s?.key === key)
    : undefined;
  if (entry) return { value: entry.value, address: entry.address };
  for (const child of record.children ?? []) {
    const found = findStateEntry(child, key);
    if (found) return found;
  }
  return undefined;
}

type PanesEntry = { value: Panes; address: unknown };

function findPanesEntry(value: unknown): PanesEntry | undefined {
  const entry = findStateEntry(value, "panes");
  const v = entry?.value as Partial<Panes> | undefined;
  if (v && typeof v.app === "boolean" && typeof v.inspector === "boolean") {
    return {
      address: entry?.address,
      value: {
        app: v.app,
        inspector: v.inspector,
        appWidth: typeof v.appWidth === "number" ? v.appWidth : DEFAULT_PANES.appWidth,
        inspectorWidth:
          typeof v.inspectorWidth === "number" ? v.inspectorWidth : DEFAULT_PANES.inspectorWidth,
      },
    };
  }
  return undefined;
}

type SurfaceMeta = { version: number; title: string; lastError: string | null };
type SurfaceArtifact = { version: number; title: string; source: string };

// The surface's TSX is a server-side artifact (sessions.get joins the latest
// artifacts row); machine state carries only the small meta — lastError is
// the piece the pane still reads from it.
function findSurface(
  instances: unknown,
  artifact: SurfaceArtifact | null | undefined,
): (SurfaceMeta & { source: string }) | null {
  if (!artifact?.source) return null;
  const meta = findStateEntry(instances, "appSurface")?.value as Partial<SurfaceMeta> | undefined;
  return {
    version: artifact.version,
    title: artifact.title,
    lastError: typeof meta?.lastError === "string" ? meta.lastError : null,
    source: artifact.source,
  };
}

type AppProps = {
  client: ConvexReactClient | null;
  actionsUrl?: string;
  initialMessage?: string;
  initialTopic?: string;
  sessionId?: string;
};

// Mobile Safari has two viewports: the layout viewport and the actually
// visible one. Browser chrome and the software keyboard resize/offset only
// the latter, so a fixed inset:0 shell can wind up underneath either. Keep a
// pair of CSS variables in sync with the visual viewport; CSS still has a
// 100dvh fallback for browsers without the API.
function useAppViewport() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const narrow = matchMedia("(max-width: 900px)");
    const viewport = window.visualViewport;
    let frame = 0;
    let widest = viewport?.width ?? window.innerWidth;
    let largestHeight = viewport?.height ?? window.innerHeight;

    const isEditing = () => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        (active.matches("input, textarea, select") || active.isContentEditable)
      );
    };

    const paint = () => {
      frame = 0;
      if (!narrow.matches) {
        root.style.removeProperty("--app-viewport-height");
        root.style.removeProperty("--app-viewport-top");
        delete root.dataset.appKeyboard;
        return;
      }

      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const top = Math.max(0, viewport?.offsetTop ?? 0);
      if (Math.abs(width - widest) > 1) {
        widest = width;
        largestHeight = height;
      } else {
        largestHeight = Math.max(largestHeight, height);
      }

      root.style.setProperty("--app-viewport-height", `${height}px`);
      root.style.setProperty("--app-viewport-top", `${top}px`);

      // Dropping the home-indicator inset while the keyboard is present
      // avoids the large dead band iOS otherwise leaves above the keyboard.
      const layoutGap = Math.max(0, window.innerHeight - height - top);
      const keyboardOpen =
        isEditing() && (largestHeight - height > 96 || layoutGap > 96);
      root.toggleAttribute("data-app-keyboard", keyboardOpen);
    };

    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };

    paint();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    narrow.addEventListener("change", schedule);
    addEventListener("orientationchange", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      narrow.removeEventListener("change", schedule);
      removeEventListener("orientationchange", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
      delete root.dataset.appKeyboard;
    };
  }, []);
}

export function App({ client, actionsUrl, initialMessage, initialTopic, sessionId }: AppProps) {
  useAppViewport();
  if (!client) {
    return (
      <div className="app">
        <AppNav />
        <div className="app-body">
          <div className="app-chat">
            <div className="app-scroll">
              <div className="app-thread">
                <div className="msg">
                  <span className="msg-role">setup</span>
                  <p className="msg-body">
                    The conversation backend isn't configured yet. Set{" "}
                    <code>VITE_CONVEX_URL</code> in <code>apps/site/.env.local</code> and run{" "}
                    <code>npx convex dev</code> — see apps/site/README.md.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <ConvexAuthProvider client={client}>
      <Conversation
        actionsUrl={actionsUrl}
        initialMessage={initialMessage}
        initialTopic={initialTopic}
        sessionId={sessionId}
      />
    </ConvexAuthProvider>
  );
}

// The marketing header, continued: same brand, same two CTA steps centered,
// same Why/Docs/theme cluster on the right — the page folded into an app, so
// the chrome shouldn't change vocabulary.
function AppNav({ sessionId }: { sessionId?: string }) {
  const exit = (e: React.MouseEvent) => {
    e.preventDefault();
    if (history.state?.app) history.back();
    else location.assign("/");
  };
  return (
    <header className="app-nav">
      <div className="app-nav-left">
        <a className="nav-brand" href="/" onClick={exit}>projector</a>
        {sessionId && <span className="app-nav-session">s/{sessionId.slice(0, 12)}</span>}
      </div>
      <div className="start" aria-label="Project actions">
        <div className="steps">
          <InstallStep />
          <a className="step step-github" href="https://github.com/markov-machines/markov-machines" aria-label="Star markov-machines on GitHub">
            <svg className="i-gh" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.56A11.52 11.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>
            <span className="step-body"><span className="step-label">GitHub</span><code>Star</code></span>
            <span className="step-act step-stars"><svg className="i-star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.9 6.2 21l1.1-6.5L2.6 9.9 9.1 9z"/></svg><span className="count">1</span><span className="vh">stars</span></span>
          </a>
        </div>
      </div>
      <nav className="nav-links app-nav-links">
        <a href="/#why">Why</a>
        <a href="/#docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>
  );
}

function PaneCloseIcon() {
  return (
    <svg className="pane-toggle-close" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function InstallStep() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText("npm i @projectors/core");
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {}
  };
  // data-copy is inert here (the landing's copy script ran before this
  // mounted) but keys the same hide-on-mobile CSS as the landing's step.
  return (
    <button className="step" type="button" data-copy="" data-copied={copied ? "" : undefined} onClick={() => void copy()}>
      <span className="step-body"><span className="step-label">Install</span><code>npm i @projectors/core</code></span>
      <span className="step-act"><span className="vh">Copy</span><svg className="i-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><svg className="i-done" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11"/></svg></span>
    </button>
  );
}

// Mirrors the marketing page's toggle: flip from whatever is in effect,
// persist the choice, and keep the (hidden) marketing button's icon in sync
// so nothing is stale when the visitor goes back.
function ThemeToggle() {
  const effective = () =>
    document.documentElement.dataset.theme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [mode, setMode] = useState(effective);
  useEffect(() => {
    const sysDark = matchMedia("(prefers-color-scheme: dark)");
    const paint = () => setMode(effective());
    sysDark.addEventListener("change", paint);
    return () => sysDark.removeEventListener("change", paint);
  }, []);
  const toggle = () => {
    const next = effective() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    const pageButton = document.querySelector(".page .theme");
    pageButton?.setAttribute("data-mode", next);
    pageButton?.setAttribute("aria-label", `Theme: ${next}`);
    setMode(next);
  };
  return (
    <button className="theme" type="button" data-mode={mode} aria-label={`Theme: ${mode}`} onClick={toggle}>
      <svg className="i-light" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 .9v1.8M8 13.3v1.8M15.1 8h-1.8M2.7 8H.9M13 3l-1.3 1.3M4.3 11.7 3 13M13 13l-1.3-1.3M4.3 4.3 3 3"/></svg>
      <svg className="i-dark" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A6 6 0 1 1 6.4 2.5a4.8 4.8 0 0 0 7.1 7.1Z"/></svg>
      <svg className="i-drop" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6c2.7 3 4.4 5.2 4.4 7.1a4.4 4.4 0 0 1-8.8 0c0-1.9 1.7-4.1 4.4-7.1Z"/></svg>
    </button>
  );
}

type LocalMessage = {
  key: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
};

type PaneAgentNotice = {
  id: string;
  content: string;
  pending?: boolean;
};

const pendingMessageKey = (sessionId: string) => `projector:pending-message:${sessionId}`;

function Conversation({ actionsUrl, initialMessage, initialTopic, sessionId: sessionIdProp }: {
  actionsUrl?: string;
  initialMessage?: string;
  initialTopic?: string;
  sessionId?: string;
}) {
  const [sessionId, setSessionId] = useState<Id<"sessions"> | null>(
    (sessionIdProp as Id<"sessions">) ?? null,
  );
  const [optimistic, setOptimistic] = useState<LocalMessage[]>([]);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [finalResponseStarted, setFinalResponseStarted] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [authPrompt, setAuthPrompt] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const guestSecret = useMemo(getGuestSecret, []);
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();

  const createSession = useMutation(api.sessions.create);
  const sendMessage = useAction(api.agent.sendMessage);
  const openTopic = useMutation(api.topics.open);
  const sendCommand = useMutation(api.sessions.sendCommand);

  const session = useQuery(api.sessions.get, sessionId ? { sessionId } : "skip");

  // The effigy: the framework's client-side stand-in for the machine. Its
  // send transport is the sessions.sendCommand mutation; refs keep the
  // once-created effigy pointed at the live session and mutation.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const sendCommandRef = useRef(sendCommand);
  sendCommandRef.current = sendCommand;
  const beginPaneAgentNoticeRef = useRef<(callId: string) => void>(() => {});
  // TInstances is `any`: the site has no generated client-instance types yet,
  // and the command surface is discovered from the snapshot at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const effigyRef = useRef<OptimisticEffigy<any> | null>(null);
  if (!effigyRef.current) {
    effigyRef.current = createOptimisticEffigy(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createMachineEffigy<any>(async (message) => {
        const id = sessionIdRef.current;
        if (!id) throw new Error("No active session");
        const result = await sendCommandRef.current({ sessionId: id, message, guestSecret });
        if (message.name === "appPanePing") {
          beginPaneAgentNoticeRef.current(message.callId);
        }
        return result;
      }),
    );
  }
  const effigy = effigyRef.current;

  const snapshot = (
    session as
      | { clientSnapshot?: { instance?: unknown; recentCommandResidue?: string[] } }
      | undefined
  )?.clientSnapshot;
  useEffect(() => {
    if (!snapshot) return;
    effigy.setRecentCommandResidue(snapshot.recentCommandResidue ?? []);
    effigy.setInstances(snapshot.instance ?? null);
  }, [effigy, snapshot]);
  const [, bumpEffigyVersion] = useState(0);
  useEffect(
    () => effigy.subscribe(() => bumpEffigyVersion((v) => v + 1)),
    [effigy],
  );

  // The surface api is the effigy itself, thinly wrapped — agent-authored UI
  // reads the same projection and runs the same commands as the shell.
  const surfaceApi = useMemo(() => createSurfaceApi(effigy), [effigy]);
  const surfaceArtifact = (session as { surface?: SurfaceArtifact | null } | undefined)?.surface;
  const surface = findSurface(effigy.getInstances(), surfaceArtifact);
  const reportSurfaceError = useCallback(
    (error: string) => {
      if (!sessionIdRef.current) return;
      void effigy
        .getCommand("reportSurfaceError")
        .run({ error } as never)
        .catch(() => {});
    },
    [effigy],
  );

  // Panes as the effigy sees them: durable state plus pending optimistic
  // overlays. A drag previews its width locally until release commits it.
  const panesEntry = findPanesEntry(effigy.getInstances());
  const [dragWidth, setDragWidth] = useState<{ pane: "app" | "inspector"; rem: number } | null>(
    null,
  );
  const basePanes = panesEntry?.value ?? DEFAULT_PANES;
  const panes: Panes = {
    ...basePanes,
    ...(dragWidth?.pane === "app" ? { appWidth: dragWidth.rem } : {}),
    ...(dragWidth?.pane === "inspector" ? { inspectorWidth: dragWidth.rem } : {}),
  };

  const runSetPanes = useCallback(
    (patch: Partial<Panes>) => {
      if (!sessionIdRef.current) return;
      const entry = findPanesEntry(effigy.getInstances());
      const command = effigy.getCommand("setPanes", {
        optimistic: (ctx) => {
          if (entry?.address) ctx.patchAt(entry.address as never, patch);
        },
      });
      void command.run(patch as never).catch(() => {});
    },
    [effigy],
  );
  const togglePane = useCallback(
    (pane: "app" | "inspector") => {
      const current = findPanesEntry(effigy.getInstances())?.value ?? DEFAULT_PANES;
      runSetPanes({ [pane]: !current[pane] });
    },
    [effigy, runSetPanes],
  );

  // Narrow viewports: the panes become view-local full-screen layers, one at
  // a time, over the chat. The machine's pane state keeps meaning "the agent
  // opened this" — the phone renders that as a badge on the toggle instead of
  // a takeover, and never writes view choice back through setPanes.
  const [isNarrow, setIsNarrow] = useState(() => matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const mq = matchMedia("(max-width: 900px)");
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [layer, setLayer] = useState<"app" | "inspector" | null>(null);
  const [closingLayer, setClosingLayer] = useState<"app" | "inspector" | null>(null);
  const layerCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (layerCloseTimerRef.current) clearTimeout(layerCloseTimerRef.current);
    },
    [],
  );
  const openMobileLayer = useCallback((pane: "app" | "inspector") => {
    if (layerCloseTimerRef.current) clearTimeout(layerCloseTimerRef.current);
    layerCloseTimerRef.current = null;
    setClosingLayer(null);
    setLayer(pane);
  }, []);
  const closeMobileLayer = useCallback(() => {
    if (!layer) return;
    const departing = layer;
    if (layerCloseTimerRef.current) clearTimeout(layerCloseTimerRef.current);
    setClosingLayer(departing);
    setLayer(null);
    layerCloseTimerRef.current = setTimeout(() => {
      setClosingLayer((current) => (current === departing ? null : current));
      layerCloseTimerRef.current = null;
    }, 220);
  }, [layer]);
  const toggleView = useCallback(
    (pane: "app" | "inspector") => {
      if (!isNarrow) {
        togglePane(pane);
        return;
      }
      if (layer === pane) closeMobileLayer();
      else openMobileLayer(pane);
    },
    [closeMobileLayer, isNarrow, layer, openMobileLayer, togglePane],
  );
  // On a phone the three views form a small horizontal pager:
  // app <- chat -> inspector. The edge controls move one page at a time;
  // desktop keeps the independent pane toggles and their shortcuts.
  const moveViewLeft = useCallback(() => {
    if (!isNarrow) {
      togglePane("app");
      return;
    }
    if (layer === "inspector") closeMobileLayer();
    else openMobileLayer("app");
  }, [closeMobileLayer, isNarrow, layer, openMobileLayer, togglePane]);
  const moveViewRight = useCallback(() => {
    if (!isNarrow) {
      togglePane("inspector");
      return;
    }
    if (layer === "app") closeMobileLayer();
    else openMobileLayer("inspector");
  }, [closeMobileLayer, isNarrow, layer, openMobileLayer, togglePane]);
  // "open the app pane" at the end of a surface-writing response: view-local
  // on a phone, the machine's own setPanes on a desktop.
  const openAppPane = useCallback(() => {
    if (isNarrow) openMobileLayer("app");
    else runSetPanes({ app: true });
  }, [isNarrow, openMobileLayer, runSetPanes]);

  // Dragging previews per pointer frame; on release the final width goes
  // through the same setPanes command as everything else.
  const startResize = useCallback(
    (pane: "app" | "inspector") => (e: React.PointerEvent) => {
      e.preventDefault();
      const body = (e.currentTarget as HTMLElement).closest(".app-body");
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const widthKey = pane === "app" ? "appWidth" : "inspectorWidth";
      document.documentElement.setAttribute("data-resizing", "");
      const widthAt = (ev: PointerEvent) => {
        const px = pane === "app" ? ev.clientX - rect.left : rect.right - ev.clientX;
        return Math.min(PANE_MAX_REM, Math.max(PANE_MIN_REM, px / rootPx));
      };
      const onMove = (ev: PointerEvent) => setDragWidth({ pane, rem: widthAt(ev) });
      const onUp = (ev: PointerEvent) => {
        removeEventListener("pointermove", onMove);
        document.documentElement.removeAttribute("data-resizing");
        setDragWidth(null);
        runSetPanes({ [widthKey]: Math.round(widthAt(ev) * 10) / 10 });
      };
      addEventListener("pointermove", onMove);
      addEventListener("pointerup", onUp, { once: true });
    },
    [runSetPanes],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editing = e.composedPath().some(
        (target) =>
          target instanceof HTMLElement &&
          (target.matches("input, textarea, select") || target.isContentEditable),
      );
      if (
        isNarrow &&
        !e.defaultPrevented &&
        !e.isComposing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !editing &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        if (e.key === "ArrowLeft") moveViewLeft();
        else moveViewRight();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        toggleView("inspector");
      } else if (key === "b") {
        e.preventDefault();
        toggleView("app");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [isNarrow, moveViewLeft, moveViewRight, toggleView]);

  // The conversation is the demo's default keyboard destination. Printable
  // keys pressed outside an editor flow into the composer, while embedded
  // surfaces can keep keys they explicitly handle by preventing the event.
  useEffect(() => {
    const onType = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        e.key.length !== 1
      ) {
        return;
      }
      const editing = e.composedPath().some(
        (target) =>
          target instanceof HTMLElement &&
          (target.matches("input, textarea, select") || target.isContentEditable),
      );
      if (editing) return;

      const field = inputRef.current;
      if (!field || field.disabled || field.readOnly) return;
      e.preventDefault();
      field.focus({ preventScroll: true });
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? field.value.length;
      const next = `${field.value.slice(0, start)}${e.key}${field.value.slice(end)}`;
      const caret = start + e.key.length;
      setInput(next);
      requestAnimationFrame(() => field.setSelectionRange(caret, caret));
    };
    addEventListener("keydown", onType);
    return () => removeEventListener("keydown", onType);
  }, []);

  const serverMessages = useQuery(
    api.messages.list,
    sessionId ? { sessionId } : "skip",
  );

  const requestAuthentication = useCallback((draft: string) => {
    setInput(draft);
    setAuthPrompt(true);
    setWaitingSince(null);
  }, []);

  const send = useCallback(
    async (text: string, topic?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (authLoading) {
        setInput(trimmed);
        return;
      }
      if (!topic && !isAuthenticated && session?.anonymousTurnUsed) {
        requestAuthentication(trimmed);
        return;
      }

      let id = sessionId;
      if (!id) {
        id = await createSession({ guestSecret });
        setSessionId(id);
        history.replaceState({ app: true }, "", `/s/${id}`);
      }

      const optimisticKey = `opt-${Date.now()}-${crypto.randomUUID()}`;
      setOptimistic((prev) => [
        ...prev,
        { key: optimisticKey, role: "user", content: trimmed },
      ]);
      setFinalResponseStarted(false);
      setWaitingSince(Date.now());
      try {
        setSendError(null);
        // A topic turn is prebuilt server-side — a rich explainer lands as a
        // real frame with no model call, so the answer is effectively instant.
        if (topic) {
          await openTopic({ sessionId: id, topic, ask: trimmed, guestSecret });
        } else if (isAuthenticated) {
          await sendMessage({ sessionId: id, text: trimmed, guestSecret });
        } else if (actionsUrl) {
          await sendAnonymousMessage(actionsUrl, { sessionId: id, text: trimmed, guestSecret });
        } else {
          throw new Error("Anonymous message endpoint isn't configured");
        }
        setInput("");
        setAuthPrompt(false);
      } catch (error) {
        if (
          error instanceof AnonymousMessageError &&
          (error.code === "AUTH_REQUIRED" || error.code === "IP_RATE_LIMITED")
        ) {
          setOptimistic((prev) => prev.filter((message) => message.key !== optimisticKey));
          requestAuthentication(trimmed);
          return;
        }
        // The turn died server-side (model error, action crash). Anything the
        // machine durably did before the failure is already in the log; say
        // so instead of sitting silent.
        setSendError(
          "that turn hit an error before projector could answer — anything it already did is in the frame log; try sending again",
        );
      } finally {
        setWaitingSince(null);
      }
    },
    [
      actionsUrl,
      authLoading,
      createSession,
      guestSecret,
      isAuthenticated,
      openTopic,
      requestAuthentication,
      sendMessage,
      session?.anonymousTurnUsed,
      sessionId,
    ],
  );

  const beginGithubSignIn = useCallback(async () => {
    if (!sessionId || signingIn) return;
    const draft = input.trim();
    if (draft) sessionStorage.setItem(pendingMessageKey(sessionId), draft);
    setSigningIn(true);
    setSendError(null);
    try {
      await signIn("github", { redirectTo: location.href });
    } catch {
      setSigningIn(false);
      setSendError("GitHub sign-in couldn't start — please try again");
    }
  }, [input, sessionId, signIn, signingIn]);

  const resumedSendRef = useRef(false);
  useEffect(() => {
    if (authLoading || !isAuthenticated || !sessionId || resumedSendRef.current) return;
    const key = pendingMessageKey(sessionId);
    const draft = sessionStorage.getItem(key)?.trim();
    if (!draft) return;
    resumedSendRef.current = true;
    sessionStorage.removeItem(key);
    setAuthPrompt(false);
    setInput("");
    void send(draft);
  }, [authLoading, isAuthenticated, send, sessionId]);

  // The message typed on the marketing page is the first turn. StrictMode
  // double-invokes effects in dev; the ref makes the send once-only.
  const bootRef = useRef(false);
  useEffect(() => {
    if (authLoading) return;
    if (bootRef.current) return;
    bootRef.current = true;
    if (initialMessage) void send(initialMessage, initialTopic);
    else if (!sessionId) {
      void createSession({ guestSecret }).then((id) => {
        setSessionId(id);
        history.replaceState({ app: true }, "", `/s/${id}`);
      });
    }
  }, [authLoading, createSession, guestSecret, initialMessage, initialTopic, send, sessionId]);

  // Server truth replaces optimism as soon as it covers it: any optimistic
  // user message whose text has landed server-side is dropped.
  const server = serverMessages ?? [];
  const visibleOptimistic = optimistic.filter(
    (o) => !server.some((m) => m.role === o.role && m.content === o.content),
  );

  // A full-screen narrow pane hides the conversation, but it should not hide
  // a newly arriving agent turn. Existing messages establish the baseline;
  // only assistant rows first observed after that can become a notice. Stream
  // patches update the same notice without restarting its lifetime.
  const [paneAgentNotice, setPaneAgentNotice] = useState<PaneAgentNotice | null>(null);
  const seenPaneAgentMessagesRef = useRef<{
    sessionId: string | null;
    ids: Set<string>;
  }>({ sessionId: null, ids: new Set() });
  beginPaneAgentNoticeRef.current = (callId) => {
    if (!isNarrow || !layer) return;
    setPaneAgentNotice({
      id: `pending:${callId}`,
      content: "",
      pending: true,
    });
  };
  useEffect(() => {
    if (serverMessages === undefined) return;
    const assistantMessages = serverMessages.filter(
      (message) => message.role === "assistant" && message.content.trim(),
    );
    const tracker = seenPaneAgentMessagesRef.current;
    if (tracker.sessionId !== sessionId) {
      seenPaneAgentMessagesRef.current = {
        sessionId,
        ids: new Set(assistantMessages.map((message) => String(message.id))),
      };
      setPaneAgentNotice(null);
      return;
    }

    let newest: (typeof assistantMessages)[number] | undefined;
    for (const message of assistantMessages) {
      const id = String(message.id);
      if (!tracker.ids.has(id)) newest = message;
      tracker.ids.add(id);
    }

    setPaneAgentNotice((current) => {
      if (newest && isNarrow && layer) {
        return { id: String(newest.id), content: newest.content };
      }
      if (!current) return null;
      if (current.pending) return current;
      const updated = assistantMessages.find((message) => String(message.id) === current.id);
      return updated ? { ...current, content: updated.content } : null;
    });
  }, [serverMessages, sessionId, isNarrow, layer]);
  useEffect(() => {
    if (isNarrow && layer) return;
    setPaneAgentNotice(null);
  }, [isNarrow, layer]);
  useEffect(() => {
    // The cursor stays up while generation is pending. Once the first text
    // arrives, replacing the pending notice with the real message starts the
    // requested ten-second reading window.
    if (!paneAgentNotice || paneAgentNotice.pending) return;
    const noticeId = paneAgentNotice.id;
    const timeout = setTimeout(() => {
      setPaneAgentNotice((current) => (current?.id === noticeId ? null : current));
    }, 10_000);
    return () => clearTimeout(timeout);
  }, [paneAgentNotice?.id]);

  const streaming = server.some((m) => m.streamState === "streaming");

  // A poke (appPanePing) marks the session doc the moment its mutation
  // commits, so the thinking indicator starts as soon as the agent wake is
  // scheduled — not when the model's first token arrives. Survives refresh
  // mid-run; a timestamp a dead run stranded ages out client-side.
  const workStartedAt = (session as { workStartedAt?: number } | undefined)?.workStartedAt;
  const WORK_STALE_MS = 90_000;
  const [, bumpWorkTick] = useState(0);
  useEffect(() => {
    if (workStartedAt === undefined) return;
    const remaining = WORK_STALE_MS - (Date.now() - workStartedAt);
    if (remaining <= 0) return;
    const timeout = setTimeout(() => bumpWorkTick((v) => v + 1), remaining);
    return () => clearTimeout(timeout);
  }, [workStartedAt]);
  const agentWorking =
    workStartedAt !== undefined && Date.now() - workStartedAt < WORK_STALE_MS;
  // Each new poke re-arms the latch so its own turn blinks again.
  useEffect(() => {
    if (agentWorking) setFinalResponseStarted(false);
  }, [workStartedAt]);

  useEffect(() => {
    if ((waitingSince !== null || agentWorking) && streaming) setFinalResponseStarted(true);
  }, [waitingSince, agentWorking, streaming]);
  // Commentary is an assistant message too, but it does not finish the turn.
  // Keep the existing blinking rectangle up through that gap, then latch it
  // off once the final response starts so it cannot briefly reappear between
  // stream completion and the action returning.
  const thinking =
    (waitingSince !== null || agentWorking) && !streaming && !finalResponseStarted;

  // Every visited session lands in the device-local past-conversations list,
  // titled by its first user message (deep links included — the title fills
  // in once messages load).
  const firstUserText =
    server.find((m) => m.role === "user")?.content ??
    optimistic.find((m) => m.role === "user")?.content ??
    "";
  const threadTitle = session?.title?.trim() || firstUserText;
  useEffect(() => {
    if (sessionId) recordStoredSession(sessionId, threadTitle);
  }, [sessionId, threadTitle]);

  // One turn at a time: less a chat feed than pages with an input at the
  // bottom. When the speaker changes, the new turn scrolls to the top of the
  // screen and everything before it becomes history above the fold;
  // consecutive messages from the same speaker accumulate below the current
  // page top without re-paging. turnCount only moves on a speaker switch, so
  // optimistic→server row swaps and streaming growth never re-trigger the
  // sync. The thinking placeholder is not a turn — the page flips when the
  // agent actually starts saying something.
  const rendered = [
    ...server.map((m) => ({
      key: m.id,
      role: m.role,
      content: m.content,
      activationId: m.activationId,
      widget: m.widget,
      card: m.card,
      updatedSurface: m.updatedSurface === true,
      pending: m.streamState === "streaming",
    })),
    ...visibleOptimistic.map((m) => ({
      key: m.key,
      role: m.role,
      content: m.content,
      activationId: undefined as string | undefined,
      widget: undefined as string | undefined,
      card: undefined as { title: string; source: string } | undefined,
      updatedSurface: false,
      pending: false,
    })),
  ];
  let turnCount = 0;
  const items = rendered.map((m, i) => {
    const previous = rendered[i - 1];
    const speakerStart = i === 0 || previous.role !== m.role;
    // An autonomous activation has no visible user row to create a speaker
    // boundary. Its changed activation value arms a one-message latch: the
    // first assistant row starts a page, then later rows from that same run
    // retain the current scroll position.
    const activationStart =
      m.role === "assistant" &&
      previous?.role === "assistant" &&
      m.activationId !== undefined &&
      m.activationId !== previous.activationId;
    const turnStart = speakerStart || activationStart;
    if (turnStart) turnCount += 1;
    return { ...m, turnStart };
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const syncedOnce = useRef(false);
  useEffect(() => {
    if (turnCount === 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const starts = container.querySelectorAll<HTMLElement>("[data-turn-start]");
    const target = starts[starts.length - 1];
    if (!target) return;
    const top =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      24; // breathing room above the page top
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({
      top: Math.max(0, top),
      // The first sync (loading an existing session) is a cut, not a scroll.
      behavior: syncedOnce.current && !still ? "smooth" : "instant",
    });
    syncedOnce.current = true;
  }, [turnCount]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const draft = input.trim();
    if (!draft) return;
    if (!isAuthenticated && session?.anonymousTurnUsed) {
      requestAuthentication(draft);
      return;
    }
    setInput("");
    void send(draft);
  };

  const revealPaneAgentNotice = useCallback(() => {
    const messageId = paneAgentNotice?.id;
    setPaneAgentNotice(null);
    closeMobileLayer();
    if (!messageId) return;
    requestAnimationFrame(() => {
      const message = scrollRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${messageId}"]`,
      );
      message?.scrollIntoView({
        block: "start",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    });
  }, [closeMobileLayer, paneAgentNotice?.id]);

  // Wide: the machine's pane state renders as side-by-side panes. Narrow:
  // the view-local layer decides what's on screen.
  const showApp = isNarrow ? layer === "app" || closingLayer === "app" : panes.app;
  const showInspector = isNarrow
    ? layer === "inspector" || closingLayer === "inspector"
    : panes.inspector;

  return (
    <div className="app">
      <AppNav sessionId={sessionId ?? undefined} />
      <div className="app-body" data-layer-closing={closingLayer ?? undefined}>
        {/* The same contextual chips control panes at every size. On a phone
            they dock over the nav rule; desktop keeps them just below it. */}
        <button
          className="pane-btn pane-toggle pane-toggle-left"
          type="button"
          aria-label={
            isNarrow
              ? layer === "inspector" ? "Back to chat" : "Open app"
              : showApp ? "Close app pane (⌘B)" : "Open app pane (⌘B)"
          }
          title={isNarrow ? undefined : "⌘B"}
          aria-pressed={isNarrow ? undefined : showApp}
          data-mobile-hidden={isNarrow && layer === "app" ? "" : undefined}
          onClick={moveViewLeft}
        >
          {!isNarrow && showApp ? (
            <PaneCloseIcon />
          ) : (
            <>
              <PaneIcon side="left" />
              <span className="pane-toggle-label" aria-hidden="true">
                {isNarrow ? (layer === "inspector" ? "< chat" : "< app") : "app"}
              </span>
            </>
          )}
        </button>
        <button
          className="pane-btn pane-toggle pane-toggle-right"
          type="button"
          aria-label={
            isNarrow
              ? layer === "app" ? "Back to chat" : "Open inspector"
              : showInspector ? "Close inspector (⌘J)" : "Open inspector (⌘J)"
          }
          title={isNarrow ? undefined : "⌘J"}
          aria-pressed={isNarrow ? undefined : showInspector}
          data-mobile-hidden={isNarrow && layer === "inspector" ? "" : undefined}
          onClick={moveViewRight}
        >
          {!isNarrow && showInspector ? (
            <PaneCloseIcon />
          ) : (
            <>
              <span className="pane-toggle-label" aria-hidden="true">
                {isNarrow ? (layer === "app" ? "chat >" : "inspector >") : "inspector"}
              </span>
              <PaneIcon side="right" />
            </>
          )}
        </button>
        {showApp && (
          <AppPane
            width={panes.appWidth}
            onResizeStart={startResize("app")}
            surface={surface}
            api={surfaceApi}
            onSurfaceError={reportSurfaceError}
            onAsk={(text) => void send(text)}
          />
        )}
        <div className="app-chat">
          <div className="app-scroll" ref={scrollRef}>
            <div className="app-thread">
              {items.map((m) => (
                <Message
                  key={m.key}
                  messageId={String(m.key)}
                  role={m.role}
                  content={m.content}
                  widget={m.widget}
                  card={m.card}
                  api={surfaceApi}
                  pending={m.pending}
                  turnStart={m.turnStart}
                  onAsk={send}
                  onOpenAppPane={m.updatedSurface && !showApp ? openAppPane : undefined}
                />
              ))}
              {thinking && <Message role="assistant" content="" pending />}
              {sendError && (
                <div className="msg msg-send-error">
                  <span className="msg-role">error</span>
                  <p className="msg-body">{sendError}</p>
                </div>
              )}
            </div>
          </div>
          <form className="app-composer" onSubmit={submit} autoComplete="off">
            {authPrompt && !isAuthenticated ? (
              <div className="auth-gate" role="dialog" aria-label="Continue with GitHub">
                <div className="auth-gate-copy">
                  <strong>Continue with GitHub</strong>
                  <span>Sign in to send your next message.</span>
                </div>
                <button
                  className="auth-gate-github"
                  type="button"
                  disabled={signingIn}
                  onClick={() => void beginGithubSignIn()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.56A11.52 11.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>
                  {signingIn ? "opening GitHub…" : "Sign in with GitHub"}
                </button>
                <p className="auth-gate-public">Conversations are public. Don’t share secrets or personal information.</p>
              </div>
            ) : (
              <div className="talk-card">
                <input
                  ref={inputRef}
                  className="talk-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="ask projector…"
                  spellCheck={false}
                  enterKeyHint="send"
                  aria-label="Message projector"
                  // Preserve the keyboard through the landing-to-chat handoff,
                  // but don't summon it merely by opening an existing session.
                  autoFocus={Boolean(initialMessage) || !isNarrow}
                />
                <button className="talk-mic" type="button" disabled title="voice — coming soon" aria-label="Voice input, coming soon">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>
                </button>
                <button className="talk-go" type="submit" aria-label="Send">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>
                </button>
              </div>
            )}
          </form>
        </div>
        {showInspector && (
          <Inspector
            sessionId={sessionId}
            guestSecret={guestSecret}
            fallbackTitle={firstUserText}
            width={panes.inspectorWidth}
            onResizeStart={startResize("inspector")}
          />
        )}
        {isNarrow && layer && !paneAgentNotice && (
          <button
            className="pane-chat-return"
            type="button"
            onClick={closeMobileLayer}
            aria-label="Back to chat"
          >
            <span className="pane-chat-return-mark" aria-hidden="true">
              <TextAlignStart strokeWidth={1.75} />
            </span>
          </button>
        )}
        {isNarrow && layer && paneAgentNotice && (
          <button
            className="pane-agent-notice"
            type="button"
            onClick={revealPaneAgentNotice}
            data-pending={paneAgentNotice.pending ? "" : undefined}
            aria-label={
              paneAgentNotice.pending
                ? "Projector is responding"
                : "Open the conversation to read projector's new message"
            }
          >
            {paneAgentNotice.pending ? (
              <span className="pane-agent-notice-cursor" aria-hidden="true" />
            ) : (
              <>
                <span className="pane-agent-notice-role">projector</span>
                <span className="pane-agent-notice-copy">{paneAgentNotice.content}</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// The left pane: the app surface. Renders whatever writeAppSurface last
// wrote — the source is an immutable server-side artifact (every version is
// kept), with the small meta (version/title/lastError) in machine state.
function AppPane({ width, onResizeStart, surface, api, onSurfaceError, onAsk }: {
  width: number;
  onResizeStart: (e: React.PointerEvent) => void;
  surface: ReturnType<typeof findSurface>;
  api: ReturnType<typeof createSurfaceApi>;
  onSurfaceError: (error: string) => void;
  onAsk: (text: string) => void;
}) {
  return (
    <aside className="app-pane" aria-label="App pane" style={{ width: `min(${width}rem, 42vw)` }}>
      <div className="app-pane-head">
        <span className="app-pane-title">{surface?.title ? surface.title : "app"}</span>
        {surface && <span className="app-pane-version">v{surface.version}</span>}
      </div>
      <div className="app-pane-body">
        {surface ? (
          <>
            {surface.lastError && (
              <div className="surface-error">
                <p>{surface.lastError}</p>
                <button
                  type="button"
                  onClick={() =>
                    onAsk(`The app surface failed with: ${surface.lastError}. Please fix it.`)
                  }
                >
                  ask projector to fix it
                </button>
              </div>
            )}
            <SurfaceHost
              source={surface.source}
              version={surface.version}
              api={api}
              onError={onSurfaceError}
            />
          </>
        ) : (
          <p className="inspector-empty">
            nothing here yet — ask projector to draw something and it writes this pane as state
          </p>
        )}
      </div>
      <div className="pane-resize pane-resize-app" onPointerDown={onResizeStart} />
    </aside>
  );
}

function Message({ messageId, role, content, widget, card, api, pending, turnStart, onAsk, onOpenAppPane }: {
  messageId?: string;
  role: "user" | "assistant";
  content: string;
  widget?: string;
  card?: { title: string; source: string };
  api?: ReturnType<typeof createSurfaceApi>;
  pending?: boolean;
  turnStart?: boolean;
  onAsk?: (text: string) => void;
  onOpenAppPane?: () => void;
}) {
  // Rich renderings replace the prose (the prose is the LLM-facing
  // equivalent): an agent-authored card first, then prebuilt explainer
  // widgets. Unknown widget ids fall back to the prose.
  const Explainer = widget ? EXPLAINERS[widget] : undefined;
  return (
    <div
      className={`msg msg-${role}${pending ? " msg-pending" : ""}`}
      data-message-id={messageId}
      data-turn-start={turnStart ? "" : undefined}
    >
      <span className="msg-role">{role === "user" ? "you" : "projector"}</span>
      {card && api
        ? <CardMessage card={card} api={api} />
        : Explainer && onAsk
          ? <Explainer onAsk={(text) => void onAsk(text)} />
          : <p className="msg-body">{content}</p>}
      {/* This response also wrote the app surface; offered only while the
          pane isn't already on screen (the parent passes the handler). */}
      {onOpenAppPane && (
        <button className="msg-open-pane" type="button" onClick={onOpenAppPane}>
          open app pane
        </button>
      )}
    </div>
  );
}

// An inline chat card: the same surface runtime as the app pane, but frame
// content — immutable and pinned to its turn.
function CardMessage({ card, api }: {
  card: { title: string; source: string };
  api: ReturnType<typeof createSurfaceApi>;
}) {
  return (
    <div className="msg-card">
      <div className="msg-card-head">
        <span className="msg-card-title">{card.title}</span>
      </div>
      <SurfaceHost source={card.source} version={1} api={api} onError={() => {}} />
    </div>
  );
}
