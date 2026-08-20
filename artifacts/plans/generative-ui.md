# Generative UI Plan (apps/site)

The agent writes React — composing a small design system or authoring custom
components with CSS — rendered in the left app pane. Follows on from
`conceptual-demo.md`; updated for what apps/site actually is now (panes as
machine state, OptimisticEffigy client, explainer widgets in chat).

## Semantics

Two kinds of generated UI, matching projector's two storage kinds:

- **App pane surface = state.** One surface at a time — the pane is a screen,
  `writeAppSurface` writes to it. Mutable, current, durable; prior versions
  live in the frame log (replace is a state write; time travel can resurrect).
  Multiple surfaces arrive later via spawned children owning their own
  surface state (pane grows tabs) — not designed now.
- **Chat cards = frame content.** Immutable, append-only, scroll into history.
  A card is authored once and pinned to its turn. Ephemerality is not a
  compromise — it is the frame log's semantics showing through, and the agent
  can say so.

**Surfaces own zero data.** A surface binds to machine state through the api;
data lives in state descriptors. This is what lets one pane be "anything in
the agent," keeps UI replayable, and makes the todo loop multiplayer.

## Charter additions (ui node)

- `appSurface` state: `{ version, title, source, lastError? }`.
  - `writeAppSurface` action, caller **"any"** (agent tool; also lets the
    client "promote" a chat card to the pane as a plain command).
  - Projection `exposure: "deferred"`: the model retrieves its own source via
    getState when editing — no TSX in every prompt, cache stays stable.
    (Flagship use of exposure tiers; worth narrating in the demo.)
  - Source cap ~32KB, schema-enforced.
  - `requestOpenPane?: boolean` (default true): the same action patches
    `panesState` via `ctx.updateStateAt` — one tool call, both mutations in
    the log as one intent. Scaffold notes `false` for silent edits.
- **Spawned children with JSON-Schema state** (no untyped appData record):
  - `spawnChild` tool: `{ key, name, purpose, stateSchema (JSON Schema),
    init }` → `z.fromJSONSchema` → inline `createState` + `createNode`
    (instructions are text only — inline nodes/descriptors round-trip through
    serialization by design; convexJson handles the `$schema` keys) →
    `ctx.instance.spawn`. `cede` tears down; cede-before-respawn replaces
    (the demo camera pattern).
  - The LLM cannot mint actions (closure rule), so children get no custom
    tools. One charter-authored generic action `setState({ address, update })`
    (replace/patch/append variants) built on `ctx.updateStateAt`, validated
    against the target descriptor's schema at fold, addressed via the same
    alias map as `getState`. Caller **"any"**: the agent's write tool, the
    client command, and generated UI's mutation path are the same action —
    and the effigy's optimistic `patchAt` is already address-based, so the
    client needs nothing new.
  - State keys namespaced by child key (collision with the one-identity-per-
    key law is rejected in `spawnChild`'s run). Schemas constrained to the
    JSON-Schema-compatible object subset (same rule as params);
    unconvertible input → structured tool error.
  - Spawned children are component-runtime nodes under the root generator:
    their instructions + projected state appear in the guide's own compiled
    prompt — the inspector shows the prompt growing when the agent becomes a
    todo app.
  - Write scope: ships open for the demo (any-caller setState can write any
    projected state — it is the agent's own machine). Optional later guard:
    restrict generic writes to spawned-child state (wants resolved-target
    metadata exposed on the action context).

The todo loop: spawnChild(todos schema) → surface binds the child's state via
the api → checkbox runs `setState` as a client command → frame lands → agent
sees the same state next turn, schema-validated at every write.

## Framework change (required, MASTER_PLAN-sanctioned)

`ctx.updateStateAt(address, update)` on action contexts — the write twin of
the existing address-based `ctx.getState(address)`. MASTER_PLAN reserves
exactly this ("future plural helpers can accept structured StateAddress
values ... without changing stored mutation semantics"); durable mutation
messages already carry `stateKey`, so the frame format is untouched. Unlocks
both `writeAppSurface`'s pane patch and the generic `setState` action.

## Client runtime

- Agent authors **plain TSX**, default-exporting a component that receives
  `api`.
- **Transform: Sucrase** (jsx + TS strip), classic runtime
  (`React.createElement` — no jsx-runtime shim needed), cached per version,
  compile errors routed to the same lastError path without mounting.
- **Module wiring: rewrite-to-shim, NOT import maps.** The app is a Vite
  bundle; `react` is not a resolvable bare specifier at runtime (dev serves
  pre-bundled paths, build hashes chunks). Host exposes a registry (React,
  ds, api types); post-transform, bare imports (`react`, `projector/ds`) are
  rewritten to one-time blob shim modules re-exporting from the registry.
  Single React instance guaranteed; identical in dev and build.
- **Mount:** blob-URL `import()` into a shadow root in the app pane; React
  error boundary; separate `createRoot` per surface; remount keyed on
  `version`; StrictMode-safe (idempotent effects).
- **api = the effigy.** No new bridge: `api.run(name, input)` is
  `effigy.getCommand(name, { optimistic }).run(input)` — generated UI gets
  optimistic updates through the same machinery as the pane toggles.
  `api.useData()` / `api.useState(key)` hooks via `useSyncExternalStore` over
  the effigy. Commands validated against the client snapshot as before
  (typos → structured errors).
- **Styling:** document CSS does NOT reach shadow roots. The ds ships its own
  constructable stylesheet adopted into each surface's shadow root; theme
  tokens (`--ink`, `--bg`, `--accent`, …) inherit through the boundary, so
  light/dark just works. Agent custom CSS = `<style>` in its JSX,
  shadow-scoped. (No Tailwind anywhere in this app; that whole earlier
  thread is moot.)

## Design system (to build)

~8 components in the landing's vocabulary (ink borders, hard shadows, mono
eyebrow labels, tokens): Card, Button, Input, Checkbox, Row/List, Stat,
Label, Divider. Exported as the `projector/ds` shim module + one ds
stylesheet. Real prop signatures go in the scaffold prompt verbatim.

## Chat cards (phase 3)

Extend the existing `widget` message field (today: registry id of a prebuilt
explainer) with an authored-source payload. Agent-side `postCard` tool whose
action returns an assistant message carrying a data content part; agent.ts
persistence maps it onto the message row. Same runtime renders both mounts.
Cards binding live state show CURRENT state when scrolled back — a view, not
a screenshot; acceptable and honest. Each card gets "open in app pane" =
`writeAppSurface` as a client command.

## Error loop (v1: user-mediated)

The agent activates only on actor frames — a crash cannot summon it. Boundary
catch → external `reportSurfaceError` command writes `appSurface.lastError` →
pane shows the error + a "tell projector it broke" chip pre-filling a
message → agent reads lastError + its source (getState) and rewrites.
Auto-repair without a user turn is a trigger-design question for later, not a
v1 hack.

## Scaffold prompt essentials

ds component signatures (real TS), api contract, classic-JSX note, custom CSS
via `<style>` (shadow-scoped, tokens available), commands-first rule (if the
interaction has no command/state, add data first), size discipline, no
surface-to-surface side channels.

## Posture

Error containment, not security: agent code is trusted-but-fallible,
same-realm, shadow-DOM-contained (unchanged from conceptual-demo.md). New
flag: shared/replayed sessions execute agent-authored code on other viewers'
machines — fine for the demo, revisit before share links are a headline
feature. The declarative schema-renderer tier from conceptual-demo.md is
consciously deferred; the ds absorbs part of that role.

## Phases

(All phases 0–4 landed 2026-08-17. Remaining: browser-visual verification and scaffold iteration against real model output once an API key is on the deployment.)

0. Framework: `ctx.updateStateAt(address, update)` in @projectors/core, with
   focused tests (address resolution, schema validation on fold, mutation
   message carries stateKey).
1. Surface runtime (shims, transform, shadow mount, boundary) + `appSurface`
   + `writeAppSurface` (with requestOpenPane) + pane rendering.
2. `spawnChild`/`cede` tools + generic `setState` action + api/effigy bridge
   with optimistic run + hooks. ← the todo-app moment lands here.
3. Chat cards (`postCard`) + promote-to-pane.
4. Repair-loop polish + scaffold iteration against real model output.
