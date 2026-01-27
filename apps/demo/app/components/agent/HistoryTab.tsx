"use client";

import { useState, type JSX } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id, Doc } from "@/convex/_generated/dataModel";
import type {
  ConversationMessage,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "markov-machines/client";
import {
  activeHistorySubtabAtom,
  selectedStepIdAtom,
  stepPreviewInstanceAtom,
  isPreviewingAtom,
  type HistorySubtab,
} from "@/src/atoms";

type MachineStep = Doc<"machineSteps">;
type MachineTurn = Doc<"machineTurns">;

interface HistoryTabProps {
  sessionId: Id<"sessions">;
}

const subtabs: { id: HistorySubtab; label: string }[] = [
  { id: "steps", label: "Steps" },
  { id: "turns", label: "Turns" },
  { id: "messages", label: "Messages" },
  { id: "branches", label: "Branches" },
];

export function HistoryTab({ sessionId }: HistoryTabProps) {
  const [activeSubtab, setActiveSubtab] = useAtom(activeHistorySubtabAtom);

  return (
    <div className="h-full flex flex-col">
      {/* Subtabs */}
      <div className="flex border-b border-terminal-green-dimmer mb-4">
        {subtabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubtab(tab.id)}
            className={`
              px-3 py-1 text-xs font-mono transition-colors
              ${activeSubtab === tab.id
                ? "text-terminal-green border-b border-terminal-green"
                : "text-terminal-green-dim hover:text-terminal-green"
              }
            `}
          >
            [{tab.label}]
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto terminal-scrollbar">
        {activeSubtab === "steps" && <StepsView sessionId={sessionId} />}
        {activeSubtab === "turns" && <TurnsView sessionId={sessionId} />}
        {activeSubtab === "messages" && <MessagesView sessionId={sessionId} />}
        {activeSubtab === "branches" && <BranchesView sessionId={sessionId} />}
      </div>
    </div>
  );
}

function StepsView({ sessionId }: { sessionId: Id<"sessions"> }) {
  const steps = useQuery(api.machineSteps.getRecent, { sessionId, limit: 20 });
  const [selectedStepId, setSelectedStepId] = useAtom(selectedStepIdAtom);
  const setPreviewInstance = useSetAtom(stepPreviewInstanceAtom);
  const setIsPreviewing = useSetAtom(isPreviewingAtom);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const toggleExpand = (stepId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  const handleStepClick = (step: MachineStep) => {
    if (selectedStepId === step._id) {
      setSelectedStepId(null);
      setPreviewInstance(null);
      setIsPreviewing(false);
    } else {
      setSelectedStepId(step._id);
      setPreviewInstance(step.instance);
      setIsPreviewing(true);
    }
  };

  const clearPreview = () => {
    setSelectedStepId(null);
    setPreviewInstance(null);
    setIsPreviewing(false);
  };

  if (!steps) {
    return <div className="text-terminal-green-dimmer">Loading...</div>;
  }

  if (steps.length === 0) {
    return <div className="text-terminal-green-dimmer italic">No steps yet</div>;
  }

  return (
    <div className="space-y-2">
      {selectedStepId && (
        <button
          onClick={clearPreview}
          className="text-xs text-terminal-yellow hover:underline mb-2"
        >
          [Clear Preview]
        </button>
      )}
      {steps.map((step) => {
        const isExpanded = expandedSteps.has(step._id);
        return (
          <div
            key={step._id}
            onClick={() => handleStepClick(step)}
            className={`
              p-2 rounded border cursor-pointer transition-colors
              ${selectedStepId === step._id
                ? "border-terminal-green bg-terminal-bg-lighter"
                : "border-terminal-green-dimmer hover:border-terminal-green-dim"
              }
            `}
          >
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => toggleExpand(step._id, e)}
                className="text-terminal-green-dim hover:text-terminal-green w-4 text-left"
              >
                {isExpanded ? "v" : ">"}
              </button>
              <span className="text-terminal-cyan">#{step.stepNumber}</span>
              <span className="text-terminal-green-dim">{step.yieldReason}</span>
              {step.done && <span className="text-terminal-yellow">[done]</span>}
              <span className="text-terminal-green-dimmer">[{step.messages.length} msgs]</span>
            </div>
            {step.response && (
              <div className="text-terminal-green-dimmer text-xs mt-1 truncate ml-6">
                {step.response.slice(0, 60)}...
              </div>
            )}
            {isExpanded && (
              <pre
                onClick={(e) => e.stopPropagation()}
                className="mt-2 ml-6 p-2 text-xs bg-terminal-bg border border-terminal-green-dimmer rounded overflow-auto max-h-64 text-terminal-green-dim cursor-text"
              >
                {JSON.stringify(step.messages, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TurnsView({ sessionId }: { sessionId: Id<"sessions"> }) {
  const turnTree = useQuery(api.sessions.getTurnTree, { sessionId });
  const timeTravel = useMutation(api.sessions.timeTravel);
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());

  const toggleExpand = (turnId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedTurns(prev => {
      const next = new Set(prev);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  };

  if (!turnTree) {
    return <div className="text-terminal-green-dimmer">Loading...</div>;
  }

  if (turnTree.turns.length === 0) {
    return <div className="text-terminal-green-dimmer italic">No turns yet</div>;
  }

  const handleTimeTravel = async (turnId: Id<"machineTurns">) => {
    await timeTravel({ sessionId, targetTurnId: turnId });
  };

  return (
    <div className="space-y-2">
      {turnTree.turns.map((turn) => {
        const isCurrent = turn._id === turnTree.currentTurnId;
        const isExpanded = expandedTurns.has(turn._id);
        const date = new Date(turn.createdAt);
        const timeStr = date.toLocaleTimeString();

        return (
          <div
            key={turn._id}
            className={`
              p-2 rounded border
              ${isCurrent
                ? "border-terminal-green bg-terminal-bg-lighter"
                : "border-terminal-green-dimmer"
              }
            `}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => toggleExpand(turn._id, e)}
                  className="text-terminal-green-dim hover:text-terminal-green w-4 text-left"
                >
                  {isExpanded ? "v" : ">"}
                </button>
                <span className="text-terminal-green-dim text-xs">{timeStr}</span>
                {isCurrent && <span className="text-terminal-green">[current]</span>}
                <span className="text-terminal-green-dimmer">[{turn.messages.length} msgs]</span>
              </div>
              {!isCurrent && (
                <button
                  onClick={() => handleTimeTravel(turn._id)}
                  className="text-xs text-terminal-cyan hover:underline"
                >
                  [Travel Here]
                </button>
              )}
            </div>
            {isExpanded && (
              <pre
                onClick={(e) => e.stopPropagation()}
                className="mt-2 ml-6 p-2 text-xs bg-terminal-bg border border-terminal-green-dimmer rounded overflow-auto max-h-64 text-terminal-green-dim cursor-text"
              >
                {JSON.stringify(turn.messages, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Content block types from Anthropic API
type DemoToolResultBlock = ToolResultBlock & { content: string | unknown[] };

type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | DemoToolResultBlock
  | { type: string; [key: string]: unknown };

type APIMessage = Omit<ConversationMessage, "role" | "items"> & {
  role: "user" | "assistant";
  items: string | ContentBlock[];
};

function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return (
      <div className="text-terminal-green-dim">
        {(block as TextBlock).text}
      </div>
    );
  }

  if (block.type === "tool_use") {
    const toolUse = block as ToolUseBlock;
    return (
      <div className="border border-terminal-cyan rounded p-2 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-terminal-cyan font-bold">tool_use</span>
          <span className="text-terminal-yellow">{toolUse.name}</span>
        </div>
        <pre className="text-terminal-green-dim text-xs whitespace-pre-wrap break-all max-h-40 overflow-auto bg-terminal-bg p-1 rounded">
          {JSON.stringify(toolUse.input, null, 2)}
        </pre>
      </div>
    );
  }

  if (block.type === "tool_result") {
    const toolResult = block as DemoToolResultBlock;
    const content = typeof toolResult.content === "string"
      ? toolResult.content
      : JSON.stringify(toolResult.content, null, 2);
    return (
      <div className="border border-terminal-green-dimmer rounded p-2 space-y-1">
        <span className="text-terminal-green-dimmer">tool_result</span>
        <pre className="text-terminal-green-dim text-xs whitespace-pre-wrap break-all max-h-24 overflow-auto">
          {content}
        </pre>
      </div>
    );
  }

  // Unknown block type
  return (
    <div className="text-terminal-green-dimmer text-xs">
      <pre>{JSON.stringify(block, null, 2)}</pre>
    </div>
  );
}

function MessagesView({ sessionId }: { sessionId: Id<"sessions"> }) {
  const steps = useQuery(api.machineSteps.getRecent, { sessionId, limit: 50 });

  if (!steps) {
    return <div className="text-terminal-green-dimmer">Loading...</div>;
  }

  // Flatten all messages from all steps
  const allMessages: { stepId: string; stepNumber: number; message: APIMessage; index: number }[] = [];
  for (const step of steps) {
    (step.messages as APIMessage[]).forEach((msg, i) => {
      allMessages.push({ stepId: step._id, stepNumber: step.stepNumber, message: msg, index: i });
    });
  }

  if (allMessages.length === 0) {
    return <div className="text-terminal-green-dimmer italic">No messages yet</div>;
  }

  return (
    <div className="space-y-3">
      {allMessages.map(({ stepId, stepNumber, message, index }) => {
        const blocks: ContentBlock[] = typeof message.items === "string"
          ? [{ type: "text", text: message.items }]
          : (message.items);

        return (
          <div
            key={`${stepId}-${index}`}
            className="p-2 rounded border border-terminal-green-dimmer"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs font-bold ${message.role === "user" ? "text-terminal-cyan" : "text-terminal-green"
                }`}>
                {message.role}
              </span>
              <span className="text-terminal-green-dimmer text-xs">
                step #{stepNumber}
              </span>
            </div>
            <div className="space-y-2 text-xs">
              {blocks.map((block, blockIdx) => (
                <ContentBlockView key={blockIdx} block={block} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Types for branch visualization
interface TurnNode {
  id: Id<"machineTurns">;
  parentId?: Id<"machineTurns">;
  createdAt: number;
  messageCount: number;
  isCurrent: boolean;
  children: Id<"machineTurns">[];
  depth: number;
  isInCurrentPath: boolean;
  isBranchPoint: boolean;
}

interface TurnTreeViz {
  nodes: Map<string, TurnNode>;
  root: TurnNode | null;
  currentPath: Set<string>;
  branchCount: number;
  maxDepth: number;
}

function buildTurnTreeViz(
  turns: MachineTurn[],
  currentTurnId: Id<"machineTurns"> | undefined
): TurnTreeViz {
  const nodes = new Map<string, TurnNode>();
  const childMap = new Map<string, Id<"machineTurns">[]>();

  // First pass: create nodes and build child relationships
  let root: TurnNode | null = null;
  for (const turn of turns) {
    const node: TurnNode = {
      id: turn._id,
      parentId: turn.parentId,
      createdAt: turn.createdAt,
      messageCount: turn.messages.length,
      isCurrent: turn._id === currentTurnId,
      children: [],
      depth: 0,
      isInCurrentPath: false,
      isBranchPoint: false,
    };
    nodes.set(turn._id, node);

    if (!turn.parentId) {
      root = node;
    } else {
      if (!childMap.has(turn.parentId)) {
        childMap.set(turn.parentId, []);
      }
      childMap.get(turn.parentId)!.push(turn._id);
    }
  }

  // Second pass: assign children and mark branch points
  let branchCount = 0;
  for (const [parentId, children] of childMap.entries()) {
    const node = nodes.get(parentId);
    if (node) {
      node.children = children.sort((a, b) => {
        const nodeA = nodes.get(a);
        const nodeB = nodes.get(b);
        return (nodeA?.createdAt ?? 0) - (nodeB?.createdAt ?? 0);
      });
      if (children.length > 1) {
        node.isBranchPoint = true;
        branchCount++;
      }
    }
  }

  // Calculate depths
  let maxDepth = 0;
  const calculateDepth = (nodeId: string, depth: number) => {
    const node = nodes.get(nodeId);
    if (!node) return;
    node.depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    for (const childId of node.children) {
      calculateDepth(childId, depth + 1);
    }
  };
  if (root) {
    calculateDepth(root.id, 0);
  }

  // Build current path (trace from current to root)
  const currentPath = new Set<string>();
  if (currentTurnId) {
    let curr: string | undefined = currentTurnId;
    while (curr) {
      currentPath.add(curr);
      const node = nodes.get(curr);
      if (node) {
        node.isInCurrentPath = true;
      }
      curr = node?.parentId;
    }
  }

  return { nodes, root, currentPath, branchCount, maxDepth };
}

function BranchesView({ sessionId }: { sessionId: Id<"sessions"> }) {
  const turnTree = useQuery(api.sessions.getTurnTree, { sessionId });
  const timeTravel = useMutation(api.sessions.timeTravel);

  if (!turnTree) {
    return <div className="text-terminal-green-dimmer">Loading...</div>;
  }

  if (turnTree.turns.length === 0) {
    return <div className="text-terminal-green-dimmer italic">No turns yet</div>;
  }

  const viz = buildTurnTreeViz(turnTree.turns, turnTree.currentTurnId);

  if (!viz.root) {
    return <div className="text-terminal-green-dimmer italic">No root turn found</div>;
  }

  const handleTimeTravel = async (turnId: Id<"machineTurns">) => {
    if (turnId !== turnTree.currentTurnId) {
      await timeTravel({ sessionId, targetTurnId: turnId });
    }
  };

  // Render a single node line
  const renderNode = (
    node: TurnNode,
    prefix: string,
    isLast: boolean
  ): JSX.Element[] => {
    const connector = isLast ? "└── " : "├── ";
    const time = new Date(node.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const elements: JSX.Element[] = [];

    // Current node
    elements.push(
      <div
        key={node.id}
        onClick={() => handleTimeTravel(node.id)}
        className={`
          flex items-center gap-1 cursor-pointer hover:bg-terminal-bg-lighter py-0.5
          ${node.isInCurrentPath ? "text-terminal-green" : "text-terminal-green-dim"}
        `}
      >
        <span className="text-terminal-green-dimmer select-none whitespace-pre">
          {prefix}
          {connector}
        </span>
        <span className={node.isCurrent ? "text-terminal-green font-bold" : ""}>
          {time}
        </span>
        <span className="text-terminal-green-dimmer">[{node.messageCount}]</span>
        {node.isBranchPoint && <span className="text-terminal-yellow">◆</span>}
        {node.isCurrent && <span className="text-terminal-cyan">✦</span>}
      </div>
    );

    // Render children
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    node.children.forEach((childId, index) => {
      const childNode = viz.nodes.get(childId);
      if (childNode) {
        const isLastChild = index === node.children.length - 1;
        elements.push(...renderNode(childNode, childPrefix, isLastChild));
      }
    });

    return elements;
  };

  return (
    <div className="space-y-4">
      {/* Header stats */}
      <div className="text-terminal-cyan text-xs border-b border-terminal-green-dimmer pb-2">
        {viz.maxDepth + 1} levels · {viz.nodes.size} turns · {viz.branchCount}{" "}
        branch{viz.branchCount !== 1 ? "es" : ""}
      </div>

      {/* Tree visualization */}
      <div className="font-mono text-xs">{renderNode(viz.root, "", true)}</div>

      {/* Legend */}
      <div className="text-terminal-green-dimmer text-xs border-t border-terminal-green-dimmer pt-2 space-y-1">
        <div>
          <span className="text-terminal-yellow">◆</span> = Branch point
        </div>
        <div>
          <span className="text-terminal-cyan">✦</span> = Current turn
        </div>
        <div>[n] = Message count</div>
        <div className="text-terminal-green-dim mt-2">
          Click any turn to time travel
        </div>
      </div>
    </div>
  );
}
