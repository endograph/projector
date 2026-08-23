import { CodeXml } from "lucide-react";
import { useState } from "react";

export function AppNav({
  sessionId,
  sessionMode = false,
  isAdmin = false,
  onOpenDev,
}: {
  sessionId?: string;
  sessionMode?: boolean;
  isAdmin?: boolean;
  onOpenDev?: () => void;
}) {
  const exit = (event: React.MouseEvent) => {
    event.preventDefault();
    if (history.state?.app) history.back();
    else location.assign("/");
  };

  return (
    <header className={`app-nav${sessionMode ? " app-nav-active-session" : ""}`}>
      <div className="app-nav-left">
        <a className="nav-brand" href="/" onClick={exit}>projector</a>
        {(sessionId || isAdmin) && (
          <div className="app-nav-context">
            {sessionId && <span className="app-nav-session">s/{sessionId.slice(0, 5)}</span>}
            {isAdmin && onOpenDev && (
              <button
                className="dev-panel-trigger"
                type="button"
                onClick={onOpenDev}
                aria-label="Open developer panel"
                title="Developer panel"
              >
                <CodeXml aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="app-nav-actions-slot" data-app-nav-actions />
      <nav className="nav-links app-nav-links">
        <a href="/#why">Why</a>
        <a href="/#docs">Docs</a>
        {isAdmin && (
          <a
            className="admin-sessions-link"
            href="/sessions"
            aria-label="All sessions"
            title="All sessions"
            aria-current={location.pathname === "/sessions" ? "page" : undefined}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="5.25" r="1.25" />
              <circle cx="8" cy="8.75" r="1.25" />
              <circle cx="8" cy="12.25" r="1.25" />
            </svg>
          </a>
        )}
        <ThemeToggle />
      </nav>
    </header>
  );
}

function ThemeToggle() {
  const effective = () => document.documentElement.dataset.theme ?? "dark";
  const [mode, setMode] = useState(effective);
  const toggle = () => {
    const next = effective() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    const pageButton = document.querySelector(".page .theme");
    pageButton?.setAttribute("data-mode", next);
    pageButton?.setAttribute("aria-label", `Theme: ${next}`);
    setMode(next);
  };
  return (
    <button className="theme" type="button" data-mode={mode} aria-label={`Theme: ${mode}`} onClick={toggle}>
      <svg className="i-light" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 .9v1.8M8 13.3v1.8M15.1 8h-1.8M2.7 8H.9M13 3l-1.3 1.3M4.3 11.7 3 13M13 13l-1.3-1.3M4.3 4.3 3 3"/></svg>
      <svg className="i-dark" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A6 6 0 1 1 6.4 2.5a4.8 4.8 0 0 0 7.1 7.1Z"/></svg>
      <svg className="i-drop" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6c2.7 3 4.4 5.2 4.4 7.1a4.4 4.4 0 0 1-8.8 0c0-1.9 1.7-4.1 4.4-7.1Z"/></svg>
    </button>
  );
}
