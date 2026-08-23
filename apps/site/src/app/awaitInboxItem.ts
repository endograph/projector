import type { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const DEFAULT_TIMEOUT_MS = 120_000;

export type InboxItemResult = { success: true } | { success: false; error: string };

/**
 * The client half of the awaitable command: an enqueue mutation returns an
 * agentInbox item id, and this waits (via a reactive subscription) for the
 * session runner to settle it. Resolves with the command's result; rejects if
 * the runner reported an error, the remote command failed, or the wait times
 * out — so `await command.run(...)` throws exactly when the durable execution
 * did not do what was asked.
 */
export async function awaitInboxItem(
  client: ConvexReactClient,
  itemId: Id<"agentInbox">,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<InboxItemResult> {
  return await new Promise<InboxItemResult>((resolve, reject) => {
    const watch = client.watchQuery(api.inbox.itemStatus, { itemId });
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (settleFn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      settleFn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("Timed out waiting for the session runner"))),
      timeoutMs,
    );

    const check = () => {
      let status;
      try {
        status = watch.localQueryResult();
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (status === undefined) return; // not loaded yet
      if (status === null) {
        finish(() => reject(new Error("Inbox item not found")));
        return;
      }
      if (status.status === "pending") return;
      if (status.status === "error") {
        finish(() => reject(new Error(status.error ?? "Command failed")));
        return;
      }
      const result = status.result as Partial<InboxItemResult> | undefined;
      if (result && result.success === false) {
        finish(() => reject(new Error(result.error ?? "Command failed")));
        return;
      }
      finish(() => resolve((result as InboxItemResult | undefined) ?? { success: true }));
    };

    unsubscribe = watch.onUpdate(check);
    check();
  });
}
