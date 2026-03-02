/**
 * Provider-agnostic tracing interface for machine framework observability.
 *
 * Concrete implementations (e.g., Braintrust, Datadog) live outside this library.
 */

export interface SpanOptions {
  input?: unknown;
  attributes?: Record<string, unknown>;
}

export interface Span {
  log(data: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> }): void;
  end(): void;
  /** Returns a Tracer scoped to this span for creating child spans. */
  child(): Tracer;
}

export interface Tracer {
  /** Wrap an async function in a span with automatic lifecycle management. */
  withSpan<T>(name: string, fn: (span: Span) => T | Promise<T>, options?: SpanOptions): Promise<T>;
  /** Start a span manually — caller must call span.end(). Use for generators. */
  startSpan(name: string, options?: SpanOptions): Span;
}
