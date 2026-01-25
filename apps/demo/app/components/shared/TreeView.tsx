"use client";

import { useState, type ReactNode } from "react";

// ============================================================================
// Shared Tree Components (exported for reuse)
// ============================================================================

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

export function jsonPreview(data: unknown, maxLen: number = 40): string {
  const str = JSON.stringify(data);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

export function Expander({
  label,
  badge,
  preview,
  defaultOpen = false,
  children,
}: {
  label: string;
  badge?: string | number;
  preview?: unknown;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-terminal-cyan hover:text-terminal-green text-left"
      >
        <span className="w-2.5 text-terminal-green-dimmer shrink-0">
          {open ? "▾" : "▸"}
        </span>
        <span className="shrink-0">{label}</span>
        {badge !== undefined && (
          <span className="text-terminal-yellow shrink-0">({badge})</span>
        )}
        {!open && preview !== undefined && (
          <span className="text-terminal-green-dimmer truncate">
            {jsonPreview(preview)}
          </span>
        )}
      </button>
      {open && <div className="pl-2.5 pt-0.5">{children}</div>}
    </div>
  );
}

export function KeyValue({
  k,
  v,
  vClass = "text-terminal-green-dim",
}: {
  k: string;
  v: ReactNode;
  vClass?: string;
}) {
  return (
    <div className="flex gap-1 text-xs">
      <span className="text-terminal-cyan shrink-0">{k}:</span>
      <span className={vClass}>{v}</span>
    </div>
  );
}

export function JsonBlock({ data }: { data: unknown }) {
  return (
    <pre className="text-terminal-green-dim text-xs whitespace-pre-wrap break-all max-h-40 overflow-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

/**
 * Generic tree node component with unified styling.
 * Handles header, vertical line, content, and child rendering.
 */
export function TreeNode<T extends { id: string; children?: T[] }>({
  item,
  getName,
  renderContent,
  getBadge,
}: {
  item: T;
  getName: (item: T) => string;
  renderContent: (item: T) => ReactNode;
  getBadge?: (item: T) => ReactNode;
}) {
  const hasChildren = item.children && item.children.length > 0;
  const nodeName = getName(item);

  return (
    <div className="font-mono">
      {/* Header row */}
      <div className="flex items-center text-sm">
        <span className="font-bold text-terminal-green border border-dashed border-terminal-green-dimmer px-1 m-px">
          {nodeName}
        </span>
        <span className="text-terminal-green-dimmer text-xs ml-2">
          {item.id.slice(0, 8)}
        </span>
        {getBadge && getBadge(item)}
      </div>

      {/* Content sections with vertical line */}
      <div className="border-l border-terminal-green-dimmer ml-px pl-3 space-y-1 py-1">
        {renderContent(item)}

        {/* Children with connectors */}
        {hasChildren &&
          item.children!.map((child) => (
            <div key={child.id} className="mt-2 flex items-start">
              {/* Horizontal connector from parent's vertical border */}
              <div
                className="shrink-0"
                style={{
                  width: '23px',
                  height: '1px',
                  backgroundColor: 'var(--terminal-green-dimmer)',
                  marginTop: '0.75em',
                  marginLeft: '-12px'
                }}
              />
              {/* Child node */}
              <TreeNode
                item={child}
                getName={getName}
                renderContent={renderContent}
                getBadge={getBadge}
              />
            </div>
          ))}
      </div>
    </div>
  );
}

// ============================================================================
// Server TreeView Types & Implementation
// ============================================================================

interface SerializedSuspendInfo {
  suspendId: string;
  reason: string;
  suspendedAt: string;
  metadata?: Record<string, unknown>;
}

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

type NodeType = DisplayNode | SerialNode | Ref;

export interface ServerInstance {
  id: string;
  node: NodeType;
  state: unknown;
  children?: ServerInstance[];
  packStates?: Record<string, unknown>;
  executorConfig?: Record<string, unknown>;
  suspended?: SerializedSuspendInfo;
}

function isRef(value: unknown): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    "ref" in value &&
    typeof (value as Ref).ref === "string" &&
    Object.keys(value).length === 1
  );
}

function isDisplayNode(node: NodeType): node is DisplayNode {
  return (
    !isRef(node) &&
    "tools" in node &&
    Array.isArray((node as DisplayNode).tools)
  );
}

function getServerNodeName(instance: ServerInstance): string {
  if (isRef(instance.node)) {
    return instance.node.ref;
  } else if ("name" in instance.node && typeof instance.node.name === "string") {
    return instance.node.name;
  }
  return "[inline]";
}

function NodeSection({ node }: { node: NodeType }) {
  if (isRef(node)) {
    return (
      <div className="text-xs text-terminal-green-dim italic">
        ref: {node.ref}
      </div>
    );
  }

  const instructionPreview = truncate(node.instructions.replace(/\n/g, " "), 100);

  if (isDisplayNode(node)) {
    const toolNames = node.tools;
    const transitions = node.transitions;
    const transitionNames = Object.keys(transitions);

    return (
      <div className="space-y-1">
        <KeyValue
          k="instructions"
          v={<span className="italic">"{instructionPreview}"</span>}
        />

        <Expander label="validator" preview={node.validator}>
          <JsonBlock data={node.validator} />
        </Expander>

        {toolNames.length > 0 && (
          <Expander label="tools" badge={toolNames.length} preview={toolNames}>
            <div className="text-terminal-green-dim space-y-0.5">
              {toolNames.map((name) => (
                <div key={name}>• {name}</div>
              ))}
            </div>
          </Expander>
        )}

        {transitionNames.length > 0 && (
          <Expander label="transitions" badge={transitionNames.length} preview={transitions}>
            <div className="text-terminal-green-dim space-y-0.5">
              {transitionNames.map((name) => (
                <div key={name}>
                  • {name} → <span className="text-terminal-cyan">{transitions[name]}</span>
                </div>
              ))}
            </div>
          </Expander>
        )}

        {Object.keys(node.commands).length > 0 && (
          <Expander label="commands" badge={Object.keys(node.commands).length} preview={node.commands}>
            <div className="text-terminal-green-dim space-y-0.5">
              {Object.entries(node.commands).map(([cmdName, cmd]) => (
                <div key={cmdName}>
                  • {cmdName}: <span className="italic">{cmd.description}</span>
                </div>
              ))}
            </div>
          </Expander>
        )}

        {node.packs && node.packs.length > 0 && (
          <Expander label="packs" badge={node.packs.length} preview={node.packs}>
            <div className="text-terminal-green-dim space-y-0.5">
              {node.packs.map((name) => (
                <div key={name}>• {name}</div>
              ))}
            </div>
          </Expander>
        )}

        {node.worker && <KeyValue k="worker" v="true" />}

        {node.initialState !== undefined && (
          <Expander label="initialState" preview={node.initialState}>
            <JsonBlock data={node.initialState} />
          </Expander>
        )}
      </div>
    );
  }

  // Handle serial format
  const serialNode = node as SerialNode;
  const toolNames = serialNode.tools ? Object.keys(serialNode.tools) : [];
  const transitionNames = Object.keys(serialNode.transitions);

  return (
    <div className="space-y-1">
      <KeyValue
        k="instructions"
        v={<span className="italic">"{instructionPreview}"</span>}
      />

      <Expander label="validator" preview={serialNode.validator}>
        <JsonBlock data={serialNode.validator} />
      </Expander>

      {toolNames.length > 0 && (
        <Expander label="tools" badge={toolNames.length}>
          <div className="text-terminal-green-dim space-y-0.5">
            {toolNames.map((name) => (
              <div key={name}>• {name}</div>
            ))}
          </div>
        </Expander>
      )}

      {transitionNames.length > 0 && (
        <Expander label="transitions" badge={transitionNames.length}>
          <div className="text-terminal-green-dim space-y-0.5">
            {transitionNames.map((name) => {
              const t = serialNode.transitions[name];
              const target = isRef(t)
                ? t.ref
                : typeof t === "object" && t && "node" in t && isRef((t as { node: unknown }).node)
                  ? (((t as { node: Ref }).node) as Ref).ref
                  : "inline";
              return (
                <div key={name}>
                  • {name} → <span className="text-terminal-cyan">{target}</span>
                </div>
              );
            })}
          </div>
        </Expander>
      )}

      {serialNode.initialState !== undefined && (
        <Expander label="initialState" preview={serialNode.initialState}>
          <JsonBlock data={serialNode.initialState} />
        </Expander>
      )}
    </div>
  );
}

function ServerInstanceContent({ instance }: { instance: ServerInstance }) {
  const hasPackStates =
    instance.packStates && Object.keys(instance.packStates).length > 0;
  const isSuspended = !!instance.suspended;

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

      <Expander label="node" preview={instance.node}>
        <NodeSection node={instance.node} />
      </Expander>

      {instance.executorConfig && (
        <Expander label="executorConfig" preview={instance.executorConfig}>
          <JsonBlock data={instance.executorConfig} />
        </Expander>
      )}

      {isSuspended && (
        <Expander label="suspended" defaultOpen preview={instance.suspended}>
          <div className="text-terminal-yellow text-xs space-y-0.5">
            <KeyValue k="reason" v={instance.suspended!.reason} vClass="text-terminal-yellow" />
            <KeyValue k="id" v={instance.suspended!.suspendId} vClass="text-terminal-yellow" />
            <KeyValue k="at" v={instance.suspended!.suspendedAt} vClass="text-terminal-yellow" />
            {instance.suspended!.metadata && (
              <Expander label="metadata" preview={instance.suspended!.metadata}>
                <JsonBlock data={instance.suspended!.metadata} />
              </Expander>
            )}
          </div>
        </Expander>
      )}
    </>
  );
}

function getServerBadge(instance: ServerInstance): ReactNode {
  if (instance.suspended) {
    return <span className="text-terminal-yellow text-xs ml-2">[SUSPENDED]</span>;
  }
  return null;
}

export function TreeView({ instance }: { instance: ServerInstance }) {
  return (
    <TreeNode
      item={instance}
      getName={getServerNodeName}
      renderContent={(inst) => <ServerInstanceContent instance={inst} />}
      getBadge={getServerBadge}
    />
  );
}
