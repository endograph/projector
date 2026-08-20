// Prebuilt rich explainers, rendered in place of an assistant message that
// carries a widget id (see convex/topics.ts — the plain-text equivalent is
// persisted as the message content, so the LLM and unknown clients still get
// prose). Each explainer keeps the conceit alive: its follow-up chips send
// straight into the conversation, same as every card on the marketing page.

import type { ComponentType } from "react";

type ExplainerProps = { onAsk: (text: string) => void };

function SubagentsExplainer({ onAsk }: ExplainerProps) {
  return (
    <div className="xp">
      <svg className="xp-diagram" viewBox="0 0 520 210" role="img" aria-label="Diagram: a parent machine fans out to three child machines, and all of them write frames into one shared durable log">
        {/* parent */}
        <g className="xp-node">
          <rect x="14" y="52" width="72" height="30" rx="6" />
          <text x="50" y="71">guide</text>
        </g>
        {/* fan: one source, a beam per child — the prism, again */}
        <path className="xp-beam xp-b1" d="M86 63 C 150 50, 190 30, 250 27" />
        <path className="xp-beam xp-b2" d="M86 67 C 150 67, 190 67, 250 67" />
        <path className="xp-beam xp-b3" d="M86 71 C 150 84, 190 104, 250 107" />
        {/* children */}
        <g className="xp-node xp-child xp-c1">
          <rect x="250" y="12" width="66" height="28" rx="6" />
          <text x="283" y="30">plan</text>
        </g>
        <g className="xp-node xp-child xp-c2">
          <rect x="250" y="53" width="66" height="28" rx="6" />
          <text x="283" y="71">build</text>
        </g>
        <g className="xp-node xp-child xp-c3">
          <rect x="250" y="94" width="66" height="28" rx="6" />
          <text x="283" y="112">check</text>
        </g>
        {/* every lane writes down into the same log rail */}
        <path className="xp-drop xp-b1" d="M283 40 C 283 90, 300 140, 330 168" />
        <path className="xp-drop xp-b2" d="M283 81 C 283 110, 320 150, 355 168" />
        <path className="xp-drop xp-b3" d="M283 122 C 283 140, 340 158, 380 168" />
        <path className="xp-drop xp-parent" d="M50 82 C 50 150, 180 172, 300 172" />
        {/* the log: one rail, interleaved frames */}
        <g className="xp-log">
          <line x1="24" y1="184" x2="496" y2="184" />
          <text className="xp-log-label" x="24" y="205">one durable frame log</text>
        </g>
        <g className="xp-frames">
          <rect className="xp-fp" x="60" y="178" width="12" height="12" rx="2" />
          <rect className="xp-f1" x="120" y="178" width="12" height="12" rx="2" />
          <rect className="xp-f2" x="150" y="178" width="12" height="12" rx="2" />
          <rect className="xp-f1" x="180" y="178" width="12" height="12" rx="2" />
          <rect className="xp-f3" x="210" y="178" width="12" height="12" rx="2" />
          <rect className="xp-f2" x="240" y="178" width="12" height="12" rx="2" />
          <rect className="xp-f2" x="270" y="178" width="12" height="12" rx="2" />
          <rect className="xp-f3" x="300" y="178" width="12" height="12" rx="2" />
          <rect className="xp-fp" x="360" y="178" width="12" height="12" rx="2" />
        </g>
      </svg>
      <dl className="xp-points">
        <div>
          <dt>spawn</dt>
          <dd>Children are full machines — their own node, states, and tools.</dd>
        </div>
        <div>
          <dt>share</dt>
          <dd>No copied transcript. They attach to the same durable frame log.</dd>
        </div>
        <div>
          <dt>converge</dt>
          <dd>No hand-back step — a child's results are frames the parent already sees.</dd>
        </div>
      </dl>
      <div className="xp-asks">
        <button type="button" onClick={() => onAsk("What slice of state does a child machine see?")}>
          What does a child see? →
        </button>
        <button type="button" onClick={() => onAsk("Point me at this turn in the inspector's frame log.")}>
          Show me this turn in the log →
        </button>
      </div>
    </div>
  );
}

export const EXPLAINERS: Record<string, ComponentType<ExplainerProps>> = {
  subagents: SubagentsExplainer,
};
