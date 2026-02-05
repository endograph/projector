/**
 * Opaque handle for referencing a command without string literals.
 * Returned by MachineContract's typed `commands` accessor.
 */
export interface CommandHandle {
  readonly name: string;
  readonly scope?: string;
}

/**
 * A contract command entry.
 * - `[scope, commandName]` — command must exist in the named pack or node.
 * - `[commandName]` — command must exist somewhere in the charter.
 */
export type ContractCommandEntry = readonly [string] | readonly [string, string];

/**
 * Build a typed commands accessor object from an array of contract entries.
 *
 * Scoped entries `[scope, name]` become nested: `{ [scope]: { [name]: CommandHandle } }`
 * Unscoped entries `[name]` become flat: `{ [name]: CommandHandle }`
 */
export type BuildCommands<T extends readonly ContractCommandEntry[]> =
  // Scoped commands grouped by scope
  {
    [S in Extract<T[number], readonly [string, string]>[0]]: {
      [N in Extract<T[number], readonly [S, string]>[1]]: CommandHandle;
    };
  } & {
    // Unscoped commands at top level
    [N in Extract<T[number], readonly [string]>[0]]: CommandHandle;
  };

/**
 * Configuration for creating a machine contract.
 */
export interface MachineContractConfig<
  T extends readonly ContractCommandEntry[],
> {
  commands: T;
}

/**
 * A machine contract declares structural requirements that a machine must satisfy.
 * Provides typed command accessors and raw entries for assertion.
 */
export interface MachineContract<
  T extends readonly ContractCommandEntry[] = readonly ContractCommandEntry[],
> {
  /** Typed command accessors — use `contract.commands.scope.name` or `contract.commands.name`. */
  readonly commands: BuildCommands<T>;
  /** Raw entries for assertion logic. */
  readonly _commandEntries: readonly ContractCommandEntry[];
}
