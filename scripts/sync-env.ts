// scripts/sync-convex-env.mjs
import fs from "node:fs";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

const envFile = ".env.local";
const allow = new Set([
    "ANTHROPIC_API_KEY",
]);

const parsed = dotenv.parse(fs.readFileSync(envFile));

for (const [key, value] of Object.entries(parsed)) {
    if (!allow.has(key)) continue;
    // Quote value safely for shell usage:
    execSync(`npx convex env set ${key} ${JSON.stringify(value)}`, { stdio: "inherit" });
}
