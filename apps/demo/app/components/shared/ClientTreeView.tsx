"use client";

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

function ClientInstanceContent({ instance }: { instance: ClientInstance }) {
  const hasPacks = instance.packs && instance.packs.length > 0;

  return (
    <>
      <Expander label="state" preview={instance.state}>
        <JsonBlock data={instance.state} />
      </Expander>

      {hasPacks && (
        <Expander
          label="packs"
          badge={instance.packs!.length}
          preview={instance.packs}
        >
          <div className="space-y-1">
            {instance.packs!.map((pack) => (
              <Expander key={pack.name} label={pack.name} preview={pack.state}>
                <div className="space-y-1">
                  <Expander label="state" preview={pack.state}>
                    <JsonBlock data={pack.state} />
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
            ))}
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
        renderContent={(inst) => <ClientInstanceContent instance={inst} />}
      />
    </div>
  );
}
