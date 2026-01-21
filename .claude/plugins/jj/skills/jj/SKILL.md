---
allowed-tools: Bash(jj:*)
description: General jj (Jujutsu) guidance and help
argument-hint: [question]
---

# Jujutsu (jj) Quick Reference

Use `jj` instead of `git` for all version control operations.

## Key Concepts

- **No staging area** - Files are automatically tracked. Just edit and commit.
- **`@`** = working copy (current change)
- **`@-`** = parent of working copy
- **Changes auto-amend** - Editing files updates the current change automatically
- **`jj new`** = Start a new empty change (like starting fresh work)
- **`jj commit`** = Finalize current change with a message and start a new one

## Essential Commands

| Task                     | Command                         |
| ------------------------ | ------------------------------- |
| Set commit message       | `jj describe -m "message"`      |
| Finalize and continue    | `jj commit -m "message"`        |
| Start new change         | `jj new` or `jj new main`       |
| Amend into parent        | `jj squash`                     |
| Interactive amend        | `jj squash -i`                  |
| View status              | `jj st`                         |
| View log                 | `jj log`                        |
| View diff                | `jj diff`                       |
| Push to remote           | `jj git push --bookmark <name>` |
| Undo last operation      | `jj undo`                       |
| Rebase onto destination  | `jj rebase -d <dest>`           |
| Abandon change           | `jj abandon`                    |

## Common Revsets

- `@` - Working copy
- `@-` - Parent of working copy
- `@--` - Grandparent
- `main` - The main bookmark
- `main..@` - Commits between main and working copy
- `::@` - All ancestors of working copy
- `@::` - All descendants of working copy

## Git Command Translations

| Git                          | jj                              |
| ---------------------------- | ------------------------------- |
| `git status`                 | `jj st`                         |
| `git diff HEAD`              | `jj diff`                       |
| `git commit -a`              | `jj commit`                     |
| `git commit --amend -a`      | `jj squash`                     |
| `git log --oneline --graph`  | `jj log`                        |
| `git stash`                  | `jj new @-` (old change stays)  |
| `git checkout -b topic main` | `jj new main`                   |
| `git rebase B A`             | `jj rebase -b A -d B`           |
| `git reset --hard`           | `jj abandon` or `jj restore`    |
| `git branch`                 | `jj bookmark list`              |
| `git branch <name>`          | `jj bookmark create <name>`     |

## Request

$ARGUMENTS
