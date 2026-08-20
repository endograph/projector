// The surface design system: a small component vocabulary in the landing's
// language, tuned quiet — hairline rules and restrained type by default, the
// landing's chunky ink-and-shadow reserved for the `raised` Card. Styled by a
// constructable stylesheet adopted into each surface's shadow root. Document
// CSS never reaches shadow DOM; the theme tokens (--ink, --bg, …) do, by
// custom-property inheritance — which is what makes light/dark just work.

import type { ReactNode } from "react";

export function Card({ title, raised, children }: {
  title?: string;
  raised?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="ds-card" data-raised={raised ? "" : undefined}>
      {title && <p className="ds-eyebrow">{title}</p>}
      {children}
    </div>
  );
}

export function Stack({ gap = "m", children }: {
  gap?: "s" | "m" | "l";
  children?: ReactNode;
}) {
  return (
    <div className="ds-stack" data-gap={gap}>
      {children}
    </div>
  );
}

export function Inline({ justify = "start", children }: {
  justify?: "start" | "between" | "end";
  children?: ReactNode;
}) {
  return (
    <div className="ds-inline" data-justify={justify}>
      {children}
    </div>
  );
}

export function Divider() {
  return <hr className="ds-divider" />;
}

export function Empty({ children }: { children?: ReactNode }) {
  return <p className="ds-empty">{children}</p>;
}

export function Label({ children }: { children?: ReactNode }) {
  return <p className="ds-eyebrow">{children}</p>;
}

export function Button({
  children,
  onClick,
  kind = "primary",
  disabled,
}: {
  children?: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="ds-button"
      data-kind={kind}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  onSubmit,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
}) {
  return (
    <input
      className="ds-input"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit?.();
      }}
    />
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <label className="ds-checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Row({
  children,
  onClick,
  active,
}: {
  children?: ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <div
      className="ds-row"
      data-active={active ? "" : undefined}
      data-clickable={onClick ? "" : undefined}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ds-stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

const DS_CSS = `
:host {
  display: block;
  font-family: var(--sans);
  color: var(--ink);
  font-size: 0.8125rem;
  line-height: 1.5;
}
* { box-sizing: border-box; }
p { margin: 0; }
.ds-card {
  border: 1px solid var(--rule);
  border-radius: 0.5rem;
  background: var(--bg);
  padding: 0.75rem;
}
.ds-card + .ds-card { margin-top: 0.5rem; }
/* The landing's chunky paper card — one per surface, for the hero moment. */
.ds-card[data-raised] {
  border: 1.5px solid var(--ink);
  border-radius: 0.625rem;
  box-shadow: 0.1875rem 0.1875rem 0 var(--shadow);
}
.ds-stack { display: flex; flex-direction: column; }
.ds-stack[data-gap="s"] { gap: 0.25rem; }
.ds-stack[data-gap="m"] { gap: 0.5rem; }
.ds-stack[data-gap="l"] { gap: 1rem; }
.ds-inline { display: flex; align-items: center; gap: 0.5rem; }
.ds-inline[data-justify="between"] { justify-content: space-between; }
.ds-inline[data-justify="end"] { justify-content: flex-end; }
.ds-divider { border: 0; border-top: 1px solid var(--rule); margin: 0.5rem 0; }
.ds-empty {
  font-family: var(--mono);
  font-size: 0.6875rem;
  color: var(--faint);
  text-align: center;
  padding: 1.25rem 0.5rem;
  margin: 0;
}
.ds-eyebrow {
  font-family: var(--mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 0.5rem;
}
.ds-button {
  font: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  border: 1px solid var(--ink);
  border-radius: 0.375rem;
  background: var(--ink);
  color: var(--bg);
  padding: 0.25rem 0.625rem;
  cursor: pointer;
  transition: opacity 0.1s, background 0.1s;
}
.ds-button:hover:not(:disabled) { opacity: 0.85; }
.ds-button[data-kind="ghost"] {
  background: transparent;
  border-color: var(--rule);
  color: var(--ink);
}
.ds-button[data-kind="ghost"]:hover:not(:disabled) { opacity: 1; border-color: var(--ink); }
.ds-button:disabled { opacity: 0.4; cursor: default; }
.ds-input {
  font: inherit;
  width: 100%;
  border: 1px solid var(--rule);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--ink);
  padding: 0.3125rem 0.5625rem;
  outline: none;
}
.ds-input::placeholder { color: var(--faint); }
.ds-input:focus-visible { border-color: var(--ink); }
.ds-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.ds-checkbox input { accent-color: var(--accent); width: 0.875rem; height: 0.875rem; margin: 0; }
.ds-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.125rem;
  border-bottom: 1px solid var(--rule);
}
.ds-row:last-child { border-bottom: 0; }
.ds-row[data-active] { color: var(--accent); }
.ds-row[data-clickable] { cursor: pointer; }
.ds-row[data-clickable]:hover { background: color-mix(in srgb, var(--wash) 55%, transparent); }
.ds-stat { display: inline-flex; flex-direction: column; gap: 0.125rem; }
.ds-stat b { font-size: 1.125rem; font-weight: 600; letter-spacing: -0.02em; }
.ds-stat span {
  font-family: var(--mono);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--muted);
}
`;

let sheet: CSSStyleSheet | null = null;

export function dsStyleSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(DS_CSS);
  }
  return sheet;
}
