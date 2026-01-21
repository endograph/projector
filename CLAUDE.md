# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

**Always use `bun` - never use npm, yarn, or pnpm.**

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run <script>     # Run package.json scripts
bun run --filter <package> <script>  # Run script in specific package
```

## Architecture

This is a Bun-based monorepo using workspaces.

```
packages/
  markov-machines/   # Framework package
  todo/              # Reference implementation
```

- `packages/markov-machines` - Core framework
- `packages/todo` - Example implementation demonstrating framework usage
