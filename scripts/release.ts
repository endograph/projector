import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Bump = "patch" | "minor" | "major" | "prerelease";
type ReleaseStage =
  | "preflight"
  | "version"
  | "verify-version"
  | "commit"
  | "tag"
  | "push"
  | "publish"
  | "verify-publish";

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[];
  scripts?: Record<string, string>;
};

export type WorkspacePackage = {
  name: string;
  version: string;
  dir: string;
  packageJsonPath: string;
  packageJson: PackageJson;
};

export type ReleaseOptions = {
  dryRun: boolean;
  bump?: Bump;
  preid?: string;
  registry?: string;
  cwd: string;
};

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type RunOptions = {
  cwd?: string;
  stdio?: "inherit" | "pipe";
  allowFailure?: boolean;
};

type CommandRunner = (command: string, args: string[], options?: RunOptions) => CommandResult;
type Prompter = {
  bump: () => Promise<Bump>;
  preid: () => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
};

type ReleaseContext = {
  options: ReleaseOptions;
  runner: CommandRunner;
  stage: ReleaseStage;
  publishedPackages: string[];
  committed: boolean;
  tagged: boolean;
  pushed: boolean;
  targetVersion?: string;
};

const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const DEFAULT_PREID = "alpha";
const VALID_BUMPS = new Set<Bump>(["patch", "minor", "major", "prerelease"]);

class ReleaseError extends Error {
  constructor(message: string, readonly stage: ReleaseStage) {
    super(message);
  }
}

export function parseArgs(argv: string[], cwd = process.cwd()): ReleaseOptions {
  const options: ReleaseOptions = { dryRun: false, cwd };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      throw new Error("Missing release option.");
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--bump") {
      const value = argv[++index];
      if (!isBump(value)) {
        throw new Error(`Invalid --bump value: ${String(value)}`);
      }
      options.bump = value;
      continue;
    }
    if (arg.startsWith("--bump=")) {
      const value = arg.slice("--bump=".length);
      if (!isBump(value)) {
        throw new Error(`Invalid --bump value: ${value}`);
      }
      options.bump = value;
      continue;
    }
    if (arg === "--preid") {
      options.preid = requireValue(argv[++index], "--preid");
      continue;
    }
    if (arg.startsWith("--preid=")) {
      options.preid = arg.slice("--preid=".length);
      continue;
    }
    if (arg === "--registry") {
      options.registry = requireValue(argv[++index], "--registry");
      continue;
    }
    if (arg.startsWith("--registry=")) {
      options.registry = arg.slice("--registry=".length);
      continue;
    }
    throw new Error(`Unknown release option: ${arg}`);
  }

  return options;
}

export function discoverPublishablePackages(rootDir: string): WorkspacePackage[] {
  const rootPackage = readJson<PackageJson>(join(rootDir, "package.json"));
  const workspacePatterns = rootPackage.workspaces ?? [];
  const packages = workspacePatterns.flatMap((pattern) => resolveWorkspacePattern(rootDir, pattern));

  return packages
    .map((dir) => {
      const packageJsonPath = join(dir, "package.json");
      if (!existsSync(packageJsonPath)) {
        return undefined;
      }
      const packageJson = readJson<PackageJson>(packageJsonPath);
      if (!packageJson.name || !packageJson.version || packageJson.private === true) {
        return undefined;
      }
      return {
        name: packageJson.name,
        version: packageJson.version,
        dir,
        packageJsonPath,
        packageJson,
      };
    })
    .filter((pkg): pkg is WorkspacePackage => Boolean(pkg))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function bumpVersion(version: string, bump: Bump, preid = DEFAULT_PREID): string {
  const semver = parseSemver(version);
  if (bump === "major") {
    return `${semver.major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${semver.major}.${semver.minor + 1}.0`;
  }
  if (bump === "patch") {
    return `${semver.major}.${semver.minor}.${semver.patch + 1}`;
  }

  if (semver.prerelease?.id === preid && semver.prerelease.number !== undefined) {
    return `${semver.major}.${semver.minor}.${semver.patch}-${preid}.${semver.prerelease.number + 1}`;
  }
  return `${semver.major}.${semver.minor}.${semver.patch + 1}-${preid}.0`;
}

export function highestVersion(versions: string[]): string {
  if (versions.length === 0) {
    throw new Error("Cannot compute highest version from an empty list.");
  }
  return versions.reduce((highest, version) => (compareSemver(version, highest) > 0 ? version : highest));
}

export async function runRelease(
  options: ReleaseOptions,
  runner: CommandRunner = runCommand,
  prompter: Prompter = interactivePrompter,
): Promise<void> {
  const context: ReleaseContext = {
    options,
    runner,
    stage: "preflight",
    publishedPackages: [],
    committed: false,
    tagged: false,
    pushed: false,
  };

  try {
    await runReleaseInner(context, prompter);
  } catch (error) {
    reportFailure(context, error);
    throw error;
  }
}

async function runReleaseInner(context: ReleaseContext, prompter: Prompter): Promise<void> {
  const { options, runner } = context;
  const packages = discoverPublishablePackages(options.cwd);
  if (packages.length === 0) {
    fail(context, "No publishable workspace packages found.");
  }

  checkedRun(context, "git", ["fetch", DEFAULT_REMOTE, DEFAULT_BRANCH, "--tags"], { cwd: options.cwd });

  const branch = prepareReleaseCheckout(context);
  const containsRemoteMain = runner("git", ["merge-base", "--is-ancestor", `${DEFAULT_REMOTE}/${DEFAULT_BRANCH}`, "HEAD"], {
    cwd: options.cwd,
    allowFailure: true,
  });
  if (containsRemoteMain.status !== 0) {
    fail(context, `Release HEAD must contain ${DEFAULT_REMOTE}/${DEFAULT_BRANCH} before release.`);
  }

  const status = capture(runner, "git", ["status", "--porcelain"], { cwd: options.cwd }).trim();
  if (status.length > 0) {
    fail(context, "Worktree must be clean before release.");
  }

  const npmVersions = new Map<string, string>();
  for (const pkg of packages) {
    npmVersions.set(pkg.name, getNpmVersion(runner, pkg.name, options));
  }

  const bump = options.bump ?? (await prompter.bump());
  const preid = bump === "prerelease" ? options.preid ?? (await prompter.preid()) : options.preid;
  const baseVersion = highestVersion([...packages.map((pkg) => pkg.version), ...npmVersions.values()]);
  const targetVersion = bumpVersion(baseVersion, bump, preid);
  context.targetVersion = targetVersion;
  const tag = `v${targetVersion}`;

  ensureTagDoesNotExist(context, tag);
  printSummary(packages, npmVersions, bump, preid, targetVersion, branch, tag, options);

  if (!(await prompter.confirm("Continue with this release?"))) {
    fail(context, "Release cancelled before mutation.");
  }

  runVerification(context, packages);
  ensureNpmAuth(context);

  if (options.dryRun) {
    runPackDryRun(context, packages);
    console.log(`Dry run complete for ${tag}. No files, git refs, or packages were changed.`);
    return;
  }

  context.stage = "version";
  updatePackageVersions(packages, targetVersion);
  checkedRun(context, "bun", ["install", "--lockfile-only"], { cwd: options.cwd });

  context.stage = "verify-version";
  runVerification(context, packages);
  runPackDryRun(context, packages);

  context.stage = "commit";
  const filesToCommit = [...packages.map((pkg) => relative(options.cwd, pkg.packageJsonPath)), "bun.lock"];
  checkedRun(context, "git", ["add", ...filesToCommit], { cwd: options.cwd });
  checkedRun(context, "git", ["commit", "-m", `chore(release): ${tag}`], { cwd: options.cwd });
  context.committed = true;

  context.stage = "tag";
  checkedRun(context, "git", ["tag", "-a", tag, "-m", tag], { cwd: options.cwd });
  context.tagged = true;

  context.stage = "push";
  checkedRun(context, "git", ["push", DEFAULT_REMOTE, DEFAULT_BRANCH], { cwd: options.cwd });
  checkedRun(context, "git", ["push", DEFAULT_REMOTE, tag], { cwd: options.cwd });
  context.pushed = true;

  context.stage = "publish";
  for (const pkg of packages) {
    checkedRun(context, "npm", publishArgs(options), { cwd: pkg.dir, stdio: "inherit" });
    context.publishedPackages.push(pkg.name);
  }

  context.stage = "verify-publish";
  for (const pkg of packages) {
    const publishedVersion = getNpmVersion(runner, pkg.name, options);
    if (publishedVersion !== targetVersion) {
      fail(context, `${pkg.name} published version ${publishedVersion}, expected ${targetVersion}.`);
    }
  }

  const commitHash = capture(runner, "git", ["rev-parse", "HEAD"], { cwd: options.cwd }).trim();
  console.log(`Released ${tag} from ${commitHash}.`);
  console.log(`Published: ${packages.map((pkg) => pkg.name).join(", ")}`);
}

function prepareReleaseCheckout(context: ReleaseContext): string {
  const branchResult = context.runner("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: context.options.cwd,
    allowFailure: true,
  });
  const branch = branchResult.stdout.trim();

  if (branchResult.status === 0 && branch !== DEFAULT_BRANCH) {
    fail(context, `Release requires ${DEFAULT_BRANCH}; current branch is ${branch || "<unknown>"}.`);
  }

  const hasJj = hasJjRepository(context);
  if (hasJj) {
    if (branchResult.status !== 0) {
      console.log(`Detached Git checkout detected in a jj repo. Moving ${DEFAULT_BRANCH} to @ and attaching Git.`);
    } else {
      console.log(`jj repo detected. Moving ${DEFAULT_BRANCH} to @ before release checks.`);
    }
    attachJjWorkingCopyToMain(context);
  } else if (branchResult.status !== 0) {
    fail(context, `Release requires attached ${DEFAULT_BRANCH}; current checkout is detached.`);
  }

  const attached = context.runner("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: context.options.cwd,
    allowFailure: true,
  });
  const attachedBranch = attached.stdout.trim();
  if (attached.status !== 0 || attachedBranch !== DEFAULT_BRANCH) {
    fail(context, `Unable to attach Git checkout to ${DEFAULT_BRANCH}.`);
  }
  return attachedBranch;
}

function hasJjRepository(context: ReleaseContext): boolean {
  const result = context.runner("jj", ["status"], {
    cwd: context.options.cwd,
    allowFailure: true,
  });
  return result.status === 0;
}

function attachJjWorkingCopyToMain(context: ReleaseContext): void {
  ensureJjConflictFree(context);
  ensureJjWorkingCopyDescendsFromMain(context);
  checkedRun(context, "jj", ["bookmark", "move", DEFAULT_BRANCH, "--to", "@"], { cwd: context.options.cwd });
  checkedRun(context, "jj", ["git", "export"], { cwd: context.options.cwd });
  checkedRun(context, "git", ["symbolic-ref", "HEAD", `refs/heads/${DEFAULT_BRANCH}`], { cwd: context.options.cwd });
  checkedRun(context, "git", ["reset"], { cwd: context.options.cwd });
}

function ensureJjConflictFree(context: ReleaseContext): void {
  const conflicts = capture(context.runner, "jj", ["log", "-r", "conflicts() & @", "--no-graph", "-T", "commit_id"], {
    cwd: context.options.cwd,
  }).trim();
  if (conflicts.length > 0) {
    fail(context, "jj working copy has conflicts; resolve them before release.");
  }
}

function ensureJjWorkingCopyDescendsFromMain(context: ReleaseContext): void {
  const descendants = capture(context.runner, "jj", ["log", "-r", `@ & ${DEFAULT_BRANCH}::`, "--no-graph", "-T", "commit_id"], {
    cwd: context.options.cwd,
  }).trim();
  if (descendants.length === 0) {
    fail(context, `jj working copy @ must descend from ${DEFAULT_BRANCH} before release.`);
  }
}

function runVerification(context: ReleaseContext, packages: WorkspacePackage[]): void {
  checkedRun(context, "bun", ["run", "typecheck"], { cwd: context.options.cwd });
  for (const pkg of packages) {
    if (pkg.packageJson.scripts?.test) {
      checkedRun(context, "bun", ["--filter", pkg.name, "test"], { cwd: context.options.cwd });
    }
  }
}

function ensureNpmAuth(context: ReleaseContext): void {
  const whoami = context.runner("npm", registryArgs(["whoami"], context.options), {
    cwd: context.options.cwd,
    allowFailure: true,
  });
  if (whoami.status === 0) {
    console.log(`npm authenticated as ${whoami.stdout.trim()}.`);
    return;
  }

  console.log("npm is not authenticated. Running `npm login`; enter npm credentials and OTP in the terminal prompt.");
  checkedRun(context, "npm", registryArgs(["login"], context.options), {
    cwd: context.options.cwd,
    stdio: "inherit",
  });
  checkedRun(context, "npm", registryArgs(["whoami"], context.options), { cwd: context.options.cwd });
}

function runPackDryRun(context: ReleaseContext, packages: WorkspacePackage[]): void {
  for (const pkg of packages) {
    checkedRun(context, "npm", registryArgs(["pack", "--dry-run"], context.options), { cwd: pkg.dir });
  }
}

function getNpmVersion(runner: CommandRunner, packageName: string, options: ReleaseOptions): string {
  const result = runner("npm", registryArgs(["view", packageName, "version", "--json"], options), {
    cwd: options.cwd,
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new ReleaseError(`Unable to read npm version for ${packageName}: ${result.stderr.trim()}`, "preflight");
  }
  const parsed = JSON.parse(result.stdout.trim()) as unknown;
  if (typeof parsed !== "string") {
    throw new ReleaseError(`npm returned an invalid version for ${packageName}.`, "preflight");
  }
  return parsed;
}

function ensureTagDoesNotExist(context: ReleaseContext, tag: string): void {
  const local = context.runner("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    cwd: context.options.cwd,
    allowFailure: true,
  });
  if (local.status === 0) {
    fail(context, `Local tag ${tag} already exists.`);
  }

  const remote = context.runner("git", ["ls-remote", "--exit-code", "--tags", DEFAULT_REMOTE, `refs/tags/${tag}`], {
    cwd: context.options.cwd,
    allowFailure: true,
  });
  if (remote.status === 0) {
    fail(context, `Remote tag ${tag} already exists on ${DEFAULT_REMOTE}.`);
  }
}

function updatePackageVersions(packages: WorkspacePackage[], targetVersion: string): void {
  for (const pkg of packages) {
    const packageJson = { ...pkg.packageJson, version: targetVersion };
    writeJson(pkg.packageJsonPath, packageJson);
  }
}

function printSummary(
  packages: WorkspacePackage[],
  npmVersions: Map<string, string>,
  bump: Bump,
  preid: string | undefined,
  targetVersion: string,
  branch: string,
  tag: string,
  options: ReleaseOptions,
): void {
  console.log("");
  console.log(options.dryRun ? "Release dry run" : "Release");
  console.log(`Branch: ${branch}`);
  console.log(`Remote: ${DEFAULT_REMOTE}`);
  console.log(`Tag: ${tag}`);
  console.log(`Bump: ${bump}${bump === "prerelease" ? ` (${preid ?? DEFAULT_PREID})` : ""}`);
  console.log(`Target version: ${targetVersion}`);
  console.log("Packages:");
  for (const pkg of packages) {
    console.log(`- ${pkg.name}: local ${pkg.version}, npm ${npmVersions.get(pkg.name) ?? "<unknown>"}`);
  }
  console.log("");
}

function reportFailure(context: ReleaseContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release failed during ${context.stage}: ${message}`);

  if (context.publishedPackages.length > 0) {
    console.error(`Partial publish completed for: ${context.publishedPackages.join(", ")}`);
  }

  if (context.committed && !context.pushed) {
    console.error("Version commit exists locally. Inspect with `git show --stat HEAD` before retrying.");
  }
  if (context.tagged && !context.pushed) {
    console.error(`Tag ${context.targetVersion ? `v${context.targetVersion}` : "<target>"} exists locally.`);
    console.error("Push manually with `git push origin main` and `git push origin <tag>` once verified.");
  }
  if (context.pushed && context.stage === "publish") {
    console.error("Git refs are already pushed. Retry npm publish after resolving the package failure.");
  }
}

function checkedRun(context: ReleaseContext, command: string, args: string[], options?: RunOptions): CommandResult {
  const result = context.runner(command, args, options);
  if (result.status !== 0) {
    fail(context, `${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
  return result;
}

function capture(runner: CommandRunner, command: string, args: string[], options?: RunOptions): string {
  const result = runner(command, args, options);
  if (result.status !== 0) {
    throw new ReleaseError(`${command} ${args.join(" ")} failed with exit code ${result.status}.`, "preflight");
  }
  return result.stdout;
}

function fail(context: ReleaseContext, message: string): never {
  throw new ReleaseError(message, context.stage);
}

function runCommand(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const stdio = options.stdio ?? "pipe";
  const spawnOptions: SpawnSyncOptions = {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : "pipe",
  };
  const result = spawnSync(command, args, spawnOptions);
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    return {
      status,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? result.error?.message ?? ""),
    };
  }
  return {
    status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

function registryArgs(args: string[], options: ReleaseOptions): string[] {
  return options.registry ? [...args, "--registry", options.registry] : args;
}

function publishArgs(options: ReleaseOptions): string[] {
  return registryArgs(["publish", "--access", "public"], options);
}

async function promptBump(): Promise<Bump> {
  const answer = await prompt("Version bump (patch/minor/major/prerelease): ");
  if (!isBump(answer)) {
    throw new Error(`Invalid version bump: ${answer}`);
  }
  return answer;
}

async function promptPreid(): Promise<string> {
  const answer = await prompt(`Prerelease id (${DEFAULT_PREID}/beta/rc): `);
  return answer.trim() || DEFAULT_PREID;
}

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} [y/N] `);
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

const interactivePrompter: Prompter = {
  bump: promptBump,
  preid: promptPreid,
  confirm,
};

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function resolveWorkspacePattern(rootDir: string, pattern: string): string[] {
  if (!pattern.endsWith("/*")) {
    const exact = join(rootDir, pattern);
    return existsSync(exact) ? [exact] : [];
  }

  const parent = join(rootDir, pattern.slice(0, -2));
  if (!existsSync(parent)) {
    return [];
  }

  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: {
    id: string;
    number?: number;
  };
};

function parseSemver(version: string): ParsedSemver {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<preid>[0-9A-Za-z-]+)(?:\.(?<prenumber>\d+))?)?$/.exec(
    version,
  );
  if (!match?.groups) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.preid
      ? {
          id: match.groups.preid,
          number: match.groups.prenumber === undefined ? undefined : Number(match.groups.prenumber),
        }
      : undefined,
  };
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) {
      return diff;
    }
  }
  if (!left.prerelease && right.prerelease) {
    return 1;
  }
  if (left.prerelease && !right.prerelease) {
    return -1;
  }
  if (!left.prerelease && !right.prerelease) {
    return 0;
  }
  const idDiff = left.prerelease!.id.localeCompare(right.prerelease!.id);
  if (idDiff !== 0) {
    return idDiff;
  }
  return (left.prerelease!.number ?? 0) - (right.prerelease!.number ?? 0);
}

function isBump(value: unknown): value is Bump {
  return typeof value === "string" && VALID_BUMPS.has(value as Bump);
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

if (import.meta.main) {
  runRelease(parseArgs(process.argv.slice(2))).catch(() => {
    process.exitCode = 1;
  });
}
