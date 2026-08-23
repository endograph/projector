"use node";

import {
  Bash,
  InMemoryFs,
  MountableFs,
  type BufferEncoding,
  type CpOptions,
  type FileContent,
  type FsStat,
  type IFileSystem,
  type MkdirOptions,
  type RmOptions,
} from "just-bash";
import snapshot from "./repoSnapshot.generated";

const MAX_COMMAND_BYTES = 12_000;
const MAX_TOOL_CALLS = 20;
const MAX_RESULT_BYTES = 120_000;

class ReadOnlyFs implements IFileSystem {
  constructor(private readonly inner: IFileSystem) {}

  readFile(path: string, options?: Parameters<IFileSystem["readFile"]>[1]) { return this.inner.readFile(path, options); }
  readFileBuffer(path: string) { return this.inner.readFileBuffer(path); }
  exists(path: string) { return this.inner.exists(path); }
  stat(path: string) { return this.inner.stat(path); }
  lstat(path: string) { return this.inner.lstat(path); }
  readdir(path: string) { return this.inner.readdir(path); }
  resolvePath(base: string, path: string) { return this.inner.resolvePath(base, path); }
  getAllPaths() { return this.inner.getAllPaths(); }
  readlink(path: string) { return this.inner.readlink(path); }
  realpath(path: string) { return this.inner.realpath(path); }

  private deny(): never {
    throw new Error("/repo is read-only; write scratch files under /workspace or /tmp");
  }

  async writeFile(_path: string, _content: FileContent, _options?: Parameters<IFileSystem["writeFile"]>[2]): Promise<void> { this.deny(); }
  async appendFile(_path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]): Promise<void> { this.deny(); }
  async mkdir(_path: string, _options?: MkdirOptions): Promise<void> { this.deny(); }
  async rm(_path: string, _options?: RmOptions): Promise<void> { this.deny(); }
  async cp(_src: string, _dest: string, _options?: CpOptions): Promise<void> { this.deny(); }
  async mv(_src: string, _dest: string): Promise<void> { this.deny(); }
  async chmod(_path: string, _mode: number): Promise<void> { this.deny(); }
  async symlink(_target: string, _linkPath: string): Promise<void> { this.deny(); }
  async link(_existingPath: string, _newPath: string): Promise<void> { this.deny(); }
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> { this.deny(); }
}

export type RepoBash = {
  exec(command: string): Promise<string>;
};

export function createRepoBash(): RepoBash {
  const repoFs = new ReadOnlyFs(new InMemoryFs(snapshot.files));
  const scratchFs = new InMemoryFs(undefined, { maxTotalBytes: 64 * 1024 * 1024 });
  scratchFs.mkdirSync("/workspace", { recursive: true });
  scratchFs.mkdirSync("/tmp", { recursive: true });
  const fs = new MountableFs({
    base: scratchFs,
    mounts: [{ mountPoint: "/repo", filesystem: repoFs }],
  });
  const bash = new Bash({
    fs,
    cwd: "/repo",
    env: {
      HOME: "/workspace",
      TMPDIR: "/tmp",
      PROJECTOR_REPO_REVISION: snapshot.revision,
    },
    executionLimitProfile: "hardened",
    executionLimits: {
      maxSourceBytes: MAX_COMMAND_BYTES,
      maxCommandCount: 50_000,
      maxLoopIterations: 50_000,
      maxWorkUnits: 2_000_000,
      maxTraversalEntries: 250_000,
      maxTraversalWork: 1_000_000,
      maxLiveBytes: 128 * 1024 * 1024,
      maxInputBytes: 128 * 1024 * 1024,
      maxFileSystemBytes: 64 * 1024 * 1024,
      maxOutputSize: 1024 * 1024,
      maxExecutionTimeMs: 20_000,
    },
    // Capability-detect and enable just-bash's secondary host-realm guards in
    // the Convex Node action runtime. The primary boundary remains the virtual
    // FS with network, code runtimes, and custom commands absent.
    defenseInDepth: { enabled: "auto" },
  });
  let calls = 0;

  return {
    async exec(command) {
      if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
        throw new Error(`bash command exceeds ${MAX_COMMAND_BYTES} bytes`);
      }
      calls += 1;
      if (calls > MAX_TOOL_CALLS) {
        throw new Error(`bash is limited to ${MAX_TOOL_CALLS} calls per agent turn`);
      }
      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        result = await bash.exec(command);
      } catch (error) {
        result = {
          stdout: "",
          stderr: error instanceof Error ? error.message : "bash execution failed",
          exitCode: 1,
        };
      }
      const header = [
        `snapshot: ${snapshot.revision}`,
        `exitCode: ${result.exitCode}`,
        "stdout:",
      ].join("\n");
      const full = `${header}\n${result.stdout}\nstderr:\n${result.stderr}`;
      if (Buffer.byteLength(full, "utf8") <= MAX_RESULT_BYTES) return full;
      return `${Buffer.from(full).subarray(0, MAX_RESULT_BYTES).toString("utf8")}\n[output truncated at ${MAX_RESULT_BYTES} bytes]`;
    },
  };
}
