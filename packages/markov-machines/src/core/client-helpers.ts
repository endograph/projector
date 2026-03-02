import type { DisplayInstance } from "../types/display";
import type { CommandHandle } from "../types/contract";

/**
 * Get the active leaf instance (deepest non-worker child).
 */
function getActiveDisplayInstance(instance: DisplayInstance): DisplayInstance {
  if (!instance.children || instance.children.length === 0) return instance;
  const lastChild = instance.children[instance.children.length - 1];
  if (!lastChild) return instance;
  return getActiveDisplayInstance(lastChild);
}

/**
 * Find a command on the current active instance by its handle.
 * Returns the handle if the command is available, undefined if not.
 *
 * Checks both node commands and pack commands. Pack commands are checked
 * on the root instance (where full pack data with commands is stored).
 *
 * @example
 * ```ts
 * const cmd = findCommand(displayInstance, contract.commands.agentControls.setVoiceEnabled);
 * if (cmd) {
 *   liveClient.executeCommand(cmd.name, { enabled: true });
 * }
 * ```
 */
export function findCommand(
  instance: DisplayInstance,
  handle: CommandHandle,
): CommandHandle | undefined {
  const active = getActiveDisplayInstance(instance);

  // Check node commands
  if (handle.name in (active.node.commands ?? {})) {
    return handle;
  }

  // Check pack commands on root instance (that's where full pack data is stored)
  if (instance.packs) {
    for (const pack of instance.packs) {
      if (handle.name in (pack.commands ?? {})) {
        return handle;
      }
    }
  }

  return undefined;
}
