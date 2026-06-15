# Convex Usage Guidance

These notes capture Convex-specific guidance learned while building a durable
projector application. They are written for future apps, not just the demo.

## Convex Value Boundaries

Convex rejects object field names beginning with `$`. This matters for JSON
Schema because fields such as `$schema` are common in projected state and action
metadata.

The restriction applies at multiple boundaries:

- database documents
- mutation arguments
- action-to-mutation arguments
- external Convex client mutation arguments
- query/action/mutation return values

Do not rely on a mutation handler to escape invalid nested keys if the raw value
is passed as an argument. Convex validates arguments before the handler runs.

## Escape Before Crossing Convex

Apps that persist schema-bearing projector data should own a Convex-safe JSON
codec at the app boundary.

Recommended behavior:

- escape `$` keys before passing values into Convex mutations
- store escaped values in documents
- restore escaped values inside server-side logic before running projector code
- strip schema metadata from browser-facing results unless the browser truly needs it

Common values that need attention:

- serialized projector instances
- client snapshots
- display instances
- frame metadata
- frame messages
- sync state
- projected command schemas
- projected state schemas
- `inputSchema` objects

Avoid returning restored `$schema` objects directly from public Convex queries.
Even if storage is fixed, return-value validation can still reject the payload.

## Keep Projector Serialization Lean

Register reusable nodes/states/actions so durable serialized instances can refer
to known definitions instead of embedding full schemas. A healthy durable
instance should usually carry refs to registered objects rather than large schema
objects.

Client snapshots may still need rich UI metadata, so the app boundary still
needs escaping/stripping. Lean instance serialization reduces the amount of
schema-bearing data that must cross Convex at all.

## Server Mutations Should Read The Head

For projector applications, do not expose broad mutations that accept arbitrary
whole-instance replacements from clients or workers.

Prefer narrow mutations:

- `applyUserMessage`
- `applyClientMessage`
- `appendFrame`
- `appendInstanceLog`

Those mutations should load the current session/head frame inside Convex, apply
the requested semantic update, and append durable records. This protects newer
state from being overwritten by stale callers.

## Streaming Message Writes

Streaming updates should patch a message row, not append a projector frame per
delta.

Recommended message fields:

- `idempotencyKey`
- `streamState`: `streaming`, `complete`, or `error`
- `streamSeq`: monotonic update sequence
- `mode`: `text` or `voice` if the UI needs transport/source labels
- `frameId`: optional until final content has a durable frame

When patching an existing message, ignore updates whose `streamSeq` is older
than the stored sequence. This prevents late network or worker updates from
overwriting completed content.

## Worker Lease State

Convex is a good authority for runtime worker leases because mutations are
transactional and visible to clients.

A lease table or room table should include:

- stable transport/session key
- worker id
- lease token
- lease expiration timestamp
- heartbeat timestamp
- dispatch/reconnect bookkeeping if workers are externally dispatched

Workers should:

- claim a lease before doing semantic work
- heartbeat/renew periodically
- assert the lease before mutating durable state or running inference
- release the lease on disconnect
- exit if the lease row changes or another token owns the lease

Clients/actions should check for a live lease before dispatching replacement
workers.

## Debugging With Convex

Useful read-only debugging patterns:

- list a small amount of table data
- inspect function specs
- watch logs
- run public queries for a session

Treat mutation/debug writes as explicit operations. They can alter durable
application history and should not be run casually while diagnosing runtime
transport bugs.

## Practical Checks

For Convex-backed projector apps, verify:

- schema-bearing payloads pass Convex value serialization before mutation calls
- public queries do not return `$schema` or explicit invalid values
- server logic restores escaped values before running projector functions
- sends apply against the latest durable head
- streaming patches cannot overwrite complete messages
- worker lease loss stops further writes
