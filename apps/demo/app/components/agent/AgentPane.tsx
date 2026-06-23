"use client";

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { useAtom, useAtomValue } from "jotai";
import type {
  CompiledProjectionNodeView,
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
import type {
  DemoClientInstance,
  DemoClientSnapshot,
  DemoMessage,
} from "@/src/types/display";

type AgentPaneProps = {
  sessionId: Id<"sessions"> | null;
  activeTab: AgentTab;
  docked: boolean;
  onToggleDock: () => void;
  onResetSession: () => void;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  onTimeTravelFrame: (frameId: Id<"frames">) => void;
  onReturnToLatest: () => void;
  onSwitchSession: (sessionId: Id<"sessions">) => void;
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
      latestFrameId,
      timeTravelFrameId,
      onTimeTravelFrame,
      onReturnToLatest,
      onSwitchSession,
      messageTransport,
      onMessageTransportChange,
      liveKitStatus,
      liveKitReady,
    },
    ref,
  ) {
    const [, setActiveTab] = useAtom(activeAgentTabAtom);
    const activeTreeSubtab = useAtomValue(activeTreeSubtabAtom);
    const activeHistorySubtab = useAtomValue(activeHistorySubtabAtom);
    const { effigy, instances, snapshot, readOnly } = useProjector();
    const contentScrollRef = useRef<HTMLDivElement>(null);
    const activeSubtab =
      activeTab === "tree"
        ? activeTreeSubtab
        : activeTab === "history"
          ? activeHistorySubtab
          : null;

    useLayoutEffect(() => {
      if (!contentScrollRef.current) return;
      contentScrollRef.current.scrollTop = 0;
      contentScrollRef.current.scrollLeft = 0;
    }, [activeTab, activeSubtab]);

    return (
      <aside
        ref={ref}
        tabIndex={0}
        className="pane-focus flex h-full min-h-0 flex-col bg-terminal-bg"
      >
        <header className="flex items-center justify-between gap-3 border-b border-terminal-green-dimmer px-4 py-2">
          <h2 className="terminal-glow text-sm font-bold tracking-[0.08em]">
            AGENT
          </h2>
          <button
            type="button"
            onClick={onToggleDock}
            className="rounded border border-terminal-green-dimmer px-2 py-1 text-xs text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
          >
            {docked ? "inline" : "dock"}
          </button>
        </header>
        <nav className="flex border-b border-terminal-green-dimmer px-2 text-xs">
          {(
            [
              "tree",
              "state",
              "history",
              "commands",
              "playground",
              "dev",
            ] as AgentTab[]
          ).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 ${activeTab === tab ? "text-terminal-green" : "text-terminal-green-dim hover:text-terminal-green"}`}
            >
              {tab}
            </button>
          ))}
        </nav>
        <div
          ref={contentScrollRef}
          className="terminal-scrollbar min-h-0 flex-1 overflow-y-auto p-4"
        >
          {activeTab === "tree" && (
            <TreeTab
              sessionId={sessionId}
              instances={instances}
              projectionTree={snapshot.projectionTree}
            />
          )}
          {activeTab === "state" && <StateTab instances={instances} />}
          {activeTab === "history" && (
            <HistoryTab
              sessionId={sessionId}
              projectionTree={snapshot.projectionTree}
              latestFrameId={latestFrameId}
              timeTravelFrameId={timeTravelFrameId}
              onTimeTravelFrame={onTimeTravelFrame}
              onReturnToLatest={onReturnToLatest}
              onSwitchSession={onSwitchSession}
            />
          )}
          {activeTab === "commands" && (
            <CommandsTab
              instances={instances}
              effigy={effigy}
              readOnly={readOnly}
            />
          )}
          {activeTab === "playground" && (
            <PlaygroundTab
              instances={instances}
              canonicalInstances={snapshot.root ? [snapshot.root] : []}
              effigy={effigy}
              readOnly={readOnly}
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
  sessionId,
  instances,
  projectionTree,
}: {
  sessionId: Id<"sessions"> | null;
  instances: DemoClientInstance[];
  projectionTree?: CompiledProjectionTree;
}) {
  const [activeSubtab, setActiveSubtab] = useAtom(activeTreeSubtabAtom);
  const switchSubtab = (tab: TreeSubtab) => {
    if (tab === activeSubtab) return;
    setActiveSubtab(tab);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky -top-4 z-20 -mx-4 -mt-4 mb-4 flex border-b border-terminal-green-dimmer bg-terminal-bg px-4 pt-4 text-xs">
        {(["instance", "projection", "ir", "realized"] as TreeSubtab[]).map(
          (tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => switchSubtab(tab)}
              className={`px-3 py-2 ${
                activeSubtab === tab
                  ? "border-b border-terminal-green text-terminal-green"
                  : "text-terminal-green-dim hover:text-terminal-green"
              }`}
            >
              {tab}
            </button>
          ),
        )}
      </div>
      {activeSubtab === "instance" && <InstanceTree instances={instances} />}
      {activeSubtab === "projection" && (
        <ProjectionTree tree={projectionTree} />
      )}
      {activeSubtab === "ir" && <CompiledIrTree sessionId={sessionId} />}
      {activeSubtab === "realized" && (
        <RealizedPromptTree sessionId={sessionId} />
      )}
    </div>
  );
}

function InstanceTree({ instances }: { instances: DemoClientInstance[] }) {
  if (instances.length === 0) {
    return <EmptyTree>No instances</EmptyTree>;
  }

  return (
    <div className="space-y-2 text-xs">
      {instances.map((instance) => (
        <InstanceNode
          key={instance.runtime.runtimeInstanceId}
          instance={instance}
          depth={0}
          defaultExpanded
        />
      ))}
    </div>
  );
}

function ProjectionTree({ tree }: { tree?: CompiledProjectionTree }) {
  if (!tree) {
    return <EmptyTree>No projection tree in snapshot</EmptyTree>;
  }
  if (tree.roots.length === 0) {
    return <EmptyTree>No projection roots</EmptyTree>;
  }
  return (
    <div className="space-y-2 text-xs">
      {tree.roots.map((node) => (
        <ProjectionNode key={node.runtimeInstanceId} node={node} depth={0} />
      ))}
    </div>
  );
}

type RuntimeInspectionBase = {
  generatorId: string;
  runtimeInstanceId: string;
  kind: "generator";
  nodeKey: string;
  name?: string;
};

type CompiledIrResult = {
  runtimes: Array<
    RuntimeInspectionBase & {
      inference: {
        systemParts: string[];
        dynamicParts: string[];
        tools: string[];
        retrievableStates: unknown[];
      };
    }
  >;
};

type RealizedPromptsResult = {
  runtimes: Array<
    RuntimeInspectionBase & {
      prompt: {
        provider: string;
        input: unknown;
      };
    }
  >;
};

function CompiledIrTree({ sessionId }: { sessionId: Id<"sessions"> | null }) {
  const result = useQuery(
    api.sessions.getCompiledIr,
    sessionId ? { sessionId } : "skip",
  ) as CompiledIrResult | null | undefined;

  if (!sessionId) return <EmptyTree>No session</EmptyTree>;
  if (result === undefined) return <EmptyTree>Loading IR...</EmptyTree>;
  if (!result || result.runtimes.length === 0)
    return <EmptyTree>No generator runtimes</EmptyTree>;

  return (
    <div className="space-y-2 text-sm">
      {result.runtimes.map((runtime, index) => (
        <RuntimeInspectionBlock
          key={runtime.runtimeInstanceId}
          runtime={runtime}
          defaultExpanded={index === 0}
          summary={`system ${runtime.inference.systemParts.length} / dynamic ${runtime.inference.dynamicParts.length} / tools ${runtime.inference.tools.length}`}
        >
          <TreeSection title="compiled inference">
            <JsonDisclosure
              title={`system ${runtime.inference.systemParts.length}`}
              value={runtime.inference.systemParts}
            />
            <JsonDisclosure
              title={`dynamic ${runtime.inference.dynamicParts.length}`}
              value={runtime.inference.dynamicParts}
            />
            <NameList
              title={`tools ${runtime.inference.tools.length}`}
              names={runtime.inference.tools}
            />
            <JsonDisclosure
              title={`retrievable states ${runtime.inference.retrievableStates.length}`}
              value={runtime.inference.retrievableStates}
            />
          </TreeSection>
        </RuntimeInspectionBlock>
      ))}
    </div>
  );
}

function RealizedPromptTree({
  sessionId,
}: {
  sessionId: Id<"sessions"> | null;
}) {
  const result = useQuery(
    api.sessions.getRealizedPrompts,
    sessionId ? { sessionId } : "skip",
  ) as RealizedPromptsResult | null | undefined;

  if (!sessionId) return <EmptyTree>No session</EmptyTree>;
  if (result === undefined)
    return <EmptyTree>Loading realized prompts...</EmptyTree>;
  if (!result || result.runtimes.length === 0)
    return <EmptyTree>No generator runtimes</EmptyTree>;

  return (
    <div className="space-y-2 text-sm">
      {result.runtimes.map((runtime, index) => (
        <RuntimeInspectionBlock
          key={runtime.runtimeInstanceId}
          runtime={runtime}
          defaultExpanded={index === 0}
          summary={runtime.prompt.provider}
        >
          <TreeSection title={`${runtime.prompt.provider} prompt`}>
            <RealizedPromptInput value={runtime.prompt.input} />
          </TreeSection>
        </RuntimeInspectionBlock>
      ))}
    </div>
  );
}

function RealizedPromptInput({ value }: { value: unknown }) {
  const input = objectRecord(value);
  if (!input) {
    return <JsonPreview value={value} />;
  }

  const system = typeof input.system === "string" ? input.system : undefined;
  const messages = Array.isArray(input.messages) ? input.messages : undefined;
  const config = omitKeys(input, ["system", "messages"]);

  return (
    <div className="space-y-3">
      {system !== undefined && (
        <TreeSection title="system">
          {system.trim() ? (
            <div className="whitespace-pre-wrap break-words rounded border border-terminal-green-dimmer bg-terminal-bg p-2 text-xs leading-5 text-terminal-green-dim">
              {system}
            </div>
          ) : (
            <MutedLine>system empty</MutedLine>
          )}
        </TreeSection>
      )}
      {messages !== undefined && (
        <TreeSection title={`messages ${messages.length}`}>
          {messages.length > 0 ? (
            <div className="space-y-1 rounded border border-terminal-green-dimmer bg-terminal-bg p-2">
              {messages.map((message, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[80px_minmax(0,1fr)] gap-2 text-xs leading-5"
                >
                  <span className="text-terminal-cyan">
                    [{messageRole(message)}]:
                  </span>
                  <span className="whitespace-pre-wrap break-words text-terminal-green-dim">
                    {messageText(message)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <MutedLine>messages empty</MutedLine>
          )}
        </TreeSection>
      )}
      <TreeSection title="config">
        {Object.keys(config).length > 0 ? (
          <JsonPreview value={config} />
        ) : (
          <MutedLine>config empty</MutedLine>
        )}
      </TreeSection>
    </div>
  );
}

function RuntimeInspectionBlock({
  runtime,
  summary,
  defaultExpanded = false,
  children,
}: {
  runtime: RuntimeInspectionBase;
  summary: string;
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-terminal-bg focus:outline-none focus:ring-1 focus:ring-terminal-green"
      >
        <span className="w-3 text-terminal-green-dim">
          {expanded ? "-" : "+"}
        </span>
        <span className="text-terminal-yellow">{runtime.kind}</span>
        <span className="text-terminal-green">{runtime.nodeKey}</span>
        {runtime.name && (
          <span className="truncate text-terminal-cyan">{runtime.name}</span>
        )}
        <span className="truncate text-terminal-green-dim">
          {runtime.runtimeInstanceId}
        </span>
        <span className="ml-auto shrink-0 text-terminal-green-dim">
          {summary}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-terminal-green-dimmer p-3">
          <KeyValueRows
            rows={[
              ["generator", runtime.generatorId],
              ["runtime", runtime.runtimeInstanceId],
            ]}
          />
          {children}
        </div>
      )}
    </section>
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function omitKeys(
  value: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  );
}

function messageRole(message: unknown): string {
  const record = objectRecord(message);
  const role = record?.role;
  return typeof role === "string" && role ? role : "message";
}

function messageText(message: unknown): string {
  const record = objectRecord(message);
  if (!record) return stringifyCompact(message);

  const content = record.content;
  if (typeof content === "string") return content;
  if (content !== undefined) return renderCompactContent(content);

  const text = record.text;
  if (typeof text === "string") return text;

  return stringifyCompact(message);
}

function renderCompactContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(renderCompactContent).filter(Boolean).join(" ");
  }
  const record = objectRecord(value);
  if (record) {
    if (typeof record.text === "string") return record.text;
    if (typeof record.type === "string") return `[${record.type}]`;
  }
  return stringifyCompact(value);
}

function stringifyCompact(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function NameList({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) {
    return <MutedLine>{title} empty</MutedLine>;
  }

  return (
    <TreeSection title={title}>
      <div className="flex flex-wrap gap-1">
        {names.map((name, index) => (
          <span
            key={`${name}:${index}`}
            className="rounded border border-terminal-green-dimmer bg-terminal-bg px-2 py-1 text-terminal-green"
          >
            {name}
          </span>
        ))}
      </div>
    </TreeSection>
  );
}

type FrameDoc = Doc<"frames">;

type FrameMessage = {
  type?: string;
  role?: string;
  text?: string;
  value?: unknown;
  name?: string;
  [key: string]: unknown;
};

type FrameHistoryView = {
  frame: FrameDoc;
  index: number;
  messages: FrameMessage[];
  frameType: FrameType;
};

type FrameType = "instance" | "work" | "actor";

type HistoryFilterOption = {
  value: string;
  label: string;
  count: number;
  detail?: string;
  title?: string;
};

function HistoryTab({
  sessionId,
  projectionTree,
  latestFrameId,
  timeTravelFrameId,
  onTimeTravelFrame,
  onReturnToLatest,
  onSwitchSession,
}: {
  sessionId: Id<"sessions"> | null;
  projectionTree?: CompiledProjectionTree;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  onTimeTravelFrame: (frameId: Id<"frames">) => void;
  onReturnToLatest: () => void;
  onSwitchSession: (sessionId: Id<"sessions">) => void;
}) {
  const [activeSubtab, setActiveSubtab] = useAtom(activeHistorySubtabAtom);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const [filterStickyTop, setFilterStickyTop] = useState(0);
  const isTimeTraveling = Boolean(
    timeTravelFrameId && latestFrameId && timeTravelFrameId !== latestFrameId,
  );
  const switchSubtab = (tab: HistorySubtab) => {
    if (tab === activeSubtab) return;
    setActiveSubtab(tab);
  };

  useLayoutEffect(() => {
    const header = stickyHeaderRef.current;
    if (!header) {
      setFilterStickyTop(0);
      return;
    }
    const topBleed = Number.parseFloat(getComputedStyle(header).paddingTop) || 0;
    setFilterStickyTop(Math.max(0, header.offsetHeight - topBleed));
  }, [activeSubtab, isTimeTraveling]);

  return (
    <div className="flex min-h-0 flex-col">
      <div
        ref={stickyHeaderRef}
        className="sticky -top-4 z-20 -mx-4 -mt-4 border-b border-terminal-green-dimmer bg-terminal-bg px-4 pt-4"
      >
        <div className="flex text-xs">
          {(["frames", "messages", "branches"] as HistorySubtab[]).map(
            (tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => switchSubtab(tab)}
                className={`px-3 py-2 ${
                  activeSubtab === tab
                    ? "border-b border-terminal-green text-terminal-green"
                    : "text-terminal-green-dim hover:text-terminal-green"
                }`}
              >
                {tab}
              </button>
            ),
          )}
        </div>
        {isTimeTraveling && (
          <div className="flex items-center justify-between gap-3 px-1 py-2 text-xs">
            <div className="min-w-0 truncate text-terminal-cyan">
              viewing{" "}
              {timeTravelFrameId ? shortId(timeTravelFrameId) : "history"}
            </div>
            <button
              type="button"
              onClick={onReturnToLatest}
              className="shrink-0 text-terminal-green-dim hover:text-terminal-green"
            >
              live latest
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {activeSubtab === "frames" && (
          <FramesHistory
            sessionId={sessionId}
            projectionTree={projectionTree}
            filterStickyTop={filterStickyTop}
            latestFrameId={latestFrameId}
            timeTravelFrameId={timeTravelFrameId}
            onTimeTravelFrame={onTimeTravelFrame}
          />
        )}
        {activeSubtab === "messages" && (
          <MessagesHistory
            sessionId={sessionId}
            latestFrameId={latestFrameId}
            timeTravelFrameId={timeTravelFrameId}
            onTimeTravelFrame={onTimeTravelFrame}
          />
        )}
        {activeSubtab === "branches" && (
          <BranchesHistory
            sessionId={sessionId}
            latestFrameId={latestFrameId}
            timeTravelFrameId={timeTravelFrameId}
            onTimeTravelFrame={onTimeTravelFrame}
            onSwitchSession={onSwitchSession}
          />
        )}
      </div>
    </div>
  );
}

function FramesHistory({
  sessionId,
  projectionTree,
  filterStickyTop,
  latestFrameId,
  timeTravelFrameId,
  onTimeTravelFrame,
}: {
  sessionId: Id<"sessions"> | null;
  projectionTree?: CompiledProjectionTree;
  filterStickyTop: number;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  onTimeTravelFrame: (frameId: Id<"frames">) => void;
}) {
  const frames = useQuery(
    api.frames.list,
    sessionId ? { sessionId } : "skip",
  ) as FrameDoc[] | undefined;
  const [expandedFrameIds, setExpandedFrameIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedFrameTypes, setSelectedFrameTypes] = useState<Set<string>>(
    () => new Set(),
  );
  const [nodeRuntimeFilters, setNodeRuntimeFilters] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setExpandedFrameIds(new Set());
    setSelectedFrameTypes(new Set());
    setNodeRuntimeFilters(new Set());
  }, [sessionId]);

  if (!sessionId) return <EmptyHistory>No session</EmptyHistory>;
  if (!frames) return <EmptyHistory>Loading...</EmptyHistory>;

  const orderedFrames = frames
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  if (orderedFrames.length === 0)
    return <EmptyHistory>No frames yet</EmptyHistory>;
  const frameViews = orderedFrames.map((frame, index) => {
    const messages = normalizeFrameMessages(frame.messages);
    return {
      frame,
      index,
      messages,
      frameType: frameTypeForFrame(frame, messages),
    };
  });
  const activationRuntimeIds = activationRuntimeIdsFromFrameViews(frameViews);
  const frameTypeOptions = frameTypeFilterOptions(frameViews);
  const nodeOptions = nodeFilterOptions(
    projectionTree,
    frameViews,
    activationRuntimeIds,
  );
  const frameTypeValues = frameTypeOptions.map((option) => option.value);
  const nodeRuntimeValues = nodeOptions.map((option) => option.value);
  const filteredFrameViews = frameViews.filter(
    (view) =>
      (selectedFrameTypes.size === 0 || selectedFrameTypes.has(view.frameType)) &&
      (nodeRuntimeFilters.size === 0 ||
        Array.from(nodeRuntimeFilters).some((runtimeInstanceId) =>
          frameMatchesRuntime(
            view.frame,
            view.messages,
            activationRuntimeIds,
            runtimeInstanceId,
          ),
        )),
  );
  const selectedFrameTypeValues = new Set(
    selectedFrameTypes.size === 0 ? frameTypeValues : selectedFrameTypes,
  );
  const selectedNodeRuntimeIds = new Set(
    nodeRuntimeFilters.size === 0 ? nodeRuntimeValues : nodeRuntimeFilters,
  );
  const activeFrameTypeFilters =
    selectedFrameTypes.size === 0
      ? []
      : frameTypeOptions.filter((option) => selectedFrameTypes.has(option.value));
  const activeNodeFilters =
    nodeRuntimeFilters.size === 0 ? [] : nodeOptions.filter((option) => nodeRuntimeFilters.has(option.value));
  const activeFilterCount = activeFrameTypeFilters.length + activeNodeFilters.length;
  const toggleFrameTypeFilter = (value: string) => {
    setSelectedFrameTypes((current) =>
      toggleInclusiveFilter(current, value, frameTypeValues),
    );
  };
  const toggleNodeRuntimeFilter = (value: string) => {
    setNodeRuntimeFilters((current) =>
      toggleInclusiveFilter(current, value, nodeRuntimeValues),
    );
  };
  const clearFilters = () => {
    setSelectedFrameTypes(new Set());
    setNodeRuntimeFilters(new Set());
  };

  return (
    <div className="space-y-3">
      <FrameHistoryFilters
        frameTypeOptions={frameTypeOptions}
        nodeOptions={nodeOptions}
        selectedFrameTypes={selectedFrameTypeValues}
        selectedNodeRuntimeIds={selectedNodeRuntimeIds}
        activeFrameTypeFilters={activeFrameTypeFilters}
        activeNodeFilters={activeNodeFilters}
        activeFilterCount={activeFilterCount}
        stickyTop={filterStickyTop}
        onToggleFrameType={toggleFrameTypeFilter}
        onToggleNodeRuntime={toggleNodeRuntimeFilter}
        onClear={clearFilters}
      />
      {filteredFrameViews.length === 0 ? (
        <div className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-3 text-xs italic text-terminal-green-dim">
          No frames match the current filters
        </div>
      ) : (
        <div className="space-y-2">
          {filteredFrameViews.map(({ frame, index, messages, frameType }) => {
            const expanded = expandedFrameIds.has(frame._id);
            const isLatest = frame._id === latestFrameId;
            const isSelected = frame._id === timeTravelFrameId && !isLatest;
            return (
              <section
                key={frame._id}
                className={`rounded border bg-terminal-bg-lighter ${
                  isSelected
                    ? "border-terminal-cyan"
                    : "border-terminal-green-dimmer"
                }`}
              >
                <div className="flex items-stretch">
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
                    aria-expanded={expanded}
                    className="block min-w-0 flex-1 p-3 text-left hover:bg-terminal-bg focus:outline-none focus:ring-1 focus:ring-terminal-green"
                  >
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="shrink-0 text-terminal-cyan">
                            frame #{index + 1}
                          </span>
                          <span className="truncate text-terminal-green-dim">
                            {shortId(frame._id)}
                          </span>
                          <span className="shrink-0 text-terminal-green">
                            {frameType}
                          </span>
                          {isLatest && (
                            <span className="text-terminal-yellow">latest</span>
                          )}
                          {isSelected && (
                            <span className="text-terminal-cyan">viewing</span>
                          )}
                        </div>
                        <CollapsedFrameMessages
                          frame={frame}
                          messages={messages}
                        />
                      </div>
                      <div className="shrink-0 text-right text-terminal-green-dim">
                        <div>
                          {new Date(frame.createdAt).toLocaleTimeString()}
                        </div>
                        <div>{messages.length} msgs</div>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onTimeTravelFrame(frame._id)}
                    aria-label={`time travel to frame ${index + 1}`}
                    title="time travel"
                    className={`w-10 shrink-0 border-l border-terminal-green-dimmer hover:bg-terminal-bg focus:outline-none focus:ring-1 focus:ring-terminal-green ${
                      isSelected
                        ? "text-terminal-cyan"
                        : "text-terminal-green-dim hover:text-terminal-green"
                    }`}
                  >
                    ⑂
                  </button>
                </div>
                {expanded && (
                  <div className="space-y-3 border-t border-terminal-green-dimmer p-3 text-xs">
                    {messages.length > 0 ? (
                      <div className="space-y-2">
                        {messages.map((message, messageIndex) => (
                          <HistoryFrameMessage
                            key={messageIndex}
                            message={message}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="italic text-terminal-green-dim">
                        No frame messages
                      </div>
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
      )}
    </div>
  );
}

function FrameHistoryFilters({
  frameTypeOptions,
  nodeOptions,
  selectedFrameTypes,
  selectedNodeRuntimeIds,
  activeFrameTypeFilters,
  activeNodeFilters,
  activeFilterCount,
  stickyTop,
  onToggleFrameType,
  onToggleNodeRuntime,
  onClear,
}: {
  frameTypeOptions: HistoryFilterOption[];
  nodeOptions: HistoryFilterOption[];
  selectedFrameTypes: Set<string>;
  selectedNodeRuntimeIds: Set<string>;
  activeFrameTypeFilters: HistoryFilterOption[];
  activeNodeFilters: HistoryFilterOption[];
  activeFilterCount: number;
  stickyTop: number;
  onToggleFrameType: (value: string) => void;
  onToggleNodeRuntime: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section
        className="sticky z-10 -mx-4 overflow-hidden border-b border-terminal-green-dimmer bg-terminal-bg px-4 text-xs"
        style={{ top: stickyTop }}
      >
        <div className="hide-horizontal-scrollbar terminal-scrollbar flex items-center gap-2 overflow-x-auto px-2 py-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded border border-terminal-green-dimmer bg-terminal-bg px-2 py-1 text-terminal-green hover:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
          >
            filters{activeFilterCount > 0 ? ` ${activeFilterCount}` : ""}
          </button>
          {activeFilterCount > 0 && (
            <>
              <AppliedFilterChips
                label="type"
                options={activeFrameTypeFilters}
                onRemove={onToggleFrameType}
              />
              <AppliedFilterChips
                label="node"
                options={activeNodeFilters}
                onRemove={onToggleNodeRuntime}
              />
              <button
                type="button"
                onClick={onClear}
                className="ml-auto shrink-0 text-terminal-green-dim hover:text-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
              >
                clear
              </button>
            </>
          )}
        </div>
      </section>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-terminal-bg/80 p-4">
          <button
            type="button"
            aria-label="close filters"
            className="absolute inset-0 cursor-default"
            onClick={() => setOpen(false)}
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="frame filters"
            className="relative w-full max-w-xl rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-3 text-xs shadow-2xl shadow-terminal-bg"
          >
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-terminal-green-dimmer pb-2">
              <div className="text-terminal-green">filters</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-terminal-green-dim hover:text-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
              >
                close
              </button>
            </div>
            <div className="space-y-3">
              <FilterChipGroup
                label="type"
                options={frameTypeOptions}
                selectedValues={selectedFrameTypes}
                emptyLabel="no frame types"
                onToggle={onToggleFrameType}
              />
              <FilterChipGroup
                label="node"
                options={nodeOptions}
                selectedValues={selectedNodeRuntimeIds}
                emptyLabel="no inference nodes"
                onToggle={onToggleNodeRuntime}
              />
            </div>
            <div className="mt-4 flex items-center justify-end gap-3 border-t border-terminal-green-dimmer pt-3">
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={onClear}
                  className="text-terminal-green-dim hover:text-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
                >
                  clear
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-terminal-green-dimmer bg-terminal-bg px-3 py-1 text-terminal-green hover:border-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
              >
                done
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function AppliedFilterChips({
  label,
  options,
  onRemove,
}: {
  label: string;
  options: HistoryFilterOption[];
  onRemove: (value: string) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {options.map((option) => (
        <button
          key={`${label}:${option.value}`}
          type="button"
          title={`remove ${label} ${option.label}`}
          onClick={() => onRemove(option.value)}
          className="flex max-w-full shrink-0 items-center gap-1 rounded border border-terminal-cyan bg-terminal-bg px-2 py-1 text-terminal-cyan hover:border-terminal-green hover:text-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
        >
          <span className="text-terminal-green-dim">{label}</span>
          <span className="min-w-0 max-w-[11rem] truncate">{option.label}</span>
          <span className="text-terminal-green-dim">x</span>
        </button>
      ))}
    </div>
  );
}

function FilterChipGroup({
  label,
  options,
  selectedValues,
  emptyLabel,
  onToggle,
}: {
  label: string;
  options: HistoryFilterOption[];
  selectedValues: Set<string>;
  emptyLabel: string;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <div className="text-[11px] uppercase tracking-[0.08em] text-terminal-green-dim">
        {label}
      </div>
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {options.map((option) => {
            const selected = selectedValues.has(option.value);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                title={option.title ?? option.label}
                onClick={() => onToggle(option.value)}
                className={`flex max-w-full items-center gap-1 rounded border px-2 py-1 focus:outline-none focus:ring-1 focus:ring-terminal-green ${
                  selected
                    ? "border-terminal-cyan bg-terminal-bg text-terminal-cyan"
                    : "border-terminal-green-dimmer bg-terminal-bg text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
                }`}
              >
                <span className="min-w-0 max-w-[11rem] truncate">
                  {option.label}
                </span>
                {option.detail && (
                  <span
                    className={
                      selected
                        ? "text-terminal-cyan"
                        : "text-terminal-green-dim"
                    }
                  >
                    {option.detail}
                  </span>
                )}
                <span
                  className={
                    selected ? "text-terminal-cyan" : "text-terminal-green-dim"
                  }
                >
                  {option.count}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="italic text-terminal-green-dim">{emptyLabel}</div>
      )}
    </div>
  );
}
function MessagesHistory({
  sessionId,
  latestFrameId,
  timeTravelFrameId,
  onTimeTravelFrame,
}: {
  sessionId: Id<"sessions"> | null;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  onTimeTravelFrame: (frameId: Id<"frames">) => void;
}) {
  const messages = useQuery(
    api.messages.listForFramePath,
    sessionId
      ? {
          sessionId,
          ...(timeTravelFrameId ? { upToFrameId: timeTravelFrameId } : {}),
        }
      : "skip",
  ) as DemoMessage[] | undefined;

  if (!sessionId) return <EmptyHistory>No session</EmptyHistory>;
  if (!messages) return <EmptyHistory>Loading...</EmptyHistory>;

  const orderedMessages = messages
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  if (orderedMessages.length === 0)
    return <EmptyHistory>No messages yet</EmptyHistory>;

  return (
    <div className="space-y-2">
      {orderedMessages.map((message) => {
        const frameId =
          "frameId" in message && typeof message.frameId === "string"
            ? (message.frameId as Id<"frames">)
            : null;
        const isLatest = frameId === latestFrameId;
        const isSelected = frameId === timeTravelFrameId && !isLatest;
        return (
          <button
            key={message._id}
            type="button"
            disabled={!frameId}
            onClick={() => {
              if (frameId) onTimeTravelFrame(frameId);
            }}
            className={`block w-full rounded border bg-terminal-bg-lighter p-3 text-left text-xs focus:outline-none focus:ring-1 focus:ring-terminal-green disabled:cursor-default ${
              isSelected
                ? "border-terminal-cyan"
                : frameId
                  ? "border-terminal-green-dimmer hover:border-terminal-green"
                  : "border-terminal-green-dimmer"
            }`}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={
                    message.role === "user"
                      ? "text-terminal-cyan"
                      : "text-terminal-green"
                  }
                >
                  {message.role}
                </span>
                {message.mode && (
                  <span className="text-terminal-green-dim">
                    {message.mode}
                  </span>
                )}
                {isLatest && <span className="text-terminal-yellow">latest</span>}
                {isSelected && (
                  <span className="text-terminal-cyan">viewing</span>
                )}
                {frameId && (
                  <span className="truncate text-terminal-green-dim">
                    {shortId(frameId)}
                  </span>
                )}
              </div>
              <span className="shrink-0 text-terminal-green-dim">
                {new Date(message.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="whitespace-pre-wrap break-words leading-5 text-terminal-green-dim">
              {message.content}
            </div>
          </button>
        );
      })}
    </div>
  );
}

type BranchSession = {
  sessionId: Id<"sessions">;
  latestFrameId?: Id<"frames">;
  contextEpoch: number;
  forkedFromSessionId?: Id<"sessions">;
  forkedFromFrameId?: Id<"frames">;
  frames: FrameDoc[];
};

type FamilyTimeline = {
  familyRootSessionId: Id<"sessions">;
  sessions: BranchSession[];
  edges: Array<{
    fromSessionId?: Id<"sessions">;
    fromFrameId?: Id<"frames">;
    toSessionId: Id<"sessions">;
  }>;
};

function BranchesHistory({
  sessionId,
  latestFrameId,
  timeTravelFrameId,
  onTimeTravelFrame,
  onSwitchSession,
}: {
  sessionId: Id<"sessions"> | null;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  onTimeTravelFrame: (frameId: Id<"frames">) => void;
  onSwitchSession: (sessionId: Id<"sessions">) => void;
}) {
  const timeline = useQuery(
    api.sessions.getFamilyTimeline,
    sessionId ? { sessionId } : "skip",
  ) as FamilyTimeline | null | undefined;
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(
    new Set(),
  );

  if (!sessionId) return <EmptyHistory>No session</EmptyHistory>;
  if (timeline === undefined)
    return <EmptyHistory>Loading branches...</EmptyHistory>;
  if (!timeline || timeline.sessions.length === 0)
    return <EmptyHistory>No branch family yet</EmptyHistory>;

  const orderedSessions = timeline.sessions
    .slice()
    .sort(
      (a, b) =>
        firstFrameTime(a) - firstFrameTime(b) ||
        a.sessionId.localeCompare(b.sessionId),
    );
  const childrenByParent = new Map<string, BranchSession[]>();
  for (const branch of orderedSessions) {
    if (!branch.forkedFromSessionId) continue;
    const children = childrenByParent.get(branch.forkedFromSessionId) ?? [];
    children.push(branch);
    childrenByParent.set(branch.forkedFromSessionId, children);
  }
  const rootBranches = orderedSessions.filter(
    (branch) =>
      branch.sessionId === timeline.familyRootSessionId ||
      !branch.forkedFromSessionId,
  );
  const branchNumber = new Map(
    orderedSessions.map((branch, index) => [branch.sessionId, index + 1]),
  );
  const forksByFrame = new Map<string, number>();
  for (const edge of timeline.edges) {
    if (!edge.fromFrameId) continue;
    forksByFrame.set(
      edge.fromFrameId,
      (forksByFrame.get(edge.fromFrameId) ?? 0) + 1,
    );
  }
  const totalFrames = orderedSessions.reduce(
    (total, branch) => total + branch.frames.length,
    0,
  );
  const expandedIds =
    expandedSessionIds.size === 0
      ? new Set(orderedSessions.map((branch) => branch.sessionId))
      : expandedSessionIds;

  return (
    <div className="space-y-4 text-xs">
      <div className="grid grid-cols-3 gap-2">
        <BranchMetric label="branches" value={orderedSessions.length} />
        <BranchMetric label="frames" value={totalFrames} />
        <BranchMetric label="forks" value={timeline.edges.length} />
      </div>
      <div className="space-y-3">
        {rootBranches.map((branch) => (
          <BranchNode
            key={branch.sessionId}
            branch={branch}
            depth={0}
            currentSessionId={sessionId}
            rootSessionId={timeline.familyRootSessionId}
            latestFrameId={latestFrameId}
            timeTravelFrameId={timeTravelFrameId}
            branchNumber={branchNumber}
            childrenByParent={childrenByParent}
            forksByFrame={forksByFrame}
            expandedSessionIds={expandedIds}
            onToggleSession={(id) => {
              setExpandedSessionIds((current) => {
                const source =
                  current.size === 0
                    ? new Set(orderedSessions.map((item) => item.sessionId))
                    : current;
                const next = new Set(source);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onTimeTravelFrame={onTimeTravelFrame}
            onSwitchSession={onSwitchSession}
          />
        ))}
      </div>
    </div>
  );
}

function BranchNode({
  branch,
  depth,
  currentSessionId,
  rootSessionId,
  latestFrameId,
  timeTravelFrameId,
  branchNumber,
  childrenByParent,
  forksByFrame,
  expandedSessionIds,
  onToggleSession,
  onTimeTravelFrame,
  onSwitchSession,
}: {
  branch: BranchSession;
  depth: number;
  currentSessionId: Id<"sessions">;
  rootSessionId: Id<"sessions">;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  branchNumber: Map<Id<"sessions">, number>;
  childrenByParent: Map<string, BranchSession[]>;
  forksByFrame: Map<string, number>;
  expandedSessionIds: Set<string>;
  onToggleSession: (sessionId: Id<"sessions">) => void;
  onTimeTravelFrame: (frameId: Id<"frames">) => void;
  onSwitchSession: (sessionId: Id<"sessions">) => void;
}) {
  const childBranches = childrenByParent.get(branch.sessionId) ?? [];
  const isCurrent = branch.sessionId === currentSessionId;
  const isRoot = branch.sessionId === rootSessionId;
  const expanded = expandedSessionIds.has(branch.sessionId);
  const orderedFrames = branch.frames
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  const branchLabel = isRoot
    ? "root"
    : `branch ${String(branchNumber.get(branch.sessionId) ?? 1).padStart(2, "0")}`;

  return (
    <div className="relative">
      {depth > 0 && (
        <div
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-terminal-green-dimmer"
          style={{ left: depth * 18 - 10 }}
        />
      )}
      <section className="space-y-2" style={{ marginLeft: depth * 18 }}>
        <div
          className={`rounded border bg-terminal-bg-lighter ${
            isCurrent ? "border-terminal-cyan" : "border-terminal-green-dimmer"
          }`}
        >
          <div className="flex items-stretch">
            <button
              type="button"
              onClick={() => onSwitchSession(branch.sessionId)}
              className="min-w-0 flex-1 p-3 text-left hover:bg-terminal-bg focus:outline-none focus:ring-1 focus:ring-terminal-green"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span
                      className={
                        isCurrent ? "text-terminal-cyan" : "text-terminal-green"
                      }
                    >
                      {branchLabel}
                    </span>
                    {isCurrent && (
                      <span className="text-terminal-yellow">current</span>
                    )}
                    {isRoot && (
                      <span className="text-terminal-green-dim">
                        family root
                      </span>
                    )}
                    <span className="truncate text-terminal-green-dim">
                      {shortId(branch.sessionId)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-terminal-green-dim">
                    latest{" "}
                    {branch.latestFrameId ? shortId(branch.latestFrameId) : "none"}{" "}
                    / epoch {branch.contextEpoch}
                  </div>
                </div>
                <div className="shrink-0 text-right text-terminal-green-dim">
                  <div>{orderedFrames.length} frames</div>
                  <div>{childBranches.length} forks</div>
                </div>
              </div>
            </button>
            {childBranches.length > 0 && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => onToggleSession(branch.sessionId)}
                className="w-10 shrink-0 border-l border-terminal-green-dimmer text-terminal-green-dim hover:bg-terminal-bg hover:text-terminal-green focus:outline-none focus:ring-1 focus:ring-terminal-green"
              >
                {expanded ? "-" : "+"}
              </button>
            )}
          </div>
          <BranchFrameRail
            frames={orderedFrames}
            currentSession={isCurrent}
            latestFrameId={isCurrent ? latestFrameId : (branch.latestFrameId ?? null)}
            timeTravelFrameId={isCurrent ? timeTravelFrameId : null}
            forksByFrame={forksByFrame}
            onFrameClick={(frameId) => {
              if (isCurrent) {
                onTimeTravelFrame(frameId);
              } else {
                onSwitchSession(branch.sessionId);
              }
            }}
          />
          {branch.forkedFromSessionId && branch.forkedFromFrameId && (
            <div className="border-t border-terminal-green-dimmer px-3 py-2 text-terminal-green-dim">
              forked from {shortId(branch.forkedFromSessionId)} at{" "}
              {shortId(branch.forkedFromFrameId)}
            </div>
          )}
        </div>
        {expanded && childBranches.length > 0 && (
          <div className="space-y-3">
            {childBranches.map((child) => (
              <BranchNode
                key={child.sessionId}
                branch={child}
                depth={depth + 1}
                currentSessionId={currentSessionId}
                rootSessionId={rootSessionId}
                latestFrameId={latestFrameId}
                timeTravelFrameId={timeTravelFrameId}
                branchNumber={branchNumber}
                childrenByParent={childrenByParent}
                forksByFrame={forksByFrame}
                expandedSessionIds={expandedSessionIds}
                onToggleSession={onToggleSession}
                onTimeTravelFrame={onTimeTravelFrame}
                onSwitchSession={onSwitchSession}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function BranchFrameRail({
  frames,
  currentSession,
  latestFrameId,
  timeTravelFrameId,
  forksByFrame,
  onFrameClick,
}: {
  frames: FrameDoc[];
  currentSession: boolean;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  forksByFrame: Map<string, number>;
  onFrameClick: (frameId: Id<"frames">) => void;
}) {
  if (frames.length === 0) {
    return (
      <div className="border-t border-terminal-green-dimmer px-3 py-2 text-terminal-green-dim">
        no frames
      </div>
    );
  }

  return (
    <div className="hide-horizontal-scrollbar terminal-scrollbar overflow-x-auto border-t border-terminal-green-dimmer px-3 py-3">
      <div className="relative flex min-w-max items-start gap-2 pr-2">
        <div
          aria-hidden
          className="absolute left-3 right-3 top-[13px] h-px bg-terminal-green-dimmer"
        />
        {frames.map((frame, index) => {
          const messages = normalizeFrameMessages(frame.messages);
          const isLatest = frame._id === latestFrameId;
          const isSelected =
            currentSession && frame._id === timeTravelFrameId && !isLatest;
          const forkCount = forksByFrame.get(frame._id) ?? 0;
          const label = String(index + 1).padStart(2, "0");
          return (
            <button
              key={frame._id}
              type="button"
              onClick={() => onFrameClick(frame._id)}
              title={frameSummary(frame, messages)}
              className="relative z-[1] flex w-12 shrink-0 flex-col items-center gap-1 text-center focus:outline-none focus:ring-1 focus:ring-terminal-green"
            >
              <span
                className={`grid h-7 w-7 place-items-center rounded border text-[11px] ${
                  isSelected
                    ? "border-terminal-cyan bg-terminal-cyan text-terminal-bg"
                    : isLatest
                      ? "border-terminal-yellow bg-terminal-bg text-terminal-yellow"
                      : forkCount > 0
                        ? "border-terminal-cyan bg-terminal-bg text-terminal-cyan"
                        : "border-terminal-green-dimmer bg-terminal-bg text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
                }`}
              >
                {label}
              </span>
              <span className="w-full truncate text-[10px] leading-3 text-terminal-green-dim">
                {forkCount > 0
                  ? `${forkCount} fork${forkCount === 1 ? "" : "s"}`
                  : messageKind(messages)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BranchMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-2">
      <div className="text-terminal-green-dim">{label}</div>
      <div className="mt-1 text-base text-terminal-green">{value}</div>
    </div>
  );
}

function firstFrameTime(branch: BranchSession) {
  return branch.frames.reduce(
    (earliest, frame) => Math.min(earliest, frame.createdAt),
    Number.POSITIVE_INFINITY,
  );
}

function messageKind(messages: FrameMessage[]) {
  const first = messages[0];
  if (!first) return "state";
  return first.type ?? first.role ?? "msg";
}

function HistoryFrameMessage({ message }: { message: FrameMessage }) {
  const type = message.type ?? message.role ?? "message";
  return (
    <div className="rounded border border-terminal-green-dimmer p-2">
      <div className="mb-1 flex items-center gap-2">
        <span
          className={
            type === "user" ? "text-terminal-cyan" : "text-terminal-green"
          }
        >
          {type}
        </span>
        {message.name && (
          <span className="text-terminal-yellow">{message.name}</span>
        )}
      </div>
      {typeof message.text === "string" ? (
        <div className="whitespace-pre-wrap break-words text-terminal-green-dim">
          {message.text}
        </div>
      ) : (
        <pre className="max-h-40 overflow-auto text-terminal-green-dim">
          {JSON.stringify(message, null, 2)}
        </pre>
      )}
    </div>
  );
}

function CollapsedFrameMessages({
  frame,
  messages,
}: {
  frame: FrameDoc;
  messages: FrameMessage[];
}) {
  if (messages.length === 0) {
    return (
      <div className="mt-1 truncate text-terminal-green-dim">no messages</div>
    );
  }

  return (
    <div className="mt-2 space-y-1">
      {messages.map((message, index) => {
        const preview = collapsedFrameMessagePreview(frame, message);
        return (
          <div key={index} className="flex min-w-0 gap-2 leading-5">
            <span className="shrink-0 text-terminal-green-dim">
              {preview.label}:
            </span>
            <span className="min-w-0 truncate text-terminal-green">
              {preview.detail}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyHistory({ children }: { children: ReactNode }) {
  return (
    <div className="text-sm italic text-terminal-green-dim">{children}</div>
  );
}

function normalizeFrameMessages(messages: unknown): FrameMessage[] {
  return Array.isArray(messages) ? (messages as FrameMessage[]) : [];
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function toggleInclusiveFilter(
  current: Set<string>,
  value: string,
  allValues: string[],
): Set<string> {
  if (allValues.length === 0) return new Set();

  const source = current.size === 0 ? new Set(allValues) : current;
  const next = toggleSetValue(source, value);
  return next.size === 0 || next.size === allValues.length ? new Set() : next;
}

function frameTypeFilterOptions(
  frameViews: FrameHistoryView[],
): HistoryFilterOption[] {
  const counts = new Map<FrameType, number>();
  for (const view of frameViews) {
    counts.set(view.frameType, (counts.get(view.frameType) ?? 0) + 1);
  }
  return (["instance", "work", "actor"] as FrameType[])
    .map((frameType) => ({
      value: frameType,
      label: frameType,
      count: counts.get(frameType) ?? 0,
    }))
    .filter((option) => option.count > 0);
}

function nodeFilterOptions(
  projectionTree: CompiledProjectionTree | undefined,
  frameViews: FrameHistoryView[],
  activationRuntimeIds: Map<string, string>,
): HistoryFilterOption[] {
  if (!projectionTree) return [];

  return collectProjectionNodeFilterOptions(projectionTree)
    .map((option) => ({
      ...option,
      count: frameViews.filter((view) =>
        frameMatchesRuntime(
          view.frame,
          view.messages,
          activationRuntimeIds,
          option.value,
        ),
      ).length,
    }))
    .filter((option) => option.count > 0);
}

function collectProjectionNodeFilterOptions(
  tree: CompiledProjectionTree,
): HistoryFilterOption[] {
  const options: HistoryFilterOption[] = [];
  const seen = new Set<string>();
  const visit = (node: CompiledProjectionNode) => {
    if (!seen.has(node.runtimeInstanceId)) {
      seen.add(node.runtimeInstanceId);
      const label = node.name ?? node.nodeKey;
      const detailParts = [node.kind, node.runtime.concurrency].filter(Boolean);
      options.push({
        value: node.runtimeInstanceId,
        label,
        detail: detailParts.join(" "),
        count: 0,
        title: `${label} ${node.runtimeInstanceId}`,
      });
    }
    node.children.forEach(visit);
  };
  tree.roots.forEach(visit);
  return options;
}

function activationRuntimeIdsFromFrameViews(
  frameViews: FrameHistoryView[],
): Map<string, string> {
  const runtimeIds = new Map<string, string>();
  for (const view of frameViews) {
    const frameActivationId = stringValue(view.frame.activationId);
    const frameRuntimeInstanceId = stringValue(view.frame.runtimeInstanceId);
    if (frameActivationId && frameRuntimeInstanceId) {
      runtimeIds.set(frameActivationId, frameRuntimeInstanceId);
    }

    for (const message of view.messages) {
      if (message.type !== "work" || message.kind !== "activation") continue;
      const activationId = stringValue(message.activationId);
      const runtimeInstanceId = stringValue(message.runtimeInstanceId);
      if (activationId && runtimeInstanceId) {
        runtimeIds.set(activationId, runtimeInstanceId);
      }
    }
  }
  return runtimeIds;
}

function frameMatchesRuntime(
  frame: FrameDoc,
  messages: FrameMessage[],
  activationRuntimeIds: Map<string, string>,
  runtimeInstanceId: string,
): boolean {
  if (stringValue(frame.runtimeInstanceId) === runtimeInstanceId) return true;
  if (
    generatorMatchesRuntime(stringValue(frame.generatorId), runtimeInstanceId)
  )
    return true;
  const frameActivationId = stringValue(frame.activationId);
  if (
    frameActivationId &&
    activationRuntimeIds.get(frameActivationId) === runtimeInstanceId
  )
    return true;

  return messages.some((message) => {
    if (stringValue(message.runtimeInstanceId) === runtimeInstanceId)
      return true;
    if (
      generatorMatchesRuntime(
        stringValue(message.generatorId),
        runtimeInstanceId,
      )
    )
      return true;
    const activationId = stringValue(message.activationId);
    return Boolean(
      activationId &&
      activationRuntimeIds.get(activationId) === runtimeInstanceId,
    );
  });
}

function generatorMatchesRuntime(
  generatorId: string | undefined,
  runtimeInstanceId: string,
): boolean {
  if (!generatorId) return false;
  return (
    generatorId === runtimeInstanceId ||
    generatorId.startsWith(`generator:${runtimeInstanceId}:activation:`) ||
    generatorId.startsWith(`generator:${runtimeInstanceId}:activation:`)
  );
}

function frameTypeForFrame(frame: FrameDoc, messages: FrameMessage[]): FrameType {
  const metadata = recordValue(frame.metadata);
  const metadataType = stringValue(metadata?.type);
  if (
    metadataType === "projector.runtime-completion" ||
    metadataType === "projector.runtime-turn"
  ) {
    return "work";
  }
  if (messages.some((message) => message.type === "work")) return "work";
  if (messages.length === 0) return "instance";
  if (messages.some((message) => message.type === "instance")) return "instance";
  return "actor";
}

function frameSummary(frame: FrameDoc, messages: FrameMessage[]) {
  const preview = messages.map(messagePreview).find(Boolean);
  if (preview) return preview;
  return `state frame`;
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

function collapsedFrameMessagePreview(frame: FrameDoc, message: FrameMessage) {
  if (isToolCallMessage(message)) {
    return {
      label: "tool call",
      detail:
        stringValue(message.name) ??
        stringValue(message.toolName) ??
        stringValue(message.tool_name) ??
        "unknown",
    };
  }

  if (message.type === "tool") {
    const name = stringValue(message.name);
    const result = truncatePreview(
      renderUnknown(message.text ?? message.value),
    );
    return {
      label: "tool result",
      detail: [name, result].filter(Boolean).join(" "),
    };
  }

  if (message.type === "user" || message.role === "user") {
    return {
      label: "user",
      detail: truncatePreview(renderMessageText(message)),
    };
  }

  if (message.type === "assistant" || message.role === "assistant") {
    return {
      label: "assistant",
      detail: truncatePreview(renderMessageText(message)),
    };
  }

  if (message.type === "instance") {
    return { label: "instance", detail: renderInstanceMessage(message) };
  }

  if (message.type === "work") {
    return { label: "work", detail: renderWorkMessage(frame, message) };
  }

  return {
    label: stringValue(message.type) ?? stringValue(message.role) ?? "message",
    detail: truncatePreview(renderUnknown(message)),
  };
}

function isToolCallMessage(message: FrameMessage) {
  return (
    message.type === "tool_call" ||
    message.type === "tool-call" ||
    message.kind === "tool.call" ||
    message.kind === "tool_call"
  );
}

function renderMessageText(message: FrameMessage) {
  return renderUnknown(message.text ?? message.content ?? message.value);
}

function renderInstanceMessage(message: FrameMessage) {
  const kind = stringValue(message.kind);
  if (kind === "state.update") {
    const update = recordValue(message.update);
    const op = stringValue(update?.op) ?? "update";
    const value = op === "append" ? update?.values : update?.value;
    return `${op} ${formatKeyList(keysFromRecord(recordValue(value)), stringValue(message.stateKey))}`;
  }
  if (kind) return truncatePreview(kind.replace(/^state\./, ""));
  return "update";
}

function renderWorkMessage(frame: FrameDoc, message: FrameMessage) {
  const kind = stringValue(message.kind) ?? "work";
  const runtimeInstanceId =
    stringValue(message.runtimeInstanceId) ?? frame.runtimeInstanceId ?? "";
  return [kind, runtimeInstanceId].filter(Boolean).join(" ");
}

function formatKeyList(keys: string[], fallback?: string) {
  const values = keys.length > 0 ? keys : fallback ? [fallback] : [];
  return values.length > 0 ? values.join(", ") : "unknown";
}

function keysFromRecord(record: Record<string, unknown> | undefined) {
  return record ? Object.keys(record) : [];
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function renderUnknown(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncatePreview(value: string, maxLength = 160) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function shortId(id: string) {
  return id.slice(-8);
}

function InstanceNode({
  instance,
  depth,
  defaultExpanded = false,
}: {
  instance: DemoClientInstance;
  depth: number;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const details = instance.states.length + instance.commands.length;
  const childCount = instance.members.length + instance.children.length;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-terminal-bg-lighter focus:outline-none focus:ring-1 focus:ring-terminal-green"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <span className="w-3 text-terminal-green-dim">
          {expanded ? "-" : "+"}
        </span>
        <span className="text-terminal-green-dim">{instance.kind}</span>
        <span className="text-terminal-green">{instance.nodeKey}</span>
        {instance.name && (
          <span className="truncate text-terminal-cyan">{instance.name}</span>
        )}
        <span className="text-terminal-yellow">{instance.runtime.type}</span>
        <span className="truncate text-terminal-green-dim">
          {instance.runtime.runtimeInstanceId}
        </span>
        <span className="ml-auto shrink-0 text-terminal-green-dim">
          {details} meta / {childCount} child
        </span>
      </button>
      {expanded && (
        <div
          className="space-y-2 rounded bg-lightener py-2 pr-2"
          style={{ paddingLeft: depth * 16 + 24 }}
        >
          <TreeDisclosure title="metadata">
            <KeyValueRows
              plain
              rows={[
                [
                  "runtime address",
                  addressLabel(instance.runtime.runtimeAddress),
                ],
                ...(instance.id
                  ? ([["instance id", instance.id]] as Array<
                      [string, ReactNode]
                    >)
                  : []),
              ]}
            />
          </TreeDisclosure>
          <StateList states={instance.states} />
          <ActionList title="commands" actions={instance.commands} />
          {instance.members.length > 0 ? (
            <TreeSection title={`members ${instance.members.length}`}>
              {instance.members.map((member) => (
                <InstanceNode
                  key={member.runtime.runtimeInstanceId}
                  instance={member}
                  depth={depth + 1}
                />
              ))}
            </TreeSection>
          ) : (
            <MutedLine>members empty</MutedLine>
          )}
          {instance.children.length > 0 ? (
            <TreeSection title={`children ${instance.children.length}`}>
              {instance.children.map((child) => (
                <InstanceNode
                  key={child.runtime.runtimeInstanceId}
                  instance={child}
                  depth={depth + 1}
                />
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

function ProjectionNode({
  node,
  depth,
}: {
  node: CompiledProjectionNode;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-terminal-bg-lighter focus:outline-none focus:ring-1 focus:ring-terminal-green"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <span className="w-3 text-terminal-green-dim">
          {expanded ? "-" : "+"}
        </span>
        <span className="text-terminal-yellow">{node.kind}</span>
        <span className="text-terminal-green">{node.nodeKey}</span>
        {node.name && (
          <span className="truncate text-terminal-cyan">{node.name}</span>
        )}
        <span className="text-terminal-green-dim">
          {node.runtime.trigger.type}
        </span>
        <span className="truncate text-terminal-green-dim">
          {node.runtimeInstanceId}
        </span>
        <span className="ml-auto shrink-0 text-terminal-green-dim">
          system {node.compiled.systemParts.length} / dynamic{" "}
          {node.compiled.dynamicParts.length} / tools{" "}
          {node.compiled.tools.length}
        </span>
      </button>
      {expanded && (
        <div
          className="space-y-2 pb-2"
          style={{ paddingLeft: depth * 16 + 24 }}
        >
          <KeyValueRows
            rows={[
              ["address", addressLabel(node.address)],
              ["concurrency", node.runtime.concurrency],
              ["history", node.runtime.activationHistory],
              ["own projection", projectionLabel(node.projection.own)],
              [
                "boundary projection",
                projectionLabel(node.projection.boundary),
              ],
              ...(node.parentRuntimeInstanceId
                ? ([["parent runtime", node.parentRuntimeInstanceId]] as Array<
                    [string, ReactNode]
                  >)
                : []),
            ]}
          />
          <CompiledPayload node={node} />
          <ProjectionNodeList projectionNodes={node.projectionNodes} />
          {node.children.length > 0 ? (
            <TreeSection title={`child projections ${node.children.length}`}>
              {node.children.map((child) => (
                <ProjectionNode
                  key={child.runtimeInstanceId}
                  node={child}
                  depth={depth + 1}
                />
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
      <JsonDisclosure
        title={`system ${node.compiled.systemParts.length}`}
        value={node.compiled.systemParts}
      />
      <JsonDisclosure
        title={`dynamic ${node.compiled.dynamicParts.length}`}
        value={node.compiled.dynamicParts}
      />
      <JsonDisclosure
        title={`tools ${node.compiled.tools.length}`}
        value={node.compiled.tools}
      />
      <JsonDisclosure
        title={`retrievable states ${node.compiled.retrievableStates.length}`}
        value={node.compiled.retrievableStates}
      />
    </TreeSection>
  );
}

function ProjectionNodeList({
  projectionNodes,
}: {
  projectionNodes: CompiledProjectionNodeView[];
}) {
  if (projectionNodes.length === 0) {
    return <MutedLine>projection nodes empty</MutedLine>;
  }

  return (
    <TreeSection title={`projection nodes ${projectionNodes.length}`}>
      <div className="space-y-2">
        {projectionNodes.map((projectionNode) => (
          <div
            key={projectionNode.runtimeInstanceId}
            className="rounded border border-terminal-green-dimmer bg-terminal-bg-lighter p-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-terminal-green-dim">{projectionNode.kind}</span>
              <span className="text-terminal-green">{projectionNode.nodeKey}</span>
              {projectionNode.name && (
                <span className="truncate text-terminal-cyan">
                  {projectionNode.name}
                </span>
              )}
              <span className="truncate text-terminal-green-dim">
                {projectionNode.runtimeInstanceId}
              </span>
            </div>
            <KeyValueRows
              rows={[
                ["address", addressLabel(projectionNode.address)],
                ["projection", projectionLabel(projectionNode.projection)],
              ]}
            />
            <StateList states={projectionNode.states} />
            <ActionList title="tools" actions={projectionNode.tools} />
            <ActionList title="commands" actions={projectionNode.commands} />
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
          <StateTreeItem
            key={`${addressLabel(state.address)}:${state.key}`}
            state={state}
          />
        ))}
      </div>
    </TreeSection>
  );
}

function StateTreeItem({
  state,
}: {
  state: {
    key: string;
    address: unknown;
    projection?: string;
    value: unknown;
  };
}) {
  return (
    <TreeDisclosure
      title={
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-terminal-green">{state.key}</span>
          {state.projection && (
            <span className="text-terminal-yellow">{state.projection}</span>
          )}
          <span className="truncate text-terminal-green-dim">
            {addressLabel(state.address)}
          </span>
        </div>
      }
      preview={jsonInline(state.value)}
    >
      <JsonPreview value={state.value} className="bg-lightener" />
    </TreeDisclosure>
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
          <ActionTreeItem
            key={`${title}:${action.name}:${index}`}
            action={action}
          />
        ))}
      </div>
    </TreeSection>
  );
}

function ActionTreeItem({
  action,
}: {
  action: {
    name: string;
    description?: string;
    target?: unknown;
    inputSchema?: unknown;
  };
}) {
  const hasDetails = action.description || action.inputSchema !== undefined;

  return (
    <TreeDisclosure
      title={
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-terminal-green">{action.name}</span>
          {action.target !== undefined && (
            <span className="truncate text-terminal-green-dim">
              {addressLabel(action.target)}
            </span>
          )}
        </div>
      }
      preview={
        action.description ??
        (action.inputSchema !== undefined ? "input schema" : "")
      }
    >
      <div className="space-y-2">
        {action.description && (
          <div className="text-terminal-green-dim">{action.description}</div>
        )}
        {action.inputSchema !== undefined && (
          <JsonDisclosure title="input schema" value={action.inputSchema} />
        )}
        {!hasDetails && <MutedLine>no action details</MutedLine>}
      </div>
    </TreeDisclosure>
  );
}

function JsonDisclosure({ title, value }: { title: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`rounded ${expanded ? "border border-terminal-green-dimmer bg-lightener" : ""}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-terminal-bg-lighter focus:outline-none focus:ring-1 focus:ring-terminal-green"
      >
        <span className="w-3 text-terminal-green-dim">
          {expanded ? "-" : "+"}
        </span>
        <span className="text-terminal-green-dim">{title}</span>
        <span className="truncate text-terminal-green">
          {jsonInline(value)}
        </span>
      </button>
      {expanded && (
        <pre className="max-h-72 overflow-auto border-t border-terminal-green-dimmer p-2 text-terminal-green-dim">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function JsonPreview({
  value,
  className = "bg-terminal-bg",
}: {
  value: unknown;
  className?: string;
}) {
  return (
    <pre
      className={`max-h-40 overflow-auto rounded p-2 text-terminal-green-dim ${className}`}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function TreeDisclosure({
  title,
  preview,
  expandedClassName = "bg-lightener",
  expandedBodyClassName = "",
  children,
}: {
  title: ReactNode;
  preview?: ReactNode;
  expandedClassName?: string;
  expandedBodyClassName?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`overflow-hidden rounded ${expanded ? `border border-terminal-green-dimmer ${expandedClassName}` : ""}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left hover:bg-terminal-bg-lighter focus:outline-none focus:ring-1 focus:ring-terminal-green"
      >
        <span className="w-3 shrink-0 text-terminal-green-dim">
          {expanded ? "-" : "+"}
        </span>
        <div className="min-w-0 flex-1">{title}</div>
        {preview && (
          <span className="min-w-0 max-w-[45%] truncate text-terminal-green-dim">
            {preview}
          </span>
        )}
      </button>
      {expanded && (
        <div
          className={`border-t border-terminal-green-dimmer p-2 ${expandedBodyClassName}`}
        >
          {children}
        </div>
      )}
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
    <section className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.08em] text-terminal-green-dim">
        {title}
      </div>
      {children}
    </section>
  );
}

function KeyValueRows({
  rows,
  plain = false,
}: {
  rows: Array<[string, ReactNode]>;
  plain?: boolean;
}) {
  return (
    <div
      className={
        plain
          ? "space-y-1"
          : "space-y-1 rounded border border-terminal-green-dimmer bg-lightener p-2"
      }
    >
      {rows.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[104px_minmax(0,1fr)] gap-2">
          <span className="text-terminal-green-dim">{key}</span>
          <span className="min-w-0 break-words text-terminal-green">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyTree({ children }: { children: ReactNode }) {
  return (
    <div className="text-sm italic text-terminal-green-dim">{children}</div>
  );
}

function MutedLine({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs italic text-terminal-green-dim">{children}</div>
  );
}

function projectionLabel(projection: unknown) {
  if (!projection || typeof projection !== "object") {
    return String(projection);
  }
  const record = projection as Record<string, unknown>;
  if (typeof record.name === "string") {
    return `function ${record.name}`;
  }

  const mode = typeof record.mode === "string" ? record.mode : "unknown";
  const parts = [mode];
  if ("instructions" in record) {
    parts.push(`instructions ${String(record.instructions)}`);
  }
  if ("tools" in record) {
    parts.push(`tools ${String(record.tools)}`);
  }
  return parts.join(" / ");
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
        <section
          key={`${state.address.instanceId}:${state.address.stateKey}`}
          className="space-y-2"
        >
          <div className="text-xs uppercase tracking-[0.08em] text-terminal-green-dim">
            {state.key}
          </div>
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
  readOnly,
}: {
  instances: DemoClientInstance[];
  effigy: OptimisticEffigy<DemoClientInstance[]>;
  readOnly: boolean;
}) {
  const commands = collectCommands(instances);
  const demoAddress = instances[0]?.states.find(
    (item) => item.key === "demo",
  )?.address;
  const run = async (commandMeta: DemoClientInstance["commands"][number]) => {
    if (readOnly) return;
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
        if (name === "setThemeHue" && "hue" in input)
          ctx.patchAt(demoAddress, { themeHue: input.hue });
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
          disabled={readOnly}
          className="block w-full rounded border border-terminal-green-dimmer px-3 py-2 text-left text-sm text-terminal-green hover:border-terminal-green disabled:cursor-not-allowed disabled:opacity-40"
        >
          <div>{command.name}</div>
          <div className="text-xs text-terminal-green-dim">
            {readOnly
              ? "fork session to run commands"
              : (command.description ?? "client command")}
          </div>
        </button>
      ))}
    </div>
  );
}

function PlaygroundTab({
  instances,
  canonicalInstances,
  effigy,
  readOnly,
}: {
  instances: DemoClientInstance[];
  canonicalInstances: DemoClientInstance[];
  effigy: OptimisticEffigy<DemoClientInstance[]>;
  readOnly: boolean;
}) {
  const optimisticState = findState(instances, "agentControls");
  const canonicalState = findState(canonicalInstances, "agentControls");
  const optimisticControls = optimisticState?.value as
    | { testCounter?: number }
    | undefined;
  const canonicalControls = canonicalState?.value as
    | { testCounter?: number }
    | undefined;
  const optimisticValue = optimisticControls?.testCounter ?? 0;
  const canonicalValue = canonicalControls?.testCounter ?? 0;
  const incrementCommand = findCommand(instances, "incrementTestCounter");

  const increment = async () => {
    if (readOnly || !optimisticState || !incrementCommand) return;
    const command = effigy.getCommand("incrementTestCounter" as never, {
      target: incrementCommand.target,
      optimistic: (ctx) => {
        ctx.patchAt(optimisticState.address, {
          testCounter: optimisticValue + 1,
        });
      },
    });
    await command.run({ amount: 1 } as never);
  };

  return (
    <div className="space-y-4 text-sm">
      <section className="space-y-3 rounded border border-terminal-green-dimmer p-3">
        <div>
          <div className="text-xs uppercase tracking-[0.08em] text-terminal-green-dim">
            test counter
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
            <Metric label="optimistic" value={optimisticValue} />
            <Metric label="canonical" value={canonicalValue} />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void increment()}
          disabled={readOnly || !optimisticState || !incrementCommand}
          className="rounded border border-terminal-green-dimmer px-3 py-2 text-left text-terminal-green hover:border-terminal-green disabled:cursor-not-allowed disabled:opacity-50"
        >
          {readOnly ? "fork session to edit" : "increment counter"}
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
          <div className="text-xs uppercase tracking-[0.08em] text-terminal-green-dim">
            message transport
          </div>
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
            <span
              className={
                liveKitReady ? "text-terminal-cyan" : "text-terminal-yellow"
              }
            >
              {liveKitReady ? "ready" : liveKitStatus.status}
            </span>
          </div>
          {liveKitStatus.detail && (
            <div
              className={`mt-2 ${liveKitStatus.status === "error" ? "text-terminal-red" : liveKitReady ? "text-terminal-green-dim" : "text-terminal-yellow"}`}
            >
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

function findState(
  instances: DemoClientInstance[],
  key: string,
): DemoClientInstance["states"][number] | undefined {
  for (const instance of instances) {
    const state = findStateInInstance(instance, key);
    if (state) return state;
  }
  return undefined;
}

function findCommand(
  instances: DemoClientInstance[],
  name: string,
): DemoClientInstance["commands"][number] | undefined {
  for (const instance of instances) {
    const command = findCommandInInstance(instance, name);
    if (command) return command;
  }
  return undefined;
}

function findCommandInInstance(
  instance: DemoClientInstance,
  name: string,
): DemoClientInstance["commands"][number] | undefined {
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

function findStateInInstance(
  instance: DemoClientInstance,
  key: string,
): DemoClientInstance["states"][number] | undefined {
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
