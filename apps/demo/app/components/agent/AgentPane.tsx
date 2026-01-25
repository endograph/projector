"use client";

import { forwardRef } from "react";
import { useAtomValue } from "jotai";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { activeAgentTabAtom, shiftHeldAtom } from "@/src/atoms";
import { TabNav } from "./TabNav";
import { InstanceTreeTab } from "./InstanceTreeTab";
import { StateTab } from "./StateTab";
import { HistoryTab } from "./HistoryTab";
import { CommandsTab } from "./CommandsTab";
import { DevTab } from "./DevTab";

interface SerializedInstance {
  id: string;
  node: Record<string, unknown>;
  state: unknown;
  children?: SerializedInstance[];
  packStates?: Record<string, unknown>;
  executorConfig?: Record<string, unknown>;
  suspended?: {
    suspendId: string;
    reason: string;
    suspendedAt: string;
    metadata?: Record<string, unknown>;
  };
}

interface SerializedCommandInfo {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown> };
}

interface DisplayCommand {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DisplayInstance {
  id: string;
  node: {
    name: string;
    instructions: string;
    validator: Record<string, unknown>;
    tools: string[];
    transitions: Record<string, string>;
    commands: Record<string, DisplayCommand>;
    initialState?: unknown;
    packs?: string[];
    worker?: boolean;
  };
  state: unknown;
  children?: DisplayInstance[];
  packStates?: Record<string, unknown>;
  executorConfig?: Record<string, unknown>;
  suspended?: {
    suspendId: string;
    reason: string;
    suspendedAt: string;
    metadata?: Record<string, unknown>;
  };
}

interface AgentPaneProps {
  sessionId: Id<"sessions">;
  instance: SerializedInstance | undefined;
  displayInstance: DisplayInstance | undefined;
  onResetSession: () => void;
}

export const AgentPane = forwardRef<HTMLDivElement, AgentPaneProps>(
  function AgentPane({ sessionId, instance, displayInstance, onResetSession }, ref) {
    const activeTab = useAtomValue(activeAgentTabAtom);
    const shiftHeld = useAtomValue(shiftHeldAtom);
    const getCommands = useAction(api.commands.getCommands);
    const [commands, setCommands] = useState<SerializedCommandInfo[]>([]);

    useEffect(() => {
      if (sessionId) {
        getCommands({ sessionId }).then((cmds) => setCommands(cmds as SerializedCommandInfo[])).catch(console.error);
      }
    }, [sessionId, instance, getCommands]);

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
            <CommandsTab sessionId={sessionId} commands={commands} />
          )}
          {activeTab === "dev" && <DevTab onResetSession={onResetSession} />}
        </div>
      </div>
    );
  }
);
