"use client";

import { useCallback } from "react";
import { useAtom } from "jotai";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { activeTreeSubtabAtom, type TreeSubtab } from "@/src/atoms";
import { TreeView } from "../shared/TreeView";
import { ClientTreeView } from "../shared/ClientTreeView";
import type { SerializedInstance } from "markov-machines/client";
import type { DisplayInstance } from "@/src/types/display";
import type { Id } from "@/convex/_generated/dataModel";

interface InstanceTreeTabProps {
  sessionId: Id<"sessions">;
  instance: SerializedInstance | null;
  displayInstance: DisplayInstance | null;
  systemPrompt?: string;
}

const subtabs: { id: TreeSubtab; label: string }[] = [
  { id: "server", label: "Server" },
  { id: "client", label: "Client" },
  { id: "prompt", label: "Prompt" },
  { id: "restore", label: "Restore" },
];

interface RestorableNode {
  instanceId: string;
  name: string;
}

function collectRestorableNodes(instance: DisplayInstance | SerializedInstance): RestorableNode[] {
  const nodes: RestorableNode[] = [];

  function walk(inst: DisplayInstance | SerializedInstance) {
    const node = inst.node as { name?: string };
    if (node && typeof node === "object" && "name" in node && node.name && node.name !== "[inline]") {
      nodes.push({ instanceId: inst.id, name: node.name });
    }
    if (inst.children) {
      for (const child of inst.children) {
        walk(child as DisplayInstance | SerializedInstance);
      }
    }
  }

  walk(instance);
  return nodes;
}

function RestoreTab({
  sessionId,
  instance
}: {
  sessionId: Id<"sessions">;
  instance: DisplayInstance | SerializedInstance;
}) {
  const restoreToCharter = useMutation(api.sessions.restoreToCharter);

  const packs = (instance as DisplayInstance).packs || [];
  const nodes = collectRestorableNodes(instance);

  const handleRestoreNode = useCallback((instanceId: string, nodeName: string) => {
    restoreToCharter({ sessionId, instanceId, type: "node", name: nodeName });
  }, [restoreToCharter, sessionId]);

  const handleRestorePack = useCallback((packName: string) => {
    restoreToCharter({ sessionId, instanceId: "", type: "pack", name: packName });
  }, [restoreToCharter, sessionId]);

  const hasItems = packs.length > 0 || nodes.length > 0;

  return (
    <div className="space-y-4">
      <p className="text-terminal-green-dim text-xs">
        Restore resets instructions and state back to charter defaults.
      </p>

      {!hasItems ? (
        <div className="text-terminal-green-dimmer italic text-xs">
          Nothing to restore
        </div>
      ) : (
        <div className="space-y-3">
          {nodes.length > 0 && (
            <div className="space-y-1">
              <div className="text-terminal-cyan text-xs">Nodes</div>
              {nodes.map((node) => (
                <div key={node.instanceId} className="flex items-center gap-3 text-xs">
                  <span className="text-terminal-green">{node.name}</span>
                  <button
                    onClick={() => handleRestoreNode(node.instanceId, node.name)}
                    className="text-terminal-green-dim hover:text-terminal-green"
                  >
                    [restore]
                  </button>
                </div>
              ))}
            </div>
          )}

          {packs.length > 0 && (
            <div className="space-y-1">
              <div className="text-terminal-cyan text-xs">Packs</div>
              {packs.map((pack) => (
                <div key={pack.name} className="flex items-center gap-3 text-xs">
                  <span className="text-terminal-green">{pack.name}</span>
                  <button
                    onClick={() => handleRestorePack(pack.name)}
                    className="text-terminal-green-dim hover:text-terminal-green"
                  >
                    [restore]
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function InstanceTreeTab({ sessionId, instance, displayInstance, systemPrompt }: InstanceTreeTabProps) {
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
          <TreeView sessionId={sessionId} instance={displayInstance ?? instance as any} />
        ) : activeSubtab === "client" ? (
          <ClientTreeView instance={displayInstance ?? instance as any} />
        ) : activeSubtab === "prompt" ? (
          systemPrompt ? (
            <pre className="text-terminal-green text-xs whitespace-pre-wrap font-mono">
              {systemPrompt}
            </pre>
          ) : (
            <div className="text-terminal-green-dimmer italic">
              System prompt not available
            </div>
          )
        ) : activeSubtab === "restore" ? (
          <RestoreTab sessionId={sessionId} instance={displayInstance ?? instance as any} />
        ) : null}
      </div>
    </div>
  );
}
