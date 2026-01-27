"use client";

import { useAtom } from "jotai";
import { activeTreeSubtabAtom, type TreeSubtab } from "@/src/atoms";
import { TreeView } from "../shared/TreeView";
import { ClientTreeView } from "../shared/ClientTreeView";
import type { SerializedInstance } from "markov-machines/client";
import type { DisplayInstance } from "@/src/types/display";

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
