"use node";

import { openai } from "@ai-sdk/openai";
import { AiSdkExecutor, type AiSdkStreamUpdate } from "@projectors/aisdk-executor";
import {
  ROOT_GENERATOR_ID,
  actionResult,
  createMachine,
  executeCommand,
  patchState,
  runMachine,
  type ActionRequestMessage,
  type Frame,
  type FrameMessage,
  type Machine,
  type SerializedInstance,
} from "@projectors/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  GET_SURFACE_SOURCE_ACTION_NAME,
  READ_SESSION_ARTIFACTS_ACTION_NAME,
  READ_SESSION_MESSAGES_ACTION_NAME,
  REPO_BASH_ACTION_NAME,
  WRITE_APP_SURFACE_ACTION_NAME,
  hydrateSiteInstance,
  panesState,
  readCardData,
  siteCharter,
} from "../src/agent/charter";
import type { MessageActor } from "./messageActor";
import { escapeConvexJson, restoreConvexJson } from "./convexJson";
import { SITE_MODEL_ID, sitePromptExecutorConfig } from "./executorConfig";
import { isTranscriptVisible } from "../src/agent/transcript-visibility";
import { createRepoBash, type RepoBash } from "./repoBash";
import {
  MAX_RUNNER_MS,
  isStaleLeaseError,
  type InboxItemSettle,
} from "./runnerShared";

const STREAM_WRITE_INTERVAL_MS = 250;

type PendingInboxItem = {
  itemId: Id<"agentInbox">;
  kind: "message" | "command";
  payload: unknown;
  actor: MessageActor;
};

// The session's single runner. Claims the lease (or exits if a live runner
// already holds it), keeps ONE machine in memory for its whole tenure, and
// loops: drain inbox items into the machine, run the machine step by step
// persisting each frame through the generation-fenced append, then either
// release (inbox empty, atomically) or hand off (deadline). A stale-lease
// rejection anywhere means a newer runner owns the session — this one stops
// without retrying; its in-memory machine is no longer the truth.
export const runSession = internalAction({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const claim = await ctx.runMutation(internal.inbox.claim, { sessionId });
    if (!claim) return null;
    try {
      await runSessionLoop(ctx, sessionId, claim.generation);
    } catch (error) {
      if (isStaleLeaseError(error)) return null;
      // Resume durable work in a fresh action. This is a scheduled, bounded
      // retry chain rather than recursive action invocation.
      const failure = String(error).slice(0, 4_000);
      let retry: { retryScheduled: boolean; consecutiveFailures: number };
      try {
        retry = await ctx.runMutation(internal.inbox.retryAfterFailure, {
          sessionId,
          generation: claim.generation,
          error: failure,
        });
      } catch (retryError) {
        if (isStaleLeaseError(retryError)) return null;
        throw retryError;
      }
      console.error("Session runner failed", {
        sessionId,
        generation: claim.generation,
        retryScheduled: retry.retryScheduled,
        consecutiveFailures: retry.consecutiveFailures,
        error: failure,
      });
      return null;
    }
    return null;
  },
});

async function runSessionLoop(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  generation: number,
): Promise<void> {
  const deadlineAt = Date.now() + MAX_RUNNER_MS;
  const { machine, streamWriter } = await loadAgentMachine(ctx, sessionId, generation);

  // Each inbox item materializes to one frame; its settlement rides that
  // frame's fenced append.
  const settlesByFrameId = new Map<string, InboxItemSettle[]>();
  // Ids this runner has already folded into its machine but not yet settled —
  // takePending re-returns them until the settling append commits.
  const materialized = new Set<string>();

  const materializePending = async (kinds: ReadonlySet<PendingInboxItem["kind"]>) => {
    const items: PendingInboxItem[] = await ctx.runMutation(internal.inbox.takePending, {
      sessionId,
      generation,
    });
    for (const item of items) {
      if (!kinds.has(item.kind) || materialized.has(item.itemId)) continue;
      materialized.add(item.itemId);
      await materializeInboxItem(ctx, { machine, sessionId, generation, item, settlesByFrameId });
    }
  };

  const ALL_KINDS = new Set<PendingInboxItem["kind"]>(["message", "command"]);
  // Mid-drain, only frame-enqueue materializations are safe: executeCommand
  // opens a frame capture, and an in-flight activation step completing during
  // it would be merged into the command's frame. Commands therefore wait for
  // the drain boundary; messages fold in at every step so the
  // machine's delivery rules (immediate vs queued visibility) decide what the
  // in-flight turn sees.
  const STEP_SAFE_KINDS = new Set<PendingInboxItem["kind"]>(["message"]);

  while (true) {
    await materializePending(ALL_KINDS);

    const reachedDeadline = await drainAndPersist(ctx, {
      machine,
      sessionId,
      generation,
      settlesByFrameId,
      streamWriter,
      onStepBoundary: () => materializePending(STEP_SAFE_KINDS),
      shouldHandoff: () => Date.now() >= deadlineAt,
    });

    if (reachedDeadline || Date.now() >= deadlineAt) {
      await ctx.runMutation(internal.inbox.handoff, { sessionId, generation });
      return;
    }
    const { released } = await ctx.runMutation(internal.inbox.releaseIfIdle, {
      sessionId,
      generation,
    });
    if (released) return;
  }
}

/**
 * Folds one inbox item into the live machine. The frames an item produces are
 * observed via machine.subscribe; the item's settle (with the command's result
 * for the client's awaitable promise) is keyed to its last produced frame and
 * committed by that frame's append. Items that produce no frames, or whose
 * materialization throws, settle through a standalone fenced mutation.
 */
async function materializeInboxItem(
  ctx: ActionCtx,
  {
    machine,
    sessionId,
    generation,
    item,
    settlesByFrameId,
  }: {
    machine: Machine;
    sessionId: Id<"sessions">;
    generation: number;
    item: PendingInboxItem;
    settlesByFrameId: Map<string, InboxItemSettle[]>;
  },
): Promise<void> {
  const produced: Frame[] = [];
  const unsubscribe = machine.subscribe((frame) => produced.push(frame));
  let result: unknown;
  try {
    const payload = restoreConvexJson(item.payload) as Record<string, unknown>;
    if (item.kind === "message") {
      machine.enqueueFrame({
        messages: [
          {
            type: "user",
            text: String(payload.text ?? ""),
            actor: item.actor,
            clientMessageId: payload.clientMessageId,
            messageId: payload.messageId,
          } as FrameMessage,
        ],
      });
    } else {
      const commandResult = await executeCommand(
        machine,
        payload as ActionRequestMessage & { action: "command" },
      );
      // Command-emitted user stimuli (e.g. appPanePing) carry the caller.
      for (const frame of produced) {
        for (const message of frame.messages) {
          if (message.type === "user" && !message.actor) message.actor = item.actor;
        }
      }
      result = commandResult.success
        ? { success: true }
        : { success: false, error: commandResult.error };
    }
  } catch (error) {
    unsubscribe();
    await ctx.runMutation(internal.inbox.settleItems, {
      sessionId,
      generation,
      items: [{ itemId: item.itemId, error: String(error) }],
    });
    return;
  }
  unsubscribe();

  const settle: InboxItemSettle = {
    itemId: item.itemId,
    ...(result !== undefined ? { result } : {}),
  };
  const lastFrame = produced.at(-1);
  if (!lastFrame) {
    await ctx.runMutation(internal.inbox.settleItems, {
      sessionId,
      generation,
      items: [settle],
    });
    return;
  }
  const settles = settlesByFrameId.get(lastFrame.id) ?? [];
  settles.push(settle);
  settlesByFrameId.set(lastFrame.id, settles);
}

async function drainAndPersist(
  ctx: ActionCtx,
  {
    machine,
    sessionId,
    generation,
    settlesByFrameId,
    streamWriter,
    onStepBoundary,
    shouldHandoff,
  }: {
    machine: Machine;
    sessionId: Id<"sessions">;
    generation: number;
    settlesByFrameId: Map<string, InboxItemSettle[]>;
    streamWriter: StreamWriter;
    onStepBoundary: () => Promise<void>;
    shouldHandoff: () => boolean;
  },
): Promise<boolean> {
  let surfaceUpdated = false;
  let reachedDeadline = false;
  let lastAssistant:
    | { frame: Frame; frameId: Id<"frames">; message: FrameMessage; messageIndex: number }
    | null = null;

  try {
    for await (const frame of runMachine(machine)) {
      const settleItems = settlesByFrameId.get(frame.id);
      settlesByFrameId.delete(frame.id);
      const frameId: Id<"frames"> = await ctx.runMutation(internal.sessions.appendRunnerFrame, {
        sessionId,
        generation,
        frame: escapeConvexJson(frame),
        ...(settleItems ? { settleItems: escapeConvexJson(settleItems) } : {}),
      });

      for (const message of frame.messages) {
        if (message.type === "action" && message.name === "writeAppSurface") {
          if (message.kind === "result" && message.success) surfaceUpdated = true;
        }
      }
      for (const [messageIndex, message] of frame.messages.entries()) {
        const text = typeof message.text === "string" ? message.text : "";
        if (
          message.type === "assistant" &&
          shouldPersistAssistantMessage(frame, message) &&
          text.trim()
        ) {
          lastAssistant = { frame, frameId, message, messageIndex };
        }
      }

      await persistFrameMessages(ctx, { sessionId, frame, frameId });

      // Stop only after the yielded frame and its transcript writes are
      // durable. The successor reconstructs any remaining work from the log.
      if (shouldHandoff()) {
        reachedDeadline = true;
        break;
      }

      // Step boundary: fold newly enqueued messages into the live machine so
      // this same drain picks them up (renews the lease as a side effect).
      await onStepBoundary();
    }
  } finally {
    // The executor reports stream failures out-of-band too. Always drain its
    // final delta or terminal marker, even when model/tool execution throws.
    await streamWriter.flush();
  }

  // A successful writeAppSurface anywhere in the drain stamps its last
  // assistant message, so the transcript can offer "open the app pane" at the
  // end of the response. Idempotent re-add: same key, patched row.
  if (surfaceUpdated && lastAssistant) {
    const text = typeof lastAssistant.message.text === "string" ? lastAssistant.message.text : "";
    const card = readCardData(lastAssistant.message);
    await ctx.runMutation(internal.messages.add, {
      sessionId,
      role: "assistant",
      content: text,
      frameId: lastAssistant.frameId,
      ...(card ? { card: { title: card.title, source: card.source } } : {}),
      idempotencyKey: frameMessageKey(
        "assistant",
        lastAssistant.frame,
        lastAssistant.message,
        lastAssistant.messageIndex,
      ),
      updatedSurface: true,
      streamState: "complete",
    });
  }
  return reachedDeadline;
}

async function loadAgentMachine(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  generation: number,
) {
  const session = await ctx.runQuery(internal.sessions.getForAction, { sessionId });
  if (!session) {
    throw new Error("Session not found");
  }

  // Both payloads cross Convex return boundaries escaped (spawned children
  // put JSON Schema $-keys inside serialized instances and spawn frames).
  const instance = hydrateSiteInstance(
    restoreConvexJson(session.instance) as SerializedInstance,
    sessionId,
  );
  const contextFrames = restoreConvexJson(
    await ctx.runQuery(internal.sessions.listMachineContextFrames, { sessionId }),
  ) as Frame[];
  const streamWriter = createStreamWriter(ctx, sessionId, generation);
  const machine = createMachine({
    id: sessionId,
    instance,
    charter: siteCharter,
    executor: createExecutor(ctx, sessionId, generation, streamWriter),
    frames: contextFrames,
  });
  return { machine, streamWriter };
}

function createExecutor(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  generation: number,
  streamWriter: StreamWriter,
) {
  let repoBash: RepoBash | undefined;
  return new AiSdkExecutor({
    ...sitePromptExecutorConfig(openai(SITE_MODEL_ID)),
    stream: true,
    runAction: async ({ action, input, context, aiSdkContext }) => {
      if (action.name === WRITE_APP_SURFACE_ACTION_NAME) {
        const title = readStringField(input, "title");
        const source = readStringField(input, "source");
        const callId = readStringField(aiSdkContext, "toolCallId");
        if (!title || !source) throw new Error("writeAppSurface requires title and source");
        if (!callId) throw new Error("writeAppSurface requires a stable tool call id");
        const written: { version: number } = await ctx.runMutation(
          internal.artifacts.writeSurface,
          { sessionId, generation, callId, title, source },
        );
        context.updateState?.(
          patchState({ version: written.version, title, lastError: null }),
        );
        if (readBooleanField(input, "requestOpenPane") !== false) {
          context.updateStateAt?.(panesState, patchState({ app: true }));
        }
        return actionResult({ value: `surface v${written.version} written` });
      }
      // The surface's TSX lives in the artifacts table, not machine state, so
      // retrieval is an executor concern: read the latest artifact here.
      if (action.name === GET_SURFACE_SOURCE_ACTION_NAME) {
        const surface: { version: number; title: string; source: string } | null =
          await ctx.runQuery(internal.artifacts.activeSurfaceSource, { sessionId });
        return actionResult({
          value: surface
            ? `app surface v${surface.version} "${surface.title}":\n\n${surface.source}`
            : "no app surface has been written yet",
        });
      }
      if (action.name === READ_SESSION_MESSAGES_ACTION_NAME) {
        const targetSessionId = requireSessionId(input);
        const result = await ctx.runQuery(internal.messages.pageForAgent, {
          sessionId: targetSessionId,
          paginationOpts: {
            numItems: 10,
            cursor: readStringField(input, "cursor") ?? null,
          },
        });
        return actionResult({ value: JSON.stringify(result) });
      }
      if (action.name === READ_SESSION_ARTIFACTS_ACTION_NAME) {
        const targetSessionId = requireSessionId(input);
        const result = await ctx.runQuery(internal.artifacts.pageForAgent, {
          sessionId: targetSessionId,
          paginationOpts: {
            numItems: 10,
            cursor: readStringField(input, "cursor") ?? null,
          },
        });
        return actionResult({ value: JSON.stringify(result) });
      }
      if (action.name === REPO_BASH_ACTION_NAME) {
        repoBash ??= createRepoBash();
        const command = readStringField(input, "command")?.trim();
        if (!command) throw new Error("bash command is required");
        return actionResult({ value: await repoBash.exec(command) });
      }
      return await action.run?.(input as never, context as never);
    },
    onStreamUpdate: (update) => {
      streamWriter.push(update);
    },
  });
}

type StreamWriter = {
  push: (update: AiSdkStreamUpdate) => void;
  flush: () => Promise<void>;
};

function createStreamWriter(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  generation: number,
): StreamWriter {
  // Keep only the latest pending snapshot for each assistant block and cap
  // durable updates at a still-smooth 4 fps. Each successful write appends
  // only the text since the prior write; coalesced provider chunks therefore
  // become one small immutable delta rather than a cumulative message rewrite.
  const pending = new Map<string, AiSdkStreamUpdate>();
  const persistedText = new Map<string, string>();
  const terminals = new Map<string, "cancelled" | "error">();
  const failed = new Set<string>();
  let lastWriteAt = 0;
  // One serialization mechanism: every push chains a drain onto this tail.
  // drainAll never rejects (both mutation calls are individually guarded),
  // so the chain cannot wedge on an earlier failure.
  let tail: Promise<void> = Promise.resolve();

  const drainAll = async (): Promise<void> => {
    while (pending.size > 0 || terminals.size > 0) {
      const next = pending.entries().next().value as
        | [string, AiSdkStreamUpdate]
        | undefined;
      if (next) {
        const [messageId, update] = next;
        pending.delete(messageId);
        if (!failed.has(messageId)) {
          const previous = persistedText.get(messageId) ?? "";
          const delta = update.text.startsWith(previous)
            ? update.text.slice(previous.length)
            : update.text;
          if (delta) {
            const waitMs = STREAM_WRITE_INTERVAL_MS - (Date.now() - lastWriteAt);
            if (waitMs > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            }
            try {
              await ctx.runMutation(internal.messages.appendStreamDelta, {
                sessionId,
                generation,
                messageKey: assistantStreamKey(messageId),
                text: delta,
                streamSeq: update.streamSeq,
              });
              persistedText.set(messageId, update.text);
              lastWriteAt = Date.now();
            } catch {
              failed.add(messageId);
              terminals.set(messageId, "error");
            }
          }
        }
        continue;
      }

      const terminal = terminals.entries().next().value as
        | [string, "cancelled" | "error"]
        | undefined;
      if (!terminal) break;
      const [messageId, state] = terminal;
      terminals.delete(messageId);
      await ctx.runMutation(internal.messages.markStreamFailed, {
        sessionId,
        generation,
        messageKey: assistantStreamKey(messageId),
        state,
      }).catch(() => {});
    }
  };

  return {
    push(update) {
      if (update.streamState === "streaming" && update.text.length > 0) {
        pending.set(update.messageId, update);
      }
      if (update.streamState === "cancelled" || update.streamState === "error") {
        terminals.set(update.messageId, update.streamState);
      }
      if (pending.size === 0 && terminals.size === 0) return;
      tail = tail.then(drainAll);
    },
    async flush() {
      // Stream callbacks are deliberately out-of-band in the executor. Let
      // the final callback enter this writer, then await the tail — looping
      // in case a straggler push lands while an earlier drain settles.
      await Promise.resolve();
      let settled: Promise<void>;
      do {
        settled = tail;
        await settled;
      } while (settled !== tail);
    },
  };
}

function requireSessionId(input: unknown): Id<"sessions"> {
  const sessionId = readStringField(input, "sessionId")?.trim();
  if (!sessionId) throw new Error("sessionId is required");
  return sessionId as Id<"sessions">;
}

async function persistFrameMessages(
  ctx: ActionCtx,
  {
    sessionId,
    frame,
    frameId,
  }: {
    sessionId: Id<"sessions">;
    frame: Frame;
    frameId: Id<"frames">;
  },
): Promise<void> {
  for (const [messageIndex, message] of frame.messages.entries()) {
    const text = typeof message.text === "string" ? message.text : "";
    if (message.type === "user" && text.trim() && isTranscriptVisible(message)) {
      const actor = readMessageActor(message);
      const clientMessageId = readStringField(message, "clientMessageId");
      await ctx.runMutation(internal.messages.add, {
        sessionId,
        role: "user",
        content: text,
        frameId,
        ...(actor ? { actor } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        idempotencyKey: frameMessageKey("user", frame, message, messageIndex),
      });
    }

    if (
      message.type === "assistant" &&
      shouldPersistAssistantMessage(frame, message) &&
      text.trim()
    ) {
      // postCard rides an assistant message as a data content part; lift it
      // onto the message row so the transcript renders the card (content
      // stays the prose equivalent, same doctrine as explainer widgets).
      const card = readCardData(message);
      await ctx.runMutation(internal.messages.add, {
        sessionId,
        role: "assistant",
        content: text,
        frameId,
        ...(card ? { card: { title: card.title, source: card.source } } : {}),
        idempotencyKey: frameMessageKey("assistant", frame, message, messageIndex),
        // The durable write settles any in-flight stream row for this message:
        // frame messages never carry streamState, so it must be set here or a
        // streamed message stays "streaming" forever.
        streamState: "complete",
      });
    }
  }
}

function shouldPersistAssistantMessage(frame: Frame, message: FrameMessage): boolean {
  if (message.audience === "self") return false;
  return frame.generatorId === undefined || frame.generatorId === ROOT_GENERATOR_ID;
}

function frameMessageKey(
  prefix: "user" | "assistant",
  frame: Frame,
  message: FrameMessage,
  messageIndex: number,
): string {
  const messageId = readStringField(message, "messageId");
  if (messageId && prefix === "assistant") return assistantStreamKey(messageId);
  if (messageId) return `${prefix}:${messageId}`;
  return `${prefix}:${frame.id}:${messageIndex}`;
}

function assistantStreamKey(messageId: string): string {
  return `assistant:${messageId}`;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}


function readMessageActor(message: FrameMessage): MessageActor | undefined {
  const actor = message.actor;
  if (!actor || typeof actor !== "object") return undefined;
  const { id, kind, label, profileUrl } = actor as Record<string, unknown>;
  if (
    typeof id !== "string" ||
    (kind !== "anonymous" && kind !== "github") ||
    typeof label !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    label,
    ...(typeof profileUrl === "string" ? { profileUrl } : {}),
  };
}
