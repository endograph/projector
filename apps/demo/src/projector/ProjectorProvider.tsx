"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createMachineEffigy,
  createOptimisticEffigy,
  type ClientMachineMessage,
  type OptimisticEffigy,
} from "@projectors/core/client";
import type { Id } from "@/convex/_generated/dataModel";
import type { DemoClientInstance, DemoClientSnapshot } from "@/src/types/display";

type SendClientMessageAction = (args: {
  sessionId: Id<"sessions">;
  message: ClientMachineMessage;
}) => Promise<unknown>;

const EMPTY_CLIENT_SNAPSHOT: DemoClientSnapshot = {
  instances: [],
  recentCommandResidue: [],
  projectionTree: { roots: [] },
};

type ProjectorContextValue = {
  effigy: OptimisticEffigy<DemoClientInstance[]>;
  instances: DemoClientInstance[];
  snapshot: DemoClientSnapshot;
};

const ProjectorContext = createContext<ProjectorContextValue | null>(null);

export function ProjectorProvider({
  children,
  sessionId,
  sendClientMessage,
  snapshot,
}: {
  children: ReactNode;
  sessionId: Id<"sessions"> | null;
  sendClientMessage: SendClientMessageAction;
  snapshot?: DemoClientSnapshot | null;
}) {
  const sessionIdRef = useRef<Id<"sessions"> | null>(null);
  const sendClientMessageRef = useRef<SendClientMessageAction | null>(null);
  const effigyRef = useRef<OptimisticEffigy<DemoClientInstance[]> | null>(null);

  if (!effigyRef.current) {
    effigyRef.current = createOptimisticEffigy(
      createMachineEffigy<DemoClientInstance[]>(async (message) => {
        const activeSessionId = sessionIdRef.current;
        const activeSendClientMessage = sendClientMessageRef.current;
        if (!activeSessionId || !activeSendClientMessage) {
          throw new Error("No active session");
        }
        return await activeSendClientMessage({ sessionId: activeSessionId, message });
      }),
    );
  }

  const effigy = effigyRef.current;
  const currentSnapshot = snapshot ?? EMPTY_CLIENT_SNAPSHOT;
  const residue = currentSnapshot.recentCommandResidue ?? [];
  const [, rerenderOptimisticState] = useState(0);

  useEffect(() => {
    sendClientMessageRef.current = sendClientMessage;
  }, [sendClientMessage]);

  useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      effigy.clearPending();
      sessionIdRef.current = sessionId;
    }
  }, [effigy, sessionId]);

  useEffect(() => {
    effigy.setRecentCommandResidue(residue);
    effigy.setInstances(currentSnapshot.instances);
  }, [effigy, residue, currentSnapshot.instances]);

  useEffect(
    () => effigy.subscribe(() => rerenderOptimisticState((version) => version + 1)),
    [effigy],
  );

  return (
    <ProjectorContext.Provider
      value={{
        effigy,
        instances: effigy.getInstances() ?? currentSnapshot.instances,
        snapshot: currentSnapshot,
      }}
    >
      {children}
    </ProjectorContext.Provider>
  );
}

export function useProjector() {
  const context = useContext(ProjectorContext);
  if (!context) {
    throw new Error("useProjector must be used within ProjectorProvider");
  }
  return context;
}
