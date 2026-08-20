// Mounts an agent-authored surface: compile (cached) → blob import → render
// through a portal into a shadow root. Shadow DOM scopes the surface's styles
// both ways; the portal keeps one React tree, so an error boundary above the
// surface catches its render errors. Errors — compile, import, or runtime —
// go to onError once per version, which reports them into machine state
// (appSurface.lastError) for the agent to read on its next turn.

import {
  Component,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { SurfaceApi } from "./api";
import { dsStyleSheet } from "./ds";
import { compileSurface } from "./runtime";

type SurfaceComponent = ComponentType<{ api: SurfaceApi }>;

export function SurfaceHost({ source, version, api, onError }: {
  source: string;
  version: number;
  api: SurfaceApi;
  onError: (error: string) => void;
}) {
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [component, setComponent] = useState<{ render: SurfaceComponent } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Report at most once per surface version, through a ref so effects don't
  // re-run when the callback identity changes.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const reportedVersionRef = useRef<number | null>(null);
  const report = (error: string) => {
    setFailure(error);
    if (reportedVersionRef.current !== version) {
      reportedVersionRef.current = version;
      onErrorRef.current(error);
    }
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  const attachHost = (el: HTMLDivElement | null) => {
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [dsStyleSheet()];
    setShadow((previous) => (previous === root ? previous : root));
  };

  useEffect(() => {
    let cancelled = false;
    setComponent(null);
    setFailure(null);
    const compiled = compileSurface(source);
    if (!compiled.ok) {
      reportRef.current(compiled.error);
      return;
    }
    import(/* @vite-ignore */ compiled.url)
      .then((mod) => {
        if (cancelled) return;
        const render = (mod as { default?: unknown }).default;
        if (typeof render !== "function") {
          reportRef.current("surface module must default-export a React component");
          return;
        }
        setComponent({ render: render as SurfaceComponent });
      })
      .catch((error) => {
        if (!cancelled) reportRef.current(`import error: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [source, version]);

  return (
    <div className="surface-host" ref={attachHost}>
      {failure && <p className="surface-failure">{failure}</p>}
      {shadow && component && !failure &&
        createPortal(
          <SurfaceBoundary key={version} onError={(error) => reportRef.current(error)}>
            <component.render api={api} />
          </SurfaceBoundary>,
          shadow,
        )}
    </div>
  );
}

class SurfaceBoundary extends Component<
  { onError: (error: string) => void; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(String(error));
  }

  render() {
    if (this.state.error) return null; // the host's failure strip takes over
    return this.props.children;
  }
}
