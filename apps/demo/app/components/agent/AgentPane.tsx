"use client";

import { forwardRef, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { useAtom } from "jotai";
import type {
  CompiledProjectionFrameView,
  CompiledProjectionNode,
  CompiledProjectionTree,
} from "@projectors/core";
import type { OptimisticEffigy } from "@projectors/core/client";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  activeAgentTabAtom,
  activeHistorySubtabAtom,
  activeTreeSubtabAtom,
  type AgentTab,
  type HistorySubtab,
  type MessageTransport,
  type TreeSubtab,
} from "@/src/atoms";
import { useProjector } from "@/src/projector/ProjectorProvider";
import type { DemoClientInstance, DemoClientSnapshot, DemoMessage } from "@/src/types/display";

type AgentPaneProps = {
  sessionId: Id<"sessions"> | null;
  activeTab: AgentTab;
  docked: boolean;
  onToggleDock: () => void;
  onResetSession: () => void;
  messageTransport: MessageTransport;
  onMessageTransportChange: (transport: MessageTransport) => void;
  liveKitStatus: { status: string; detail?: string };
  liveKitReady: boolean;
};

export const AgentPane = forwardRef<HTMLDivElement, AgentPaneProps>(
  function AgentPane(
    {
      sessionId,
      activeTab,
      docked,
      onToggleDock,
      onResetSession,
      messageTransport,
      onMessageTransportChange,
      liveKitStatus,
      liveKitReady,
    },
    ref,
  ) {
    const [, setActiveTab] = useAtom(activeAgentTabAtom);
    const { effigy, instances, snapshot } = useProjector();
    return (
      <aside ref={ref} tabIndex={0} className="pane-focus flex h-full min-h-0 flex-col bg-terminal-bg">
        <header className="flex items-center justify-between gap-3 border-b border-terminal-green-dimmer px-4 py-2">
          <h2 className="terminal-glow text-sm font-bold tracking-[0.08em]">AGENT</h2>
          <button
            type="button"
            onClick={onToggleDock}
            className="rounded border border-terminal-green-dimmer px-2 py-1 text-xs text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
          >
            {docked ? "inline" : "dock"}
          </button>
        </header>
        <nav className="flex border-b border-terminal-green-dimmer px-2 text-xs">
          {(["tree", "state", "history", "commands", "playground", "dev"] as AgentTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 ${activeTab === tab ? "text-terminal-green" : "text-terminal-green-dim hover:text-terminal-green"}`}
            >
              {tab}
            </button>
          ))}
        </nav>
        <div className="terminal-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {activeTab === "tree" && (
            <TreeTab instances={instances} projectionTree={snapshot.projectionTree} />
          )}
          {activeTab === "state" && <StateTab instances={instances} />}
          {activeTab === "history" && <HistoryTab sessionId={sessionId} />}
          {activeTab === "commands" && <CommandsTab instances={instances} effigy={effigy} />}
          {activeTab === "playground" && (
            <PlaygroundTab
              instances={instances}
              canonicalInstances={snapshot.instances ?? []}
              effigy={effigy}
            />
          )}
          {activeTab === "dev" && (
            <DevTab
              snapshot={snapshot}
              onResetSession={onResetSession}
              messageTransport={messageTransport}
              onMessageTransportChange={onMessageTransportChange}
              liveKitStatus={liveKitStatus}
              liveKitReady={liveKitReady}
            />
          )}
        </div>
      </aside>
    );
  },
);

function TreeTab({
  instances,
  projectionTree,
}: {
  instances: DemoClientInstance[];
  projectionTree?: CompiledProjectionTree;
}) {
  const [activeSubtab, setActiveSubtab] = useAtom(activeTreeSubtabAtom);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-4 flex border-b border-terminal-green-dimmer text-xs">
        {(["instance", "projection"] as TreeSubtab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveSubtab(tab)}
            className={`px-3 py-2 ${
              activeSubtab === tab
                ? "border-b border-terminal-green text-terminal-green"
                : "text-terminal-green-dim hover:text-terminal-green"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      {activeSubtab === "instance" ? (
        <InstanceTree instances={instances} />
      ) : (
        <ProjectionTree tree={projectionTree} />
      )}
    </div>
  );
}

function InstanceTree({ instances }: { instances: DemoClientInstance[] }) {
  if (instances.length === 0) {
    return <EmptyTree>No instances</EmptyTree>;
  }

  return (
    <div className="space-y-2 text-sm">
      {instances.map((instance) => (
        <InstanceNode key={instance.runtime.runtimeInstanceId} instance={instance} depth={0} />
      ))}
    </div>
  );
}

function ProjectionTree({ tree }: { tree?: CompiledProjectionTree }) {
  if (!tree) {
    return <EmptyTree>No projection tree in snapshot</EmptyTree>;
  }
  if (tree.roots.length === 0) {
    return <EmptyTree>No projection runtimes</EmptyTree>;
  }

  return (
    <div className="space-y-2 text-sm">
      {tree.roots.map((node) => (
        <ProjectionNode key={node.runtimeInstanceId} node={node} depth={0} />
      ))}
    </div>
  );
}

type FrameDoc = Doc<"machineFrames">;

type FrameMessage = {
  type?: string;
  role?: string;
  text?: string;
  value?: unknown;
  name?: string;
  [key: string]: unknown;
};

function HistoryTab({ sessionId }: { sessionId: Id<"sessions"> | null }) {
  const [activeSubtab, setActiveSubtab] = useAtom(activeHistorySubtabAtom);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-4 flex border-b border-terminal-green-dimmer text-xs">
        {(["frames", "messages"] as HistorySubtab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveSubtab(tab)}
            className={`px-3 py-2 ${
              activeSubtab === tab
                ? "border-b border-terminal-green text-terminal-green"
                : "text-terminal-green-dim hover:text-terminal-green"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {activeSubtab === "frames" ? (
          <FramesHistory sessionId={sessionId} />
        ) : (
          <MessagesHistory sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}

function FramesHistory({ sessionId }: { sessionId: Id<"sessions"> | null }) {
  const frames = useQuery(api.machineFrames.list, sessionId ? { sessionId } : "skip") as FrameDoc[] | undefined;
  const session = useQuery(api.sessions.get, sessionId ? { id: sessionId } : "skip");
  const [expandedFrameIds, setExpandedFrameIds] = useState<Set<string>>(new Set());

  if (!sessionId) return <EmptyHistory>No session</EmptyHistory>;
  if (!frames || !session) return <EmptyHistory>Loading...</EmptyHistory>;

  const orderedFrames = frames.slice().sort((a, b) => a.createdAt - b.createdAt);
  if (orderedFrames.length === 0) return <EmptyHistory>No frames yet</EmptyHistory>;

  return (
    <div className="space-y-2">
      {orderedFrames.map((frame, index) => {
        const messages = normalizeFrameMessages(frame.messages);
        const expanded = expandedFrameIds.has(frame._id);
        const isHead = frame._id === session.headFrameId;
        return (
          <section key={frame._id} className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter">
            <button
              type="button"
              onClick={() => {
                setExpandedFrameIds((current) => {
                  const next = new Set(current);
                  if (next.has(frame._id)) next.delete(frame._id);
                  else next.add(frame._id);
                  return next;
                });
              }}
              className="block w-full p-3 text-left hover:border-terminal-green"
            >
              <div className="flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-terminal-cyan">frame #{index + 1}</span>
                    {isHead && <span className="text-terminal-yellow">head</span>}
                    <span className="truncate text-terminal-green-dim">{shortId(frame._id)}</span>
                  </div>
                  <div className="mt-1 truncate text-terminal-green">{frameSummary(frame, messages)}</div>
                </div>
                <div className="shrink-0 text-right text-terminal-green-dim">
                  <div>{new Date(frame.createdAt).toLocaleTimeString()}</div>
                  <div>{messages.length} msgs</div>
                </div>
              </div>
            </button>
            {expanded && (
              <div className="space-y-3 border-t border-terminal-green-dimmer p-3 text-xs">
                {messages.length > 0 ? (
                  <div className="space-y-2">
                    {messages.map((message, messageIndex) => (
                      <HistoryFrameMessage key={messageIndex} message={message} />
                    ))}
                  </div>
                ) : (
                  <div className="italic text-terminal-green-dim">No frame messages</div>
                )}
                <pre className="max-h-72 overflow-auto rounded border border-terminal-green-dimmer bg-terminal-bg p-2 text-terminal-green-dim">
                  {JSON.stringify(frame, null, 2)}
                </pre>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function MessagesHistory({ sessionId }: { sessionId: Id<"sessions"> | null }) {
  const messages = useQuery(api.messages.list, sessionId ? { sessionId } : "skip") as DemoMessage[] | undefined;

  if (!sessionId) return <EmptyHistory>No session</EmptyHistory>;
  if (!messages) return <EmptyHistory>Loading...</EmptyHistory>;

  const orderedMessages = messages.slice().sort((a, b) => a.createdAt - b.createdAt);
  if (orderedMessages.length === 0) return <EmptyHistory>No messages yet</EmptyHistory>;

  return (
    <div className="space-y-2">
      {orderedMessages.map((message) => (
        <section key={message._id} className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-3 text-xs">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className={message.role === "user" ? "text-terminal-cyan" : "text-terminal-green"}>
                {message.role}
              </span>
              {message.mode && <span className="text-terminal-green-dim">{message.mode}</span>}
              {"frameId" in message && typeof message.frameId === "string" && (
                <span className="truncate text-terminal-green-dim">{shortId(message.frameId)}</span>
              )}
            </div>
            <span className="shrink-0 text-terminal-green-dim">{new Date(message.createdAt).toLocaleTimeString()}</span>
          </div>
          <div className="whitespace-pre-wrap break-words leading-5 text-terminal-green-dim">{message.content}</div>
        </section>
      ))}
    </div>
  );
}

function HistoryFrameMessage({ message }: { message: FrameMessage }) {
  const type = message.type ?? message.role ?? "message";
  return (
    <div className="rounded border border-terminal-green-dimmer p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className={type === "user" ? "text-terminal-cyan" : "text-terminal-green"}>{type}</span>
        {message.name && <span className="text-terminal-yellow">{message.name}</span>}
      </div>
      {typeof message.text === "string" ? (
        <div className="whitespace-pre-wrap break-words text-terminal-green-dim">{message.text}</div>
      ) : (
        <pre className="max-h-40 overflow-auto text-terminal-green-dim">{JSON.stringify(message, null, 2)}</pre>
      )}
    </div>
  );
}

function EmptyHistory({ children }: { children: ReactNode }) {
  return <div className="text-sm italic text-terminal-green-dim">{children}</div>;
}

function normalizeFrameMessages(messages: unknown): FrameMessage[] {
  return Array.isArray(messages) ? (messages as FrameMessage[]) : [];
}

function frameSummary(frame: FrameDoc, messages: FrameMessage[]) {
  const preview = messages.map(messagePreview).find(Boolean);
  if (preview) return preview;
  return `${frame.instanceId} state frame`;
}

function messagePreview(message: FrameMessage) {
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.replace(/\s+/g, " ").trim();
  }
  if (typeof message.value === "string" && message.value.trim()) {
    return message.value.replace(/\s+/g, " ").trim();
  }
  if (message.name) return `${message.type ?? "tool"} ${message.name}`;
  return "";
}

function shortId(id: string) {
  return id.slice(-8);
}

function InstanceNode({ instance, depth }: { instance: DemoClientInstance; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const details = instance.states.length + instance.commands.length;
  const childCount = instance.members.length + instance.children.length;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-terminal-bg-lighter focus:outline-none focus:ring-1 focus:ring-terminal-green"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <span className="w-3 text-terminal-green-dim">{expanded ? "-" : "+"}</span>
        <span className="text-terminal-green-dim">{instance.kind}</span>
        <span className="text-terminal-green">{instance.nodeKey}</span>
        {instance.name && <span className="truncate text-terminal-cyan">{instance.name}</span>}
        <span className="text-terminal-yellow">{instance.runtime.type}</span>
        <span className="truncate text-terminal-green-dim">{instance.runtime.runtimeInstanceId}</span>
        <span className="ml-auto shrink-0 text-terminal-green-dim">
          {details} meta / {childCount} child
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 pb-1" style={{ paddingLeft: depth * 16 + 24 }}>
          <KeyValueRows
            rows={[
              ["runtime address", addressLabel(instance.runtime.runtimeAddress)],
              ...(instance.id ? ([["instance id", instance.id]] as Array<[string, ReactNode]>) : []),
            ]}
          />
          <StateList states={instance.states} />
          <ActionList title="commands" actions={instance.commands} />
          {instance.members.length > 0 ? (
            <TreeSection title={`members ${instance.members.length}`}>
              {instance.members.map((member) => (
                <InstanceNode key={member.runtime.runtimeInstanceId} instance={member} depth={depth + 1} />
              ))}
            </TreeSection>
          ) : (
            <MutedLine>members empty</MutedLine>
          )}
          {instance.children.length > 0 ? (
            <TreeSection title={`children ${instance.children.length}`}>
              {instance.children.map((child) => (
                <InstanceNode key={child.runtime.runtimeInstanceId} instance={child} depth={depth + 1} />
              ))}
            </TreeSection>
          ) : (
            <MutedLine>children empty</MutedLine>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectionNode({ node, depth }: { node: CompiledProjectionNode; depth: number }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-terminal-bg-lighter focus:outline-none focus:ring-1 focus:ring-terminal-green"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <span className="w-3 text-terminal-green-dim">{expanded ? "-" : "+"}</span>
        <span className="text-terminal-yellow">{node.kind}</span>
        <span className="text-terminal-green">{node.nodeKey}</span>
        {node.name && <span className="truncate text-terminal-cyan">{node.name}</span>}
        <span className="text-terminal-green-dim">{node.runtime.trigger.type}</span>
        <span className="truncate text-terminal-green-dim">{node.runtimeInstanceId}</span>
        <span className="ml-auto shrink-0 text-terminal-green-dim">
          system {node.compiled.systemParts.length} / dynamic {node.compiled.dynamicParts.length} / tools{" "}
          {node.compiled.tools.length}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 pb-2" style={{ paddingLeft: depth * 16 + 24 }}>
          <KeyValueRows
            rows={[
              ["address", addressLabel(node.address)],
              ["concurrency", node.runtime.concurrency],
              ["history", node.runtime.activationHistory],
              ["own projection", projectionLabel(node.projection.own)],
              ["boundary projection", projectionLabel(node.projection.boundary)],
              ...(node.parentRuntimeInstanceId
                ? ([["parent runtime", node.parentRuntimeInstanceId]] as Array<[string, ReactNode]>)
                : []),
            ]}
          />
          <CompiledPayload node={node} />
          <ProjectionFrameList frames={node.frames} />
          {node.children.length > 0 ? (
            <TreeSection title={`child projections ${node.children.length}`}>
              {node.children.map((child) => (
                <ProjectionNode key={child.runtimeInstanceId} node={child} depth={depth + 1} />
              ))}
            </TreeSection>
          ) : (
            <MutedLine>child projections empty</MutedLine>
          )}
        </div>
      )}
    </div>
  );
}

function CompiledPayload({ node }: { node: CompiledProjectionNode }) {
  const empty =
    node.compiled.systemParts.length === 0 &&
    node.compiled.dynamicParts.length === 0 &&
    node.compiled.tools.length === 0 &&
    node.compiled.retrievableStates.length === 0;

  if (empty) {
    return <MutedLine>compiled output empty</MutedLine>;
  }

  return (
    <TreeSection title="compiled payload">
      <JsonDisclosure title={`system ${node.compiled.systemParts.length}`} value={node.compiled.systemParts} />
      <JsonDisclosure title={`dynamic ${node.compiled.dynamicParts.length}`} value={node.compiled.dynamicParts} />
      <JsonDisclosure title={`tools ${node.compiled.tools.length}`} value={node.compiled.tools} />
      <JsonDisclosure
        title={`retrievable states ${node.compiled.retrievableStates.length}`}
        value={node.compiled.retrievableStates}
      />
    </TreeSection>
  );
}

function ProjectionFrameList({ frames }: { frames: CompiledProjectionFrameView[] }) {
  if (frames.length === 0) {
    return <MutedLine>source frames empty</MutedLine>;
  }

  return (
    <TreeSection title={`source frames ${frames.length}`}>
      <div className="space-y-2">
        {frames.map((frame) => (
          <div
            key={frame.runtimeInstanceId}
            className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-terminal-green-dim">{frame.kind}</span>
              <span className="text-terminal-green">{frame.nodeKey}</span>
              {frame.name && <span className="truncate text-terminal-cyan">{frame.name}</span>}
              <span className="truncate text-terminal-green-dim">{frame.runtimeInstanceId}</span>
            </div>
            <KeyValueRows
              rows={[
                ["address", addressLabel(frame.address)],
                ["projection", projectionLabel(frame.projection)],
              ]}
            />
            <StateList states={frame.states} />
            <ActionList title="tools" actions={frame.tools} />
            <ActionList title="commands" actions={frame.commands} />
          </div>
        ))}
      </div>
    </TreeSection>
  );
}

function StateList({
  states,
}: {
  states: Array<{
    key: string;
    address: unknown;
    projection?: string;
    value: unknown;
  }>;
}) {
  if (states.length === 0) {
    return <MutedLine>states empty</MutedLine>;
  }

  return (
    <TreeSection title={`states ${states.length}`}>
      <div className="space-y-2">
        {states.map((state) => (
          <div key={`${addressLabel(state.address)}:${state.key}`} className="rounded border border-terminal-green-dimmer p-2">
            <div className="mb-1 flex min-w-0 items-center gap-2">
              <span className="text-terminal-green">{state.key}</span>
              {state.projection && <span className="text-terminal-yellow">{state.projection}</span>}
              <span className="truncate text-terminal-green-dim">{addressLabel(state.address)}</span>
            </div>
            <JsonPreview value={state.value} />
          </div>
        ))}
      </div>
    </TreeSection>
  );
}

function ActionList({
  title,
  actions,
}: {
  title: string;
  actions: Array<{
    name: string;
    description?: string;
    target?: unknown;
    inputSchema?: unknown;
  }>;
}) {
  if (actions.length === 0) {
    return <MutedLine>{title} empty</MutedLine>;
  }

  return (
    <TreeSection title={`${title} ${actions.length}`}>
      <div className="space-y-1">
        {actions.map((action, index) => (
          <div key={`${title}:${action.name}:${index}`} className="rounded border border-terminal-green-dimmer p-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-terminal-green">{action.name}</span>
              {action.target !== undefined && (
                <span className="truncate text-terminal-green-dim">{addressLabel(action.target)}</span>
              )}
            </div>
            {action.description && <div className="mt-1 text-terminal-green-dim">{action.description}</div>}
            {action.inputSchema !== undefined && (
              <JsonDisclosure title="input schema" value={action.inputSchema} />
            )}
          </div>
        ))}
      </div>
    </TreeSection>
  );
}

function JsonDisclosure({ title, value }: { title: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded border border-terminal-green-dimmer">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-terminal-bg-lighter focus:outline-none focus:ring-1 focus:ring-terminal-green"
      >
        <span className="w-3 text-terminal-green-dim">{expanded ? "-" : "+"}</span>
        <span className="text-terminal-green-dim">{title}</span>
        <span className="truncate text-terminal-green">{jsonInline(value)}</span>
      </button>
      {expanded && (
        <pre className="max-h-72 overflow-auto border-t border-terminal-green-dimmer p-2 text-terminal-green-dim">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded bg-terminal-bg p-2 text-terminal-green-dim">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function TreeSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.08em] text-terminal-green-dim">{title}</div>
      {children}
    </section>
  );
}

function KeyValueRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="space-y-1 rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-2">
      {rows.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[104px_minmax(0,1fr)] gap-2">
          <span className="text-terminal-green-dim">{key}</span>
          <span className="min-w-0 break-words text-terminal-green">{value}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyTree({ children }: { children: ReactNode }) {
  return <div className="text-sm italic text-terminal-green-dim">{children}</div>;
}

function MutedLine({ children }: { children: ReactNode }) {
  return <div className="text-xs italic text-terminal-green-dim">{children}</div>;
}

function projectionLabel(projection: { mode: string; instructions: string; tools: string }) {
  return `${projection.mode} / instructions ${projection.instructions} / tools ${projection.tools}`;
}

function addressLabel(value: unknown): string {
  if (!value || typeof value !== "object") {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  if (record.type === "instance") {
    return `instance:${String(record.instanceId)}`;
  }
  if (record.type === "member" && Array.isArray(record.memberPath)) {
    return `member:${String(record.ownerInstanceId)}/${record.memberPath.join("/")}`;
  }
  if ("instanceId" in record && "stateKey" in record) {
    return `${String(record.instanceId)}:${String(record.stateKey)}`;
  }
  return JSON.stringify(value);
}

function jsonInline(value: unknown): string {
  const text = JSON.stringify(value);
  if (!text) {
    return "";
  }
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function StateTab({ instances }: { instances: DemoClientInstance[] }) {
  const states = collectStates(instances);
  return (
    <div className="space-y-4">
      {states.map((state) => (
        <section key={`${state.address.instanceId}:${state.address.stateKey}`} className="space-y-2">
          <div className="text-xs uppercase tracking-[0.08em] text-terminal-green-dim">{state.key}</div>
          <pre className="overflow-x-auto rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-3 text-xs leading-5 text-terminal-green">
            {JSON.stringify(state.value, null, 2)}
          </pre>
        </section>
      ))}
    </div>
  );
}

function collectStates(instances: DemoClientInstance[]) {
  const states: DemoClientInstance["states"] = [];
  const visit = (instance: DemoClientInstance) => {
    states.push(...instance.states);
    instance.members.forEach(visit);
    instance.children.forEach(visit);
  };
  instances.forEach(visit);
  return states;
}

function CommandsTab({
  instances,
  effigy,
}: {
  instances: DemoClientInstance[];
  effigy: OptimisticEffigy<DemoClientInstance[]>;
}) {
  const commands = collectCommands(instances);
  const demoAddress = instances[0]?.states.find((item) => item.key === "demo")?.address;
  const run = async (commandMeta: DemoClientInstance["commands"][number]) => {
    const name = commandMeta.name;
    const input =
      name === "setThemeHue"
        ? { hue: Math.round(Math.random() * 360) }
        : name.startsWith("set")
            ? { enabled: true }
            : {};
    const command = effigy.getCommand(name as never, {
      target: commandMeta.target,
      optimistic: (ctx) => {
        if (!demoAddress) return;
        if (name === "setThemeHue" && "hue" in input) ctx.patchAt(demoAddress, { themeHue: input.hue });
      },
    });
    await command.run(input as never);
  };
  return (
    <div className="space-y-2">
      {commands.map((command) => (
        <button
          key={`${command.target ? JSON.stringify(command.target) : "root"}:${command.name}`}
          onClick={() => run(command)}
          className="block w-full rounded border border-terminal-green-dimmer px-3 py-2 text-left text-sm text-terminal-green hover:border-terminal-green"
        >
          <div>{command.name}</div>
          <div className="text-xs text-terminal-green-dim">{command.description ?? "client command"}</div>
        </button>
      ))}
    </div>
  );
}

function PlaygroundTab({
  instances,
  canonicalInstances,
  effigy,
}: {
  instances: DemoClientInstance[];
  canonicalInstances: DemoClientInstance[];
  effigy: OptimisticEffigy<DemoClientInstance[]>;
}) {
  const optimisticState = findState(instances, "agentControls");
  const canonicalState = findState(canonicalInstances, "agentControls");
  const optimisticControls = optimisticState?.value as { testCounter?: number } | undefined;
  const canonicalControls = canonicalState?.value as { testCounter?: number } | undefined;
  const optimisticValue = optimisticControls?.testCounter ?? 0;
  const canonicalValue = canonicalControls?.testCounter ?? 0;
  const incrementCommand = findCommand(instances, "incrementTestCounter");

  const increment = async () => {
    if (!optimisticState || !incrementCommand) return;
    const command = effigy.getCommand("incrementTestCounter" as never, {
      target: incrementCommand.target,
      optimistic: (ctx) => {
        ctx.patchAt(optimisticState.address, { testCounter: optimisticValue + 1 });
      },
    });
    await command.run({ amount: 1 } as never);
  };

  return (
    <div className="space-y-4 text-sm">
      <section className="space-y-3 rounded border border-terminal-green-dimmer p-3">
        <div>
          <div className="text-xs uppercase tracking-[0.08em] text-terminal-green-dim">test counter</div>
          <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
            <Metric label="optimistic" value={optimisticValue} />
            <Metric label="canonical" value={canonicalValue} />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void increment()}
          disabled={!optimisticState || !incrementCommand}
          className="rounded border border-terminal-green-dimmer px-3 py-2 text-left text-terminal-green hover:border-terminal-green disabled:cursor-not-allowed disabled:opacity-50"
        >
          increment counter
        </button>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-3">
      <div className="text-terminal-green-dim">{label}</div>
      <div className="mt-1 text-lg text-terminal-green">{value}</div>
    </div>
  );
}

function DevTab({
  snapshot,
  onResetSession,
  messageTransport,
  onMessageTransportChange,
  liveKitStatus,
  liveKitReady,
}: {
  snapshot: DemoClientSnapshot;
  onResetSession: () => void;
  messageTransport: MessageTransport;
  onMessageTransportChange: (transport: MessageTransport) => void;
  liveKitStatus: { status: string; detail?: string };
  liveKitReady: boolean;
}) {
  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <div>
          <div className="text-xs uppercase tracking-[0.08em] text-terminal-green-dim">message transport</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["convex", "livekit"] as MessageTransport[]).map((transport) => (
              <button
                key={transport}
                type="button"
                onClick={() => onMessageTransportChange(transport)}
                className={`rounded border px-3 py-2 text-left text-sm ${
                  messageTransport === transport
                    ? "border-terminal-green text-terminal-green"
                    : "border-terminal-green-dimmer text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
                }`}
              >
                {transport}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-3 text-xs leading-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-terminal-green-dim">livekit rpc</span>
            <span className={liveKitReady ? "text-terminal-cyan" : "text-terminal-yellow"}>
              {liveKitReady ? "ready" : liveKitStatus.status}
            </span>
          </div>
          {liveKitStatus.detail && (
            <div className={`mt-2 ${liveKitStatus.status === "error" ? "text-terminal-red" : liveKitReady ? "text-terminal-green-dim" : "text-terminal-yellow"}`}>
              {liveKitStatus.detail}
            </div>
          )}
        </div>
      </section>

      <button
        onClick={onResetSession}
        className="rounded border border-terminal-red px-3 py-2 text-sm text-terminal-red hover:bg-terminal-red hover:text-terminal-bg"
      >
        reset session
      </button>
      <pre className="overflow-x-auto rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-3 text-xs leading-5 text-terminal-green">
        {JSON.stringify(snapshot, null, 2)}
      </pre>
    </div>
  );
}

function collectCommands(instances: DemoClientInstance[]) {
  const commands: DemoClientInstance["commands"] = [];
  const visit = (instance: DemoClientInstance) => {
    commands.push(...instance.commands);
    instance.members.forEach(visit);
    instance.children.forEach(visit);
  };
  instances.forEach(visit);
  return commands;
}

function findState(instances: DemoClientInstance[], key: string): DemoClientInstance["states"][number] | undefined {
  for (const instance of instances) {
    const state = findStateInInstance(instance, key);
    if (state) return state;
  }
  return undefined;
}

function findCommand(instances: DemoClientInstance[], name: string): DemoClientInstance["commands"][number] | undefined {
  for (const instance of instances) {
    const command = findCommandInInstance(instance, name);
    if (command) return command;
  }
  return undefined;
}

function findCommandInInstance(instance: DemoClientInstance, name: string): DemoClientInstance["commands"][number] | undefined {
  const command = instance.commands.find((item) => item.name === name);
  if (command) return command;
  for (const member of instance.members) {
    const found = findCommandInInstance(member, name);
    if (found) return found;
  }
  for (const child of instance.children) {
    const found = findCommandInInstance(child, name);
    if (found) return found;
  }
  return undefined;
}

function findStateInInstance(instance: DemoClientInstance, key: string): DemoClientInstance["states"][number] | undefined {
  const state = instance.states.find((item) => item.key === key);
  if (state) return state;
  for (const member of instance.members) {
    const found = findStateInInstance(member, key);
    if (found) return found;
  }
  for (const child of instance.children) {
    const found = findStateInInstance(child, key);
    if (found) return found;
  }
  return undefined;
}
