"use client";

import { useAtomValue } from "jotai";
import { isPreviewingAtom, stepPreviewInstanceAtom } from "@/src/atoms";
import { JsonViewer } from "../shared/JsonViewer";
import type { SerializedInstance } from "markov-machines/client";
import type { DisplayPack } from "@/src/types/display";

type SerializedInstanceWithPacks = SerializedInstance & { packs?: DisplayPack[] };

interface StateTabProps {
  instance: SerializedInstanceWithPacks | null;
}

function getActiveLeafState(instance: SerializedInstanceWithPacks): unknown {
  if (!instance.children || instance.children.length === 0) {
    return instance.state;
  }
  const lastChild = instance.children[instance.children.length - 1];
  return lastChild ? getActiveLeafState(lastChild) : instance.state;
}

function getActiveLeafNodeName(instance: SerializedInstanceWithPacks): string {
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
  const previewInstance = useAtomValue(stepPreviewInstanceAtom) as SerializedInstanceWithPacks | null;

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
  const packs = displayInstance.packs || [];

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

      {/* Packs */}
      {packs.length > 0 && (
        <div>
          <h3 className="text-terminal-green text-sm mb-2 terminal-glow">
            Packs
          </h3>
          {packs.map((pack) => (
            <div
              key={pack.name}
              className="bg-terminal-bg-lighter p-3 rounded border border-terminal-green-dimmer mb-2"
            >
              <div className="text-terminal-cyan text-xs mb-2">{pack.name}</div>
              <JsonViewer data={pack.state} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
