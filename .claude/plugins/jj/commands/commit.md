---
allowed-tools: Bash(jj:*)
description: Create a jj commit with a descriptive message
argument-hint: [message]
---

Create a jj commit:

1. Run `jj diff` to see changes
2. Run `jj log -r @ -T builtin_log_oneline` for context
3. Draft a descriptive commit message (or use provided message: $ARGUMENTS)
4. Run `jj commit -m "<message>"`
