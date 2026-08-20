# Projector Site

Install dependencies from the monorepo root:

```sh
bun install
```

Create `apps/site/.env.local` from `.env.local.example`, then start Convex:

```sh
cd apps/site
npx convex dev
```

Set the model key in the Convex deployment environment, not in Vite:

```sh
npx convex env set OPENAI_API_KEY <key>
```

Run the site in a second terminal:

```sh
cd apps/site
bun run dev
```

GitHub sign-in and the anonymous inference boundary require one-time deployment
configuration. See [AUTH.md](./AUTH.md).
