import type {
  ClientCommandMeta,
  ClientInstance,
  ClientStateView,
  ClientToolMeta,
} from "@projectors/core/client";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type DevPanelTab = "instances" | "prompt";

type PromptRuntime = {
  generatorId: string;
  kind: "generator";
  nodeKey: string;
  name?: string;
  prompt: { provider: string; input: unknown };
};

type CurrentPrompts = {
  sessionId: Id<"sessions">;
  runtimes: PromptRuntime[];
};

export function DevPanel({
  open,
  sessionId,
  onClose,
}: {
  open: boolean;
  sessionId: Id<"sessions"> | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<DevPanelTab>("instances");
  const instance = useQuery(
    api.dev.sessions.instanceTree,
    open && sessionId && tab === "instances" ? { sessionId } : "skip",
  ) as ClientInstance | null | undefined;
  const prompts = useQuery(
    api.dev.prompts.current,
    open && sessionId && tab === "prompt" ? { sessionId } : "skip",
  ) as CurrentPrompts | null | undefined;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="dev-panel"
      aria-label="Developer panel"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dev-panel-shell">
        <header className="dev-panel-head">
          <div>
            <span className="dev-panel-eyebrow">developer</span>
            <h2>{tab === "instances" ? "instance tree" : "rendered prompt"}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close developer panel"
          >
            close
          </button>
        </header>
        <nav className="dev-panel-tabs" aria-label="Developer panel views">
          <button
            type="button"
            aria-current={tab === "instances" ? "page" : undefined}
            onClick={() => setTab("instances")}
          >
            instance tree
          </button>
          <button
            type="button"
            aria-current={tab === "prompt" ? "page" : undefined}
            onClick={() => setTab("prompt")}
          >
            rendered prompt
          </button>
        </nav>
        <div className="dev-panel-body">
          {!sessionId ? (
            <EmptyTree>no active session</EmptyTree>
          ) : tab === "instances" ? (
            instance === undefined ? (
              <EmptyTree>loading instance tree…</EmptyTree>
            ) : instance === null ? (
              <EmptyTree>no instance snapshot</EmptyTree>
            ) : (
              <InstanceNode instance={instance} depth={0} defaultExpanded />
            )
          ) : prompts === undefined ? (
            <EmptyTree>rendering current prompt…</EmptyTree>
          ) : prompts === null ? (
            <EmptyTree>no prompt state</EmptyTree>
          ) : (
            <PromptView prompts={prompts} />
          )}
        </div>
      </div>
    </dialog>
  );
}

function PromptView({ prompts }: { prompts: CurrentPrompts }) {
  if (prompts.runtimes.length === 0) {
    return <EmptyTree>no generator runtimes</EmptyTree>;
  }

  return (
    <div className="dev-prompt-view">
      <p className="dev-prompt-note">current · read-only</p>
      {prompts.runtimes.map((runtime, index) => (
        <PromptRuntimeView
          key={runtime.generatorId}
          runtime={runtime}
          defaultExpanded={index === 0}
        />
      ))}
    </div>
  );
}

function PromptRuntimeView({
  runtime,
  defaultExpanded,
}: {
  runtime: PromptRuntime;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const input = asRecord(runtime.prompt.input);
  const system = input?.system;
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const config = input
    ? Object.fromEntries(
        Object.entries(input).filter(
          ([key]) => key !== "system" && key !== "messages",
        ),
      )
    : runtime.prompt.input;

  return (
    <section
      className="dev-prompt-runtime"
      data-expanded={expanded ? "" : undefined}
    >
      <button
        type="button"
        className="dev-prompt-runtime-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="dev-tree-sign">{expanded ? "−" : "+"}</span>
        <strong>{runtime.nodeKey}</strong>
        {runtime.name && <span className="dev-tree-name">{runtime.name}</span>}
        <span className="dev-prompt-provider">{runtime.prompt.provider}</span>
        <span className="dev-tree-id">{runtime.generatorId}</span>
        <span className="dev-tree-count">{messages.length} messages</span>
      </button>
      {expanded && (
        <div className="dev-prompt-runtime-body">
          <PromptSection title="system">
            {system === undefined ? (
              <MutedLine>empty</MutedLine>
            ) : (
              <PromptContent value={system} />
            )}
          </PromptSection>
          <PromptSection title={`messages ${messages.length}`}>
            {messages.length === 0 ? (
              <MutedLine>empty</MutedLine>
            ) : (
              <div className="dev-prompt-messages">
                {messages.map((message, index) => (
                  <PromptMessage key={index} message={message} index={index} />
                ))}
              </div>
            )}
          </PromptSection>
          <PromptSection title="config">
            <JsonValue value={config} />
          </PromptSection>
        </div>
      )}
    </section>
  );
}

function PromptSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="dev-prompt-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function PromptMessage({
  message,
  index,
}: {
  message: unknown;
  index: number;
}) {
  const record = asRecord(message);
  const role =
    typeof record?.role === "string" ? record.role : `message ${index + 1}`;
  const content = record && "content" in record ? record.content : message;
  return (
    <div className="dev-prompt-message">
      <span>{role}</span>
      <PromptContent value={content} />
    </div>
  );
}

function PromptContent({ value }: { value: unknown }) {
  return typeof value === "string" ? (
    <pre className="dev-prompt-text">{value}</pre>
  ) : (
    <JsonValue value={value} />
  );
}

function InstanceNode({
  instance,
  depth,
  defaultExpanded = false,
}: {
  instance: ClientInstance;
  depth: number;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const details =
    instance.preamble.length +
    instance.recency.length +
    instance.states.length +
    instance.tools.length +
    instance.commands.length;
  const childCount = instance.members.length + instance.children.length;

  return (
    <div className="dev-tree-node">
      <button
        type="button"
        className="dev-tree-node-toggle"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="dev-tree-sign">{expanded ? "−" : "+"}</span>
        <span className="dev-tree-kind">{instance.kind}</span>
        <strong>{instance.nodeKey}</strong>
        {instance.name && (
          <span className="dev-tree-name">{instance.name}</span>
        )}
        <span className="dev-tree-runtime">
          {instance.contributor.runtimeType}
        </span>
        <span className="dev-tree-id">{instance.contributor.id}</span>
        <span className="dev-tree-count">
          {details} meta / {childCount} child
        </span>
      </button>
      {expanded && (
        <div
          className="dev-tree-node-body"
          style={{ marginLeft: `${depth * 16 + 24}px` }}
        >
          <Disclosure title="metadata">
            <KeyValueRows
              rows={[
                ["address", addressLabel(instance.contributor.address)],
                ...(instance.id
                  ? [["instance id", instance.id] as [string, ReactNode]]
                  : []),
                ...(instance.purpose
                  ? [["purpose", instance.purpose] as [string, ReactNode]]
                  : []),
              ]}
            />
          </Disclosure>
          <ContentList title="preamble" parts={instance.preamble} />
          <ContentList title="recency" parts={instance.recency} />
          <InstanceList
            title="members"
            instances={instance.members}
            depth={depth}
          />
          <InstanceList
            title="children"
            instances={instance.children}
            depth={depth}
          />
          <StateList states={instance.states} />
          <ActionList title="tools" actions={instance.tools} />
          <ActionList title="commands" actions={instance.commands} />
        </div>
      )}
    </div>
  );
}

function ContentList({
  title,
  parts,
}: {
  title: string;
  parts: ClientInstance["preamble"];
}) {
  if (parts.length === 0) return <MutedLine>{title} empty</MutedLine>;
  return (
    <TreeSection title={`${title} ${parts.length}`}>
      {parts.map((part, index) => {
        const record = asRecord(part);
        const kind =
          typeof record?.type === "string" ? record.type : `part ${index + 1}`;
        const preview =
          typeof record?.text === "string" ? record.text : jsonInline(part);
        return (
          <Disclosure key={`${title}:${index}`} title={kind} preview={preview}>
            <JsonValue value={part} />
          </Disclosure>
        );
      })}
    </TreeSection>
  );
}

function InstanceList({
  title,
  instances,
  depth,
}: {
  title: string;
  instances: ClientInstance[];
  depth: number;
}) {
  if (instances.length === 0) return <MutedLine>{title} empty</MutedLine>;
  return (
    <TreeSection title={`${title} ${instances.length}`}>
      {instances.map((instance) => (
        <InstanceNode
          key={instance.contributor.id}
          instance={instance}
          depth={depth + 1}
        />
      ))}
    </TreeSection>
  );
}

function StateList({ states }: { states: ClientStateView[] }) {
  if (states.length === 0) return <MutedLine>states empty</MutedLine>;
  return (
    <TreeSection title={`states ${states.length}`}>
      {states.map((state) => (
        <Disclosure
          key={`${addressLabel(state.address)}:${state.key}`}
          title={
            <span className="dev-tree-item-title">
              <strong>{state.key}</strong>
              {state.projection && (
                <span>{projectionLabel(state.projection)}</span>
              )}
              <span>{addressLabel(state.address)}</span>
            </span>
          }
          preview={jsonInline(state.value)}
        >
          <JsonValue value={state.value} />
        </Disclosure>
      ))}
    </TreeSection>
  );
}

function ActionList({
  title,
  actions,
}: {
  title: string;
  actions: Array<ClientToolMeta | ClientCommandMeta>;
}) {
  if (actions.length === 0) return <MutedLine>{title} empty</MutedLine>;
  return (
    <TreeSection title={`${title} ${actions.length}`}>
      {actions.map((action, index) => (
        <Disclosure
          key={`${title}:${action.name}:${index}`}
          title={
            <span className="dev-tree-item-title">
              <strong>{action.name}</strong>
              {action.target && <span>{addressLabel(action.target)}</span>}
            </span>
          }
          preview={
            action.description ??
            (action.inputSchema !== undefined ? "input schema" : undefined)
          }
        >
          {action.description && (
            <p className="dev-tree-description">{action.description}</p>
          )}
          {action.inputSchema !== undefined && (
            <JsonValue value={action.inputSchema} />
          )}
        </Disclosure>
      ))}
    </TreeSection>
  );
}

function Disclosure({
  title,
  preview,
  children,
}: {
  title: ReactNode;
  preview?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="dev-tree-disclosure"
      data-expanded={expanded ? "" : undefined}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="dev-tree-sign">{expanded ? "−" : "+"}</span>
        <span className="dev-tree-disclosure-title">{title}</span>
        {preview && <span className="dev-tree-preview">{preview}</span>}
      </button>
      {expanded && <div className="dev-tree-disclosure-body">{children}</div>}
    </div>
  );
}

function TreeSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="dev-tree-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function KeyValueRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="dev-tree-kv">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JsonValue({ value }: { value: unknown }) {
  return <pre className="dev-tree-json">{JSON.stringify(value, null, 2)}</pre>;
}

function EmptyTree({ children }: { children: ReactNode }) {
  return <p className="dev-tree-empty">{children}</p>;
}

function MutedLine({ children }: { children: ReactNode }) {
  return <p className="dev-tree-muted">{children}</p>;
}

function projectionLabel(projection: ClientStateView["projection"]): string {
  if (!projection) return "";
  return [
    projection.exposure,
    projection.slot ? `slot:${projection.slot}` : undefined,
    projection.region ? `region:${projection.region}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function jsonInline(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return String(value);
  }
}

function addressLabel(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const address = value as Record<string, unknown>;
  if (address.type === "instance")
    return `instance:${String(address.instanceId)}`;
  if (address.type === "member" && Array.isArray(address.memberPath)) {
    return `member:${String(address.ownerInstanceId)}/${address.memberPath.join("/")}`;
  }
  if ("instanceId" in address && "stateKey" in address) {
    return `${String(address.instanceId)}:${String(address.stateKey)}`;
  }
  return jsonInline(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
