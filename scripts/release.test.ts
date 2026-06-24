import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpVersion, discoverPublishablePackages, highestVersion, parseArgs, runRelease } from "./release.ts";

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "projectors-release-"));
  mkdirSync(join(root, "packages", "projector"), { recursive: true });
  mkdirSync(join(root, "packages", "private-one"), { recursive: true });
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeJson(join(root, "package.json"), {
    name: "@projectors/root",
    private: true,
    workspaces: ["packages/*", "apps/*"],
  });
  writeJson(join(root, "packages", "projector", "package.json"), {
    name: "@projectors/core",
    version: "0.0.0",
    scripts: {
      test: "vitest run",
    },
  });
  writeJson(join(root, "packages", "private-one", "package.json"), {
    name: "@projectors/private-one",
    version: "0.0.0",
    private: true,
  });
  writeJson(join(root, "apps", "demo", "package.json"), {
    name: "@projectors/demo",
    version: "0.1.0",
    private: true,
  });
  return root;
}

describe("release package discovery", () => {
  it("includes publishable workspace packages and skips private workspaces", () => {
    const root = fixtureRepo();
    const packages = discoverPublishablePackages(root);

    expect(packages.map((pkg) => pkg.name)).toEqual(["@projectors/core"]);
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain("@projectors/root");
  });
});

describe("release versioning", () => {
  it("computes standard semver bumps", () => {
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(bumpVersion("0.0.0", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.0.0", "major")).toBe("1.0.0");
  });

  it("computes prerelease bumps", () => {
    expect(bumpVersion("0.0.0", "prerelease", "alpha")).toBe("0.0.1-alpha.0");
    expect(bumpVersion("0.0.1-alpha.0", "prerelease", "alpha")).toBe("0.0.1-alpha.1");
  });

  it("chooses the highest local or registry version as the bump base", () => {
    expect(highestVersion(["0.0.0", "0.0.2", "0.0.1"])).toBe("0.0.2");
  });
});

describe("release cli args", () => {
  it("parses dry run, bump, preid, and registry", () => {
    expect(parseArgs(["--dry-run", "--bump", "prerelease", "--preid", "rc", "--registry", "https://npm.example"])).toMatchObject({
      dryRun: true,
      bump: "prerelease",
      preid: "rc",
      registry: "https://npm.example",
    });
  });
});

describe("release flow", () => {
  it("fails detached HEAD outside jj before mutation", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (command === "git" && args.join(" ") === "fetch origin main --tags") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "symbolic-ref --short HEAD") {
        return { status: 1, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref" };
      }
      if (command === "jj" && args.join(" ") === "status") {
        return { status: 1, stdout: "", stderr: "no jj repo" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await expect(
      runRelease({ cwd: root, dryRun: true, bump: "patch" }, runner, {
        bump: async () => "patch",
        preid: async () => "alpha",
        confirm: async () => true,
      }),
    ).rejects.toThrow(/detached/);

    expect(calls).toEqual(["git fetch origin main --tags", "git symbolic-ref --short HEAD", "jj status"]);
  });

  it("fails dirty worktrees before versioning", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      const joined = args.join(" ");
      if (command === "git" && joined === "symbolic-ref --short HEAD") {
        return { status: 0, stdout: "main\n", stderr: "" };
      }
      if (command === "jj" && joined === "status") {
        return { status: 1, stdout: "", stderr: "no jj repo" };
      }
      if (command === "git" && joined === "merge-base --is-ancestor origin/main HEAD") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && joined === "status --porcelain") {
        return { status: 0, stdout: " M package.json\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await expect(
      runRelease({ cwd: root, dryRun: true, bump: "patch" }, runner, {
        bump: async () => "patch",
        preid: async () => "alpha",
        confirm: async () => true,
      }),
    ).rejects.toThrow(/Worktree must be clean/);

    expect(calls).not.toContain("bun install --lockfile-only");
  });

  it("attaches detached jj work to main before a dry run", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    let attached = false;
    const runner = (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      const joined = args.join(" ");
      if (command === "git" && joined === "symbolic-ref --short HEAD") {
        return attached
          ? { status: 0, stdout: "main\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref" };
      }
      if (command === "jj" && joined === "status") {
        return { status: 0, stdout: "Working copy changes:\n", stderr: "" };
      }
      if (command === "jj" && joined === "log -r conflicts() & @ --no-graph -T commit_id") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "jj" && joined === "log -r @ & main:: --no-graph -T commit_id") {
        return { status: 0, stdout: "abc", stderr: "" };
      }
      if (command === "git" && joined === "symbolic-ref HEAD refs/heads/main") {
        attached = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && joined === "merge-base --is-ancestor origin/main HEAD") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && joined === "status --porcelain") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && joined.startsWith("rev-parse -q --verify refs/tags/")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (command === "git" && joined.startsWith("ls-remote --exit-code --tags origin refs/tags/")) {
        return { status: 2, stdout: "", stderr: "" };
      }
      if (command === "npm" && joined === "view @projectors/core version --json") {
        return { status: 0, stdout: JSON.stringify("0.0.0"), stderr: "" };
      }
      if (command === "npm" && joined === "whoami") {
        return { status: 0, stdout: "zack\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await runRelease({ cwd: root, dryRun: true, bump: "patch" }, runner, {
      bump: async () => "patch",
      preid: async () => "alpha",
      confirm: async () => true,
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        "jj log -r @ & main:: --no-graph -T commit_id",
        "jj bookmark move main --to @",
        "jj git export",
        "git symbolic-ref HEAD refs/heads/main",
        "git reset",
        "npm pack --dry-run",
      ]),
    );
  });

  it("moves attached jj main to @ before checking Git cleanliness", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      const joined = args.join(" ");
      if (command === "git" && joined === "symbolic-ref --short HEAD") {
        return { status: 0, stdout: "main\n", stderr: "" };
      }
      if (command === "jj" && joined === "status") {
        return { status: 0, stdout: "Working copy changes:\n", stderr: "" };
      }
      if (command === "jj" && joined === "log -r conflicts() & @ --no-graph -T commit_id") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "jj" && joined === "log -r @ & main:: --no-graph -T commit_id") {
        return { status: 0, stdout: "abc", stderr: "" };
      }
      if (command === "git" && joined === "merge-base --is-ancestor origin/main HEAD") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && joined === "status --porcelain") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && joined.startsWith("rev-parse -q --verify refs/tags/")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (command === "git" && joined.startsWith("ls-remote --exit-code --tags origin refs/tags/")) {
        return { status: 2, stdout: "", stderr: "" };
      }
      if (command === "npm" && joined === "view @projectors/core version --json") {
        return { status: 0, stdout: JSON.stringify("0.0.0"), stderr: "" };
      }
      if (command === "npm" && joined === "whoami") {
        return { status: 0, stdout: "zack\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await runRelease({ cwd: root, dryRun: true, bump: "patch" }, runner, {
      bump: async () => "patch",
      preid: async () => "alpha",
      confirm: async () => true,
    });

    expect(calls).toEqual(
      expect.arrayContaining(["jj bookmark move main --to @", "jj git export", "git symbolic-ref HEAD refs/heads/main", "git reset"]),
    );
  });

  it("dry run verifies and packs without editing package versions", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    const runner = releaseRunner(calls, { published: false });

    await runRelease({ cwd: root, dryRun: true, bump: "patch" }, runner, {
      bump: async () => "patch",
      preid: async () => "alpha",
      confirm: async () => true,
    });

    const packageJson = JSON.parse(readFileSync(join(root, "packages", "projector", "package.json"), "utf8")) as {
      version: string;
    };
    expect(packageJson.version).toBe("0.0.0");
    expect(calls).toContain("bun run typecheck");
    expect(calls).toContain("bun --filter @projectors/core test");
    expect(calls).toContain("npm pack --dry-run");
    expect(calls.some((call) => call.startsWith("git commit"))).toBe(false);
    expect(calls.some((call) => call.startsWith("npm publish"))).toBe(false);
  });

  it("commits, tags, pushes, publishes, and verifies in order", async () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "bun.lock"), "");
    const state = { published: false };
    const calls: string[] = [];
    const runner = releaseRunner(calls, state);

    await runRelease({ cwd: root, dryRun: false, bump: "patch" }, runner, {
      bump: async () => "patch",
      preid: async () => "alpha",
      confirm: async () => true,
    });

    const packageJson = JSON.parse(readFileSync(join(root, "packages", "projector", "package.json"), "utf8")) as {
      version: string;
    };
    expect(packageJson.version).toBe("0.0.1");
    expect(calls).toEqual(
      expect.arrayContaining([
        "bun install --lockfile-only",
        "git commit -m chore(release): v0.0.1",
        "git tag -a v0.0.1 -m v0.0.1",
        "git push origin main",
        "git push origin v0.0.1",
        "npm publish --access public",
      ]),
    );
    expect(calls.indexOf("git tag -a v0.0.1 -m v0.0.1")).toBeGreaterThan(
      calls.indexOf("git commit -m chore(release): v0.0.1"),
    );
    expect(calls.indexOf("npm publish --access public")).toBeGreaterThan(calls.indexOf("git push origin v0.0.1"));
  });
});

function releaseRunner(calls: string[], state: { published: boolean }) {
  return (command: string, args: string[]) => {
    calls.push([command, ...args].join(" "));
    const joined = args.join(" ");

    if (command === "git" && joined === "symbolic-ref --short HEAD") {
      return { status: 0, stdout: "main\n", stderr: "" };
    }
    if (command === "jj" && joined === "status") {
      return { status: 1, stdout: "", stderr: "no jj repo" };
    }
    if (command === "git" && joined === "merge-base --is-ancestor origin/main HEAD") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && joined === "status --porcelain") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && joined.startsWith("rev-parse -q --verify refs/tags/")) {
      return { status: 1, stdout: "", stderr: "" };
    }
    if (command === "git" && joined.startsWith("ls-remote --exit-code --tags origin refs/tags/")) {
      return { status: 2, stdout: "", stderr: "" };
    }
    if (command === "git" && joined === "rev-parse HEAD") {
      return { status: 0, stdout: "def\n", stderr: "" };
    }
    if (command === "npm" && joined === "view @projectors/core version --json") {
      return { status: 0, stdout: JSON.stringify(state.published ? "0.0.1" : "0.0.0"), stderr: "" };
    }
    if (command === "npm" && joined === "whoami") {
      return { status: 0, stdout: "zack\n", stderr: "" };
    }
    if (command === "npm" && joined === "publish --access public") {
      state.published = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}
