# TODO

## Executor-Owned Streaming Metadata

Status: design pending.

Keep streaming primarily in executor packages for now. Executors can decide
whether a provider supports incremental output, how to enable it, and how to
surface partial updates to the host. The core machine should not yet commit to a
generic `runMachine(..., { streamWhenAvailable })` API.

Core still needs a small amount of framework support so executor-owned streaming
can finalize durably:

- Add machine-scoped metadata for final actor messages produced by executors.
- Prefer `outputId` for the stable logical output identifier. It is clearer than
  `messageId` because apps often already have app-level message IDs.
- Treat `outputId` as projector-owned and activation-scoped, for example derived
  from `activationId` plus an output index.
- Keep provider stream attempts separate from logical outputs. A `streamId` may
  change across retries, while the final logical `outputId` should remain stable
  for the activation output.
- Allow final messages to carry stream completion metadata such as state and
  final sequence number.
- Extend implicit text output handling so an executor that returns final text can
  also return metadata for the final durable message. Without this, core maps
  `value: string` into a plain assistant message and loses the stream
  correlation.
- Consider adding `ExecutorRunRequest` helpers such as `createOutputId(index)`
  and `createStreamId()` so executor packages do not invent incompatible ID
  schemes.

Rationale:

- Partial stream deltas should not become projector frames. Token-level frames
  would backpressure provider streaming on durable writes and would pollute
  model-visible history.
- The durable source of truth should remain the final projector frame.
- Apps should own storage-specific idempotency keys. Core should provide stable
  machine metadata that apps can use to derive those keys.
- `outputId` is intentionally not an app message ID. Hosts may map it to Convex
  rows, SQL rows, telemetry events, or ignore it entirely.

Current naming preference:

- `outputId`: preferred. Short, readable, and scoped to executor output.
- `activationOutputId`: precise but longer.
- `machineOutputId`: clear but a little awkward.
- `messageId`: avoid, because it collides conceptually with app-owned messages.
- `asId`: avoid for now; it is too opaque despite being compact.

Open design questions:

- Whether message metadata should be top-level, such as `outputId` and `stream`,
  or namespaced, such as `machine.outputId` and `machine.stream`.
- Whether stream completion metadata belongs only on assistant messages or on all
  actor messages.
- Whether core should expose reusable stream event types even if event emission
  remains executor-owned.
