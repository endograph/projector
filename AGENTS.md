# AGENTS.md

Guidelines for AI agents working in this repository.

## Package Manager

**Always use `bun` - never use npm, yarn, or pnpm.**

## Commands

- `bun install` - Install dependencies
- `bun run typecheck` - Typecheck (uses tsgo)
- `bun test --filter markov-machines` - Run all tests in markov-machines
- `bun test --filter markov-machines -- src/__tests__/commands.test.ts` - Run single test file
- `bun add <package>` / `bun add -d <package>` - Add dependencies

## Monorepo Structure

Bun workspace monorepo with `packages/` and `apps/`:

- `packages/markov-machines` - Core agent framework (vitest for tests)
- `packages/voice` - Voice package
- `apps/todo`, `apps/demo` - Example applications

## Framework: markov-machines

`packages/markov-machines` is a stateful agent framework with a tree of node instances.

- Charter = static registry (executor, nodes, transitions, tools, packs); no runtime state.
- Node = instructions + tools + transitions + Zod state validator + optional initialState.
- Instance = runtime node + state + optional child (or children); active instance is last child.
- Machine = charter + root instance + conversation history; run with `runMachine` or `runMachineToCompletion`.
- Transitions: `transition` swaps nodes, `spawn` adds children, `cede` removes the current child and returns control to parent.
- Packs: shared state/tools stored on the root instance and visible to nodes that include the pack.
- Serialization: use `serializeMachine`/`deserializeMachine`; code transitions and inline nodes must be registered in the charter for ref-based serialization.
