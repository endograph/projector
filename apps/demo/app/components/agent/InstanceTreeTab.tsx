"use client";

import { useAtom } from "jotai";
import { activeTreeSubtabAtom, type TreeSubtab } from "@/src/atoms";
import { TreeView } from "../shared/TreeView";
import { ClientTreeView } from "../shared/ClientTreeView";

interface SerializedInstance {
  id: string;
  node: Record<string, unknown>;
  state: unknown;
  children?: SerializedInstance[];
  packStates?: Record<string, unknown>;
  executorConfig?: Record<string, unknown>;
  suspended?: {
    suspendId: string;
    reason: string;
    suspendedAt: string;
    metadata?: Record<string, unknown>;
  };
}

interface DisplayCommand {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DisplayInstance {
  id: string;
  node: {
    name: string;
    instructions: string;
    validator: Record<string, unknown>;
    tools: string[];
    transitions: Record<string, string>;
    commands: Record<string, DisplayCommand>;
    initialState?: unknown;
    packs?: string[];
    worker?: boolean;
  };
  state: unknown;
  children?: DisplayInstance[];
  packStates?: Record<string, unknown>;
  executorConfig?: Record<string, unknown>;
  suspended?: {
    suspendId: string;
    reason: string;
    suspendedAt: string;
    metadata?: Record<string, unknown>;
  };
}

interface InstanceTreeTabProps {
  instance: SerializedInstance | null;
  displayInstance: DisplayInstance | null;
}

const subtabs: { id: TreeSubtab; label: string }[] = [
  { id: "server", label: "Server" },
  { id: "client", label: "Client" },
];

export function InstanceTreeTab({ instance, displayInstance }: InstanceTreeTabProps) {
  const [activeSubtab, setActiveSubtab] = useAtom(activeTreeSubtabAtom);

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
              ${
                activeSubtab === tab.id
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
        {!instance ? (
          <div className="text-terminal-green-dimmer italic">
            No instance loaded
          </div>
        ) : activeSubtab === "server" ? (
          <TreeView instance={displayInstance ?? instance as any} />
        ) : (
          <ClientTreeView instance={displayInstance ?? instance as any} />
        )}
      </div>
    </div>
  );
}
