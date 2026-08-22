// The conversation: chat column + inspector. Same paper and ink as the
// marketing page — the visitor should feel like the page folded into an app,
// not like they navigated somewhere else.

import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvex, useMutation, useQuery } from "convex/react";
import { TextAlignStart } from "lucide-react";
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { MessageActor } from "../../convex/messageActor";
import {
  createMachineEffigy,
  createOptimisticEffigy,
  type OptimisticEffigy,
} from "@projectors/core/client";
import {
  AnonymousMessageError,
  getGuestSecret,
  sendAnonymousMessage,
} from "../guest-access";
import { EXPLAINERS } from "./explainers";
import { Inspector, PaneIcon } from "./Inspector";
import { DevPanel } from "./dev/DevPanel";
import { AppNav } from "./AppNav";
import { AdminSessions } from "./AdminSessions";
import { AgentResponse } from "./AgentResponse";
import { awaitInboxItem } from "./awaitInboxItem";
import { formatStateUpdateRejection } from "./state-update-notice";
import { createSurfaceApi } from "./surface/api";
import { SurfaceHost } from "./surface/Surface";
import { useAdminAccess } from "./useAdminAccess";

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
const TURN_TOP_INSET = 18;

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

// The surface's TSX is a server-side artifact (sessions.get joins the selected
// artifact row); machine state carries only the small meta — lastError is the
// piece the pane still reads from it.
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
  route?: "conversation" | "sessions";
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

export function App({ client, actionsUrl, initialMessage, initialTopic, sessionId, route = "conversation" }: AppProps) {
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
      {route === "sessions" ? (
        <AdminSessions />
      ) : (
        <Conversation
          actionsUrl={actionsUrl}
          initialMessage={initialMessage}
          initialTopic={initialTopic}
          sessionId={sessionId}
        />
      )}
    </ConvexAuthProvider>
  );
}

function PaneCloseIcon() {
  return (
    <svg className="pane-toggle-close" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}


type LocalMessage = {
  key: string;
  clientMessageId: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
};

type PaneNotice =
  | {
      kind: "agent";
      id: string;
      order: number;
      content: string;
      pending: boolean;
      messageId?: string;
    }
  | {
      kind: "state-update";
      id: string;
      order: number;
      content: string;
    };

type StateUpdatePaneNotice = Extract<PaneNotice, { kind: "state-update" }>;
type PaneNoticeDisplay = PaneNotice | {
  kind: "state-update-stack";
  id: "state-update-stack";
  order: number;
  notices: StateUpdatePaneNotice[];
};

const MAX_VISIBLE_PANE_NOTICES = 3;

function prioritizePaneNotices(notices: PaneNotice[]): PaneNoticeDisplay[] {
  const agentNotices = notices
    .filter((notice): notice is Extract<PaneNotice, { kind: "agent" }> =>
      notice.kind === "agent"
    )
    .slice(-MAX_VISIBLE_PANE_NOTICES);
  const availableErrorSlots = MAX_VISIBLE_PANE_NOTICES - agentNotices.length;
  if (availableErrorSlots <= 0) return agentNotices;

  const errorNotices = notices.filter(
    (notice): notice is StateUpdatePaneNotice => notice.kind === "state-update",
  );
  if (errorNotices.length <= availableErrorSlots) {
    return [...agentNotices, ...errorNotices].sort((left, right) => left.order - right.order);
  }

  const individualCount = availableErrorSlots - 1;
  const groupedCount = errorNotices.length - individualCount;
  const grouped = errorNotices.slice(0, groupedCount);
  const individual = individualCount > 0 ? errorNotices.slice(-individualCount) : [];
  const errorStack: Extract<PaneNoticeDisplay, { kind: "state-update-stack" }> = {
    kind: "state-update-stack",
    id: "state-update-stack",
    order: grouped[grouped.length - 1]?.order ?? 0,
    notices: grouped,
  };
  return [
    ...agentNotices,
    errorStack,
    ...individual,
  ].sort((left, right) => left.order - right.order);
}

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const guestSecret = useMemo(getGuestSecret, []);
  const { authLoading, isAuthenticated, isAdmin } = useAdminAccess();
  const { signIn } = useAuthActions();
  const [devPanelOpen, setDevPanelOpen] = useState(false);

  useEffect(() => {
    if (!isAdmin) setDevPanelOpen(false);
  }, [isAdmin]);

  const convex = useConvex();
  const createSession = useMutation(api.sessions.create);
  const sendMessage = useMutation(api.inbox.send);
  const openTopic = useMutation(api.topics.open);
  const sendCommand = useMutation(api.inbox.sendCommand);

  const session = useQuery(api.sessions.get, sessionId ? { sessionId } : "skip");

  // The effigy: the framework's client-side stand-in for the machine. Its
  // send transport is the sessions.sendCommand mutation; refs keep the
  // once-created effigy pointed at the live session and mutation.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const sendCommandRef = useRef(sendCommand);
  sendCommandRef.current = sendCommand;
  const convexRef = useRef(convex);
  convexRef.current = convex;
  const beginPaneAgentNoticeRef = useRef<(callId: string) => void>(() => {});
  const cancelPaneAgentNoticeRef = useRef<(callId: string) => void>(() => {});
  const stateUpdateRejectedRef = useRef<
    (event: { error: unknown; input: unknown }) => void
  >(() => {});
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
        const isPanePing = message.name === "appPanePing";
        if (isPanePing) beginPaneAgentNoticeRef.current(message.callId);
        try {
          // Commands are queued for the session's single runner; the promise
          // settles when the runner has durably executed the command (and
          // rejects if it failed), not when the enqueue commits.
          const { itemId } = await sendCommandRef.current({ sessionId: id, message, guestSecret });
          return await awaitInboxItem(convexRef.current, itemId);
        } catch (error) {
          if (isPanePing) cancelPaneAgentNoticeRef.current(message.callId);
          throw error;
        }
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
  const surfaceApi = useMemo(
    () =>
      createSurfaceApi(effigy, {
        onStateUpdateRejected: (event) => stateUpdateRejectedRef.current(event),
      }),
    [effigy],
  );
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
  const viewerActorIds = useQuery(
    api.messages.viewerActors,
    sessionId ? { sessionId, guestSecret } : "skip",
  ) ?? [];

  const requestAuthentication = useCallback((draft: string) => {
    setInput(draft);
    setAuthPrompt(true);
    setWaitingSince(null);
  }, []);

  // Fire-and-forget watch on a message turn's inbox item: the enqueue itself
  // almost never fails, but the runner can reject the item at materialization
  // (or die before a runner exists to claim it) — say so instead of sitting
  // silent.
  const watchTurnItem = useCallback((itemId: Id<"agentInbox">) => {
    void awaitInboxItem(convexRef.current, itemId).catch(() => {
      setSendError(
        "that turn hit an error before projector could answer — anything it already did is in the frame log; try sending again",
      );
    });
  }, []);

  const send = useCallback(
    async (text: string, topic?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (authLoading) {
        setInput(trimmed);
        return;
      }
      if (!isAuthenticated && session?.anonymousTurnUsed) {
        requestAuthentication(trimmed);
        return;
      }

      let id = sessionId;
      if (!id) {
        id = await createSession({ guestSecret });
        setSessionId(id);
        history.replaceState({ app: true }, "", `/s/${id}`);
      }

      const clientMessageId = crypto.randomUUID();
      setOptimistic((prev) => [
        ...prev,
        {
          key: clientMessageId,
          clientMessageId,
          role: "user",
          content: trimmed,
        },
      ]);
      setFinalResponseStarted(false);
      setWaitingSince(Date.now());
      try {
        setSendError(null);
        // A topic turn is prebuilt server-side — a rich explainer lands as a
        // real frame with no model call, so the answer is effectively instant.
        if (topic) {
          await openTopic({
            sessionId: id,
            topic,
            ask: trimmed,
            clientMessageId,
            guestSecret,
          });
        } else if (isAuthenticated) {
          // Enqueue-only: the turn itself runs in the session's single runner.
          // The thinking indicator flips on with the same transaction (a
          // pending inbox item lights workStartedAt); the item watch surfaces
          // an enqueue that the runner failed to materialize.
          const { itemId } = await sendMessage({
            sessionId: id,
            text: trimmed,
            clientMessageId,
            guestSecret,
          });
          watchTurnItem(itemId);
        } else if (actionsUrl) {
          const { itemId } = await sendAnonymousMessage(actionsUrl, {
            sessionId: id,
            text: trimmed,
            clientMessageId,
            guestSecret,
          });
          if (itemId) watchTurnItem(itemId as Id<"agentInbox">);
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
          setOptimistic((prev) =>
            prev.filter((message) => message.clientMessageId !== clientMessageId),
          );
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
      watchTurnItem,
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

  // Server truth replaces optimism by end-to-end client message id as soon as
  // the durable row lands. Matching text is ambiguous in a shared room.
  const server = serverMessages ?? [];
  const visibleOptimistic = optimistic.filter(
    (o) => !server.some((m) => m.clientMessageId === o.clientMessageId),
  );

  // A full-screen narrow pane hides the conversation, but it should not hide
  // a newly arriving agent turn. Existing messages establish the baseline;
  // only assistant rows first observed after that can become a notice. Stream
  // patches update the same notice without restarting its lifetime.
  const [paneNotices, setPaneNotices] = useState<PaneNotice[]>([]);
  const paneNoticeSequenceRef = useRef(0);
  const paneNoticeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dismissPaneNotice = useCallback((noticeId: string) => {
    const timer = paneNoticeTimersRef.current.get(noticeId);
    if (timer) clearTimeout(timer);
    paneNoticeTimersRef.current.delete(noticeId);
    setPaneNotices((current) => current.filter((notice) => notice.id !== noticeId));
  }, []);
  stateUpdateRejectedRef.current = ({ error, input }) => {
    const order = paneNoticeSequenceRef.current++;
    const id = `state:${Date.now()}:${order}`;
    setPaneNotices((current) => [
      ...current,
      {
        kind: "state-update",
        id,
        order,
        content: formatStateUpdateRejection(error, input),
      },
    ]);
  };
  useEffect(() => {
    setPaneNotices([]);
    for (const timer of paneNoticeTimersRef.current.values()) clearTimeout(timer);
    paneNoticeTimersRef.current.clear();
  }, [sessionId]);
  useEffect(() => {
    const activeIds = new Set(paneNotices.map((notice) => notice.id));
    for (const [id, timer] of paneNoticeTimersRef.current) {
      if (activeIds.has(id)) continue;
      clearTimeout(timer);
      paneNoticeTimersRef.current.delete(id);
    }
    for (const notice of paneNotices) {
      if (paneNoticeTimersRef.current.has(notice.id)) continue;
      if (notice.kind === "agent" && notice.pending) continue;
      const lifetime = notice.kind === "agent" ? 10_000 : 12_000;
      const timer = setTimeout(() => dismissPaneNotice(notice.id), lifetime);
      paneNoticeTimersRef.current.set(notice.id, timer);
    }
  }, [dismissPaneNotice, paneNotices]);
  useEffect(
    () => () => {
      for (const timer of paneNoticeTimersRef.current.values()) clearTimeout(timer);
      paneNoticeTimersRef.current.clear();
    },
    [],
  );
  const seenPaneAgentMessagesRef = useRef<{
    sessionId: string | null;
    ids: Set<string>;
  }>({ sessionId: null, ids: new Set() });
  beginPaneAgentNoticeRef.current = (callId) => {
    if (!isNarrow || !layer) return;
    const order = paneNoticeSequenceRef.current++;
    setPaneNotices((current) => {
      const id = `agent:${callId}`;
      if (current.some((notice) => notice.id === id)) return current;
      return [
        ...current,
        { kind: "agent", id, order, content: "", pending: true },
      ];
    });
  };
  cancelPaneAgentNoticeRef.current = (callId) => {
    dismissPaneNotice(`agent:${callId}`);
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
      setPaneNotices((current) => current.filter((notice) => notice.kind !== "agent"));
      return;
    }

    let newest: (typeof assistantMessages)[number] | undefined;
    for (const message of assistantMessages) {
      const id = String(message.id);
      if (!tracker.ids.has(id)) newest = message;
      tracker.ids.add(id);
    }

    setPaneNotices((current) => {
      let next = current.map((notice) => {
        if (notice.kind !== "agent" || !notice.messageId) return notice;
        const updated = assistantMessages.find(
          (message) => String(message.id) === notice.messageId,
        );
        return updated ? { ...notice, content: updated.content } : notice;
      });
      if (!newest || !isNarrow || !layer) return next;
      const messageId = String(newest.id);
      if (next.some((notice) => notice.kind === "agent" && notice.messageId === messageId)) {
        return next;
      }
      let pendingIndex = -1;
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const notice = next[index];
        if (notice?.kind === "agent" && notice.pending) {
          pendingIndex = index;
          break;
        }
      }
      if (pendingIndex >= 0) {
        next = next.map((notice, index) =>
          index === pendingIndex && notice.kind === "agent"
            ? { ...notice, messageId, content: newest.content, pending: false }
            : notice,
        );
        return next;
      }
      const order = paneNoticeSequenceRef.current++;
      return [
        ...next,
        {
          kind: "agent",
          id: `agent:${messageId}`,
          order,
          messageId,
          content: newest.content,
          pending: false,
        },
      ];
    });
  }, [serverMessages, sessionId, isNarrow, layer]);
  useEffect(() => {
    if (isNarrow && layer) return;
    setPaneNotices((current) => current.filter((notice) => notice.kind !== "agent"));
  }, [isNarrow, layer]);

  // Stream state belongs to rows, but the blinking cursor belongs to the
  // transcript: only the newest live assistant row should own it. Multiple
  // rows can briefly remain marked streaming across commentary/final handoff.
  let pendingAssistantId: (typeof server)[number]["id"] | undefined;
  for (const message of server) {
    if (message.role === "assistant" && message.streamState === "streaming") {
      pendingAssistantId = message.id;
    }
  }
  const streaming = pendingAssistantId !== undefined;

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
  const firstUserText =
    server.find((message) => message.role === "user")?.content ??
    optimistic.find((message) => message.role === "user")?.content ??
    "";

  // One turn at a time: less a chat feed than pages with an input at the
  // bottom. When the speaker changes, the new turn scrolls to the top of the
  // screen and everything before it becomes history above the fold;
  // consecutive messages from the same speaker accumulate below the current
  // page top without re-paging. The turn key only moves on a speaker switch, so
  // optimistic→server row swaps and streaming growth never re-trigger the
  // sync. The thinking placeholder is not a turn — the page flips when the
  // agent actually starts saying something.
  const rendered = [
    ...server.map((m) => ({
      key: m.id,
      role: m.role,
      content: m.content,
      actor: m.actor,
      clientMessageId: m.clientMessageId,
      isMine: m.role === "user" && viewerActorIds.includes(m.actor?.id ?? ""),
      activationId: m.activationId,
      widget: m.widget,
      card: m.card,
      updatedSurface: m.updatedSurface === true,
      pending: m.role === "assistant" && m.id === pendingAssistantId,
      streamingLive: m.streamState === "streaming",
    })),
    ...visibleOptimistic.map((m) => ({
      key: m.key,
      role: m.role,
      content: m.content,
      actor: undefined as MessageActor | undefined,
      clientMessageId: m.clientMessageId,
      isMine: true,
      activationId: undefined as string | undefined,
      widget: undefined as string | undefined,
      card: undefined as { title: string; source: string } | undefined,
      updatedSurface: false,
      pending: false,
      streamingLive: false,
    })),
  ];
  let latestTurnKey: string | null = null;
  let latestTurnIsMine = false;
  // Viewer-authored rows share one speaker id whether optimistic or durable,
  // so the optimistic→server swap cannot move the turn key or reshuffle
  // boundaries between two quick consecutive sends.
  const speakerIdOf = (m: (typeof rendered)[number] | undefined) => {
    if (!m) return undefined;
    if (m.role === "assistant") return "projector";
    if (m.isMine) return "me";
    return m.actor?.id ?? m.clientMessageId;
  };
  const items = rendered.map((m, i) => {
    const previous = rendered[i - 1];
    const speakerId = speakerIdOf(m);
    const previousSpeakerId = speakerIdOf(previous);
    const speakerStart = i === 0 || speakerId !== previousSpeakerId;
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
    if (turnStart) {
      const boundaryId = m.role === "assistant"
        ? m.activationId ?? String(m.key)
        : m.clientMessageId ?? String(m.key);
      latestTurnKey = `${speakerId}:${boundaryId}`;
      latestTurnIsMine = m.role === "user" && m.isMine === true;
    }
    return { ...m, turnStart };
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const followingBottomRef = useRef(false);
  const syncedOnce = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  // Track actual bottom position, while treating wheel/touch/drag input as an
  // explicit request to stop following a multi-message assistant turn.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const readBottom = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
      if (!followingBottomRef.current || atBottom) atBottomRef.current = atBottom;
      if (atBottom) setShowJumpToLatest(false);
    };
    const releaseFollow = () => {
      followingBottomRef.current = false;
      readBottom();
    };
    readBottom();
    container.addEventListener("scroll", readBottom, { passive: true });
    container.addEventListener("wheel", releaseFollow, { passive: true });
    container.addEventListener("touchstart", releaseFollow, { passive: true });
    container.addEventListener("pointerdown", releaseFollow, { passive: true });
    return () => {
      container.removeEventListener("scroll", readBottom);
      container.removeEventListener("wheel", releaseFollow);
      container.removeEventListener("touchstart", releaseFollow);
      container.removeEventListener("pointerdown", releaseFollow);
    };
  }, []);

  const previousTranscriptRef = useRef<{
    initialized: boolean;
    sessionId: string | null;
    turnKey: string | null;
    itemCount: number;
  }>({ initialized: false, sessionId: null, turnKey: null, itemCount: 0 });

  // One ordered scroll controller owns spacer sizing, author-boundary paging,
  // and same-author bottom following. In particular, a new turn disarms follow
  // before the spacer is measured, so the previous turn cannot pull this one
  // to the bottom before its page sync runs.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const thread = threadRef.current;
    const composer = composerRef.current;
    const spacer = bottomSpacerRef.current;
    if (!container || !thread || !composer || !spacer) return;
    const noticeHost = composer.closest<HTMLElement>(".app-body");

    const previous = previousTranscriptRef.current;
    const sessionChanged = previous.initialized && previous.sessionId !== (sessionId ?? null);
    const turnChanged =
      !previous.initialized || sessionChanged || previous.turnKey !== latestTurnKey;
    const appendedWithinTurn =
      previous.initialized &&
      !turnChanged &&
      items.length > previous.itemCount;
    const wasAtBottom = atBottomRef.current;
    previousTranscriptRef.current = {
      initialized: true,
      sessionId: sessionId ?? null,
      turnKey: latestTurnKey,
      itemCount: items.length,
    };

    if (turnChanged) followingBottomRef.current = false;
    if (sessionChanged) syncedOnce.current = false;

    let frame = 0;
    const resize = () => {
      frame = 0;
      const starts = thread.querySelectorAll<HTMLElement>("[data-turn-start]");
      const target = starts[starts.length - 1];
      if (!target) {
        spacer.style.height = "0px";
        return;
      }

      const composerClearance = composer.getBoundingClientRect().height;
      noticeHost?.style.setProperty("--app-composer-height", `${composerClearance}px`);
      const messages = thread.querySelectorAll<HTMLElement>(".msg");
      const lastMessage = messages[messages.length - 1];
      const messageRunHeight = lastMessage
        ? lastMessage.getBoundingClientRect().bottom - target.getBoundingClientRect().top
        : 0;
      const threadGap = Number.parseFloat(getComputedStyle(thread).rowGap) || 0;
      const spacerHeight = Math.max(
        composerClearance,
        container.clientHeight - TURN_TOP_INSET - messageRunHeight - threadGap,
      );
      // Write the measured height once. Temporarily collapsing the spacer to
      // measure it can clamp scrollTop at the old document height; expanding
      // it afterward then strands the viewport back in transcript history.
      spacer.style.height = `${spacerHeight}px`;
      if (followingBottomRef.current) {
        container.scrollTop = container.scrollHeight;
        atBottomRef.current = true;
      }
      return target;
    };
    const scheduleResize = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    };

    const target = resize();
    if (turnChanged && target) {
      // Another participant's turn must not yank a reader out of history:
      // only page when the viewer was at the bottom, authored the turn
      // themselves, or this is the initial sync. Otherwise offer a chip.
      const shouldPage =
        !syncedOnce.current || sessionChanged || wasAtBottom || latestTurnIsMine;
      if (shouldPage) {
        const top =
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop -
          TURN_TOP_INSET;
        const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
        container.scrollTo({
          top: Math.max(0, top),
          behavior: syncedOnce.current && !still ? "smooth" : "instant",
        });
        syncedOnce.current = true;
        setShowJumpToLatest(false);
      } else {
        setShowJumpToLatest(true);
      }
    } else if (appendedWithinTurn && wasAtBottom) {
      followingBottomRef.current = true;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    }

    const observer = new ResizeObserver(scheduleResize);
    observer.observe(container);
    observer.observe(composer);
    thread.querySelectorAll<HTMLElement>(".msg").forEach((message) => observer.observe(message));
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      noticeHost?.style.removeProperty("--app-composer-height");
    };
  }, [sessionId, latestTurnKey, items.map((item) => String(item.key)).join("\n")]);

  const jumpToLatest = useCallback(() => {
    setShowJumpToLatest(false);
    const container = scrollRef.current;
    if (!container) return;
    const starts = container.querySelectorAll<HTMLElement>("[data-turn-start]");
    const target = starts[starts.length - 1];
    if (!target) return;
    const top =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      TURN_TOP_INSET;
    container.scrollTo({
      top: Math.max(0, top),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, []);

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

  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${field.scrollHeight}px`;
  }, [input]);

  const revealPaneAgentNotice = useCallback((noticeId: string, messageId?: string) => {
    dismissPaneNotice(noticeId);
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
  }, [closeMobileLayer, dismissPaneNotice]);

  // Wide: the machine's pane state renders as side-by-side panes. Narrow:
  // the view-local layer decides what's on screen.
  const showApp = isNarrow ? layer === "app" || closingLayer === "app" : panes.app;
  const showInspector = isNarrow
    ? layer === "inspector" || closingLayer === "inspector"
    : panes.inspector;
  const visiblePaneNotices = prioritizePaneNotices(
    paneNotices.filter((notice) => notice.kind === "state-update" || (isNarrow && layer)),
  );
  const hasPaneNotices = visiblePaneNotices.length > 0;

  return (
    <div className="app">
      <AppNav
        sessionId={sessionId ?? undefined}
        sessionMode
        isAdmin={isAdmin}
        onOpenDev={() => setDevPanelOpen(true)}
      />
      {isAdmin && (
        <DevPanel
          open={devPanelOpen}
          sessionId={sessionId}
          onClose={() => setDevPanelOpen(false)}
        />
      )}
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
            sessionId={sessionId}
            showLabs
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
            <div className="app-thread" ref={threadRef}>
              {items.map((m) => (
                <Message
                  key={m.key}
                  messageId={String(m.key)}
                  role={m.role}
                  content={m.content}
                  streamingLive={m.streamingLive}
                  actor={m.actor}
                  isMine={m.isMine}
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
              <div className="app-thread-spacer" ref={bottomSpacerRef} aria-hidden="true" />
            </div>
          </div>
          <form
            className="app-composer"
            ref={composerRef}
            onSubmit={submit}
            autoComplete="off"
          >
            {showJumpToLatest && (
              <button type="button" className="jump-latest" onClick={jumpToLatest}>
                jump to latest ↓
              </button>
            )}
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
                <textarea
                  ref={inputRef}
                  className="talk-input"
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }}
                  placeholder="ask projector…"
                  spellCheck={false}
                  enterKeyHint="send"
                  aria-label="Message projector"
                  // Preserve the keyboard through the landing-to-chat handoff,
                  // but don't summon it merely by opening an existing session.
                  autoFocus={Boolean(initialMessage) || !isNarrow}
                />
                <button
                  className="talk-mic"
                  type="button"
                  onClick={() => window.alert("voice coming soon")}
                  title="voice — coming soon"
                  aria-label="Voice input, coming soon"
                >
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
        {isNarrow && layer && !hasPaneNotices && (
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
        <PaneNoticeStack
          notices={visiblePaneNotices}
          onRevealAgent={revealPaneAgentNotice}
          onDismiss={dismissPaneNotice}
        />
      </div>
    </div>
  );
}

function PaneNoticeStack({
  notices,
  onRevealAgent,
  onDismiss,
}: {
  notices: PaneNoticeDisplay[];
  onRevealAgent: (noticeId: string, messageId?: string) => void;
  onDismiss: (noticeId: string) => void;
}) {
  const noticesRef = useRef(notices);
  noticesRef.current = notices;
  const [renderedNotices, setRenderedNotices] = useState<Array<{
    notice: PaneNoticeDisplay;
    exiting: boolean;
  }>>([]);

  // Keep removed notices mounted just long enough for their measured slot to
  // collapse. The stack itself stays mounted even when empty, so the last
  // notice gets the same exit motion as every other notice.
  useLayoutEffect(() => {
    setRenderedNotices((current) => {
      const incoming = new Map(notices.map((notice) => [notice.id, notice]));
      const next = notices.map((notice) => ({ notice, exiting: false }));
      for (const rendered of current) {
        if (!incoming.has(rendered.notice.id)) next.push({ ...rendered, exiting: true });
      }
      return next.sort((left, right) => left.notice.order - right.notice.order);
    });
  }, [notices]);

  const removeExitedNotice = useCallback((noticeId: string) => {
    if (noticesRef.current.some((notice) => notice.id === noticeId)) return;
    setRenderedNotices((current) =>
      current.filter((rendered) => rendered.notice.id !== noticeId),
    );
  }, []);

  return (
    <div className="pane-notice-stack" aria-label="Application notices">
      {renderedNotices.map(({ notice, exiting }) => (
        <PaneNoticeSlot
          key={notice.id}
          notice={notice}
          exiting={exiting}
          onExited={removeExitedNotice}
        >
          {notice.kind === "state-update-stack" ? (
            <div className="pane-notice pane-state-notice pane-state-notice-stack" role="alert">
              <span className="pane-notice-role">
                state update rejected
                <span className="pane-notice-count">{notice.notices.length}</span>
              </span>
              <span className="pane-notice-copy">
                {notice.notices[notice.notices.length - 1]?.content}
              </span>
              <button
                type="button"
                onClick={() => notice.notices.forEach((item) => onDismiss(item.id))}
                aria-label={`Dismiss ${notice.notices.length} state update errors`}
              >
                ×
              </button>
            </div>
          ) : notice.kind === "state-update" ? (
            <div className="pane-notice pane-state-notice" role="alert">
              <span className="pane-notice-role">state update rejected</span>
              <span className="pane-notice-copy">{notice.content}</span>
              <button
                type="button"
                onClick={() => onDismiss(notice.id)}
                aria-label="Dismiss state update error"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              className="pane-notice pane-agent-notice"
              type="button"
              onClick={() => onRevealAgent(notice.id, notice.messageId)}
              data-pending={notice.pending ? "" : undefined}
              aria-label={
                notice.pending
                  ? "Projector is responding"
                  : "Open the conversation to read projector's new message"
              }
            >
              {notice.pending ? (
                <span className="pane-notice-cursor" aria-hidden="true" />
              ) : (
                <>
                  <span className="pane-notice-role">projector</span>
                  <span className="pane-notice-copy">{notice.content}</span>
                </>
              )}
            </button>
          )}
        </PaneNoticeSlot>
      ))}
    </div>
  );
}

function PaneNoticeSlot({ notice, exiting, onExited, children }: {
  notice: PaneNoticeDisplay;
  exiting: boolean;
  onExited: (noticeId: string) => void;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [entered, setEntered] = useState(false);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const nextHeight = content.offsetHeight;
      setContentHeight((current) => current === nextHeight ? current : nextHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!exiting) {
      setEntered(true);
      return;
    }
    setEntered(false);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onExited(notice.id);
      return;
    }
    const timeout = setTimeout(() => onExited(notice.id), 300);
    return () => clearTimeout(timeout);
  }, [exiting, notice.id, onExited]);

  const open = entered && !exiting;
  return (
    <div
      className="pane-notice-slot"
      data-open={open ? "" : undefined}
      style={{ height: open ? contentHeight : 0 }}
    >
      <div
        className={`pane-notice-slot-content${
          notice.kind === "state-update-stack" ? " pane-notice-slot-content-stacked" : ""
        }`}
        ref={contentRef}
      >
        {children}
      </div>
    </div>
  );
}

// The left pane: the app surface. Renders the selected immutable server-side
// artifact; the small meta and active-version pointer live in machine state.
function AppPane({ sessionId, showLabs, width, onResizeStart, surface, api, onSurfaceError, onAsk }: {
  sessionId: Id<"sessions"> | null;
  showLabs: boolean;
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
        {showLabs && sessionId && (
          <LabsErrorBoundary>
            <ArtifactHistoryLab sessionId={sessionId} />
          </LabsErrorBoundary>
        )}
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

class LabsErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Labs panel failed", error);
  }

  render() {
    if (this.state.failed) {
      return <span className="labs-dot labs-dot-failed" title="Labs unavailable" />;
    }
    return this.props.children;
  }
}

function ArtifactHistoryLab({ sessionId }: { sessionId: Id<"sessions"> }) {
  const [open, setOpen] = useState(false);
  const history = useQuery(api.dev.artifacts.history, open ? { sessionId } : "skip");
  const activate = useMutation(api.dev.artifacts.activate);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const choose = async (version: number) => {
    setPendingVersion(version);
    setError(null);
    try {
      await activate({ sessionId, version });
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingVersion(null);
    }
  };

  return (
    <div className="labs-history">
      <button
        className="labs-trigger"
        type="button"
        aria-label="Labs: app artifact history"
        title="Labs"
        onClick={() => setOpen(true)}
      >
        <span className="labs-dot" aria-hidden="true" />
      </button>
      <dialog
        ref={dialogRef}
        className="labs-modal"
        aria-label="Labs: app artifact history"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        <div className="labs-modal-shell">
          <header className="labs-modal-head">
            <div>
              <span className="labs-history-eyebrow">labs</span>
              <h2>app history</h2>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close app history">
              close
            </button>
          </header>
          <div className="labs-modal-body">
            <p>Select an earlier artifact from this session.</p>
            <div className="labs-history-list">
              {history === undefined ? (
                <span className="labs-history-empty">loading…</span>
              ) : !history || history.artifacts.length === 0 ? (
                <span className="labs-history-empty">no artifacts yet</span>
              ) : (
                history.artifacts.map((artifact) => {
                  const current = artifact.version === history.activeVersion;
                  return (
                    <button
                      type="button"
                      key={artifact.version}
                      disabled={current || pendingVersion !== null}
                      data-current={current ? "" : undefined}
                      onClick={() => void choose(artifact.version)}
                    >
                      <span>v{artifact.version}</span>
                      <span>{artifact.title}</span>
                      {current && <small>current</small>}
                    </button>
                  );
                })
              )}
            </div>
            {error && <p className="labs-history-error">{error}</p>}
          </div>
        </div>
      </dialog>
    </div>
  );
}

function Message({ messageId, role, content, streamingLive, actor, isMine, widget, card, api: surfaceApi, pending, turnStart, onAsk, onOpenAppPane }: {
  messageId?: string;
  role: "user" | "assistant";
  content: string;
  /** Row is mid-stream: its live text arrives via the per-message tail query. */
  streamingLive?: boolean;
  actor?: MessageActor;
  isMine?: boolean;
  widget?: string;
  card?: { title: string; source: string };
  api?: ReturnType<typeof createSurfaceApi>;
  pending?: boolean;
  turnStart?: boolean;
  onAsk?: (text: string) => void;
  onOpenAppPane?: () => void;
}) {
  // Live stream text is deliberately not part of the transcript query: each
  // streaming row subscribes to its own small tail here, so 250ms delta
  // writes invalidate only this message, never the whole thread.
  const liveText = useQuery(
    api.messages.streamText,
    streamingLive && messageId ? { messageId: messageId as Id<"messages"> } : "skip",
  );
  const body = (streamingLive ? liveText : undefined) ?? content;
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
      {role === "user" && !isMine && actor?.kind === "github" && actor.profileUrl ? (
        <a
          className="msg-role msg-role-github"
          href={actor.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {actor.label}
        </a>
      ) : (
        <span className="msg-role">
          {role === "assistant" ? "projector" : isMine ? "you" : actor?.label ?? "anon"}
        </span>
      )}
      {card && surfaceApi
        ? <CardMessage card={card} api={surfaceApi} />
        : Explainer && onAsk
          ? <Explainer onAsk={(text) => void onAsk(text)} />
          : role === "assistant"
            ? <AgentResponse markdown={body} phase={streamingLive ? "streaming" : "settled"} />
            : <p className="msg-body">{body}</p>}
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
