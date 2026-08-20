// The machine, visible: frame log + projected state beside the conversation.
// Deliberately spare for the first pass — mono rows in the terminal box's
// vocabulary. The agent references this panel when it talks about itself.

import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Tab = "overview" | "frames" | "state";
type SessionView = { title?: string; clientSnapshot?: unknown };

// The t3-style sidebar glyph: a panel outline with the divider on the side
// the pane lives on. Shared by the nav toggles and the pane minimize buttons.
export function PaneIcon({ side }: { side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={side === "left" ? "M9 3v18" : "M15 3v18"} />
    </svg>
  );
}

export function Inspector({ sessionId, guestSecret, fallbackTitle, width, onResizeStart }: {
  sessionId: Id<"sessions"> | null;
  guestSecret: string;
  fallbackTitle?: string;
  width?: number;
  onResizeStart?: (e: React.PointerEvent) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const frames = useQuery(api.sessions.listFrames, sessionId ? { sessionId } : "skip");
  const session = useQuery(api.sessions.get, sessionId ? { sessionId } : "skip");
  const title = session?.title?.trim() || fallbackTitle?.trim() || "untitled conversation";

  return (
    <aside
      className="app-inspector"
      aria-label="Machine inspector"
      style={width !== undefined ? { width: `min(${width}rem, 42vw)` } : undefined}
    >
      {onResizeStart && <div className="pane-resize pane-resize-inspector" onPointerDown={onResizeStart} />}
      <div className="app-inspector-head">
        <button type="button" data-active={tab === "overview" ? "" : undefined} onClick={() => setTab("overview")}>
          overview
        </button>
        <button type="button" data-active={tab === "frames" ? "" : undefined} onClick={() => setTab("frames")}>
          frames
        </button>
        <button type="button" data-active={tab === "state" ? "" : undefined} onClick={() => setTab("state")}>
          state
        </button>
      </div>
      <div className="app-inspector-body">
        {tab === "overview" ? (
          <Overview sessionId={sessionId} guestSecret={guestSecret} title={title} />
        ) : tab === "frames" ? (
          <FrameLog frames={frames} />
        ) : (
          <StateView session={session} />
        )}
      </div>
    </aside>
  );
}

function Overview({ sessionId, guestSecret, title }: {
  sessionId: Id<"sessions"> | null;
  guestSecret: string;
  title: string;
}) {
  const renameSession = useMutation(api.sessions.rename);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setDraft(title);
    setStatus(null);
  }, [sessionId, title]);

  const trimmed = draft.trim();
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sessionId || !trimmed || trimmed === title || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      await renameSession({ sessionId, title: trimmed, guestSecret });
      setStatus("saved");
    } catch {
      setStatus("couldn’t rename thread");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="inspector-overview">
      <p className="inspector-overview-label">thread</p>
      <form className="inspector-title-form" onSubmit={(event) => void save(event)}>
        <label htmlFor="inspector-thread-title">title</label>
        <div className="inspector-title-control">
          <input
            id="inspector-thread-title"
            value={draft}
            maxLength={80}
            onChange={(event) => {
              setDraft(event.target.value);
              setStatus(null);
            }}
            disabled={!sessionId || saving}
          />
          <button
            type="submit"
            disabled={!sessionId || !trimmed || trimmed === title || saving}
          >
            {saving ? "saving…" : "rename"}
          </button>
        </div>
        {status && <p className="inspector-title-status" aria-live="polite">{status}</p>}
      </form>
    </section>
  );
}

type FrameDoc = {
  id: string;
  createdAt: number;
  generatorId?: string | null;
  messages: unknown[];
};

function describeMessage(message: unknown): { kind: string; cls: string; detail: string } {
  const m = message as Record<string, unknown>;
  const type = typeof m?.type === "string" ? (m.type as string) : "frame";
  if (type === "user") return { kind: "user.message", cls: "m", detail: String(m.text ?? "") };
  if (type === "assistant") return { kind: "agent.say", cls: "m", detail: String(m.text ?? "") };
  if (type === "action" && m.kind === "request") {
    return { kind: `agent.${m.action ?? "action"}`, cls: "m", detail: String(m.name ?? "") };
  }
  if (type === "action" && m.kind === "result") {
    return { kind: "action.result", cls: "g", detail: String(m.name ?? "") };
  }
  if (type === "instance") return { kind: "state.update", cls: "b", detail: String((m as any).stateKey ?? "") };
  if (type === "work") return { kind: "work", cls: "l", detail: String((m as any).kind ?? "") };
  return { kind: type, cls: "l", detail: "" };
}

function FrameLog({ frames }: { frames: FrameDoc[] | undefined }) {
  if (!frames) return <p className="inspector-empty">…</p>;
  if (frames.length === 0) return <p className="inspector-empty">no frames yet</p>;
  const rows: Array<{ key: string; seq: string; kind: string; cls: string; detail: string }> = [];
  frames.forEach((frame, fi) => {
    if (frame.messages.length === 0) {
      rows.push({ key: frame.id, seq: pad(fi, 0), kind: "init", cls: "l", detail: "" });
      return;
    }
    frame.messages.forEach((message, mi) => {
      const d = describeMessage(message);
      rows.push({ key: `${frame.id}:${mi}`, seq: pad(fi, mi), ...d });
    });
  });
  return (
    <div>
      {rows.map((r) => (
        <div className="frame-row" key={r.key}>
          <span className="l">{r.seq}</span>
          <span className={r.cls}>{r.kind}</span>
          <span className="frame-detail">{r.detail}</span>
        </div>
      ))}
    </div>
  );
}

const pad = (frame: number, message: number) =>
  `${String(frame).padStart(4, "0")}${message > 0 ? `.${message}` : ""}`;

// --- State tab: the machine as a living tree. Instances nest the way the
// agent grew them (spawned children appear as new branches), each state is a
// row that flashes when its value changes, and the shell's own states get
// purpose-built renderings. The raw toggle keeps the JSON escape hatch.

type ClientStateEntry = {
  key: string;
  address?: { instanceId?: string; stateKey?: string };
  value: unknown;
};

type ClientInstanceView = {
  id?: string;
  nodeKey?: string;
  name?: string;
  states?: ClientStateEntry[];
  children?: ClientInstanceView[];
};

function StateView({ session }: { session: SessionView | undefined }) {
  const [raw, setRaw] = useState(false);
  if (!session) return <p className="inspector-empty">…</p>;
  const snapshot = session.clientSnapshot as { instance?: ClientInstanceView } | undefined;
  const root = snapshot?.instance;
  if (!root || !hasStateContent(root)) {
    return <p className="inspector-empty">no projected state yet</p>;
  }
  return (
    <div className="state-tree">
      <div className="state-tools">
        <button type="button" data-active={raw ? "" : undefined} onClick={() => setRaw((v) => !v)}>
          raw
        </button>
      </div>
      {raw ? (
        <pre className="state-json">{JSON.stringify(root, null, 2)}</pre>
      ) : (
        <InstanceBranch instance={root} depth={0} />
      )}
    </div>
  );
}

function hasStateContent(instance: ClientInstanceView): boolean {
  if ((instance.states ?? []).length > 0) return true;
  return (instance.children ?? []).some(hasStateContent);
}

function InstanceBranch({ instance, depth }: { instance: ClientInstanceView; depth: number }) {
  // Stateless leaves (like the ui node, whose states hoist to the source) are
  // wiring, not story — hide them so every visible branch says something.
  if (depth > 0 && !hasStateContent(instance)) return null;
  const label = instance.nodeKey || instance.name || instance.id || "instance";
  const spawned = depth > 0;
  return (
    <section className="state-inst">
      <p className="state-inst-head">
        <span className="state-inst-key">{label}</span>
        {spawned && <span className="state-inst-tag">spawned</span>}
      </p>
      {(instance.states ?? []).map((state) => (
        <StateRow key={`${state.address?.instanceId ?? ""}:${state.key}`} state={state} />
      ))}
      {(instance.children ?? []).map((child, index) => (
        <div className="state-children" key={child.id ?? index}>
          <InstanceBranch instance={child} depth={depth + 1} />
        </div>
      ))}
    </section>
  );
}

// Bump on every value change after mount; keying the row body on the bump
// remounts it, restarting the flash animation.
function useChangeFlash(value: unknown): number {
  const serialized = JSON.stringify(value) ?? "";
  const prevRef = useRef<string | null>(null);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (prevRef.current !== null && prevRef.current !== serialized) {
      setFlash((count) => count + 1);
    }
    prevRef.current = serialized;
  }, [serialized]);
  return flash;
}

function StateRow({ state }: { state: ClientStateEntry }) {
  const flash = useChangeFlash(state.value);
  const address = state.address
    ? `${state.address.instanceId ?? ""}.${state.address.stateKey ?? state.key}`
    : state.key;
  return (
    <div className="state-row">
      {/* Alternating animation names restart the flash on every change
          without remounting (which would collapse expanded branches). */}
      <div
        className="state-row-head"
        data-flash={flash > 0 ? flash % 2 : undefined}
        title={`address: ${address}`}
      >
        <span className="state-key">{state.key}</span>
        <StateValue stateKey={state.key} value={state.value} />
      </div>
    </div>
  );
}

function StateValue({ stateKey, value }: { stateKey: string; value: unknown }) {
  const record = isRecord(value) ? value : undefined;
  if (stateKey === "panes" && record && typeof record.app === "boolean") {
    return (
      <span className="state-inline">
        <PaneChip label="app" on={record.app === true} width={record.appWidth} />
        <PaneChip label="inspector" on={record.inspector === true} width={record.inspectorWidth} />
      </span>
    );
  }
  if (stateKey === "appSurface" && record && typeof record.version === "number") {
    if (record.version === 0) return <span className="state-scalar">none written yet</span>;
    return (
      <span className="state-inline">
        <span className="state-scalar">
          v{record.version}
          {typeof record.title === "string" && record.title ? ` “${record.title}”` : ""}
        </span>
        {typeof record.lastError === "string" && record.lastError && (
          <span className="state-bad" title={record.lastError}>error</span>
        )}
      </span>
    );
  }
  if (stateKey === "audience" && record && typeof record.mode === "string") {
    return (
      <span className="state-inline">
        <span className="state-chip" data-on="">{record.mode}</span>
        {typeof record.note === "string" && record.note && (
          <span className="state-note">{record.note}</span>
        )}
      </span>
    );
  }
  return <ValueTree value={value} depth={0} />;
}

function PaneChip({ label, on, width }: { label: string; on: boolean; width?: unknown }) {
  return (
    <span className="state-chip" data-on={on ? "" : undefined}>
      {label} {on ? "open" : "closed"}
      {on && typeof width === "number" ? ` · ${width}rem` : ""}
    </span>
  );
}

const INLINE_JSON_MAX = 56;

function ValueTree({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined) return <span className="state-faint">null</span>;
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="state-scalar">{String(value)}</span>;
  }
  if (typeof value === "string") {
    if (value.length <= 96) return <span className="state-scalar">{value || "“”"}</span>;
    return (
      <details className="state-branch">
        <summary>{value.slice(0, 72)}…</summary>
        <div className="state-entries">
          <span className="state-scalar">{value}</span>
        </div>
      </details>
    );
  }

  const inline = JSON.stringify(value) ?? "";
  if (inline.length <= INLINE_JSON_MAX) {
    return <span className="state-scalar">{inline}</span>;
  }

  if (Array.isArray(value)) {
    return (
      <details className="state-branch" open={depth === 0 && value.length <= 8}>
        <summary>[{value.length}]</summary>
        <div className="state-entries">
          {value.map((item, index) => (
            <div className="state-entry" key={index}>
              <span className="state-entry-key">{index}</span>
              <ValueTree value={item} depth={depth + 1} />
            </div>
          ))}
        </div>
      </details>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const body = (
    <div className="state-entries">
      {entries.map(([key, entryValue]) => (
        <div className="state-entry" key={key}>
          <span className="state-entry-key">{key}</span>
          <ValueTree value={entryValue} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
  if (depth === 0) return body;
  return (
    <details className="state-branch">
      <summary>{`{${entries.length}}`}</summary>
      {body}
    </details>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
