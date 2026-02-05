import type { Charter } from "../types/charter";
import type {
  CommandHandle,
  ContractCommandEntry,
  MachineContract,
  MachineContractConfig,
  BuildCommands,
} from "../types/contract";

/**
 * Create a machine contract that declares structural requirements.
 *
 * The returned contract provides typed command accessors and can be
 * validated against a charter with `assertMachineContract`.
 *
 * @example
 * ```ts
 * const contract = createMachineContract({
 *   commands: [
 *     ["agentControls", "setVoiceEnabled"],  // scoped to pack/node
 *     ["ping"],                               // must exist somewhere
 *   ],
 * });
 *
 * contract.commands.agentControls.setVoiceEnabled  // CommandHandle
 * contract.commands.ping                            // CommandHandle
 * ```
 */
export function createMachineContract<
  const T extends readonly ContractCommandEntry[],
>(config: MachineContractConfig<T>): MachineContract<T> {
  const commands: Record<string, CommandHandle | Record<string, CommandHandle>> = {};

  for (const entry of config.commands) {
    if (entry.length === 2) {
      const [scope, name] = entry;
      const scopeObj = (commands[scope] ??= {}) as Record<string, CommandHandle>;
      scopeObj[name] = Object.freeze({ name, scope });
    } else {
      const [name] = entry;
      commands[name] = Object.freeze({ name });
    }
  }

  return Object.freeze({
    commands: commands as BuildCommands<T>,
    _commandEntries: config.commands,
  });
}

/**
 * Assert that a charter satisfies a machine contract.
 * Throws an error listing all violations if the charter does not satisfy the contract.
 *
 * For scoped entries `[scope, name]`: verifies that a node or pack named `scope`
 * has a command named `name`.
 *
 * For unscoped entries `[name]`: verifies that at least one node or pack
 * in the charter has a command named `name`.
 */
export function assertMachineContract(
  contract: MachineContract,
  charter: Charter,
): void {
  const violations: string[] = [];

  for (const entry of contract._commandEntries) {
    if (entry.length === 2) {
      const [scope, name] = entry;
      if (!findScopedCommand(charter, scope, name)) {
        violations.push(
          `Command "${name}" not found in pack or node "${scope}"`,
        );
      }
    } else {
      const [name] = entry;
      if (!findUnscopedCommand(charter, name)) {
        violations.push(
          `Command "${name}" not found in any node or pack`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Machine contract violation:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
    );
  }
}

/**
 * Check if a scoped command exists in the charter.
 * Looks for a node or pack with the given scope name that has the command.
 */
function findScopedCommand(
  charter: Charter,
  scope: string,
  commandName: string,
): boolean {
  // Check nodes
  for (const [nodeName, node] of Object.entries(charter.nodes)) {
    if (nodeName === scope || node.name === scope) {
      if (node.commands?.[commandName]) return true;
    }
  }

  // Check packs (both charter-level and node-level)
  for (const pack of charter.packs) {
    if (pack.name === scope) {
      if (pack.commands?.[commandName]) return true;
    }
  }

  // Also check packs attached to nodes (in case not in charter.packs)
  for (const node of Object.values(charter.nodes)) {
    for (const pack of node.packs ?? []) {
      if (pack.name === scope) {
        if (pack.commands?.[commandName]) return true;
      }
    }
  }

  return false;
}

/**
 * Check if an unscoped command exists anywhere in the charter.
 */
function findUnscopedCommand(
  charter: Charter,
  commandName: string,
): boolean {
  // Check node commands
  for (const node of Object.values(charter.nodes)) {
    if (node.commands?.[commandName]) return true;
  }

  // Check pack commands (charter-level)
  for (const pack of charter.packs) {
    if (pack.commands?.[commandName]) return true;
  }

  // Check pack commands (node-level)
  for (const node of Object.values(charter.nodes)) {
    for (const pack of node.packs ?? []) {
      if (pack.commands?.[commandName]) return true;
    }
  }

  return false;
}
