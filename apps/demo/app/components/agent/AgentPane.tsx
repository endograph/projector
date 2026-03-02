"use client";

import { forwardRef } from "react";
import { useAtomValue } from "jotai";
import type { Id } from "@/convex/_generated/dataModel";
import { activeAgentTabAtom, shiftHeldAtom } from "@/src/atoms";
import { TabNav } from "./TabNav";
import { InstanceTreeTab } from "./InstanceTreeTab";
import { StateTab } from "./StateTab";
import { HistoryTab } from "./HistoryTab";
import { CommandsTab } from "./CommandsTab";
import { DevTab } from "./DevTab";
import type {
  CommandMeta,
  JSONSchema,
  SerializedInstance,
} from "markov-machines/client";
import type { DisplayInstance } from "@/src/types/display";

type CommandSchema = JSONSchema & {
  type?: string;
  properties?: Record<string, unknown>;
};

type SerializedCommandInfo = Omit<CommandMeta, "inputSchema"> & {
  inputSchema: CommandSchema;
};

interface AgentPaneProps {
  sessionId: Id<"sessions">;
  instance: SerializedInstance | undefined;
  displayInstance: DisplayInstance | undefined;
  systemPrompt?: string;
  onResetSession: () => void;
  onResetToFoo: () => void;
}

// Helper to get active instance (follows children to deepest)
function getActiveDisplayInstance(instance: DisplayInstance): DisplayInstance {
  if (!instance.children || instance.children.length === 0) {
    return instance;
  }
  const lastChild = instance.children[instance.children.length - 1];
  if (!lastChild) return instance;
  return getActiveDisplayInstance(lastChild);
}

// Extract commands from active instance (node commands + pack commands separately)
function getCommandsFromInstance(instance: DisplayInstance | undefined): {
  nodeCommands: SerializedCommandInfo[];
  packCommands: SerializedCommandInfo[];
} {
  if (!instance) return { nodeCommands: [], packCommands: [] };
  const active = getActiveDisplayInstance(instance);

  const nodeCommands = Object.values(active.node.commands).map(cmd => ({
    name: cmd.name,
    description: cmd.description,
    inputSchema: cmd.inputSchema as CommandSchema,
  }));

  // Get pack commands from root instance packs (that's where full pack data is stored)
  const packCommands: SerializedCommandInfo[] = [];
  const rootPacks = instance.packs || [];
  for (const pack of rootPacks) {
    for (const cmd of Object.values(pack.commands)) {
      packCommands.push({
        name: cmd.name,
        description: cmd.description,
        inputSchema: cmd.inputSchema as CommandSchema,
      });
    }
  }

  return { nodeCommands, packCommands };
}

export const AgentPane = forwardRef<HTMLDivElement, AgentPaneProps>(
  function AgentPane({ sessionId, instance, displayInstance, systemPrompt, onResetSession, onResetToFoo }, ref) {
    const activeTab = useAtomValue(activeAgentTabAtom);
    const shiftHeld = useAtomValue(shiftHeldAtom);
    const { nodeCommands, packCommands } = getCommandsFromInstance(displayInstance);

    return (
      <div
        ref={ref}
        tabIndex={0}
        className="h-full flex flex-col bg-terminal-bg relative z-0 pane-focus"
      >
        {/* Header */}
        <div className="px-4 py-2 border-b border-terminal-green-dimmer">
          <h2 className="text-terminal-green terminal-glow text-sm font-bold">
            {shiftHeld ? <u>A</u> : "A"}GENT
          </h2>
        </div>

        {/* Tab navigation */}
        <TabNav />

        {/* Tab content */}
        <div className="flex-1 overflow-hidden p-4">
          {activeTab === "tree" && (
            <InstanceTreeTab
              sessionId={sessionId}
              instance={instance ?? null}
              displayInstance={displayInstance ?? null}
              systemPrompt={systemPrompt}
            />
          )}
          {activeTab === "state" && <StateTab instance={displayInstance ?? null} />}
          {activeTab === "history" && <HistoryTab sessionId={sessionId} />}
          {activeTab === "commands" && (
            <CommandsTab nodeCommands={nodeCommands} packCommands={packCommands} />
          )}
          {activeTab === "dev" && <DevTab onResetSession={onResetSession} onResetToFoo={onResetToFoo} />}
        </div>
      </div>
    );
  }
);
