import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzePortProbe,
  collectOwnedSidecars,
  createPackagePaths,
  getRuntimeBinaryFileName,
  isSupportedRuntimePlatform,
  selectPortCandidate,
  shouldBootstrapRuntime,
  type SidecarRecord,
} from "../src/sidecar.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("sidecar helpers", () => {
  test("derives runtime binary names by platform", () => {
    expect(getRuntimeBinaryFileName("darwin")).toBe("executor");
    expect(getRuntimeBinaryFileName("linux")).toBe("executor");
    expect(getRuntimeBinaryFileName("win32")).toBe("executor.exe");
  });

  test("recognizes supported runtime platforms", () => {
    expect(isSupportedRuntimePlatform("darwin", "arm64")).toBe(true);
    expect(isSupportedRuntimePlatform("linux", "x64")).toBe(true);
    expect(isSupportedRuntimePlatform("win32", "x64")).toBe(true);
    expect(isSupportedRuntimePlatform("freebsd", "x64")).toBe(false);
    expect(isSupportedRuntimePlatform("darwin", "ia32")).toBe(false);
  });

  test("derives package paths for the runtime", () => {
    const paths = createPackagePaths("/tmp/executor/package.json", "win32");
    expect(paths.packageRoot).toBe("/tmp/executor");
    expect(paths.wrapperPath).toBe("/tmp/executor/bin/executor");
    expect(paths.installerPath).toBe("/tmp/executor/postinstall.cjs");
    expect(paths.runtimePath).toBe("/tmp/executor/bin/runtime/executor.exe");
  });

  test("detects when bootstrap is required", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-executor-sidecar-"));
    cleanup.push(dir);

    const runtimePath = join(dir, "executor");
    expect(await shouldBootstrapRuntime(runtimePath)).toBe(true);

    await writeFile(runtimePath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(runtimePath, 0o755);
    expect(await shouldBootstrapRuntime(runtimePath)).toBe(false);
  });

  test("prefers reusable sidecars over free ports", () => {
    const probes = [
      analyzePortProbe("/repo", 4788, undefined, true),
      analyzePortProbe("/repo", 4789, { id: "scope", name: "repo", dir: "/repo" }, false),
    ];

    expect(selectPortCandidate(probes)).toEqual({ reusable: probes[1] });
  });

  test("rejects scope mismatches during scan and falls back to free ports", () => {
    const probes = [
      analyzePortProbe("/repo", 4788, { id: "scope", name: "other", dir: "/other" }, false),
      analyzePortProbe("/repo", 4789, undefined, true),
    ];

    expect(selectPortCandidate(probes)).toEqual({ freePort: 4789 });
  });

  test("collects only owned sidecars with child processes for cleanup", () => {
    const child = spawn("sh", ["-c", "sleep 1"], { stdio: "ignore" });
    const records: SidecarRecord[] = [
      {
        cwd: "/repo-a",
        port: 4788,
        baseUrl: "http://127.0.0.1:4788",
        ownedByPi: true,
        child,
        stdoutTail: [],
        stderrTail: [],
      },
      {
        cwd: "/repo-b",
        port: 4789,
        baseUrl: "http://127.0.0.1:4789",
        ownedByPi: false,
        stdoutTail: [],
        stderrTail: [],
      },
    ];

    expect(collectOwnedSidecars(records)).toHaveLength(1);
    expect(collectOwnedSidecars(records)[0]?.cwd).toBe("/repo-a");
    child.kill("SIGKILL");
  });
});
