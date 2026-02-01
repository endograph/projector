"use client";

import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Ref, SerialNode, SerializedInstance } from "markov-machines/client";
import { isRef, isSerialTransition } from "markov-machines/client";
import type { DisplayNode, DisplayPack } from "@/src/types/display";
import JSON5 from "json5";
import Editor from "react-simple-code-editor";

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

type NodeType = DisplayNode | SerialNode | Ref;

export type ServerInstance = Omit<SerializedInstance, "node" | "children"> & {
  node: NodeType;
  children?: ServerInstance[];
  packStates?: Record<string, unknown>;
};

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

type EditingNode = { instanceId: string; instructions: string } | null;
type EditingState = { instanceId: string; state: unknown } | null;

function InstructionsEditModal({
  editing,
  sessionId,
  onClose,
}: {
  editing: NonNullable<EditingNode>;
  sessionId: Id<"sessions">;
  onClose: () => void;
}) {
  const [value, setValue] = useState(editing.instructions);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editCurrentInstance = useMutation(api.sessions.editCurrentInstance);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSave = useCallback(async () => {
    await editCurrentInstance({
      sessionId,
      instanceId: editing.instanceId,
      patch: { node: { instructions: value } },
    });
    onClose();
  }, [editCurrentInstance, sessionId, editing.instanceId, value, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="bg-terminal-bg border border-terminal-green-dimmer p-4 w-[600px] max-h-[80vh] flex flex-col gap-3 font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-terminal-green text-sm font-bold">
          Edit Instructions
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              handleSave();
            }
          }}
          className="bg-black border border-terminal-green-dimmer text-terminal-green text-xs p-2 w-full min-h-[200px] resize-y focus:outline-none focus:border-terminal-green terminal-scrollbar"
          spellCheck={false}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs text-terminal-green-dim border border-terminal-green-dimmer hover:text-terminal-green hover:border-terminal-green"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1 text-xs text-terminal-green border border-terminal-green hover:bg-terminal-green hover:text-black"
          >
            Enter
          </button>
        </div>
      </div>
    </div>
  );
}

/** Insert commas between lines where a value ends and a new key/value begins. */
function addMissingCommas(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim().length > 0);
    const nextTrimmed = nextNonEmpty?.trim() ?? "";

    if (
      trimmed.length > 0 &&
      !/[,{\[:\(]$/.test(trimmed) &&
      nextTrimmed.length > 0 &&
      !/^[\}\]]/.test(nextTrimmed)
    ) {
      result.push(trimmed + ",");
    } else {
      result.push(lines[i]);
    }
  }

  return result.join("\n");
}

function highlightJson(code: string): string {
  return code.replace(
    /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
    (match, key, str, bool, num) => {
      if (key) return `<span style="color:var(--terminal-cyan)">${key}</span>:`;
      if (str) return `<span style="color:var(--terminal-green-dim)">${str}</span>`;
      if (bool) return `<span style="color:var(--terminal-yellow)">${bool}</span>`;
      if (num) return `<span style="color:var(--terminal-yellow)">${num}</span>`;
      return match;
    },
  );
}

function StateEditModal({
  editing,
  sessionId,
  onClose,
}: {
  editing: NonNullable<EditingState>;
  sessionId: Id<"sessions">;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => JSON.stringify(editing.state, null, 2));
  const [error, setError] = useState<string | null>(null);
  const editCurrentInstance = useMutation(api.sessions.editCurrentInstance);

  const handleSave = useCallback(async () => {
    let parsed: unknown;
    try {
      parsed = JSON5.parse(addMissingCommas(value));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    setError(null);
    try {
      await editCurrentInstance({
        sessionId,
        instanceId: editing.instanceId,
        patch: { state: parsed },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  }, [editCurrentInstance, sessionId, editing.instanceId, value, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && e.metaKey) {
          e.preventDefault();
          handleSave();
        }
      }}
    >
      <div
        className="bg-terminal-bg border border-terminal-green-dimmer p-4 w-[600px] max-h-[80vh] flex flex-col gap-3 font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-terminal-green text-sm font-bold">
          Edit State
        </div>
        <div className="bg-black border border-terminal-green-dimmer min-h-[200px] max-h-[50vh] overflow-auto focus-within:border-terminal-green terminal-scrollbar">
          <Editor
            value={value}
            onValueChange={(code) => {
              setValue(code);
              setError(null);
            }}
            highlight={highlightJson}
            tabSize={2}
            padding={8}
            style={{
              fontFamily: "inherit",
              fontSize: "0.75rem",
              lineHeight: "1.25rem",
              color: "var(--terminal-green)",
              minHeight: "200px",
            }}
            textareaClassName="focus:outline-none"
          />
        </div>
        {error && (
          <div className="text-red-400 text-xs">{error}</div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs text-terminal-green-dim border border-terminal-green-dimmer hover:text-terminal-green hover:border-terminal-green"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1 text-xs text-terminal-green border border-terminal-green hover:bg-terminal-green hover:text-black"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function InstructionsField({
  instructions,
  instanceId,
  onEditInstructions,
}: {
  instructions: string;
  instanceId?: string;
  onEditInstructions?: (instanceId: string, instructions: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canEdit = !!instanceId && !!onEditInstructions;

  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey && canEdit) {
      e.preventDefault();
      e.stopPropagation();
      onEditInstructions!(instanceId!, instructions);
    } else {
      setExpanded(!expanded);
    }
  };

  return (
    <div className="text-xs overflow-hidden">
      <button
        onClick={handleClick}
        className={`flex items-start gap-1 text-left w-full min-w-0 ${canEdit ? "hover:bg-terminal-green/10 rounded" : ""}`}
      >
        <span className="w-2.5 shrink-0" />
        <span className="text-terminal-cyan shrink-0">instructions:</span>
        <span className={`text-terminal-green-dim italic text-left min-w-0 ${expanded ? "whitespace-pre-wrap" : "truncate"}`}>
          "{instructions}"
        </span>
      </button>
    </div>
  );
}

function NodeSection({
  node,
  instanceId,
  onEditInstructions,
}: {
  node: NodeType;
  instanceId?: string;
  onEditInstructions?: (instanceId: string, instructions: string) => void;
}) {
  if (isRef(node)) {
    return (
      <div className="text-xs text-terminal-green-dim italic">
        ref: {node.ref}
      </div>
    );
  }

  if (isDisplayNode(node)) {
    const toolNames = node.tools;
    const transitions = node.transitions;
    const transitionNames = Object.keys(transitions);

    return (
      <div className="space-y-1">
        <InstructionsField
          instructions={node.instructions}
          instanceId={instanceId}
          onEditInstructions={onEditInstructions}
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

        {node.packNames && node.packNames.length > 0 && (
          <Expander label="packs" badge={node.packNames.length} preview={node.packNames}>
            <div className="text-terminal-green-dim space-y-0.5">
              {node.packNames.map((name) => (
                <div key={name}>• {name}</div>
              ))}
            </div>
          </Expander>
        )}

        {node.worker && <div className="pl-3.5"><KeyValue k="worker" v="true" /></div>}

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
      <InstructionsField
        instructions={node.instructions}
        instanceId={instanceId}
        onEditInstructions={onEditInstructions}
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
                : isSerialTransition(t) && isRef(t.node)
                  ? t.node.ref
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

function ServerInstanceContent({
  instance,
  onEditInstructions,
  onEditState,
}: {
  instance: ServerInstance;
  onEditInstructions?: (instanceId: string, instructions: string) => void;
  onEditState?: (instanceId: string, state: unknown) => void;
}) {
  // Get packs from node if it's a DisplayNode
  const nodePacks = isDisplayNode(instance.node) ? (instance.node.packs || []) : [];
  const packStates = instance.packStates || {};
  const hasPacks = nodePacks.length > 0;
  const isSuspended = !!instance.suspended;

  const handleStateClick = (e: React.MouseEvent) => {
    if (e.metaKey && onEditState) {
      e.preventDefault();
      e.stopPropagation();
      onEditState(instance.id, instance.state);
    }
  };

  return (
    <>
      <div
        onClick={handleStateClick}
        className={onEditState ? "cursor-pointer hover:bg-terminal-green/10 -mx-1 px-1 rounded" : ""}
      >
        <Expander label="state" preview={instance.state}>
          <JsonBlock data={instance.state} />
        </Expander>
      </div>

      {hasPacks && (
        <Expander
          label="packs"
          badge={nodePacks.length}
          preview={nodePacks}
        >
          <div className="space-y-1">
            {nodePacks.map((pack) => {
              const packState = packStates[pack.name];
              return (
                <Expander key={pack.name} label={pack.name} preview={packState}>
                  <div className="space-y-1">
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
                              • {cmdName}: <span className="italic">{cmd.description}</span>
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

      <Expander label="node" preview={instance.node}>
        <NodeSection
          node={instance.node}
          instanceId={instance.id}
          onEditInstructions={onEditInstructions}
        />
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

export function TreeView({ sessionId, instance }: { sessionId: Id<"sessions">; instance: ServerInstance }) {
  const [editing, setEditing] = useState<EditingNode>(null);
  const [editingState, setEditingState] = useState<EditingState>(null);

  const handleEditInstructions = useCallback((instanceId: string, instructions: string) => {
    setEditing({ instanceId, instructions });
  }, []);

  const handleEditState = useCallback((instanceId: string, state: unknown) => {
    setEditingState({ instanceId, state });
  }, []);

  return (
    <>
      <TreeNode
        item={instance}
        getName={getServerNodeName}
        renderContent={(inst) => (
          <ServerInstanceContent
            instance={inst}
            onEditInstructions={handleEditInstructions}
            onEditState={handleEditState}
          />
        )}
        getBadge={getServerBadge}
      />
      {editing && (
        <InstructionsEditModal
          editing={editing}
          sessionId={sessionId}
          onClose={() => setEditing(null)}
        />
      )}
      {editingState && (
        <StateEditModal
          editing={editingState}
          sessionId={sessionId}
          onClose={() => setEditingState(null)}
        />
      )}
    </>
  );
}
