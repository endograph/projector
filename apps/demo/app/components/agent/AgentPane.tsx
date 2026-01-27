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
  onResetSession: () => void;
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

// Extract commands from active instance (includes node commands and pack commands)
function getCommandsFromInstance(instance: DisplayInstance | undefined): SerializedCommandInfo[] {
  if (!instance) return [];
  const active = getActiveDisplayInstance(instance);
  
  // Get node commands
  const nodeCommands = Object.values(active.node.commands).map(cmd => ({
    name: cmd.name,
    description: cmd.description,
    inputSchema: cmd.inputSchema as CommandSchema,
  }));

  // Get pack commands from root instance (packs are stored on root)
  const packCommands: SerializedCommandInfo[] = [];
  if (instance.packs) {
    for (const pack of instance.packs) {
      for (const cmd of Object.values(pack.commands)) {
        packCommands.push({
          name: cmd.name,
          description: cmd.description,
          inputSchema: cmd.inputSchema as CommandSchema,
        });
      }
    }
  }

  return [...nodeCommands, ...packCommands];
}

export const AgentPane = forwardRef<HTMLDivElement, AgentPaneProps>(
  function AgentPane({ sessionId, instance, displayInstance, onResetSession }, ref) {
    const activeTab = useAtomValue(activeAgentTabAtom);
    const shiftHeld = useAtomValue(shiftHeldAtom);
    const commands = getCommandsFromInstance(displayInstance);

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
            <InstanceTreeTab instance={instance ?? null} displayInstance={displayInstance ?? null} />
          )}
          {activeTab === "state" && <StateTab instance={instance ?? null} />}
          {activeTab === "history" && <HistoryTab sessionId={sessionId} />}
          {activeTab === "commands" && (
            <CommandsTab commands={commands} />
          )}
          {activeTab === "dev" && <DevTab onResetSession={onResetSession} />}
        </div>
      </div>
    );
  }
);
