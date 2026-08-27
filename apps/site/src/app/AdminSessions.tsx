import { useAuthActions } from "@convex-dev/auth/react";
import { usePaginatedQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { AppNav } from "./AppNav";
import { useAdminAccess } from "./useAdminAccess";

const PAGE_SIZE = 25;

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function AdminSessions() {
  const { authLoading, isAuthenticated, isAdmin, liveAdmin } = useAdminAccess();
  const { signIn } = useAuthActions();
  const [signingIn, setSigningIn] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { results, status, loadMore } = usePaginatedQuery(
    api.dev.sessions.listAll,
    liveAdmin?.isAdmin ? {} : "skip",
    { initialNumItems: PAGE_SIZE },
  );

  const loadingAccess = authLoading || (isAuthenticated && liveAdmin === undefined);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sessions = "";
    return () => { delete root.dataset.sessions; };
  }, []);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || status !== "CanLoadMore") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) loadMore(PAGE_SIZE);
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, status]);

  return (
    <div className="app app-sessions">
      <AppNav isAdmin={isAdmin} />
      <main className="sessions-page">
        <header className="sessions-head">
          <span>admin</span>
          <h1>sessions</h1>
          <p>Every conversation, ordered by latest activity.</p>
        </header>

        {loadingAccess ? (
          <p className="sessions-state">checking access…</p>
        ) : !isAuthenticated ? (
          <div className="sessions-state">
            <p>GitHub sign-in is required.</p>
            <button
              type="button"
              disabled={signingIn}
              onClick={async () => {
                setSigningIn(true);
                try {
                  await signIn("github", { redirectTo: location.href });
                } finally {
                  setSigningIn(false);
                }
              }}
            >
              {signingIn ? "opening github…" : "sign in with github"}
            </button>
          </div>
        ) : !isAdmin ? (
          <p className="sessions-state">admin access required.</p>
        ) : status === "LoadingFirstPage" ? (
          <p className="sessions-state">loading sessions…</p>
        ) : (
          <section className="sessions-list" aria-label="All sessions">
            {results.length === 0 ? (
              <p className="sessions-state">no sessions yet.</p>
            ) : (
              results.map((session) => (
                <article className="sessions-row" key={session.id}>
                  <a className="sessions-row-main" href={`/s/${session.id}`}>
                    <strong>{session.title}</strong>
                    <code>{session.id}</code>
                  </a>
                  <span className="sessions-counts">
                    <span><strong>{session.messageCount}</strong> messages</span>
                    <span><strong>{session.artifactCount}</strong> artifacts</span>
                  </span>
                  {session.ownerGithubLogin ? (
                    <a
                      className="sessions-owner"
                      href={`https://github.com/${encodeURIComponent(session.ownerGithubLogin)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      @{session.ownerGithubLogin}
                    </a>
                  ) : (
                    <span className="sessions-owner">anonymous</span>
                  )}
                  <time dateTime={new Date(session.lastActivityAt).toISOString()}>
                    {formatDate(session.lastActivityAt)}
                  </time>
                </article>
              ))
            )}
            <div ref={loadMoreRef} className="sessions-load-sentinel" aria-hidden="true" />
            {status === "LoadingMore" && <p className="sessions-loading-more">loading…</p>}
          </section>
        )}
      </main>
    </div>
  );
}
