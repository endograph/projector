# Plan: open variation — `computed` as the single variation primitive

Settled design from the 2026-07-09 discussion. Motivation: rapidly iterating
product agents prioritize rapid experimentation over agent-driven evolution. Discriminators +
selects are the right *formalization* of variation (closed vocabulary,
exhaustive branches, static analyzability) but the wrong *mechanism* to force
on every variation site. The unifying observation: a `select` is a
defunctionalized `(params, state) → parts`; `computed` is the direct form of
the same function. This plan generalizes `computed` into the one variation
primitive — for content, actions, commands, and members — and demotes the
select forms to sugar over it, without giving up the invariants that
serialization, history, and the log depend on.

The invariant, restated:

> **State placement follows the skeleton; state existence follows the log;
> state persists once attached. Surface follows the derivation.**

## Core rules

1. **Branches are data, closures are opaque.** Anything reachable by walking
   data (select/when branches today, sugar metadata tomorrow) supports inline
   definitions — ref recovery and validation walk it. Only values conjured
   inside a `compute` closure need a resolvable identity.

2. **Closure rule.** A computed's returned action parts and member nodes must
   resolve against: **computed-local registry → node → charter** (extending
   the existing `resolveActionEntry` tiers). Never mint identities inside a
   closure. Compile errors on anything unresolvable.

3. **Realization is a logged write, never a read.** A state container comes
   into existence only via the mutation path (`ctx.updateState` in an action
   frame, or a spawn's `states:` seed). Reads — compile, discriminators,
   computeds, getState — fall back to the descriptor's `init` and never
   side-effect. Compile stays a pure function of `(params, state)`.

4. **One registered descriptor identity per state key, charter-wide.**
   Validated at charter build. Makes descriptor-group merging
   (`mergeDescriptors`, `equivalentInit` conflicts, scope-mismatch checks in
   `resolveStateGroup`) impossible by construction rather than detected by
   enumeration.

5. **Discriminators evaluate per instance.** Already true
   (`evaluateDiscriminator` memo key = name + resolving container +
   contributor; "correctness never depends on the memo"). Nothing in this
   plan changes discriminator semantics — they become a naming/enforcement
   layer over computeds instead of parallel core machinery.

6. **Lifecycle stays on spawn/cede.** Derived membership (select or computed)
   is a memoryless view over durable state; "member off" is a value, not an
   event. State that should die with presence uses spawn/cede, where presence
   is a logged transition.

## Phase 1 — lazy state realization

Foundational and independently shippable; every later phase leans on it.

- Charter-build validation: one descriptor identity per state key (charters
  comply by exporting shared descriptor identities).
- `resolveStates` stops provisioning: it validates/parses *existing*
  containers only (keeping the `onInitConflict` reset path for schema
  evolution). The `collectContributors` walk for provisioning goes away.
- Write-time attachment: `ctx.updateState` on an unrealized state creates the
  container at the instance derived from the writing contributor +
  `descriptor.scope` (`local` → concrete instance, else hoist) — the same
  placement `resolveStates` computes today, now computed at the write.
  Updater callbacks receive `init` as `current` when unrealized (patchState
  flows unchanged).
- Spawn `states:` seeds realize at spawn (already a logged frame).
- `deriveStateAliases` must derive from declarations in scope, not realized
  containers, so a `getState` address never shifts when a second carrier
  realizes.
- Serialization: unrealized state does not serialize; hydration validates
  only what arrives.

Accepted trade-offs (deliberate):

- **Init drift.** Unrealized state tracks the *current code* `init` across
  deploys instead of pinning at session creation. Precedent:
  `onInitConflict: "replace"` already resets to current code init. For
  rapidly iterating agents hot-updatable defaults are a feature;
  byte-identical prompt replay for untouched state is not guaranteed across
  deploys.
- **Touched ≠ untouched.** Set-back-to-default serializes; never-touched
  doesn't. Visible in payloads and debugging, not in behavior.

## Phase 2 — widened computed parts (actions + commands)

- `compute: (env) => string | Part<T>[]` (was `string | ContentPart<T>[]`).
  Action parts arrive via the existing `tool()` / `command()` constructors —
  caller and exposure ride the part, so commands get identical semantics to
  tools (they desugar to the same action parts today, differing only in
  `caller`; see `desugarParts`).
- Optional `registry: [...]` on the computed config: local candidates for
  ref resolution (rule 2). Enables inline actions without charter
  registration and scopes serialized-ref recovery to the declaring site.
- Compile: computed-returned action parts flow through the existing
  `resolveActionEntry` → `assertNodeActionStateCompatibility` → `bindAction`
  path at the computed's contributor and depth. Deferred exposure lowers
  normally (exposure is decided on the compiled draft).
- Dispatch: `resolveContributorActions` evaluates computeds too (fresh
  evaluation, same as selects) — `compute` runs on the `executeCommand` path,
  so it must stay cheap and deterministic.
- Client metadata: computed-contributed actions appear in effective compiled
  snapshots, not in the static `collectAllNodeActions` universe. Accepted.
- Dev-mode stability check: memoize per compile on computed name + params +
  declared-state container versions; in dev, re-evaluate and assert the
  returned *action-name set* matches. Catches ambient-state flicker (the
  ambient-module-lookup class of bug) where it hurts — tool-surface churn is
  prompt-cache churn from byte zero. Content parts keep sanctioned ambient
  reads (camera snapshot); structure should derive from `env` only —
  enforced by idiom + app-side lint (flag mutable module-scope captures in
  `compute` closures), not by the framework, plus this check.
- Env stays closed: `{ params, state(descriptor), discriminator(d) }`
  (discriminator reader lands in Phase 4; nothing ambient is ever added).

## Phase 3 — computed members

- `MemberEntry` becomes `Node | Computed<Node | Node[] | null>`. There is no
  new member concept: computeds evaluate to plain registered `Node`s; nothing
  about a node changes because it arrived via a computed.
- No candidate declaration required — Phase 1 removed the provisioning
  obligation that would have forced a declared codomain. The closure rule
  (local registry → charter) bounds the universe.
- `resolveMemberNodes` drops the dual `all`/`effective` view; effective is
  the only view. Dedup by key across entries preserved.
- Client realization (`realizeContributor`) moves to the effective view —
  endorsed as an improvement: params and state are definitionally part of
  the client representation. **Check consuming UIs for any dependence on
  potential (flapped-off) members before landing.**
- Executor-config validation: walk static member entries + sugar
  metadata/registries; charter registry covers bare-computed returns.
- Contributor-by-id lookup for late-executing bound actions follows
  fresh-evaluation semantics (a member that flapped off is not found; the
  stale dispatch errors) — consistent with `findContributorCommand` today.

## Phase 4 — demote member selects to sugar

- `whenMember(d, v, node)` / `selectMember(d, branches)` keep their exact
  signatures (TypeScript exhaustiveness via `Record` over the value union is
  preserved at the type layer) but return a computed member whose **registry
  is auto-derived from the branches** and which carries
  `{ discriminator, branches }` metadata. Runtime ignores the metadata;
  ref-lookup walks the registry (inline members keep working); tooling and
  the future closed-variation lint read the metadata.
- `env.discriminator(d)` ≡ `evaluateDiscriminator(d, thisContributor, memo)`.
  Purely mechanical: closures only receive `env` (no contributor access), and
  the canonical path carries the memo write and the vocabulary validation
  (throw on out-of-set derive). Per-instance evaluation semantics unchanged —
  no pinning, no new invariant. Inline re-derivation would agree on values
  but silently skip validation; don't special-case sugar instead of exposing
  the reader.
- Delete the core kinds: `MemberSelect`, `isMemberSelect`, the
  `memberSelect` walks in machine.ts, the dual-view plumbing. Update the
  contributors.ts invariant comment to the restated form above.
- Charter diff for existing callers: zero — `whenMember(cameraActive, 'on',
  cameraSensorNode)` is the same line, lowered differently.

## Phase 5 — collapse parts `select`/`when` into sugar

The parts-side analog of Phase 4: delete `SelectPart` as a core kind, leaving
`computed` as the only variation entry in a parts list. Requires Phase 4
(members prove the sugar/registry/metadata pattern). Product adoption of
open variation (e.g. per-experiment computeds keyed off an `experiments`
param) is an app concern layered on top.

- `select(d, branches)` / `when(d, v, entry)` keep their exact signatures
  (TypeScript exhaustiveness preserved) but return a computed part whose
  registry is auto-derived from all branch parts, tagged with
  `{ discriminator, branches }` metadata, and whose compute is
  `env.discriminator(d)` → branch parts. Discriminator string refs
  (`resolveDiscriminatorRef`) keep working through the sugar.
- The bigger bite, and why this phase exists separately: **ref recovery and
  the static action walk must be retaught.** `nodeActionByName` is the
  recovery path serialized bare refs use to find inline actions by walking
  parts across select branches; `collectAllNodeActions` (machine-build
  validation, client action metadata) does the same walk. Both move from
  entering `SelectPart` branches to entering computed registries/metadata.
  Inline actions in sugar branches keep working (they land in the
  auto-derived registry); inline actions in a *bare* computed are
  recoverable only via its explicit `registry` — otherwise the closure rule
  errors at compile.
- Charter-build validation follows the same walk change: the "non-partial
  selects must be exhaustive" check moves into the sugar constructor (the
  `Record` type already enforces it; the runtime check guards JS callers).
- Atomic guidance swaps are preserved by construction — the compile.ts
  behavior where a select swapping an action swaps its guidance with it is
  exactly "one closure returns both parts."
- Branch text parts keep their own slot placement (Phase 2's widened returns
  already carry per-part slot addresses).
- Delete: `SelectPart`, `normalizeBranches`, the select arms in the compile
  walk and `walkAllParts` (which reduces to a flat walk over parts + computed
  registries).
- Follow-on cleanup (optional, after landing): `select` and `selectMember`
  become the same sugar differing only in return type — unify into one
  position-typed `select` mirroring the unified `computed`.

## Deferred (explicitly out of scope now)

- **`variation: 'closed' | 'open'` charter policy** — closed charters reject
  structure-bearing bare computeds (sugar/static only), validated in the
  existing charter-build lint pass. Introduce when a closed-mode agent needs
  it; the sugar metadata from Phases 4 and 5 is the hook it will consume.
- **Realization events beyond writes/spawn-seeds** — rejected for now;
  "compiled once = attached" would reintroduce compile side effects.

## What is knowingly given up

- Static enumeration of arbitrary computed outcomes (sugar metadata keeps the
  declarative subset enumerable; bare closures are opaque). Prompt preview +
  evals become the lint for open charters — they must exercise computeds
  across representative params/state.
- The client's potential-members ("all") view.
- Charter-build-time detection of volatile-slot violations and bad refs
  inside closures — these surface at first compile instead.
- Byte-stable init pinning for unrealized state (see Phase 1 trade-offs).
