# Root Instance Plan

## Goal

Replace the current synthetic root wrapper with an actual root instance created by
`createRoot`, using a constant instance id of `"root"`.

The projector framework should not care whether any arbitrary instance has an id
of `"root"`. The id is only significant for the root instance returned by
`createRoot`. If an application does not use `createRoot`, its root instance can
have any id and the normal traversal/runtime rules should still apply.

## Current Problem

`createRoot` currently returns a wrapper shape:

```ts
{
  type: "synthetic-root",
  instances,
}
```

That wrapper is not an `Instance`, does not have a `ProjectionFrame`, and does
not appear in the normal parent chain. As a result, several framework paths need
conditionals for `SYNTHETIC_ROOT_RUNTIME_ID`, including scheduling, runtime sync,
projection/history compilation, client display, and observability.

The most important leak is parent traversal. Runtime rules want to walk ancestor
frames until they find a generator boundary: a node runtime of type `"primary"`
or `"worker"`. Since the synthetic root is not in the frame tree, code has to
pretend it is an ancestor when no concrete boundary exists.

## Target Model

`createRoot(children)` should return a normal `Instance`:

```ts
export const ROOT_INSTANCE_ID = "root";

createRoot(children) === {
  id: ROOT_INSTANCE_ID,
  node: rootNode,
  children,
}
```

The root node should be a normal primary runtime:

```ts
const rootNode = createNode({
  key: "root",
  name: "Root",
  runtime: {
    type: "primary",
    trigger: { type: "actor-frame" },
  },
  projection: { mode: "hidden" },
});
```

The root runtime id should be derived through the normal runtime address encoder:

```ts
encodeRuntimeAddress({ type: "instance", instanceId: ROOT_INSTANCE_ID })
// "instance:root"
```

`SYNTHETIC_ROOT_RUNTIME_ID = "synthetic-root"` should be removed.

## Required Invariants

- `"root"` is not globally magical.
- The only special thing about `"root"` is that `createRoot` chooses it for the
  returned root instance.
- A machine tree should not contain duplicate instance ids. This is a general
  invariant, not a special rule for `"root"`.
- `createRoot([{ id: "root", ... }])` should fail because it creates duplicate
  instance ids.
- Passing `{ id: "root", node }` directly without `createRoot` should work like
  any other direct root instance.
- Passing `{ id: "custom", node }` directly without `createRoot` should also
  work.
- Runtime ancestry should be purely structural: walk parent frames until a
  `"primary"` or `"worker"` runtime boundary is found.

## Implementation Plan

### 1. Introduce Root Constants

Add constants in the core package:

```ts
export const ROOT_INSTANCE_ID = "root";
export const ROOT_RUNTIME_INSTANCE_ID = encodeRuntimeAddress({
  type: "instance",
  instanceId: ROOT_INSTANCE_ID,
});
```

Prefer deriving `ROOT_RUNTIME_INSTANCE_ID` from `encodeRuntimeAddress` if import
cycles allow it. Otherwise, keep the literal value close to the encoder tests.

### 2. Change `createRoot`

Update `packages/projector/src/frames.ts` so `createRoot` returns an `Instance`,
not `SyntheticRoot`.

Before:

```ts
export type SyntheticRoot = {
  type: "synthetic-root";
  instances: Instance[];
};

export function createRoot(instances: Instance[]): SyntheticRoot {
  return { type: "synthetic-root", instances };
}
```

After:

```ts
export function createRoot(instances: Instance[]): Instance {
  return {
    id: ROOT_INSTANCE_ID,
    node: rootNode,
    children: instances,
  };
}
```

The actual root node factory should live in core, not in demo-specific code.

### 3. Remove `SyntheticRoot`

Delete or collapse the `SyntheticRoot` type. Public APIs should generally accept
`Instance`.

Where helper ergonomics are useful, APIs can still accept `Instance[]`, but they
should immediately normalize with `createRoot(instances)` and continue with a
single `Instance`.

Candidate APIs:

- `compileProjection`
- `inspectCompiledProjectionTree`
- `resolveStates`
- `traversalFrames`
- `collectProjectionFrames`
- `findFrameByRuntimeId`
- `createMachine`

### 4. Make Traversal Purely Instance-Based

`traversalFrames(root)` should start with the passed instance and then traverse
members and children in pre-order.

Expected traversal for `createRoot([a, b])`:

```txt
root
a
...
b
...
```

Every child frame should have a normal `parent` link. This is the main payoff:
the root is now part of the ancestry graph.

### 5. Simplify Runtime Scheduling

Remove synthetic-root special cases from `packages/projector/src/machine.ts`.

Delete or rewrite:

- synthetic activation candidate injection
- `runSyntheticRootActivation`
- `generatorForRuntime` branch for `SYNTHETIC_ROOT_RUNTIME_ID`
- top-level primary child skip under synthetic root
- `nearestAncestorRuntimeId` synthetic fallback
- synthetic runtime type handling in `foldWork`
- `serialRuntimeIdFromGeneratorId` synthetic branch

After the change, these should all fall out of normal frame/runtime logic:

- root activation is just activation of `instance:root`
- root generator kind is read from the root node runtime
- root completion uses normal primary completion behavior
- workers under component branches find `instance:root` by walking ancestors
- workers under a concrete primary find that primary before reaching root

### 6. Simplify Projection and History Compilation

Remove synthetic-root branches from `packages/projector/src/compile.ts`.

Delete or rewrite:

- local `SYNTHETIC_ROOT_RUNTIME_ID`
- `historyProjectionContext` special case for synthetic root
- `syntheticRootRuntime`
- custom root flattening based on `isSyntheticRoot`
- inspection logic that omits the synthetic root from projection trees

The root should compile as a normal `CompiledProjectionNode` with:

- `runtimeInstanceId: "instance:root"`
- `kind: "primary"`
- `nodeKey: "root"`
- normal runtime metadata
- normal child projection nodes

### 7. Update Client Snapshots

`realizeClientInstances` currently wraps inputs in `createRoot`, then returns
`root.instances`. With a real root instance, this needs a deliberate API choice.

Recommended behavior:

- `realizeClientInstances(instance)` returns the realized passed instance.
- `realizeClientInstances([a, b])` returns the realized `createRoot([a, b])`, or
  a clearly named root-aware shape.

For the demo tree UI, the client snapshot should include the actual root node so
the instance tab does not need a display-only synthetic row.

This may require renaming or replacing `instances` in `MachineClientSnapshot`.
Options:

1. Keep `instances` but make it contain the root instance for root-aware
   snapshots.
2. Rename to `root` in a breaking change.

Given the repo is early and has no production usage, prefer the clearer breaking
change if it reduces ambiguity.

### 8. Update Runtime Sync and Executors

Replace every use of `SYNTHETIC_ROOT_RUNTIME_ID` with normal root runtime
addressing.

LiveKit-specific paths should use `ROOT_RUNTIME_INSTANCE_ID` or accept a
configured realtime runtime id.

Recommended:

```ts
new LiveKitExecutor({
  realtimeRuntimeInstanceId: ROOT_RUNTIME_INSTANCE_ID,
  ...
});
```

Default it to `ROOT_RUNTIME_INSTANCE_ID`.

### 9. Update Demo App

The durable demo instance should become a root tree.

Recommended model:

```ts
const demoBase = {
  id: `demo-${crypto.randomUUID()}`,
  node: demoBaseNode,
};

const root = createRoot([demoBase]);
```

Then:

- machines receive `root` directly
- serialization persists the root tree
- `demoBase` is a child of root
- the tree instance tab naturally shows root
- the projection tab naturally shows root
- observability no longer unshifts a fake synthetic root target

The demo node should stay named `demoBase`, not `demoRoot`.

### 10. Add Duplicate Instance Id Validation

Add generic validation that a machine tree has unique instance ids.

Recommended enforcement points:

- `createMachine`
- frame folding after spawn/attach/remove/transition
- possibly `createRoot` for immediate child collisions

This should be a general rule:

```txt
Duplicate instance id "root"
```

not:

```txt
Cannot use reserved root id
```

The root id is not reserved globally. It only collides when it appears twice in
the same tree.

## State Semantics Decision

This is the main design decision to make before implementation.

Today, with a synthetic root, top-level child instances behave like independent
tops for `scope: "top"` state. With a real root instance, `scope: "top"` under
children will naturally target the new root instance.

That means sibling children with the same state key may collide at the root.

Recommendation: accept the simpler real-root rule.

Reasons:

- It makes `createRoot` actually mean "create a root".
- It removes hidden top-instance semantics.
- It makes state ownership align with traversal ownership.
- Applications that need per-child state can use `scope: "local"` or unique
  state keys.

This is a breaking semantic change, but the repo explicitly prefers aggressive
refactors over compatibility.

## Test Plan

### Traversal

- `traversalFrames(createRoot([a, b]))` includes `root` first.
- Children of `root` have `parent.runtimeInstanceId === "instance:root"`.
- Direct roots without `createRoot` still traverse from the passed instance.

### Runtime Scheduling

- A user frame activates `instance:root`.
- No frame uses `"synthetic-root"`.
- A worker under a component child triggers after `instance:root` completion.
- A worker under a concrete primary child triggers after that primary's
  completion, not after root completion.
- Parallel/serial generator ids still derive from normal runtime ids.

### Projection

- `inspectCompiledProjectionTree(createRoot([demoBase]))` includes a root node.
- `compileProjection` targeting `instance:root` works through normal runtime
  boundary logic.
- Root history projection is normal primary history projection.
- There is no synthetic-root history branch.

### Client

- Client snapshot includes the actual root instance.
- Instance tree and projection tree require no fake synthetic-root wrapper rows.
- Commands/tools bound at root use normal `target` addresses.

### Serialization

- Root instance serializes and hydrates like any other instance.
- `createRoot` output can be persisted if the app chooses to persist the root
  tree.

### Duplicate Ids

- `createRoot([{ id: "root", ... }])` fails because of duplicate ids.
- Direct `{ id: "root", node }` without `createRoot` works.
- Direct `{ id: "custom", node }` without `createRoot` works.
- Duplicate non-root ids also fail.

### Demo

- `demoBase` appears under root in the instance tab.
- root appears in the projection tab.
- LiveKit sync targets `instance:root`.
- Text mode and voice mode use the same root runtime id.
- Memory worker still runs after parent completion.

## Migration Order

1. Add root constants and root node factory.
2. Change `createRoot` return type.
3. Update traversal/state helpers to use plain `Instance`.
4. Update machine scheduling and remove synthetic runtime branches.
5. Update projection/history compilation and inspection.
6. Update client snapshot shape.
7. Update LiveKit executor and demo agent.
8. Update demo UI and observability.
9. Add duplicate id validation.
10. Run core implementation tests, conformance tests, demo typecheck, and
    demo-agent build.

## Expected Outcome

The framework no longer needs to know about a synthetic root. Root behavior comes
from normal instance traversal, normal parent links, normal runtime boundaries,
and normal runtime addresses.

The id `"root"` remains an ordinary instance id outside of `createRoot`. The
framework should not contain rules that special-case arbitrary user instances
with that id.
