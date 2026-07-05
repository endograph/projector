# Future Work

These items are intentionally outside the first implementation pass described in
`MASTER_PLAN.md`.

- Projection builder API: keep low-level projection draft mutation available,
  but add helper methods such as `addSystem`, `addDynamic`, `addTools`,
  `addStateNote`, `merge`, and `replaceWith` so ordinary projection functions do
  not need to preserve internal `ProjectionDraft` invariants by hand.
- Discoverable tools: support tools that are not sent as provider-static tool
  definitions and must be discovered through a catalog/search mechanism.
- Polymorphic tool invocation: support a stable invoker tool that can dispatch
  to hidden node tools by name or namespace.
- Richer projection policies for commands if the model or client needs explicit
  awareness of command availability.
- State bindings: support per-attachment state options or projection overrides
  when a descriptor's global defaults are not enough.
- Additional generator history policies beyond runtime `historyProjection` if
  generators need declarative scoped or summarized history instead of custom
  projection functions.
- Generator pause / block / wake
- `refreshInference` adoption in the LiveKit cascade executor. The AI SDK
  executor re-projects history per step so mid-generation immediate messages
  surface to the model and are absorbed; the cascade executor still projects
  once per run, so messages it misses correctly retrigger but are never steered
  into an open run.
- An explicit self-wake mechanism for runtimes that need to schedule their own
  future activations. The self-trigger exclusion means self-addressed messages,
  including `delivery: "queued"` ones, never create activations on their own.
- Activation identity for multiple same-runtime trigger events within one source
  frame. The first pass may treat activations as at most one per runtime,
  trigger, and source frame, but a future design should add a per-trigger-event
  semantic key if multiple actor/work messages in one frame need to create
  distinct activations for the same runtime.
- Instance folding / canonicality semantics. Decide when locally produced
  instance messages should affect the in-memory machine state. One option is to
  fold immediately and treat that as optimistic in-machine behavior, with the
  database-reconciled instance state remaining canonical only after the frame
  lands. Another option is to fold only when the frame is yielded. These may be
  closer than they first appear: even yielded frames can still have an optimistic
  quality if the backend later rejects persistence. Slow LLM calls also make
  ordering inherently ambiguous, so there may be no intrinsic global ordering for
  concurrent instance messages without an explicit conflict policy.
- Persisted runtime sync cursors for long-lived realtime executors. The first
  LiveKit pass can keep this simple and drop old visible messages on reconnect,
  but a future design should track which frame IDs have already been forwarded
  to an external realtime session so reconnects can update instructions/tools
  without replaying or losing unsent user input.
- First-class distributed leases are out of scope for the core framework; if
  needed later, design them as an optional layer over deterministic activations.
