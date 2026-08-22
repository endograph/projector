import { useConvexAuth } from "@convex-dev/auth/react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../convex/_generated/api";

const PAGE_SIZE = 25;

function relativeTime(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function PastConversations({ onOpen }: {
  onOpen: (sessionId: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [armedSessionId, setArmedSessionId] = useState<string | null>(null);
  const [removingSessionId, setRemovingSessionId] = useState<string | null>(null);
  const [removeErrorId, setRemoveErrorId] = useState<string | null>(null);
  const { isLoading, isAuthenticated } = useConvexAuth();
  const removeMine = useMutation(api.sessionParticipants.removeMine);
  const { results, status, loadMore } = usePaginatedQuery(
    api.sessionParticipants.listMine,
    isAuthenticated ? {} : "skip",
    { initialNumItems: PAGE_SIZE },
  );

  // "Past conversations" means the complete cross-device history. Fetch it
  // in bounded Convex pages, advancing one page per frame until exhausted.
  useEffect(() => {
    if (status !== "CanLoadMore") return;
    const frame = requestAnimationFrame(() => loadMore(PAGE_SIZE));
    return () => cancelAnimationFrame(frame);
  }, [loadMore, status]);

  useEffect(() => {
    if ((!isLoading && !isAuthenticated) || results.length === 0) {
      dialogRef.current?.close();
    }
  }, [isAuthenticated, isLoading, results.length]);

  if (isLoading || !isAuthenticated || results.length === 0) return null;

  return (
    <>
      <button
        className="talk-past"
        type="button"
        onClick={() => dialogRef.current?.showModal()}
      >
        past conversations
      </button>
      {createPortal(
        <dialog
          ref={dialogRef}
          className="past-dialog"
          aria-label="Past conversations"
          onClick={(event) => {
            if (event.target === event.currentTarget) event.currentTarget.close();
          }}
          onClose={() => {
            setArmedSessionId(null);
            setRemoveErrorId(null);
          }}
        >
          <p className="past-head">past conversations</p>
          <div className="past-list">
            {results.map((session) => (
              <div className="past-row" key={session.id}>
                <button
                  className="past-open"
                  type="button"
                  onClick={() => {
                    dialogRef.current?.close();
                    onOpen(String(session.id));
                  }}
                >
                  <span className="past-title">{session.title}</span>
                  <span className="past-when">{relativeTime(session.lastParticipatedAt)}</span>
                </button>
                <button
                  className="past-remove"
                  type="button"
                  data-confirm={armedSessionId === String(session.id) ? "" : undefined}
                  disabled={removingSessionId === String(session.id)}
                  title={
                    removeErrorId === String(session.id)
                      ? "Removal failed — try again"
                      : armedSessionId === String(session.id)
                        ? "Confirm removal"
                        : "Remove"
                  }
                  aria-label={
                    armedSessionId === String(session.id)
                      ? `Confirm removal of ${session.title} from past conversations`
                      : `Remove ${session.title} from past conversations`
                  }
                  onClick={async () => {
                    const id = String(session.id);
                    setRemoveErrorId(null);
                    if (armedSessionId !== id) {
                      setArmedSessionId(id);
                      return;
                    }
                    setRemovingSessionId(id);
                    try {
                      await removeMine({ sessionId: session.id });
                      setArmedSessionId(null);
                    } catch {
                      setRemoveErrorId(id);
                    } finally {
                      setRemovingSessionId(null);
                    }
                  }}
                >
                  {removingSessionId === String(session.id)
                    ? "…"
                    : armedSessionId === String(session.id)
                      ? removeErrorId === String(session.id) ? "retry" : "confirm"
                      : "×"}
                </button>
              </div>
            ))}
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
