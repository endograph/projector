"use client";

import { forwardRef, useEffect, useRef } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { DemoClientInstance, DemoMessage } from "@/src/types/display";
import type { OptimisticContext } from "@projectors/core/client";
import type { LocalVideoTrack } from "livekit-client";
import { scanlinesEnabledAtom } from "@/src/atoms";
import { useAtom } from "jotai";
import { useProjector } from "@/src/projector/ProjectorProvider";

type TerminalPaneProps = {
  messages: DemoMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onForkSession: () => void;
  onReturnToLatest: () => void;
  isLoading: boolean;
  isTimeTraveling: boolean;
  timeTravelFrameId: Id<"frames"> | null;
  connectionError?: string | null;
  voiceStatus?: { status: string; detail?: string };
  localCameraTrack?: LocalVideoTrack | null;
};

export const TerminalPane = forwardRef<HTMLTextAreaElement, TerminalPaneProps>(
  function TerminalPane(
    {
      messages,
      input,
      onInputChange,
      onSend,
      onForkSession,
      onReturnToLatest,
      isLoading,
      isTimeTraveling,
      timeTravelFrameId,
      connectionError,
      voiceStatus,
      localCameraTrack,
    },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [scanlinesEnabled, setScanlinesEnabled] = useAtom(scanlinesEnabledAtom);
    const { effigy, instances, readOnly } = useProjector();
    const state = getAgentControlsState(instances);
    const voiceEnabled = Boolean(state?.liveMode);
    const cameraEnabled = Boolean(state?.cameraEnabled);
    const memoryEnabled = Boolean(state?.memoryEnabled);
    const streamingEnabled = state?.streamingEnabled !== false;

    useEffect(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    }, [messages.length, isLoading]);

    const runToggle = async (name: string, enabled: boolean) => {
      if (readOnly) return;
      const commandMeta = findCommand(instances, name);
      const command = effigy.getCommand(name as never, {
        target: commandMeta?.target,
        optimistic: (ctx: OptimisticContext<DemoClientInstance[]>) => {
          const address = findState(instances, "agentControls")?.address;
          if (!address) return;
          const field =
            name === "setVoiceEnabled"
              ? "liveMode"
              : name === "setCameraEnabled"
                ? "cameraEnabled"
                : name === "setMemoryEnabled"
                  ? "memoryEnabled"
                  : "streamingEnabled";
          ctx.patchAt(address, { [field]: enabled });
        },
      });
      await command.run({ enabled } as never);
    };

    return (
      <section className="pane-focus relative flex min-h-0 flex-col border-r border-terminal-green-dimmer bg-terminal-bg">
        <header className="flex items-center justify-between border-b border-terminal-green-dimmer px-4 py-2">
          <h1 className="terminal-glow text-sm font-bold tracking-[0.08em]">MESSAGES</h1>
          <div className="flex items-center gap-2 text-xs">
            <Toggle
              label="stream"
              enabled={streamingEnabled}
              disabled={readOnly}
              onClick={() => runToggle("setStreamingEnabled", !streamingEnabled)}
            />
            <Toggle
              label="voice"
              enabled={voiceEnabled}
              disabled={readOnly}
              onClick={() => runToggle("setVoiceEnabled", !voiceEnabled)}
            />
            <Toggle
              label="camera"
              enabled={cameraEnabled}
              disabled={readOnly}
              onClick={() => runToggle("setCameraEnabled", !cameraEnabled)}
            />
            <Toggle
              label="memory"
              enabled={memoryEnabled}
              disabled={readOnly}
              onClick={() => runToggle("setMemoryEnabled", !memoryEnabled)}
            />
            <button
              className="rounded border border-terminal-green-dimmer px-2 py-1 text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
              onClick={() => setScanlinesEnabled(!scanlinesEnabled)}
            >
              scanlines
            </button>
          </div>
        </header>

        {cameraEnabled && (
          <CameraPreview track={localCameraTrack ?? null} />
        )}

        <div
          ref={scrollRef}
          className={`terminal-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4 ${
            cameraEnabled ? "sm:pr-52" : ""
          }`}
        >
          <div className={cameraEnabled ? "pt-[calc((100vw-2rem)*0.5625+1rem)] sm:pt-0" : undefined}>
            {messages.length === 0 ? (
              <div className="max-w-xl space-y-3 text-sm leading-6 text-terminal-green-dim">
                <p>
                  Start with a message like{" "}
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
              <>
                {messages.map((message) => <TerminalMessage key={message._id} message={message} />)}
                {connectionError && (
                  <p className="rounded border border-terminal-red p-3 text-sm text-terminal-red">
                    {connectionError}
                  </p>
                )}
              </>
            )}
            {voiceEnabled && messages.length > 0 && voiceStatus && (
              <div className="text-xs text-terminal-cyan">
                voice {voiceStatus.status}
                {voiceStatus.detail ? `: ${voiceStatus.detail}` : ""}
              </div>
            )}
            {isLoading && <div className="text-sm text-terminal-cyan">agent is updating projector state...</div>}
          </div>
        </div>

        {isTimeTraveling ? (
          <div className="border-t border-terminal-green-dimmer p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 text-xs leading-5">
                <div className="uppercase tracking-[0.08em] text-terminal-cyan">historical frame</div>
                <div className="mt-1 truncate text-terminal-green-dim">
                  {timeTravelFrameId ? shortId(timeTravelFrameId) : "selected"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onReturnToLatest}
                  className="rounded border border-terminal-green-dimmer px-3 py-2 text-sm text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
                >
                  live latest
                </button>
                <button
                  type="button"
                  onClick={onForkSession}
                  disabled={isLoading}
                  className="rounded border border-terminal-cyan px-4 py-2 text-sm text-terminal-cyan hover:bg-terminal-cyan hover:text-terminal-bg disabled:cursor-not-allowed disabled:border-terminal-green-dimmer disabled:text-terminal-green-dimmer"
                >
                  fork session
                </button>
              </div>
            </div>
          </div>
        ) : (
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
        )}
      </section>
    );
  },
);

function CameraPreview({ track }: { track: LocalVideoTrack | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !track) return;
    track.attach(video);
    void video.play().catch(() => undefined);
    return () => {
      track.detach(video);
      video.srcObject = null;
    };
  }, [track]);

  return (
    <div className="absolute left-4 right-4 top-[3.25rem] z-10 grid gap-2 sm:left-auto sm:w-40">
      <div className="relative aspect-video overflow-hidden rounded border border-terminal-green-dimmer bg-black">
        {track ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-3 text-center text-xs uppercase tracking-[0.08em] text-terminal-green-dim">
            camera pending
          </div>
        )}
      </div>
      <div className="min-w-0 text-xs leading-5 text-terminal-cyan sm:text-right">
        camera {track ? "publishing" : "connecting"}
      </div>
    </div>
  );
}

function Toggle({
  label,
  enabled,
  disabled = false,
  onClick,
}: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${
        enabled ? "border-terminal-green text-terminal-green" : "border-terminal-green-dimmer text-terminal-green-dim"
      }`}
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

function shortId(id: string) {
  return id.slice(-8);
}

function getAgentControlsState(instances: DemoClientInstance[]) {
  return findState(instances, "agentControls")?.value as
    | {
        liveMode?: boolean;
        cameraEnabled?: boolean;
        memoryEnabled?: boolean;
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
  const command = instance.commands.find(
    (item: DemoClientInstance["commands"][number]) => item.name === name,
  );
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
  const state = instance.states.find(
    (item: DemoClientInstance["states"][number]) => item.key === key,
  );
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
