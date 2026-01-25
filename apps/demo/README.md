# demo

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.6. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Time Travel & Branching

The demo app supports time travel through the HistoryTab:

- **Steps view**: Preview the machine state at any step (client-side, ephemeral)
- **Turns view**: Travel to any turn, changing the session's current position

### How Branching Works

Branching is implicit via the turn tree structure:
- Each turn has a `parentId` linking to its predecessor
- Sending a message while time-traveled back creates a new branch
- Messages are filtered by turn ancestry (only messages in the current branch are shown)

### Current Limitations

> **TODO**: The current implementation is functional but has room for improvement:
> - No explicit branch visualization or naming
> - No branch merging capability
> - Ancestry queries walk the tree on each request
> - Consider denormalizing the turn path for efficiency at scale

See `convex/messages.ts` for implementation details.
