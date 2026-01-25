"use client";

import { useState } from "react";

interface JsonViewerProps {
  data: unknown;
  initialExpanded?: boolean;
  maxDepth?: number;
}

export function JsonViewer({
  data,
  initialExpanded = true,
  maxDepth = 10,
}: JsonViewerProps) {
  return (
    <div className="font-mono text-sm">
      <JsonNode data={data} depth={0} maxDepth={maxDepth} initialExpanded={initialExpanded} />
    </div>
  );
}

interface JsonNodeProps {
  data: unknown;
  depth: number;
  maxDepth: number;
  initialExpanded: boolean;
  keyName?: string;
}

function JsonNode({ data, depth, maxDepth, initialExpanded, keyName }: JsonNodeProps) {
  const [expanded, setExpanded] = useState(initialExpanded && depth < 2);

  const indent = "  ".repeat(depth);

  if (data === null) {
    return (
      <span>
        {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
        <span className="text-terminal-yellow">null</span>
      </span>
    );
  }

  if (data === undefined) {
    return (
      <span>
        {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
        <span className="text-terminal-green-dimmer">undefined</span>
      </span>
    );
  }

  if (typeof data === "boolean") {
    return (
      <span>
        {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
        <span className="text-terminal-yellow">{String(data)}</span>
      </span>
    );
  }

  if (typeof data === "number") {
    return (
      <span>
        {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
        <span className="text-terminal-yellow">{data}</span>
      </span>
    );
  }

  if (typeof data === "string") {
    const truncated = data.length > 100 ? data.slice(0, 100) + "..." : data;
    return (
      <span>
        {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
        <span className="text-terminal-green">"{truncated}"</span>
      </span>
    );
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return (
        <span>
          {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
          <span className="text-terminal-green-dim">[]</span>
        </span>
      );
    }

    if (depth >= maxDepth) {
      return (
        <span>
          {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
          <span className="text-terminal-green-dim">[...]</span>
        </span>
      );
    }

    return (
      <div>
        <span
          className="cursor-pointer hover:text-terminal-green"
          onClick={() => setExpanded(!expanded)}
        >
          {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
          <span className="text-terminal-green-dim">
            {expanded ? "[" : `[${data.length} items]`}
          </span>
        </span>
        {expanded && (
          <>
            {data.map((item, i) => (
              <div key={i} className="pl-4">
                <JsonNode
                  data={item}
                  depth={depth + 1}
                  maxDepth={maxDepth}
                  initialExpanded={initialExpanded}
                />
                {i < data.length - 1 && ","}
              </div>
            ))}
            <span className="text-terminal-green-dim">]</span>
          </>
        )}
      </div>
    );
  }

  if (typeof data === "object") {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return (
        <span>
          {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
          <span className="text-terminal-green-dim">{"{}"}</span>
        </span>
      );
    }

    if (depth >= maxDepth) {
      return (
        <span>
          {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
          <span className="text-terminal-green-dim">{"{...}"}</span>
        </span>
      );
    }

    return (
      <div>
        <span
          className="cursor-pointer hover:text-terminal-green"
          onClick={() => setExpanded(!expanded)}
        >
          {keyName && <span className="text-terminal-cyan">{keyName}: </span>}
          <span className="text-terminal-green-dim">
            {expanded ? "{" : `{${entries.length} keys}`}
          </span>
        </span>
        {expanded && (
          <>
            {entries.map(([key, value], i) => (
              <div key={key} className="pl-4">
                <JsonNode
                  data={value}
                  depth={depth + 1}
                  maxDepth={maxDepth}
                  initialExpanded={initialExpanded}
                  keyName={key}
                />
                {i < entries.length - 1 && ","}
              </div>
            ))}
            <span className="text-terminal-green-dim">{"}"}</span>
          </>
        )}
      </div>
    );
  }

  return <span className="text-terminal-red">[unknown]</span>;
}
