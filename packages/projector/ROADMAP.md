# Projector roadmap — deferred work from the parts-model milestone

The parts model (nodes as ordered typed parts, slots/layouts, discriminators/
selects, derived members, unified actions with `caller`, parts serialization)
landed as one milestone. These are the pieces deliberately deferred, with the
settled design where one exists. Ordered roughly by expected leverage.

## Core primitives

### 1. Focus / tenure
Same-named action collisions currently resolve by deterministic last-write-wins
(deepest contributor, `shadowed-action` diagnostic). Deferred by explicit
decision: shadowing may be the right permanent rule, and error-on-collision was
rejected. The stronger primitive — a spawned child *holding focus* and
suppressing the ancestor's whole action surface during its tenure — should be
revisited if (a) shadow diagnostics get noisy, or (b) a case needs suppression
beyond same-name shadowing. `spawn(node, { focus: true })` / `cede()` releases.

### 2. Exposure enum on action parts — PARTIALLY LANDED
`native | deferred` shipped: `tool(a, { exposure: "deferred" })` tags the
compiled tool (read via `actionExposure`), emits an overridable availability
note (explicit `guidance` replaces it), and the aisdk executor lowers to the
provider tool-search idiom built in — Anthropic (`deferLoading` + BM25 tool
search) and OpenAI Responses (`deferLoading` + `tool_search`), selected by
the model's provider id (requires `@ai-sdk/anthropic`/`@ai-sdk/openai` ^3).
The `deferredTools` config hook overrides the built-ins (custom providers,
regex search variant). A deferred tool an executor cannot lower is an ERROR,
never a silent native degradation — the compiled availability note promises
tool search, so a surface that cannot honor it must not run (the realtime
executor therefore rejects deferred tools outright). The provider search-tool
names (`tool_search`, `tool_search_tool_bm25`) are reserved against projected
action names, like `getState`. State defers symmetrically via
`projection.exposure` (getState). Model-capability compat is the CHARTER's
job, not an executor toggle: a charter that must run on both search-capable
and search-less models makes deferred-tool support a param and selects
exposure with a discriminator (`select(deferredToolSupport, ...)` swapping
`tool(x, { exposure: "deferred" })` for `tool(x)`) — exposure decides both
the availability note and the lowering at compile time, so prompt and
surface can never disagree; an executor-side degrade flag would break that.
Remaining values for later: `dispatched` (multi-tool adapter) and `rendered`
(prompt-text lowering). Invariant preserved: the log records logical
actions; exposure never enters history.

### 3. State-projection refactor — LANDED
One declaration carries state and projection config:
`StateDescriptor.projection?: { slot?, exposure?, render?, note? }` replaced
the old string policy (briefly named `view` mid-milestone before settling on
`projection`); `"retrieval"` became `projection.exposure: "deferred"`
(getState + overridable note); state projections route through slots/layout
like all content; `render`/`note` are code (registered descriptors only,
never serialize). Plural `states: [a, b]` per node landed and the singular
node-level `state:` sugar was removed — plural is the only spelling (action-
level `state:` bindings are unrelated and stay); action contexts bind the
action's own declared descriptor, and `state: null` actions get no state
context.

### 4. History renderer policies — LANDED
`layout.historyProjection` owns history rendering per document;
`runtime.historyProjection` was removed outright (no per-node overrides, by
decision). Executors keep lowering per backend. Variation, if ever needed, is
a different layout (or a future discriminator-selected layout choice).

### 5. Boundary export manifests
`boundaryProjection` is now a plain enum — `"hidden"` (default, nothing
crosses) | `"augment"` (every compiled part forwards to the parent as-is);
the opaque projection-function machinery was removed outright. The remaining
future work is selective export between those poles: **surface export** — a
static manifest (`exports: "all" | address list` of slots/action names/state
keys), enumerable and additive on the parent side — and **activity digest** —
a named history renderer over the child generator's frames (the generalized
form of a return-to-manager action's hand-written report). Both extend the enum with
declarative data, never reintroduce arbitrary code at the boundary.

### 6. Budget degradation (`droppable`)
Removed from `SlotDef` because nothing consumed it. Reintroduce together with
its consumer: layout-declared truncation tiers that a budget-constrained
executor must respect — what gets sacrificed is a charter decision the
executor enforces, never executor improvisation.

### 7. Observability artifact + transport redaction
The compiled-tree inspection should become the near-full IR artifact: parts
with addresses and provenance, discriminator resolutions (value + resolving
container), member derivations, select branches taken, plus the rendered
preview per generator. Slot-table view for inspectors ("`flow`: from select
branch voice, resolved from agentControls @ thread-x"). Who-sees-how-much is a
host-side redaction/view policy per transport channel (dev inspector: full;
end-user clients: states only), not a second document structure.

### 8. Executor lowering laws + cache breakpoints — LANDED
The compiled IR now matches the layout output: `systemParts`/`dynamicParts`
became `preamble`/`recency` (CompiledInference, ProjectionIR, the inspection
wire, and the sandbox client — which keeps dual-spelling reads for persisted
payloads), and the layout render stamps every compiled part with its resolved
slot identity and volatility (`CompiledPart`) instead of stripping placement.
Identity is slot-granular by decision: text-run merging collapses per-source
identity within a slot anyway, and owner addresses were never on content
parts (owner-level provenance stays with item 7). Settled rules: the cache
boundary is always INFERRED from `SlotDef.volatile` + slot order (lint-backed)
— never an explicit marker part (markers can lie; breakpoints are provider
mechanics; composable node parts lack the global view); no content hashes in
the IR — consumers diff by slot key + plain equality. The wins shipped with
it: the aisdk executor lowers the preamble to `SystemModelMessage[]` with one
Anthropic `cacheControl` breakpoint on the last stable block (configurable via
`promptCache`; non-Anthropic providers keep the byte-identical single string),
and the realtime executor keys dynamic-context conversation items by slot
(only changed slots create/delete items; per-slot version notes) and skips
unchanged instruction pushes. The lowering laws are conformance
(`test/conformance/lowering.test.ts`): order preserved within regions, content
preserved (image degradation is a declared fixed rule), tool surface preserved
(deferred tools lower or refuse loudly), one breakpoint at the stable/volatile
boundary, block text re-encodes (never authors) the legacy system string.
Still open here: possible region additions (e.g. `epilogue`) are IR-contract
changes with lowering semantics, never per-layout inventions; realtime item
ordering across slots is unanchored (items append at the conversation tail —
`previous_item_id` anchoring is a follow-up); tool-list `session.update`
diffing.

