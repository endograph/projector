"use client";

import { useAtom, useAtomValue } from "jotai";
import { activeAgentTabAtom, shiftHeldAtom, type AgentTab } from "@/src/atoms";

const tabs: { id: AgentTab; hotkey: string; rest: string }[] = [
  { id: "tree", hotkey: "T", rest: "ree" },
  { id: "state", hotkey: "S", rest: "tate" },
  { id: "history", hotkey: "H", rest: "istory" },
  { id: "commands", hotkey: "C", rest: "ommands" },
  { id: "dev", hotkey: "D", rest: "ev" },
];

export function TabNav() {
  const [activeTab, setActiveTab] = useAtom(activeAgentTabAtom);
  const shiftHeld = useAtomValue(shiftHeldAtom);

  return (
    <div className="flex border-b border-terminal-green-dimmer">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`
            px-4 py-2 text-sm font-mono transition-colors
            ${
              activeTab === tab.id
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-green-dim hover:text-terminal-green"
            }
          `}
        >
          [{shiftHeld ? <u>{tab.hotkey}</u> : tab.hotkey}{tab.rest}]
        </button>
      ))}
    </div>
  );
}
