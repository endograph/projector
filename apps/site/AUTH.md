# Authentication and anonymous inference

Projector allows one model-backed turn before requiring GitHub sign-in. Prebuilt
topic explainers do not consume the turn. Conversations remain publicly
readable; only their guest browser or GitHub owner can modify them.

The initial abuse boundary is intentionally small:

- one anonymous turn per guest cookie per year;
- three anonymous turns per IP per day;
- the anonymous model call enters through the Convex HTTP endpoint, where the
  IP is available and hashed before it is used as a rate-limit key.

These controls deter casual resets; they do not identify a person reliably.

## Development setup

1. Add `VITE_CONVEX_SITE_URL` to `.env.local`. It is the HTTP Actions URL shown
   by Convex and normally ends in `.convex.site`.
2. Generate the Convex Auth signing keys and set the frontend origin:

   ```sh
   npx @convex-dev/auth --web-server-url http://localhost:5199
   ```

3. Create a GitHub OAuth App. Use the local site URL as its homepage and this
   callback URL, substituting the value from `VITE_CONVEX_SITE_URL`:

   ```text
   https://<deployment>.convex.site/api/auth/callback/github
   ```

4. Set the GitHub credentials and a random IP-hashing salt on the Convex dev
   deployment:

   ```sh
   npx convex env set AUTH_GITHUB_ID <client-id>
   npx convex env set AUTH_GITHUB_SECRET <client-secret>
   npx convex env set ANONYMOUS_IP_SALT <random-secret>
   ```

Production needs its own OAuth App/callback and its own Convex Auth keys and
environment variables; dev values do not carry over. Run the corresponding
commands with `--prod`.

## Deferred hardening

Do not add these until usage warrants their cost and product tradeoffs:

- CAPTCHA or Turnstile on suspicious anonymous traffic;
- tighter model token, runtime, and tool-call budgets for the guest turn;
- per-GitHub-account quotas and account-quality signals;
- a global inference budget and emergency kill switch;
- browser fingerprinting, only after an explicit privacy review.
