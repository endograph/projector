"use client";

import { forwardRef, useEffect, useRef } from "react";
import type { DemoClientInstance, DemoMessage } from "@/src/types/display";
import { scanlinesEnabledAtom } from "@/src/atoms";
import { useAtom } from "jotai";
import { useProjector } from "@/src/projector/ProjectorProvider";

type TerminalPaneProps = {
  messages: DemoMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
  connectionError?: string | null;
  voiceStatus?: { status: string; detail?: string };
};

export const TerminalPane = forwardRef<HTMLTextAreaElement, TerminalPaneProps>(
  function TerminalPane(
    { messages, input, onInputChange, onSend, isLoading, connectionError, voiceStatus },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [scanlinesEnabled, setScanlinesEnabled] = useAtom(scanlinesEnabledAtom);
    const { effigy, instances } = useProjector();
    const state = getAgentControlsState(instances);
    const voiceEnabled = Boolean(state?.liveMode);
    const cameraEnabled = Boolean(state?.cameraEnabled);
    const streamingEnabled = state?.streamingEnabled !== false;

    useEffect(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    }, [messages.length, isLoading]);

    const runToggle = async (name: string, enabled: boolean) => {
      const commandMeta = findCommand(instances, name);
      const command = effigy.getCommand(name as never, {
        target: commandMeta?.target,
        optimistic: (ctx) => {
          const address = findState(instances, "agentControls")?.address;
          if (!address) return;
          const field =
            name === "setVoiceEnabled"
              ? "liveMode"
              : name === "setCameraEnabled"
                ? "cameraEnabled"
                : "streamingEnabled";
          ctx.patchAt(address, { [field]: enabled });
        },
      });
      await command.run({ enabled } as never);
    };

    return (
      <section className="pane-focus flex min-h-0 flex-col border-r border-terminal-green-dimmer bg-terminal-bg">
        <header className="flex items-center justify-between border-b border-terminal-green-dimmer px-4 py-2">
          <h1 className="terminal-glow text-sm font-bold tracking-[0.08em]">MESSAGES</h1>
          <div className="flex items-center gap-2 text-xs">
            <Toggle label="stream" enabled={streamingEnabled} onClick={() => runToggle("setStreamingEnabled", !streamingEnabled)} />
            <Toggle label="voice" enabled={voiceEnabled} onClick={() => runToggle("setVoiceEnabled", !voiceEnabled)} />
            <Toggle label="camera" enabled={cameraEnabled} onClick={() => runToggle("setCameraEnabled", !cameraEnabled)} />
            <button
              className="rounded border border-terminal-green-dimmer px-2 py-1 text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
              onClick={() => setScanlinesEnabled(!scanlinesEnabled)}
            >
              scanlines
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="terminal-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="max-w-xl space-y-3 text-sm leading-6 text-terminal-green-dim">
              <p>
                Start with a message like <span className="text-terminal-green">my name is Ada</span> or{" "}
                <span className="text-terminal-green">remember this demo uses projector</span>.
              </p>
              {connectionError && (
                <p className="rounded border border-terminal-red p-3 text-terminal-red">
                  Convex is not connected: {connectionError}
                </p>
              )}
              {voiceEnabled && voiceStatus && (
                <p className="rounded border border-terminal-green-dimmer p-3 text-terminal-cyan">
                  voice {voiceStatus.status}
                  {voiceStatus.detail ? `: ${voiceStatus.detail}` : ""}
                </p>
              )}
            </div>
          ) : (
            messages.map((message) => <TerminalMessage key={message._id} message={message} />)
          )}
          {voiceEnabled && messages.length > 0 && voiceStatus && (
            <div className="text-xs text-terminal-cyan">
              voice {voiceStatus.status}
              {voiceStatus.detail ? `: ${voiceStatus.detail}` : ""}
            </div>
          )}
          {isLoading && <div className="text-sm text-terminal-cyan">agent is updating projector state...</div>}
        </div>

        <form
          className="border-t border-terminal-green-dimmer p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <div className="flex items-end gap-3">
            <span className="pb-2 text-terminal-green-dim">&gt;</span>
            <textarea
              ref={ref}
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSend();
                }
              }}
              rows={2}
              className="min-h-12 flex-1 resize-none bg-transparent text-sm leading-6 text-terminal-green outline-none placeholder:text-terminal-green-dimmer"
              placeholder="Message the projector demo..."
            />
            <button
              type="submit"
              disabled={isLoading || input.trim().length === 0}
              className="rounded border border-terminal-green px-3 py-2 text-sm text-terminal-green hover:bg-terminal-green hover:text-terminal-bg disabled:cursor-not-allowed disabled:border-terminal-green-dimmer disabled:text-terminal-green-dimmer"
            >
              send
            </button>
          </div>
        </form>
      </section>
    );
  },
);

function Toggle({ label, enabled, onClick }: { label: string; enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 ${enabled ? "border-terminal-green text-terminal-green" : "border-terminal-green-dimmer text-terminal-green-dim"}`}
    >
      {label}
    </button>
  );
}

function TerminalMessage({ message }: { message: DemoMessage }) {
  const isUser = message.role === "user";
  return (
    <article className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 text-sm">
      <div className={isUser ? "text-terminal-cyan" : "text-terminal-yellow"}>{isUser ? "user" : "agent"}</div>
      <div className="whitespace-pre-wrap leading-6 text-terminal-green">{message.content}</div>
    </article>
  );
}

function getAgentControlsState(instances: DemoClientInstance[]) {
  return findState(instances, "agentControls")?.value as
    | {
        liveMode?: boolean;
        cameraEnabled?: boolean;
        streamingEnabled?: boolean;
      }
    | undefined;
}

function findState(instances: DemoClientInstance[], key: string) {
  for (const instance of instances) {
    const state = findStateInInstance(instance, key);
    if (state) return state;
  }
  return undefined;
}

function findCommand(instances: DemoClientInstance[], name: string) {
  for (const instance of instances) {
    const command = findCommandInInstance(instance, name);
    if (command) return command;
  }
  return undefined;
}

function findCommandInInstance(instance: DemoClientInstance, name: string): DemoClientInstance["commands"][number] | undefined {
  const command = instance.commands.find((item) => item.name === name);
  if (command) return command;
  for (const member of instance.members) {
    const found = findCommandInInstance(member, name);
    if (found) return found;
  }
  for (const child of instance.children) {
    const found = findCommandInInstance(child, name);
    if (found) return found;
  }
  return undefined;
}

function findStateInInstance(instance: DemoClientInstance, key: string): DemoClientInstance["states"][number] | undefined {
  const state = instance.states.find((item) => item.key === key);
  if (state) return state;
  for (const member of instance.members) {
    const found = findStateInInstance(member, key);
    if (found) return found;
  }
  for (const child of instance.children) {
    const found = findStateInInstance(child, key);
    if (found) return found;
  }
  return undefined;
}
