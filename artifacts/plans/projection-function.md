# Projection Function Draft Plan

## Summary

Refactor projector projection functions from static-policy factories into compile-time hooks, and split static node projection from static boundary projection.

The current framework types `projection` and `boundaryProjection` the same because both resolve to a passive `StaticProjection` policy. The compiler then applies that policy through two different paths:

- node projection applies policy to a node's own instructions, state, and tools
- boundary projection applies policy to an already compiled child runtime aggregate

Once projection functions can mutate drafts directly, the API should make that distinction simpler instead of hiding it behind overloaded static fields.

This plan only changes `@packages/projector`. It does not change `apps/demo` or `apps/demo-agent`.

## Goals

- Let projection functions append, remove, or rewrite compiled prompt parts.
- Keep static node projection expressive for node-local instructions/state/tools.
- Make static boundary projection intentionally small: only `mode`.
- Keep `historyProjection` as the only history-shaping hook.
- Keep the existing static field names `instructions` and `tools` for node projection.
- Prefer framework simplicity over backwards compatibility.

## Non-Goals

- Do not implement camera or sensor nodes in the demo app.
- Do not add transient frames.
- Do not add node-owned private history.
- Do not add rich image input support.
- Do not preserve old projection function compatibility.

## Type Shape

### Static Node Projection

Keep node static projection close to today:

```ts
export type ProjectionMode = "hidden" | "augment" | "replace";

export type StaticProjection = {
  mode?: ProjectionMode;
  instructions?: "system" | "dynamic" | "hidden";
  tools?: "provider-static" | "hidden";
};
```

`instructions` and `tools` apply to the current node source: node instructions, projected state, and node tools.

### Static Boundary Projection

Give boundary projection its own static type:

```ts
export type StaticBoundaryProjection = {
  mode?: ProjectionMode;
};
```

Boundary static projection should not have `instructions` or `tools`.

Rationale:

- A boundary source is already compiled; it is not raw node instructions/tools.
- Reusing `instructions` at a boundary creates overloaded semantics.
- Reusing `tools` at a boundary creates policy questions about exporting child runtime tools.
- The simple static boundary behavior is enough for common cases: hide, augment, or replace.
- More selective boundary export belongs in a projection function.

Default boundary projection remains:

```ts
export const DEFAULT_BOUNDARY_PROJECTION: StaticBoundaryProjection = {
  mode: "hidden",
};
```

When `mode` is `"augment"` or `"replace"`, static boundary projection exports the child runtime source as compiled:

- child `systemParts` stay system parts
- child `dynamicParts` stay dynamic parts
- child `tools` are exported
- child retrievable state parts are exported

If a boundary needs to export prompt but not tools, re-channel system to dynamic, filter retrieval, summarize, or otherwise customize the export, use a projection function.

## Draft And Source

### Projection Draft

`ProjectionDraft` is the mutable projection output surface.

```ts
export type ProjectionTextPart = { type: "text"; value: string };

export type ProjectionStatePart = {
  type: "state";
  section: "system" | "dynamic" | "retrieval";
  stateKey: string;
  target: StateAddress;
  value: unknown;
};

export type ProjectionPart = ProjectionTextPart | ProjectionStatePart;

export type ProjectionDraft = {
  systemParts: ProjectionPart[];
  dynamicParts: ProjectionPart[];
  tools: AnyAction[];
  states: ProjectionStatePart[];
};
```

`CompiledInference.history` remains produced by the target runtime's `historyProjection`.

`ProjectionDraft` intentionally exposes the full projection IR instead of flattened strings. Projection functions are a low-level API, and state metadata must survive until final render so aliases and retrievable state exports can be computed from the full projected state set.

### Projection Source

`ProjectionSource` is the read-only input to a projection function.

```ts
export type ProjectionSource = {
  readonly instructions?: string;
  readonly systemParts: readonly ProjectionPart[];
  readonly dynamicParts: readonly ProjectionPart[];
  readonly tools: readonly AnyAction[];
  readonly states: readonly ProjectionStatePart[];
};
```

Sources differ by call site:

- node projection source: current node instructions plus projected state/tools compiled into projection shape
- boundary projection source: complete child runtime compilation viewed as read-only

For boundary sources, `instructions` is normally undefined because child runtime instructions have already been compiled into `systemParts` or `dynamicParts`.

## Context

Use one projection function signature with a call-site marker in context.

```ts
export type ProjectionCallSite = "node" | "boundary";

export type ProjectionContext<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  callSite: ProjectionCallSite;
  runtimeInstanceId: RuntimeInstanceId;
  address: RuntimeAddress;
  target?: Generator;
  node: Node<TActorMessage>;
};
```

## Projection Function

Projection functions are a rare escape hatch. They receive the current destination draft and a normalized source, and mutate the draft.

```ts
export type ProjectionFunction<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = (
  ctx: ProjectionContext<TActorMessage>,
  draft: ProjectionDraft,
  source: ProjectionSource,
) => void;
```

Example sensor node:

```ts
projection: (_ctx, draft, source) => {
  applyStaticProjection(draft, source, {
    instructions: "dynamic",
    tools: "hidden",
  });

  const latest = sensors.camera.latest();
  if (latest) {
    draft.dynamicParts.push({
      type: "text",
      value: `Camera sees: ${latest.description}`,
    });
  }
}
```

Example custom boundary projection:

```ts
boundaryProjection: (_ctx, parentDraft, source) => {
  const promptParts = [...source.systemParts, ...source.dynamicParts].filter(
    (part) => !(part.type === "state" && part.section === "retrieval"),
  );
  parentDraft.dynamicParts.push(...promptParts);
  parentDraft.states.push(
    ...promptParts.filter(
      (part): part is ProjectionStatePart => part.type === "state",
    ),
  );
  // Intentionally do not export child runtime tools.
}
```

## Projection Values

Use separate static types, but share projection function refs.

```ts
export type Projection<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | StaticProjection
  | ProjectionFunctionRef
  | ProjectionFunction<TActorMessage>;

export type BoundaryProjection<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | StaticBoundaryProjection
  | ProjectionFunctionRef
  | ProjectionFunction<TActorMessage>;
```

Then:

```ts
export type NodeConfig<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  projection?: Projection<TActorMessage>;
  // ...
};

export type PrimaryRuntime<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  type: "primary";
  boundaryProjection: BoundaryProjection<TActorMessage>;
  // ...
};
```

Because the function signature is shared, a single `charter.projections` registry can continue to back both `projection` and `boundaryProjection` refs.

## Static Helpers

Keep separate helpers for static projection because static node projection and static boundary projection have different type shapes.

```ts
export function applyStaticProjection(
  draft: ProjectionDraft,
  source: ProjectionSource,
  projection?: StaticProjection,
): void;

export function applyStaticBoundaryProjection(
  parentDraft: ProjectionDraft,
  source: ProjectionSource,
  projection?: StaticBoundaryProjection,
): void;
```

Default node projection:

```ts
export const DEFAULT_STATIC_PROJECTION: Required<StaticProjection> = {
  mode: "augment",
  instructions: "system",
  tools: "provider-static",
};
```

Static node projection behavior:

- `mode: "hidden"` leaves the draft unchanged.
- `mode: "replace"` clears the draft before applying the source.
- `mode: "augment"` applies the source to the existing draft.
- `instructions: "system"` exports `source.instructions` as a text part to `systemParts`.
- `instructions: "dynamic"` exports `source.instructions` as a text part to `dynamicParts`.
- `instructions: "hidden"` skips `source.instructions`.
- `tools: "provider-static"` exports source tools.
- `tools: "hidden"` skips source tools.

This plan does not change existing state projection channel behavior.

Static boundary projection behavior:

- `mode: "hidden"` leaves the parent draft unchanged.
- `mode: "replace"` clears the parent draft, then merges the source as compiled.
- `mode: "augment"` merges the source into the existing parent draft as compiled.

## Compiler Model

Projection compilation keeps the current node-before-children traversal. A node `mode: "replace"` clears projections accumulated before that node, then that node's children still apply after the replace.

```ts
function compileProjectionFrame(frame): ProjectionDraft {
  const draft = emptyProjectionDraft();

  const source = compileNodeProjectionSource(frame);
  applyProjection(
    draft,
    source,
    frame.node.projection,
    projectionContext(frame, "node"),
  );

  for (const child of directProjectionChildren(frame)) {
    const childDraft = compileProjectionFrame(child);

    if (isRuntimeBoundary(child) && !belongsToTarget(child)) {
      applyBoundaryProjection(
        draft,
        readonlyProjectionSource(childDraft),
        child.node.runtime.boundaryProjection,
        projectionContext(child, "boundary"),
      );
    } else {
      mergeProjectionDraft(draft, childDraft);
    }
  }

  return draft;
}
```

Boundary `mode: "replace"` follows the same rule at the parent draft level: it clears projections accumulated before that child boundary, then later siblings still apply.

`applyProjection(...)` behavior:

- if projection is omitted, apply `DEFAULT_STATIC_PROJECTION`
- if projection is a `StaticProjection`, call `applyStaticProjection(...)`
- if projection is a `ProjectionFunction`, call it directly

`applyBoundaryProjection(...)` behavior:

- if boundary projection is omitted, apply `DEFAULT_BOUNDARY_PROJECTION`
- if boundary projection is a `StaticBoundaryProjection`, call `applyStaticBoundaryProjection(...)`
- if boundary projection is a `ProjectionFunction`, call it directly

## History Projection

Do not change history projection in this plan.

`CompiledInference.history` remains:

```ts
machine.frames
  -> visibleHistoryForTarget(targetRuntime)
  -> targetRuntime.historyProjection
```

Projection functions should not be responsible for durable history shaping. Sensor data that belongs in dynamic prompt should append text parts to `draft.dynamicParts`. If we later need node-contributed synthetic history, add that deliberately rather than overloading this change.

## Serialization

Update serialization expectations:

- `StaticProjection` serializes as a plain object.
- `StaticBoundaryProjection` serializes as a plain object.
- Registered `ProjectionFunction` values serialize by ref through `charter.projections`.
- Inline projection functions still cannot be serialized.
- Boundary static projections with `instructions` or `tools` should be rejected during hydration/validation.

## Implementation Steps

1. Update `packages/projector/src/types.ts`.
   - Add `StaticBoundaryProjection`.
   - Add `BoundaryProjection`.
   - Add `ProjectionDraft`, `ProjectionSource`, and `ProjectionCallSite`.
   - Change `ProjectionFunction` signature.
   - Keep node `Projection` using `StaticProjection`.
   - Change runtime `boundaryProjection` to use `BoundaryProjection`.

2. Update `packages/projector/src/create.ts`.
   - Keep `DEFAULT_STATIC_PROJECTION`.
   - Keep `DEFAULT_BOUNDARY_PROJECTION`, typed as `StaticBoundaryProjection`.
   - Normalize node static projection with `instructions` and `tools`.
   - Normalize boundary static projection with `mode` only.
   - Stop normalizing projection functions as static-policy factories.

3. Refactor `packages/projector/src/compile.ts`.
   - Replace `ProjectionSections` with `ProjectionDraft` or adapt it behind the new draft/source API.
   - Preserve state metadata until finalization if retrieval aliases still depend on the full projected state set.
   - Add `compileNodeProjectionSource(...)`.
   - Add `readonlyProjectionSource(...)`.
   - Add `applyStaticProjection(...)`.
   - Add `applyStaticBoundaryProjection(...)`.
   - Add `applyProjection(...)` and `applyBoundaryProjection(...)`.
   - Keep history compilation separate.

4. Update refs and serialization.
   - Keep `charter.projections` for function refs.
   - Update node projection serialization.
   - Update runtime boundary projection serialization.
   - Reject static boundary projections containing `instructions` or `tools`.

5. Update tests.
   - Static node projection can place instructions/state/tools.
   - Static boundary projection only supports hidden/augment/replace.
   - Static boundary augment exports prompt parts, tools, and retrievable states as compiled.
   - Node `mode: "replace"` clears prior projections while still allowing children to project afterward.
   - Projection function can append a text part to `dynamicParts` from closure state.
   - Boundary projection function can export prompt while filtering tools.
   - History projections still apply only from the target runtime.

6. Run package tests.
   - `pnpm --filter @projectors/core test` or the repo's equivalent projector test command.

## Expected Outcome

After this change, sensor-style nodes can project live external context into prompts without frames, without state persistence, and without special demo app plumbing in the framework.

The framework model becomes clearer:

- `projection` controls how a node projects itself into its subtree draft.
- static `boundaryProjection` controls only child runtime export mode.
- boundary projection functions handle selective or custom child runtime export.
- `historyProjection` remains the only history-shaping mechanism.
