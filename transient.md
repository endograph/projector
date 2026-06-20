# Projector Transient Frame Proposal

## Summary

Replace the old `ephemeralMessage(...)` design with a frame-native transient context API in `@packages/projector`.

The old implementation from commit `81b25b4ea2cc61a2e27df09d4e161cd64e0098bb` modeled ephemera as messages with `role: "ephemeral"`. That fit the old queue-based runtime, but the current framework is frame-based: history, visibility, scheduling, and persistence all operate on `Frame` objects.

The updated design should introduce transient frames, not a new actor message type.

## Goals

- Represent short-lived context like camera snapshots, hover state, selected UI objects, or live sensor readings.
- Make transient context visible to prompt compilation.
- Avoid creating durable history.
- Avoid triggering runtime work by itself.
- Support keyed replacement, especially for "latest camera frame" style data.
- Keep implementation idiomatic to current `Machine`, `Frame`, and `compileProjection` APIs.

## Non-Goals

- Do not preserve backwards compatibility with old `role: "ephemeral"` messages.
- Do not add durable Convex storage for transient frames.
- Do not make transient frames appear in terminal chat history by default.
- Do not require all executors to support rich image content immediately.

## Proposed Public API

Add transient frame support to `packages/projector/src/machine.ts`.

```ts
export type TransientFramePlacement =
  | "before-latest-user"
  | "append";

export type TransientFrameOptions = {
  key?: string;
  placement?: TransientFramePlacement;
};

export type Machine<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id: string;
  root: Instance<TActorMessage>;
  charter: Charter<TActorMessage>;
  frames: Frame<TActorMessage>[];
  enqueueFrame(frame: FrameDraft<TActorMessage> | Frame<TActorMessage>): Frame<TActorMessage>;
  ingestInertFrame(frame: Frame<TActorMessage>): void;
  subscribe(listener: (frame: Frame<TActorMessage>) => void): () => void;

  setTransientFrame(
    key: string,
    frame: FrameDraft<TActorMessage> | Frame<TActorMessage> | null,
    options?: Omit<TransientFrameOptions, "key">,
  ): Frame<TActorMessage> | undefined;

  enqueueTransientFrame(
    frame: FrameDraft<TActorMessage> | Frame<TActorMessage>,
    options?: TransientFrameOptions,
  ): Frame<TActorMessage>;

  clearTransientFrames(key?: string): void;
  getTransientFrames(): Frame<TActorMessage>[];
};
```

## Internal Machine Shape

Extend the internal projector machine with:

```ts
type ProjectorMachine<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  Machine<TActorMessage> & {
    pendingFrames: Frame<TActorMessage>[];
    transientFrames: Frame<TActorMessage>[];
    transientReplacementCounts: Map<string, number>;
    nextFrameIndex: number;
    listeners: Set<(frame: Frame<TActorMessage>) => void>;
  };
```

Transient frames should receive generated ids such as:

```ts
transient-${key}-${counter}
```

or:

```ts
transient-${crypto.randomUUID()}
```

They should always include metadata:

```ts
metadata: {
  ...frame.metadata,
  transient: true,
  transientKey,
  transientPlacement,
  replacementCount,
}
```

## Semantics

### Visibility

Transient frames are visible to prompt compilation.

They should be merged into the history used by `compileProjection(...)`, but they should not be stored in `machine.frames`.

Default placement:

- keyed frames: `before-latest-user`
- unkeyed frames: `append`

`before-latest-user` should place transient context just before the most recent visible user actor message for the target generator. This mirrors the old camera behavior where the snapshot appeared immediately before the user request.

### Scheduling

Transient frames must never schedule work.

Implementation rule:

- `reconcileWorkOnce(...)` iterates only over durable `machine.frames`.
- It must not inspect `transientFrames`.
- `pendingFrames` must not include transient frames.

### Persistence

Transient frames must not be yielded by `runMachine(...)`.

Apps that persist yielded frames, such as `apps/demo/convex/sessions.ts`, should not see transient frames unless they call `getTransientFrames()` explicitly.

### Folding

Transient frames should not be folded into machine state.

Only durable `enqueueFrame(...)` and `ingestInertFrame(...)` should call the existing `foldFrameIntoMachine(...)`.

If a caller tries to create a transient frame containing instance messages, reject it:

```ts
throw new Error("Transient frames cannot contain instance messages");
```

This prevents temporary context from mutating state.

## Rich Content Types

Add optional shared content block types to `packages/projector/src/types.ts`:

```ts
export type ImageDetail = "auto" | "low" | "high";

export type TextContentBlock = {
  type: "text";
  text: string;
};

export type ImageContentBlock = {
  type: "image";
  mimeType: "image/jpeg" | "image/png" | (string & {});
  data: string;
  detail?: ImageDetail;
};

export type ActorContentBlock =
  | TextContentBlock
  | ImageContentBlock;
```

Do not force `DefaultActorMessage` to use these blocks. Instead, apps can define richer actor message types:

```ts
type DemoUserContent = string | ActorContentBlock[];
type DemoActorMessage = ActorMessage<string, DemoUserContent>;
```

## Executor Support

### `AiSdkExecutor`

`AiSdkExecutor` already supports:

```ts
messageToModelMessage?: (message: TActorMessage) => ModelMessage | undefined;
```

Use that hook for rich content. Add tests showing image content can be mapped by app-provided `messageToModelMessage`.

No mandatory default image rendering is needed in the first framework patch.

### `LiveKitExecutor`

`LiveKitExecutor` currently supports:

```ts
messageToText?: (message: TActorMessage) => string | undefined;
```

That is insufficient for images. Add a new optional hook:

```ts
messageToChatMessage?: (message: TActorMessage) => import("@livekit/agents").llm.ChatMessage | undefined;
```

Use it when building realtime chat context from visible/transient user frames.

Keep `messageToText` for instructions, history summaries, and data-channel text.

## Camera Example

Once transient frames exist, the demo camera sampler should use:

```ts
machine.setTransientFrame("camera", {
  inert: true,
  metadata: {
    kind: "camera",
  },
  messages: [
    {
      type: "user",
      content: [
        {
          type: "text",
          text: "[Camera frame] Live snapshot from the user's camera.",
        },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: base64,
          detail: "low",
        },
      ],
      text: "[Camera frame] Live snapshot from the user's camera.",
      audience: "broadcast",
    },
  ],
}, {
  placement: "before-latest-user",
});
```

The LiveKit executor config for the demo would provide:

```ts
messageToChatMessage: (message) => {
  if (message.type !== "user" || !Array.isArray(message.content)) return undefined;

  return llm.ChatMessage.create({
    role: "user",
    content: message.content.map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") {
        return llm.createImageContent({
          image: `data:${part.mimeType};base64,${part.data}`,
          inferenceDetail: part.detail ?? "auto",
          mimeType: part.mimeType,
        });
      }
      return "";
    }).filter(Boolean),
  });
};
```

## Compile Changes

Update `compileProjection(...)` so it can receive transient frames.

Add an option:

```ts
transientFrames?: Frame<TActorMessage>[];
```

Then use:

```ts
const rawHistory = mergeTransientFrames(
  options.frameHistory ?? framesFromMessages(options.history ?? [], target),
  options.transientFrames ?? [],
  target,
);
```

`syncMachineRuntime(...)` and `runActivation(...)` should pass `machine.getTransientFrames()` into `compileProjection(...)`.

## Merge Algorithm

For each transient frame:

1. Determine visibility using the same actor message visibility rules as durable frames.
2. If no actor message is visible, ignore it for that target.
3. If placement is `append`, place it at the end.
4. If placement is `before-latest-user`, insert it immediately before the latest durable visible user actor frame.
5. If no user frame exists, append it.

Keep durable frame order stable.

## Tests

Add sparse framework tests in `packages/projector/src/__tests__/projector.test.ts` or a new focused test file:

1. Keyed transient frames replace prior frames:
   - set key `camera` twice
   - compiled inference includes only the second frame
   - metadata includes `replacementCount: 2`

2. Transient frames do not schedule work:
   - add only a transient user frame
   - run machine
   - no activation frames are created

3. Transient frames are visible to inference:
   - durable user asks "what do you see?"
   - transient camera frame is placed before latest user
   - executor receives both in order

4. Transient frames are not yielded or persisted:
   - run machine after setting a transient frame
   - yielded frames exclude transient ids

5. Transient instance messages are rejected:
   - `setTransientFrame("x", { messages: [{ type: "instance", ... }] })`
   - expect a thrown error

## Migration Strategy

No backwards compatibility.

Do not support old `role: "ephemeral"` messages. This repo is pre-production and explicitly allows aggressive refactors.

## Acceptance Criteria

- Temporary context can be added to prompt history without becoming durable frame history.
- Transient context cannot mutate instance state.
- Transient context cannot schedule work by itself.
- Keyed replacement works for camera snapshots.
- Executors can opt into rich content rendering without changing the default actor message type.

## Open Follow-Up

After this lands, refactor the demo camera sampler to stop writing directly into LiveKit realtime `chatCtx` and instead use `machine.setTransientFrame("camera", ...)` plus `LiveKitExecutor.messageToChatMessage`.
