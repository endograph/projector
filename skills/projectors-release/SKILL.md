---
name: projectors-release
description: Run the Projectors repository release checklist and npm publish flow. Use when the user says "let's do a release", "cut a release", "publish projector", "bump version and npm publish", "push and release", or asks to release packages from /Users/zack/dev/machines/default.
---

# Projectors Release

## Overview

Use this skill to release publishable Projectors workspace packages. The human-facing checklist lives here; the mechanical version, git, and npm publish flow lives in `scripts/release.ts`.

## Workflow

1. Confirm the working directory is `/Users/zack/dev/machines/default` unless the user explicitly targeted another repo.
2. Inspect state before running release commands:
   - `git status --short --branch`
   - root `package.json`
   - publishable workspace `package.json` files
   - `scripts/release.ts`
3. Stop before mutation if any release blocker is present:
   - detached `HEAD` outside a jj repo
   - current branch is not `main`
   - dirty Git worktree after jj attach/prep
   - release `HEAD` does not contain `origin/main`
   - npm auth cannot be established
4. If this is a jj repo, let `scripts/release.ts` snapshot `@`, require `@` to descend from `main`, move the `main` bookmark to `@`, export to Git, attach Git to `main` when needed, and refresh the Git index. If `@` has conflicts or is not on top of `main`, stop and ask the user to resolve/rebase explicitly.
5. If the Git worktree remains dirty after jj attach/prep, summarize changed files and ask the user how to handle them. Do not release from that state.
6. Run checks before invoking the release script:
   - `bun run typecheck`
   - `bun --filter @projectors/core test`
   - `npm whoami`
7. Run `bun run release:dry-run`.
8. If the dry run passes, run `bun run release`.
9. When npm prompts for credentials or OTP, tell the user to enter the code in the terminal prompt, not in chat.
10. After publish, report the released version, commit hash, tag, published package names, and npm verification result.

## Release Rules

- Publish every non-private workspace package. Today this is `@projectors/core`.
- Require attached `main` before npm publish. Detached jj working copies may be attached automatically when `@` descends from `main` and has no conflicts.
- Require release `HEAD` to contain `origin/main`; local `main` may be ahead when releasing a jj stack.
- Use unified versions across publishable packages.
- Use tags named `v<version>`.
- Let `npm login` and `npm publish` inherit the terminal so OTP stays interactive.
- Never ask the user to paste OTP into chat.
- Never run destructive git commands as part of release recovery.

## Script

Use `scripts/release.ts` as the source of truth for release mechanics.

Supported interface:

```bash
bun run scripts/release.ts [--dry-run] [--bump patch|minor|major|prerelease] [--preid alpha|beta|rc] [--registry URL]
```

Prefer the package scripts:

```bash
bun run release:dry-run
bun run release
```
