"use client";

import { useState } from "react";
import {
  TreeNode,
  Expander,
  JsonBlock,
  KeyValue,
  truncate,
} from "./TreeView";
import type { Ref, SerialNode } from "markov-machines/client";
import type { DisplayNode, DisplayPack } from "@/src/types/display";

// ============================================================================
// Client TreeView Types & Implementation
// ============================================================================

export interface ClientInstance {
  id: string;
  node: DisplayNode | SerialNode | Ref;
  state: unknown;
  children?: ClientInstance[];
  packs?: DisplayPack[];
  packStates?: Record<string, unknown>;
}

function isDisplayNode(node: unknown): node is DisplayNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "commands" in node &&
    "name" in node &&
    Array.isArray((node as DisplayNode).tools)
  );
}

function getClientNodeName(instance: ClientInstance): string {
  return isDisplayNode(instance.node) ? instance.node.name : "client";
}

function ClientPackInstructionsField({
  instructions,
  isDynamic,
}: {
  instructions: string | undefined;
  isDynamic?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasInstructions = instructions !== undefined;

  const handleClick = () => {
    if (hasInstructions) {
      setExpanded(!expanded);
    }
  };

  return (
    <div className="text-xs overflow-hidden">
      <button
        onClick={handleClick}
        className="flex items-start gap-1 text-left w-full min-w-0"
      >
        <span className="w-2.5 shrink-0" />
        <span className="text-terminal-cyan shrink-0">instructions:</span>
        {hasInstructions ? (
          <>
            <span className={`text-terminal-green-dim italic text-left min-w-0 ${expanded ? "whitespace-pre-wrap" : "truncate"}`}>
              "{instructions}"
            </span>
            {isDynamic && (
              <span className="text-terminal-yellow shrink-0">(dynamic)</span>
            )}
          </>
        ) : (
          <span className="text-terminal-green-dimmer italic">undefined</span>
        )}
      </button>
    </div>
  );
}

function ClientNodeSection({ node }: { node: DisplayNode }) {
  const instructionPreview = truncate(node.instructions.replace(/\n/g, " "), 100);
  const commandNames = Object.keys(node.commands);

  return (
    <div className="space-y-1">
      <KeyValue
        k="instructions"
        v={<span className="italic">"{instructionPreview}"</span>}
      />

      <Expander label="validator" preview={node.validator}>
        <JsonBlock data={node.validator} />
      </Expander>

      {commandNames.length > 0 && (
        <Expander label="commands" badge={commandNames.length} preview={node.commands}>
          <div className="text-terminal-green-dim space-y-0.5">
            {commandNames.map((name) => {
              const cmd = node.commands[name];
              return (
                <div key={name}>
                  • {name}: <span className="italic">{cmd?.description}</span>
                </div>
              );
            })}
          </div>
        </Expander>
      )}
    </div>
  );
}

function ClientInstanceContent({ instance, rootPackStates }: { instance: ClientInstance; rootPackStates: Record<string, unknown> }) {
  // Get packs from instance (packs are stored at root instance level only)
  const instancePacks = instance.packs || [];
  const packStates = rootPackStates;
  const hasPacks = instancePacks.length > 0;

  return (
    <>
      <Expander label="state" preview={instance.state}>
        <JsonBlock data={instance.state} />
      </Expander>

      {hasPacks && (
        <Expander
          label="packs"
          badge={instancePacks.length}
          preview={instancePacks}
        >
          <div className="space-y-1">
            {instancePacks.map((pack) => {
              const packState = packStates[pack.name];
              return (
                <Expander key={pack.name} label={pack.name} preview={packState}>
                  <div className="space-y-1">
                    <ClientPackInstructionsField
                      instructions={pack.instructions}
                      isDynamic={pack.instructionsDynamic}
                    />
                    <Expander label="state" preview={packState}>
                      <JsonBlock data={packState} />
                    </Expander>
                    <Expander label="validator" preview={pack.validator}>
                      <JsonBlock data={pack.validator} />
                    </Expander>
                    {Object.keys(pack.commands).length > 0 && (
                      <Expander label="commands" badge={Object.keys(pack.commands).length} preview={pack.commands}>
                        <div className="text-terminal-green-dim space-y-0.5">
                          {Object.entries(pack.commands).map(([cmdName, cmd]) => (
                            <div key={cmdName}>
                              • {cmdName}: <span className="italic">{cmd?.description}</span>
                            </div>
                          ))}
                        </div>
                      </Expander>
                    )}
                  </div>
                </Expander>
              );
            })}
          </div>
        </Expander>
      )}

      {isDisplayNode(instance.node) && (
        <Expander label="node" preview={instance.node}>
          <ClientNodeSection node={instance.node} />
        </Expander>
      )}
    </>
  );
}

export function ClientTreeView({ instance }: { instance: ClientInstance }) {
  return (
    <div className="font-mono text-sm">
      <div className="text-terminal-green-dimmer text-xs mb-2 border-b border-terminal-green-dimmer pb-2">
        DryClientInstance representation (what clients receive)
      </div>
      <TreeNode
        item={instance}
        getName={getClientNodeName}
        renderContent={(inst) => <ClientInstanceContent instance={inst} rootPackStates={instance.packStates || {}} />}
      />
    </div>
  );
}
