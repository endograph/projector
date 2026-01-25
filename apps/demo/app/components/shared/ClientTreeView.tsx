"use client";

import {
  TreeNode,
  Expander,
  JsonBlock,
  KeyValue,
  truncate,
} from "./TreeView";

// ============================================================================
// Client TreeView Types & Implementation
// ============================================================================

interface DisplayCommand {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DisplayNode {
  name: string;
  instructions: string;
  validator: Record<string, unknown>;
  tools: string[];
  transitions: Record<string, string>;
  commands: Record<string, DisplayCommand>;
  initialState?: unknown;
  packs?: string[];
  worker?: boolean;
}

interface SerialNode {
  instructions: string;
  validator: Record<string, unknown>;
  transitions: Record<string, unknown>;
  tools?: Record<string, unknown>;
  initialState?: unknown;
}

interface Ref {
  ref: string;
}

export interface ClientInstance {
  id: string;
  node: DisplayNode | SerialNode | Ref;
  state: unknown;
  children?: ClientInstance[];
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
                  • {name}: <span className="italic">{cmd.description}</span>
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
  const hasPackStates =
    instance.packStates && Object.keys(instance.packStates).length > 0;

  return (
    <>
      <Expander label="state" preview={instance.state}>
        <JsonBlock data={instance.state} />
      </Expander>

      {hasPackStates && (
        <Expander
          label="packStates"
          badge={Object.keys(instance.packStates!).length}
          preview={instance.packStates}
        >
          <div className="space-y-1">
            {Object.entries(instance.packStates!).map(([name, state]) => (
              <Expander key={name} label={name} preview={state}>
                <JsonBlock data={state} />
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
