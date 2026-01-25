"use client";

import { useAtomValue } from "jotai";
import { isPreviewingAtom, stepPreviewInstanceAtom } from "@/src/atoms";
import { JsonViewer } from "../shared/JsonViewer";

interface SerializedInstance {
  id: string;
  node: Record<string, unknown>;
  state: unknown;
  children?: SerializedInstance[];
  packStates?: Record<string, unknown>;
}

interface StateTabProps {
  instance: SerializedInstance | null;
}

function getActiveLeafState(instance: SerializedInstance): unknown {
  if (!instance.children || instance.children.length === 0) {
    return instance.state;
  }
  const lastChild = instance.children[instance.children.length - 1];
  return lastChild ? getActiveLeafState(lastChild) : instance.state;
}

function getActiveLeafNodeName(instance: SerializedInstance): string {
  if (!instance.children || instance.children.length === 0) {
    // Check if node is a ref (has 'ref' property) or inline
    const node = instance.node;
    if ("ref" in node && typeof node.ref === "string") {
      return node.ref;
    }
    return "inline";
  }
  const lastChild = instance.children[instance.children.length - 1];
  return lastChild ? getActiveLeafNodeName(lastChild) : "unknown";
}

export function StateTab({ instance }: StateTabProps) {
  const isPreviewing = useAtomValue(isPreviewingAtom);
  const previewInstance = useAtomValue(stepPreviewInstanceAtom) as SerializedInstance | null;

  const displayInstance = isPreviewing && previewInstance ? previewInstance : instance;

  if (!displayInstance) {
    return (
      <div className="text-terminal-green-dimmer italic">
        No instance loaded
      </div>
    );
  }

  const activeState = getActiveLeafState(displayInstance);
  const activeNodeName = getActiveLeafNodeName(displayInstance);
  const packStates = displayInstance.packStates || {};

  return (
    <div className="space-y-6">
      {/* Preview indicator */}
      {isPreviewing && (
        <div className="text-terminal-yellow text-sm border border-terminal-yellow px-2 py-1 inline-block">
          [PREVIEW]
        </div>
      )}

      {/* Current Instance State */}
      <div>
        <h3 className="text-terminal-green text-sm mb-2 terminal-glow">
          Current Instance State ({activeNodeName})
        </h3>
        <div className="bg-terminal-bg-lighter p-3 rounded border border-terminal-green-dimmer">
          <JsonViewer data={activeState} />
        </div>
      </div>

      {/* Pack States */}
      {Object.keys(packStates).length > 0 && (
        <div>
          <h3 className="text-terminal-green text-sm mb-2 terminal-glow">
            Pack States
          </h3>
          {Object.entries(packStates).map(([packName, packState]) => (
            <div
              key={packName}
              className="bg-terminal-bg-lighter p-3 rounded border border-terminal-green-dimmer mb-2"
            >
              <div className="text-terminal-cyan text-xs mb-2">{packName}</div>
              <JsonViewer data={packState} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
