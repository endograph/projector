"use client";

import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import type { ForwardedRef } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { DemoAttachment, DemoClientInstance, DemoMessage } from "@/src/types/display";
import type { OptimisticContext } from "@projectors/core/client";
import type { LocalVideoTrack } from "livekit-client";
import { scanlinesEnabledAtom, type MessageTransport } from "@/src/atoms";
import { useAtom } from "jotai";
import { useProjector } from "@/src/projector/ProjectorProvider";

type TerminalPaneProps = {
  messages: DemoMessage[];
  input: string;
  attachments: TerminalAttachment[];
  attachmentsUploading: boolean;
  onInputChange: (value: string) => void;
  onAttachmentFiles: (files: File[]) => void;
  onRemoveAttachment: (storageId: string) => void;
  onSend: () => void;
  onForkSession: () => void;
  onReturnToLatest: () => void;
  isLoading: boolean;
  isTimeTraveling: boolean;
  timeTravelFrameId: Id<"frames"> | null;
  connectionError?: string | null;
  voiceStatus?: { status: string; detail?: string };
  messageTransport: MessageTransport;
  liveKitEnabled?: boolean;
  liveKitReady?: boolean;
  liveKitStatus?: { status: string; detail?: string };
  localCameraTrack?: LocalVideoTrack | null;
};

export const TerminalPane = forwardRef<HTMLTextAreaElement, TerminalPaneProps>(
  function TerminalPane(
    {
      messages,
      input,
      attachments,
      attachmentsUploading,
      onInputChange,
      onAttachmentFiles,
      onRemoveAttachment,
      onSend,
      onForkSession,
      onReturnToLatest,
      isLoading,
      isTimeTraveling,
      timeTravelFrameId,
      connectionError,
      voiceStatus,
      messageTransport,
      liveKitEnabled = false,
      liveKitReady = false,
      liveKitStatus,
      localCameraTrack,
    },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const shouldAutoScrollRef = useRef(true);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [liveKitDiagnosticsOpen, setLiveKitDiagnosticsOpen] = useState(false);
    const [dragDepth, setDragDepth] = useState(0);
    const [scanlinesEnabled, setScanlinesEnabled] = useAtom(scanlinesEnabledAtom);
    const { effigy, instances, readOnly } = useProjector();
    const state = getAgentControlsState(instances);
    const voiceEnabled = Boolean(state?.liveMode);
    const cameraEnabled = Boolean(state?.cameraEnabled);
    const memoryEnabled = Boolean(state?.memoryEnabled);
    const streamingEnabled = state?.streamingEnabled !== false;
    const liveKitTransportActive = messageTransport === "livekit";
    const liveKitUnavailable = liveKitTransportActive && liveKitEnabled && !liveKitReady;
    const hasAttachments = attachments.length > 0;
    const isDraggingFiles = dragDepth > 0;
    const sendDisabled = isLoading || attachmentsUploading || (!input.trim() && !hasAttachments) || liveKitUnavailable;
    const handleSubmit = () => {
      if (liveKitUnavailable) {
        setLiveKitDiagnosticsOpen(true);
        return;
      }
      onSend();
    };
    const handleDragEnter = (event: DragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event) || isTimeTraveling) return;
      event.preventDefault();
      setDragDepth((depth) => depth + 1);
    };
    const handleDragOver = (event: DragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event) || isTimeTraveling) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const handleDragLeave = (event: DragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event) || isTimeTraveling) return;
      event.preventDefault();
      setDragDepth((depth) => Math.max(0, depth - 1));
    };
    const handleDrop = (event: DragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event) || isTimeTraveling) return;
      event.preventDefault();
      setDragDepth(0);
      const files = Array.from(event.dataTransfer.files).filter((file) => file.size > 0);
      if (files.length > 0) onAttachmentFiles(files);
    };
    const setTextareaRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        setForwardedRef(ref, node);
      },
      [ref],
    );

    useLayoutEffect(() => {
      const node = scrollRef.current;
      if (node && shouldAutoScrollRef.current) {
        node.scrollTop = node.scrollHeight;
      }
    }, [messages.length, isLoading, input]);

    useLayoutEffect(() => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) return;

      const scrollToBottomIfPinned = () => {
        if (shouldAutoScrollRef.current) {
          scrollNode.scrollTop = scrollNode.scrollHeight;
        }
      };
      const contentNode = scrollNode.firstElementChild;
      const observer = new ResizeObserver(scrollToBottomIfPinned);
      observer.observe(scrollNode);
      if (contentNode) observer.observe(contentNode);
      scrollToBottomIfPinned();
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.style.height = "32px";
      node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
    }, [input]);

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
      <section
        className={`pane-focus relative flex min-h-0 flex-col border-r border-terminal-green-dimmer ${
          isDraggingFiles ? "bg-terminal-cyan/10" : "bg-terminal-bg"
        }`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
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
          onScroll={(event) => {
            shouldAutoScrollRef.current = isWithinBottom(event.currentTarget, 10);
          }}
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
            className={`border-t px-2 py-1.5 ${
              isDraggingFiles ? "border-terminal-cyan bg-terminal-cyan/10" : "border-terminal-green-dimmer"
            }`}
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            {(attachments.length > 0 || attachmentsUploading) && (
              <div className="mb-1.5 flex flex-wrap gap-2 pl-6">
                {attachments.map((attachment) => (
                  <PendingAttachmentPreview
                    key={attachment.storageId}
                    attachment={attachment}
                    onRemove={() => onRemoveAttachment(attachment.storageId)}
                  />
                ))}
                {attachmentsUploading && (
                  <div className="flex h-8 items-center rounded border border-terminal-green-dimmer px-2 text-xs text-terminal-cyan">
                    uploading...
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="flex h-8 shrink-0 items-center text-terminal-green-dim">&gt;</span>
              <textarea
                ref={setTextareaRefs}
                value={input}
                onChange={(event) => onInputChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSubmit();
                  }
                }}
                rows={1}
                className="max-h-40 min-h-8 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-6 text-terminal-green outline-none placeholder:text-terminal-green-dimmer"
                placeholder="Message the projector demo..."
              />
              {liveKitTransportActive ? (
                <button
                  type="button"
                  onClick={() => setLiveKitDiagnosticsOpen(true)}
                  className={`flex h-8 w-4 shrink-0 items-center justify-center text-[10px] leading-none ${liveKitStatusColor(liveKitReady, liveKitStatus?.status)}`}
                  aria-label="Show LiveKit RPC diagnostics"
                >
                  ●
                </button>
              ) : (
                <span
                  className="flex h-8 w-4 shrink-0 items-center justify-center text-sm leading-none text-terminal-green"
                  aria-label="Convex transport ready"
                  role="img"
                >
                  ∴
                </span>
              )}
              <button
                type="submit"
                disabled={sendDisabled}
                aria-label={liveKitUnavailable ? "Show LiveKit RPC diagnostics" : "Send message"}
                className="h-8 shrink-0 rounded border border-terminal-green px-3 text-sm text-terminal-green hover:bg-terminal-green hover:text-terminal-bg disabled:cursor-not-allowed disabled:border-terminal-green-dimmer disabled:text-terminal-green-dimmer"
              >
                send
              </button>
            </div>
          </form>
        )}
        {liveKitDiagnosticsOpen && (
          <LiveKitDiagnosticsModal
            ready={liveKitReady}
            status={liveKitStatus}
            onClose={() => setLiveKitDiagnosticsOpen(false)}
          />
        )}
      </section>
    );
  },
);

function LiveKitDiagnosticsModal({
  ready,
  status,
  onClose,
}: {
  ready: boolean;
  status?: { status: string; detail?: string };
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-terminal-bg/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="LiveKit RPC diagnostics"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,calc(100vw-2rem))] border border-terminal-green-dimmer bg-terminal-bg p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-terminal-green-dimmer pb-3">
          <div>
            <h2 className="text-sm font-bold tracking-[0.08em] text-terminal-green">
              LIVEKIT RPC
            </h2>
            <div className="mt-1 text-xs text-terminal-green-dim">
              session request transport
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-terminal-green-dimmer px-2 py-1 text-xs text-terminal-green-dim hover:border-terminal-green hover:text-terminal-green"
          >
            close
          </button>
        </div>
        <dl className="mt-4 space-y-3 text-xs leading-5">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-terminal-green-dim">ready for requests</dt>
            <dd className={ready ? "text-terminal-cyan" : "text-terminal-yellow"}>
              {ready ? "yes" : "no"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-terminal-green-dim">status</dt>
            <dd className={liveKitStatusColor(ready, status?.status)}>
              {status?.status ?? "connecting"}
            </dd>
          </div>
          <div>
            <dt className="text-terminal-green-dim">detail</dt>
            <dd className="mt-1 break-words text-terminal-green">
              {status?.detail ?? "Waiting for the LiveKit room and agent worker to become available."}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function liveKitStatusColor(ready: boolean, status?: string): string {
  if (ready) return "text-terminal-green";
  return status === "disconnected" || status === "error" ? "text-terminal-red" : "text-terminal-yellow";
}

function setForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}

function isWithinBottom(element: HTMLElement, threshold: number) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

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
  const attachments = message.attachments ?? [];
  return (
    <article className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 text-sm">
      <div className={isUser ? "text-terminal-cyan" : "text-terminal-yellow"}>{isUser ? "user" : "agent"}</div>
      <div className="min-w-0 space-y-2">
        {message.content && (
          <div className="whitespace-pre-wrap leading-6 text-terminal-green">{message.content}</div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <SentAttachmentPreview key={attachment.storageId} attachment={attachment} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

type TerminalAttachment = DemoAttachment & {
  previewUrl?: string;
};

function PendingAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: TerminalAttachment;
  onRemove: () => void;
}) {
  if (attachment.kind === "image") {
    return (
      <div className="flex h-12 max-w-56 items-center gap-2 rounded border border-terminal-green-dimmer px-1.5 py-1">
        <img
          src={attachment.previewUrl ?? attachment.url ?? ""}
          alt=""
          className="h-9 w-9 shrink-0 rounded object-cover"
        />
        <span className="min-w-0 truncate text-xs text-terminal-green">{attachment.name}</span>
        <RemoveAttachmentButton onClick={onRemove} />
      </div>
    );
  }

  return (
    <div className="flex h-8 max-w-56 items-center gap-2 rounded border border-terminal-green-dimmer px-2">
      <span className="min-w-0 truncate text-xs text-terminal-green">{attachment.name}</span>
      <RemoveAttachmentButton onClick={onRemove} />
    </div>
  );
}

function SentAttachmentPreview({ attachment }: { attachment: DemoAttachment }) {
  const label = attachment.name || "attachment";
  if (attachment.kind === "image" && attachment.url) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noreferrer"
        className="block h-20 w-20 overflow-hidden rounded border border-terminal-green-dimmer hover:border-terminal-green"
        title={label}
      >
        <img src={attachment.url} alt={label} className="h-full w-full object-cover" />
      </a>
    );
  }

  const className = "max-w-64 truncate rounded border border-terminal-green-dimmer px-2 py-1 text-xs text-terminal-green-dim";
  if (attachment.url) {
    return (
      <a href={attachment.url} target="_blank" rel="noreferrer" className={`${className} hover:border-terminal-green hover:text-terminal-green`}>
        {label}
      </a>
    );
  }
  return <span className={className}>{label}</span>;
}

function RemoveAttachmentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-terminal-green-dimmer text-xs text-terminal-green-dim hover:border-terminal-red hover:text-terminal-red"
      aria-label="Remove attachment"
    >
      x
    </button>
  );
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
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
