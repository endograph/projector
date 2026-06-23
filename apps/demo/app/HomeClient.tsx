"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useAtom, useAtomValue } from "jotai";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { LocalVideoTrack } from "livekit-client";
import type { ClientMachineMessage } from "@projectors/core/client";
import {
  activeAgentTabAtom,
  inputAtom,
  isLoadingAtom,
  messageTransportAtom,
  scanlinesEnabledAtom,
  timeTravelFrameIdAtom,
  type MessageTransport,
} from "@/src/atoms";
import { useKeyboardFocus, useSessionId } from "@/src/hooks";
import { ProjectorProvider, useProjector } from "@/src/projector/ProjectorProvider";
import type { DemoClientInstance, DemoClientSnapshot, DemoMessage } from "@/src/types/display";
import { LiveVoiceClient } from "@/src/voice/LiveVoiceClient";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { AgentPane } from "./components/agent/AgentPane";

export function HomeClient({ initialSessionId }: { initialSessionId: Id<"sessions"> | null }) {
  const [sessionId, setSessionId] = useSessionId(initialSessionId);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const createSession = useAction(api.sessionActions.createSession);
  const sendMessage = useAction(api.sessionActions.sendMessage);
  const sendClientMessageToConvex = useAction(api.sessionActions.sendClientMessage);
  const ensureAgentDispatched = useAction(api.livekitAgentActions.ensureAgentDispatched);
  const cloneFromFrame = useMutation(api.sessions.cloneFromFrame);
  const [timeTravelFrameId, setTimeTravelFrameId] = useAtom(timeTravelFrameIdAtom);
  const [sendLiveKitCommand, setSendLiveKitCommand] = useState<((message: ClientMachineMessage) => Promise<unknown>) | null>(null);
  const handleLiveKitCommandSenderChange = useCallback(
    (sender: ((message: ClientMachineMessage) => Promise<unknown>) | null) => {
      setSendLiveKitCommand(sender ? () => sender : null);
    },
    [],
  );
  const sendClientMessage = useCallback(
    async (args: { sessionId: Id<"sessions">; message: ClientMachineMessage }) => {
      if (sendLiveKitCommand) {
        return await sendLiveKitCommand(args.message);
      }
      return await sendClientMessageToConvex(args);
    },
    [sendClientMessageToConvex, sendLiveKitCommand],
  );

  const session = useQuery(
    api.sessions.get,
    sessionId
      ? {
          id: sessionId,
          ...(timeTravelFrameId ? { timetravelFrameId: timeTravelFrameId } : {}),
        }
      : "skip",
  );
  const serverMessages = useQuery(
    api.messages.listForFramePath,
    sessionId
      ? {
          sessionId,
          ...(timeTravelFrameId ? { upToFrameId: timeTravelFrameId } : {}),
        }
      : "skip",
  );
  const liveKitWorkerStatus = useQuery(api.livekitAgent.getAgentWorkerStatus, sessionId ? { sessionId } : "skip");

  useEffect(() => {
    if (sessionId && session === undefined) return;
    if (sessionId && session === null) {
      if (timeTravelFrameId) {
        setTimeTravelFrameId(null);
        return;
      }
      setSessionId(null);
      return;
    }
    if (!sessionId) {
      void createSession()
        .then((id) => {
          setConnectionError(null);
          setSessionId(id);
        })
        .catch((error) => {
          setConnectionError(error instanceof Error ? error.message : "Unable to create session");
        });
    }
  }, [createSession, session, sessionId, setSessionId, setTimeTravelFrameId, timeTravelFrameId]);

  const previousSessionIdRef = useRef<Id<"sessions"> | null>(sessionId);
  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      setTimeTravelFrameId(null);
    }
  }, [sessionId, setTimeTravelFrameId]);

  const latestFrameId = timeTravelFrameId ? null : (session?.frameId ?? null);

  return (
    <ProjectorProvider
      sessionId={sessionId}
      sendClientMessage={sendClientMessage}
      snapshot={session?.clientSnapshot as DemoClientSnapshot | undefined}
      readOnly={Boolean(timeTravelFrameId)}
    >
      <HomeClientContent
        sessionId={sessionId}
        setSessionId={setSessionId}
        createSession={createSession}
        sendMessage={sendMessage}
        cloneFromFrame={cloneFromFrame}
        ensureAgentDispatched={ensureAgentDispatched}
        serverMessages={serverMessages}
        liveKitWorkerStatus={liveKitWorkerStatus}
        onLiveKitCommandSenderChange={handleLiveKitCommandSenderChange}
        connectionError={connectionError}
        onConnectionErrorChange={setConnectionError}
        latestFrameId={latestFrameId}
        timeTravelFrameId={timeTravelFrameId}
        onTimeTravelFrameChange={setTimeTravelFrameId}
      />
    </ProjectorProvider>
  );
}

function HomeClientContent({
  sessionId,
  setSessionId,
  createSession,
  sendMessage,
  cloneFromFrame,
  ensureAgentDispatched,
  serverMessages,
  liveKitWorkerStatus,
  onLiveKitCommandSenderChange,
  connectionError,
  onConnectionErrorChange,
  latestFrameId,
  timeTravelFrameId,
  onTimeTravelFrameChange,
}: {
  sessionId: Id<"sessions"> | null;
  setSessionId: (id: Id<"sessions"> | null) => void;
  createSession: () => Promise<Id<"sessions">>;
  sendMessage: (args: { sessionId: Id<"sessions">; content: string }) => Promise<unknown>;
  cloneFromFrame: (args: {
    sourceSessionId: Id<"sessions">;
    targetFrameId: Id<"frames">;
  }) => Promise<Id<"sessions">>;
  ensureAgentDispatched: (args: { sessionId: Id<"sessions">; reason: string }) => Promise<unknown>;
  serverMessages: DemoMessage[] | undefined;
  liveKitWorkerStatus:
    | {
        status: string;
        ready: boolean;
        agentWorkerHeartbeatAt?: number;
        agentWorkerLeaseExpiresAt?: number;
        agentNextDispatchAt?: number;
        agentDispatchLockExpiresAt?: number;
        agentReconnectAttempt?: number;
        agentLastDispatchError?: string;
      }
    | null
    | undefined;
  onLiveKitCommandSenderChange: (sender: ((message: ClientMachineMessage) => Promise<unknown>) | null) => void;
  connectionError: string | null;
  onConnectionErrorChange: (error: string | null) => void;
  latestFrameId: Id<"frames"> | null;
  timeTravelFrameId: Id<"frames"> | null;
  onTimeTravelFrameChange: (frameId: Id<"frames"> | null) => void;
}) {
  const [input, setInput] = useAtom(inputAtom);
  const [isLoading, setIsLoading] = useAtom(isLoadingAtom);
  const [messageTransport, setMessageTransport] = useAtom(messageTransportAtom);
  const [voiceStatus, setVoiceStatus] = useState<{ status: string; detail?: string }>({ status: "idle" });
  const [sendLiveKitMessage, setSendLiveKitMessage] = useState<((content: string) => Promise<void>) | null>(null);
  const [localCameraTrack, setLocalCameraTrack] = useState<LocalVideoTrack | null>(null);
  const [agentDocked, setAgentDocked] = useState(false);
  const [agentVisible, setAgentVisible] = useState(true);
  const [statusClock, setStatusClock] = useState(() => Date.now());
  const scanlinesEnabled = useAtomValue(scanlinesEnabledAtom);
  const activeTab = useAtomValue(activeAgentTabAtom);
  const { instances: clientInstances, snapshot } = useProjector();
  const isTimeTraveling = Boolean(timeTravelFrameId);

  const terminalRef = useRef<HTMLTextAreaElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const toggleAgentDock = useCallback(() => {
    setAgentDocked((docked) => !docked);
  }, []);
  const toggleAgentVisible = useCallback(() => {
    setAgentVisible((visible) => !visible);
  }, []);
  useKeyboardFocus(terminalRef, agentRef, toggleAgentVisible);
  const messages = ((serverMessages ?? []) as DemoMessage[]).slice().sort((a, b) => a.createdAt - b.createdAt);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || !sessionId || isLoading || isTimeTraveling) return;

    if (messageTransport === "livekit" && !sendLiveKitMessage) {
      onConnectionErrorChange("LiveKit agent is not ready");
      return;
    }

    const liveKitSender = sendLiveKitMessage;
    setInput("");
    setIsLoading(true);
    try {
      if (messageTransport === "livekit") {
        if (!liveKitSender) throw new Error("LiveKit agent is not ready");
        await liveKitSender(content);
      } else {
        await sendMessage({ sessionId, content });
      }
      onConnectionErrorChange(null);
    } catch (error) {
      onConnectionErrorChange(error instanceof Error ? error.message : "Unable to send message");
    } finally {
      setIsLoading(false);
    }
  }, [
    input,
    isLoading,
    messageTransport,
    onConnectionErrorChange,
    sendLiveKitMessage,
    sendMessage,
    sessionId,
    setInput,
    setIsLoading,
    isTimeTraveling,
  ]);

  const handleTimeTravelFrame = useCallback(
    (frameId: Id<"frames">) => {
      onTimeTravelFrameChange(frameId === latestFrameId ? null : frameId);
    },
    [latestFrameId, onTimeTravelFrameChange],
  );

  const handleReturnToLatest = useCallback(() => {
    onTimeTravelFrameChange(null);
  }, [onTimeTravelFrameChange]);

  const handleForkSession = useCallback(async () => {
    if (!sessionId || !timeTravelFrameId || isLoading) return;
    setIsLoading(true);
    try {
      const nextSessionId = await cloneFromFrame({
        sourceSessionId: sessionId,
        targetFrameId: timeTravelFrameId,
      });
      setInput("");
      onConnectionErrorChange(null);
      onTimeTravelFrameChange(null);
      setSessionId(nextSessionId);
    } catch (error) {
      onConnectionErrorChange(error instanceof Error ? error.message : "Unable to fork session");
    } finally {
      setIsLoading(false);
    }
  }, [
    cloneFromFrame,
    isLoading,
    onConnectionErrorChange,
    onTimeTravelFrameChange,
    sessionId,
    setInput,
    setIsLoading,
    setSessionId,
    timeTravelFrameId,
  ]);

  const handleReset = useCallback(async () => {
    try {
      const id = await createSession();
      onConnectionErrorChange(null);
      setSessionId(id);
    } catch (error) {
      onConnectionErrorChange(error instanceof Error ? error.message : "Unable to reset session");
    }
  }, [createSession, onConnectionErrorChange, setSessionId]);

  const handleVoiceStatus = useCallback((status: string, detail?: string) => {
    setVoiceStatus({ status, detail });
  }, []);

  const handleLiveKitSenderChange = useCallback((sender: ((content: string) => Promise<void>) | null) => {
    setSendLiveKitMessage(sender ? () => sender : null);
    if (sender) {
      onConnectionErrorChange(null);
    }
  }, [onConnectionErrorChange]);

  const handleLiveKitCommandSenderChange = useCallback((sender: ((message: ClientMachineMessage) => Promise<unknown>) | null) => {
    onLiveKitCommandSenderChange(sender);
    if (sender) {
      onConnectionErrorChange(null);
    }
  }, [onConnectionErrorChange, onLiveKitCommandSenderChange]);

  const themeHue = getThemeHue(clientInstances);
  const persistedAgentControls = getAgentControlsState(snapshot.root ? [snapshot.root] : []);
  const persistedVoiceEnabled = Boolean(persistedAgentControls?.liveMode);
  const persistedCameraEnabled = Boolean(persistedAgentControls?.cameraEnabled);
  const liveKitEnabled = persistedVoiceEnabled || persistedCameraEnabled || messageTransport === "livekit";
  const liveKitWorkerReady = Boolean(
    liveKitWorkerStatus?.agentWorkerLeaseExpiresAt && liveKitWorkerStatus.agentWorkerLeaseExpiresAt > statusClock,
  );
  const combinedLiveKitStatus = formatLiveKitStatus(voiceStatus, liveKitWorkerStatus, liveKitEnabled, statusClock);

  useEffect(() => {
    if (!liveKitEnabled) return;
    setStatusClock(Date.now());
    const interval = window.setInterval(() => setStatusClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [liveKitEnabled]);

  useEffect(() => {
    if (!liveKitEnabled || !sessionId || !liveKitWorkerStatus || liveKitWorkerReady) return;

    const now = statusClock;
    const nextDispatchAt = liveKitWorkerStatus.agentNextDispatchAt ?? 0;
    const lockExpiresAt = liveKitWorkerStatus.agentDispatchLockExpiresAt ?? 0;
    const leaseExpiresAt = liveKitWorkerStatus.agentWorkerLeaseExpiresAt ?? 0;
    const retryAt = Math.max(nextDispatchAt, lockExpiresAt, now);
    if (leaseExpiresAt > now) return;

    const timeout = window.setTimeout(() => {
      void ensureAgentDispatched({ sessionId, reason: "client_reconcile" }).catch((error) => {
        onConnectionErrorChange(error instanceof Error ? error.message : "Unable to reconnect LiveKit agent");
      });
    }, Math.max(0, retryAt - now));

    return () => window.clearTimeout(timeout);
  }, [ensureAgentDispatched, liveKitEnabled, liveKitWorkerReady, liveKitWorkerStatus, onConnectionErrorChange, sessionId, statusClock]);

  useEffect(() => {
    if (agentDocked && agentVisible) {
      agentRef.current?.focus();
    }
  }, [agentDocked, agentVisible]);

  const agentPane = (
    <AgentPane
      ref={agentRef}
      sessionId={sessionId}
      activeTab={activeTab}
      docked={agentDocked}
      onToggleDock={toggleAgentDock}
      onResetSession={handleReset}
      latestFrameId={latestFrameId}
      timeTravelFrameId={timeTravelFrameId}
      onTimeTravelFrame={handleTimeTravelFrame}
      onReturnToLatest={handleReturnToLatest}
      onSwitchSession={setSessionId}
      messageTransport={messageTransport}
      onMessageTransportChange={setMessageTransport}
      liveKitStatus={combinedLiveKitStatus}
      liveKitReady={Boolean(sendLiveKitMessage) && liveKitWorkerReady}
    />
  );

  return (
    <main
      className={`min-h-screen bg-terminal-bg text-terminal-green ${scanlinesEnabled ? "terminal-scanlines" : ""}`}
      style={{ "--glow-color": `oklch(0.82 0.18 ${themeHue})` } as React.CSSProperties}
    >
      <div className={`grid h-screen grid-cols-1 ${agentDocked || !agentVisible ? "" : "lg:grid-cols-2"}`}>
        <TerminalPane
          ref={terminalRef}
          messages={messages}
          input={input}
          onInputChange={setInput}
          onSend={handleSend}
          onForkSession={handleForkSession}
          onReturnToLatest={handleReturnToLatest}
          isLoading={isLoading}
          isTimeTraveling={isTimeTraveling}
          timeTravelFrameId={timeTravelFrameId}
          connectionError={connectionError}
          voiceStatus={voiceStatus}
          localCameraTrack={localCameraTrack}
        />
        {!agentDocked && agentVisible && agentPane}
        {agentDocked && agentVisible && (
          <div
            className="fixed inset-0 z-20 flex items-center justify-center bg-terminal-bg/80 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Agent"
          >
            <div className="h-[min(720px,calc(100vh-2rem))] w-[min(960px,calc(100vw-2rem))] border border-terminal-green-dimmer bg-terminal-bg">
              {agentPane}
            </div>
          </div>
        )}
        <LiveVoiceClient
          sessionId={sessionId}
          liveKitEnabled={liveKitEnabled}
          liveKitWorkerReady={liveKitWorkerReady}
          voiceEnabled={persistedVoiceEnabled}
          cameraEnabled={persistedCameraEnabled}
          onStatusChange={handleVoiceStatus}
          onSendMessageChange={handleLiveKitSenderChange}
          onSendCommandChange={handleLiveKitCommandSenderChange}
          onLocalCameraTrackChange={setLocalCameraTrack}
        />
      </div>
    </main>
  );
}

function getAgentControlsState(instances: DemoClientInstance[]) {
  return findState(instances, "agentControls")?.value as
    | {
        liveMode?: boolean;
        cameraEnabled?: boolean;
        streamingEnabled?: boolean;
        testCounter?: number;
      }
    | undefined;
}

function getThemeHue(instances: DemoClientInstance[]): number {
  const state = findState(instances, "demo")?.value as
    | { themeHue?: number }
    | undefined;
  return state?.themeHue ?? 126;
}

function formatLiveKitStatus(
  roomStatus: { status: string; detail?: string },
  workerStatus:
    | {
        status: string;
        ready: boolean;
        agentWorkerHeartbeatAt?: number;
        agentWorkerLeaseExpiresAt?: number;
        agentNextDispatchAt?: number;
        agentReconnectAttempt?: number;
        agentLastDispatchError?: string;
      }
    | null
    | undefined,
  enabled: boolean,
  now: number,
): { status: string; detail?: string } {
  if (!enabled) return { status: "idle" };
  if (!workerStatus) return { status: roomStatus.status === "connected" ? "connecting" : roomStatus.status, detail: roomStatus.detail };
  const ready = Boolean(workerStatus.agentWorkerLeaseExpiresAt && workerStatus.agentWorkerLeaseExpiresAt > now);
  if (ready) {
    const heartbeat = workerStatus.agentWorkerHeartbeatAt
      ? `heartbeat ${Math.max(0, Math.round((now - workerStatus.agentWorkerHeartbeatAt) / 1000))}s ago`
      : roomStatus.detail;
    return { status: "ready", detail: heartbeat };
  }

  const status = workerStatus.status === "ready" ? "stale" : workerStatus.status;
  const attempt = workerStatus.agentReconnectAttempt ?? 0;
  const reconnectDetail = workerStatus.agentLastDispatchError
    ? `attempt ${attempt}: ${workerStatus.agentLastDispatchError}`
    : workerStatus.agentNextDispatchAt && workerStatus.agentNextDispatchAt > now
      ? `attempt ${attempt}; retry in ${Math.ceil((workerStatus.agentNextDispatchAt - now) / 1000)}s`
      : roomStatus.detail;
  return { status, detail: reconnectDetail };
}

function findState(instances: DemoClientInstance[], key: string) {
  for (const instance of instances) {
    const state = findStateInInstance(instance, key);
    if (state) return state;
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
