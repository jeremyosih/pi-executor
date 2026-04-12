import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getScope, HttpError, type ScopeInfo } from "./http.ts";

export const DEFAULT_PORT_SEED = 4788;
export const PORT_SCAN_LIMIT = 32;
export const HEALTH_TIMEOUT_MS = 2_000;
export const STARTUP_TIMEOUT_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MS = 2_000;
export const LOG_RING_BUFFER_LINES = 200;
export const SIDECAR_REGISTRY_VERSION = 1;

export type PackagePaths = {
  packageJsonPath: string;
  packageRoot: string;
  wrapperPath: string;
  installerPath: string;
  runtimePath: string;
};

export type SidecarRecord = {
  cwd: string;
  port: number;
  baseUrl: string;
  pid?: number;
  ownedByPi: boolean;
  child?: ChildProcess;
  scope?: ScopeInfo;
  stdoutTail: string[];
  stderrTail: string[];
};

export type RegisteredSidecar = {
  cwd: string;
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
};

export type PortProbe =
  | { port: number; kind: "free" }
  | { port: number; kind: "reusable"; scope: ScopeInfo }
  | { port: number; kind: "occupied" };

export class SidecarError extends Error {
  readonly code:
    | "PACKAGE_RESOLUTION_FAILED"
    | "UNSUPPORTED_PLATFORM"
    | "BOOTSTRAP_FAILED"
    | "RUNTIME_MISSING"
    | "STARTUP_TIMEOUT"
    | "SCOPE_MISMATCH"
    | "PORT_EXHAUSTED"
    | "LAUNCHER_FAILED";
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    code: SidecarError["code"],
    message: string,
    details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.details = details;
  }
}

type SidecarRegistryFile = {
  version: number;
  sidecars: Record<string, RegisteredSidecar>;
};

const require = createRequire(import.meta.url);
const sidecarsByCwd = new Map<string, SidecarRecord>();

const normalizeDir = (cwd: string): string => resolve(cwd);

const buildBaseUrl = (port: number): string => `http://127.0.0.1:${port}`;

const emptySidecarRegistry = (): SidecarRegistryFile => ({
  version: SIDECAR_REGISTRY_VERSION,
  sidecars: {},
});

export const getSidecarRegistryPath = (): string =>
  join(process.env.HOME || homedir(), ".pi", "agent", "executor-sidecars.json");

const readSidecarRegistry = async (): Promise<SidecarRegistryFile> => {
  try {
    const raw = await readFile(getSidecarRegistryPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return emptySidecarRegistry();
    }

    const sidecarsValue = "sidecars" in parsed ? parsed.sidecars : undefined;
    const sidecars =
      typeof sidecarsValue === "object" && sidecarsValue !== null && !Array.isArray(sidecarsValue)
        ? (sidecarsValue as Record<string, RegisteredSidecar>)
        : {};

    return {
      version:
        "version" in parsed && typeof parsed.version === "number"
          ? parsed.version
          : SIDECAR_REGISTRY_VERSION,
      sidecars,
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return emptySidecarRegistry();
    }
    throw error;
  }
};

const writeSidecarRegistry = async (registry: SidecarRegistryFile): Promise<void> => {
  const path = getSidecarRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
};

export const getRegisteredSidecar = async (cwdInput: string): Promise<RegisteredSidecar | undefined> => {
  const cwd = normalizeDir(cwdInput);
  const registry = await readSidecarRegistry();
  return registry.sidecars[cwd];
};

export const registerSidecarForCwd = async (record: RegisteredSidecar): Promise<void> => {
  const cwd = normalizeDir(record.cwd);
  const registry = await readSidecarRegistry();
  registry.sidecars[cwd] = {
    ...record,
    cwd,
  };
  await writeSidecarRegistry(registry);
};

export const unregisterSidecarForCwd = async (cwdInput: string, pid?: number): Promise<void> => {
  const cwd = normalizeDir(cwdInput);
  const registry = await readSidecarRegistry();
  const registered = registry.sidecars[cwd];
  if (!registered) {
    return;
  }
  if (pid !== undefined && registered.pid !== pid) {
    return;
  }
  delete registry.sidecars[cwd];
  await writeSidecarRegistry(registry);
};

const registerRuntimeSidecar = async (record: SidecarRecord): Promise<void> => {
  if (!record.pid) {
    return;
  }

  await registerSidecarForCwd({
    cwd: record.cwd,
    pid: record.pid,
    port: record.port,
    baseUrl: record.baseUrl,
    startedAt: new Date().toISOString(),
  });
};

export const isSupportedRuntimePlatform = (platform: NodeJS.Platform, arch: string): boolean => {
  const supportedPlatform = platform === "darwin" || platform === "linux" || platform === "win32";
  const supportedArch = arch === "x64" || arch === "arm64";
  return supportedPlatform && supportedArch;
};

export const getRuntimeBinaryFileName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "executor.exe" : "executor";

export const shouldBootstrapRuntime = async (runtimePath: string): Promise<boolean> => {
  try {
    await access(runtimePath, fsConstants.X_OK);
    return false;
  } catch {
    return true;
  }
};

export const createPackagePaths = (
  packageJsonPath: string,
  platform: NodeJS.Platform = process.platform,
): PackagePaths => {
  const packageRoot = dirname(packageJsonPath);
  return {
    packageJsonPath,
    packageRoot,
    wrapperPath: join(packageRoot, "bin", "executor"),
    installerPath: join(packageRoot, "postinstall.cjs"),
    runtimePath: join(packageRoot, "bin", "runtime", getRuntimeBinaryFileName(platform)),
  };
};

export const resolveExecutorPackagePaths = (): PackagePaths => {
  try {
    const packageJsonPath = require.resolve("executor/package.json");
    return createPackagePaths(packageJsonPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SidecarError(
      "PACKAGE_RESOLUTION_FAILED",
      `Unable to resolve executor/package.json: ${message}`,
    );
  }
};

const joinTail = (lines: string[]): string => lines.join("\n").trim();

const pushLogChunk = (tail: string[], chunk: string): void => {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      continue;
    }
    tail.push(trimmed);
    if (tail.length > LOG_RING_BUFFER_LINES) {
      tail.splice(0, tail.length - LOG_RING_BUFFER_LINES);
    }
  }
};

const runInstaller = async (
  paths: PackagePaths,
): Promise<{ stdoutTail: string[]; stderrTail: string[] }> => {
  const stdoutTail: string[] = [];
  const stderrTail: string[] = [];

  const child = spawn(process.execPath, [paths.installerPath], {
    cwd: paths.packageRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => pushLogChunk(stdoutTail, chunk));
  child.stderr.on("data", (chunk: string) => pushLogChunk(stderrTail, chunk));

  const exitCode = await new Promise<number>((resolveExitCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExitCode(code ?? -1));
  });

  if (exitCode !== 0) {
    throw new SidecarError("BOOTSTRAP_FAILED", "Executor runtime bootstrap failed", {
      exitCode,
      stdoutTail: joinTail(stdoutTail),
      stderrTail: joinTail(stderrTail),
    });
  }

  return { stdoutTail, stderrTail };
};

export const resolveRuntimeBinary = async (): Promise<string> => {
  if (!isSupportedRuntimePlatform(process.platform, process.arch)) {
    throw new SidecarError(
      "UNSUPPORTED_PLATFORM",
      `Unsupported platform ${process.platform}/${process.arch} for executor runtime`,
      { platform: process.platform, arch: process.arch },
    );
  }

  const paths = resolveExecutorPackagePaths();
  if (await shouldBootstrapRuntime(paths.runtimePath)) {
    await runInstaller(paths);
  }

  if (await shouldBootstrapRuntime(paths.runtimePath)) {
    throw new SidecarError(
      "RUNTIME_MISSING",
      `Executor runtime is still missing after bootstrap at ${paths.runtimePath}`,
      { runtimePath: paths.runtimePath },
    );
  }

  return paths.runtimePath;
};

const isPortFree = async (port: number): Promise<boolean> => {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolveListen());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
};

export const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return error.code !== "ESRCH";
    }
    return false;
  }
};

const waitForPidExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await delay(50);
  }
  return !isPidRunning(pid);
};

const terminatePid = async (pid: number): Promise<void> => {
  if (!isPidRunning(pid)) {
    return;
  }

  process.kill(pid, "SIGTERM");
  if (await waitForPidExit(pid, SHUTDOWN_TIMEOUT_MS)) {
    return;
  }

  process.kill(pid, "SIGKILL");
  await waitForPidExit(pid, SHUTDOWN_TIMEOUT_MS);
};

const execFileText = async (command: string, args: string[]): Promise<string> => {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolveExec, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });

  return [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n");
};

const findPidByPort = async (port: number): Promise<number | undefined> => {
  try {
    if (process.platform === "win32") {
      const output = await execFileText("netstat", ["-ano", "-p", "tcp"]);
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes(`127.0.0.1:${port}`) && !line.includes(`0.0.0.0:${port}`)) {
          continue;
        }
        if (!line.toUpperCase().includes("LISTENING")) {
          continue;
        }
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts.at(-1));
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      }
      return undefined;
    }

    const output = await execFileText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    for (const line of output.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const isHealthyRecord = async (record: SidecarRecord): Promise<boolean> => {
  try {
    const scope = await getScope(record.baseUrl, HEALTH_TIMEOUT_MS);
    if (scope.dir !== record.cwd) {
      return false;
    }
    record.scope = scope;
    return true;
  } catch {
    return false;
  }
};

export const analyzePortProbe = (
  cwd: string,
  port: number,
  scope?: ScopeInfo,
  free = false,
): PortProbe => {
  if (scope && scope.dir === cwd) {
    return { port, kind: "reusable", scope };
  }
  if (free) {
    return { port, kind: "free" };
  }
  return { port, kind: "occupied" };
};

export const selectPortCandidate = (
  probes: PortProbe[],
): { reusable?: PortProbe; freePort?: number } => {
  for (const probe of probes) {
    if (probe.kind === "reusable") {
      return { reusable: probe };
    }
  }

  const freeProbe = probes.find((probe) => probe.kind === "free");
  return freeProbe ? { freePort: freeProbe.port } : {};
};

export const collectOwnedSidecars = (records: Iterable<SidecarRecord>): SidecarRecord[] =>
  Array.from(records).filter((record) => record.ownedByPi && record.child !== undefined);

const hydrateRegisteredPid = async (record: SidecarRecord): Promise<SidecarRecord> => {
  const registered = await getRegisteredSidecar(record.cwd);
  if (registered && registered.port === record.port && registered.baseUrl === record.baseUrl) {
    if (!isPidRunning(registered.pid)) {
      await unregisterSidecarForCwd(record.cwd, registered.pid);
    } else {
      record.pid = registered.pid;
      return record;
    }
  }

  const pid = await findPidByPort(record.port);
  if (pid !== undefined) {
    record.pid = pid;
    await registerSidecarForCwd({
      cwd: record.cwd,
      pid,
      port: record.port,
      baseUrl: record.baseUrl,
      startedAt: new Date().toISOString(),
    });
  }

  return record;
};

const probePort = async (cwd: string, port: number): Promise<PortProbe> => {
  const baseUrl = buildBaseUrl(port);
  try {
    const scope = await getScope(baseUrl, HEALTH_TIMEOUT_MS);
    return analyzePortProbe(cwd, port, scope, false);
  } catch (error) {
    if (error instanceof HttpError) {
      const free = await isPortFree(port);
      return analyzePortProbe(cwd, port, undefined, free);
    }
    const free = await isPortFree(port);
    return analyzePortProbe(cwd, port, undefined, free);
  }
};

const scanPorts = async (cwd: string): Promise<{ reusable?: SidecarRecord; freePort?: number }> => {
  const probes: PortProbe[] = [];
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = DEFAULT_PORT_SEED + offset;
    probes.push(await probePort(cwd, port));
  }

  const selection = selectPortCandidate(probes);
  if (selection.reusable?.kind === "reusable") {
    return {
      reusable: await hydrateRegisteredPid({
        cwd,
        port: selection.reusable.port,
        baseUrl: buildBaseUrl(selection.reusable.port),
        ownedByPi: false,
        scope: selection.reusable.scope,
        stdoutTail: [],
        stderrTail: [],
      }),
    };
  }

  return { freePort: selection.freePort };
};

const attachExitCleanup = (record: SidecarRecord): void => {
  const child = record.child;
  if (!child) {
    return;
  }

  const clear = (): void => {
    const current = sidecarsByCwd.get(record.cwd);
    if (current === record) {
      sidecarsByCwd.delete(record.cwd);
    }

    void unregisterSidecarForCwd(record.cwd, record.pid);
  };

  child.once("exit", clear);
  child.once("close", clear);
};

const spawnOwnedSidecar = async (cwd: string, port: number): Promise<SidecarRecord> => {
  const runtimePath = await resolveRuntimeBinary();
  const child = spawn(runtimePath, ["web", "--port", String(port)], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const record: SidecarRecord = {
    cwd,
    port,
    baseUrl: buildBaseUrl(port),
    pid: child.pid,
    ownedByPi: true,
    child,
    stdoutTail: [],
    stderrTail: [],
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => pushLogChunk(record.stdoutTail, chunk));
  child.stderr.on("data", (chunk: string) => pushLogChunk(record.stderrTail, chunk));
  attachExitCleanup(record);

  return record;
};

export const findRunningSidecarForCwd = async (cwdInput: string): Promise<SidecarRecord | undefined> => {
  const cwd = normalizeDir(cwdInput);
  const cached = sidecarsByCwd.get(cwd);
  if (cached && (await isHealthyRecord(cached))) {
    return cached;
  }
  if (cached) {
    sidecarsByCwd.delete(cwd);
  }

  const scanned = await scanPorts(cwd);
  if (scanned.reusable) {
    sidecarsByCwd.set(cwd, scanned.reusable);
    return scanned.reusable;
  }

  return undefined;
};

export const ensureSidecar = async (cwdInput: string): Promise<SidecarRecord> => {
  const cwd = normalizeDir(cwdInput);
  const reusable = await findRunningSidecarForCwd(cwd);
  if (reusable) {
    return reusable;
  }

  const scanned = await scanPorts(cwd);
  if (scanned.freePort === undefined) {
    throw new SidecarError(
      "PORT_EXHAUSTED",
      `No free executor sidecar port found in ${DEFAULT_PORT_SEED}-${DEFAULT_PORT_SEED + PORT_SCAN_LIMIT - 1}`,
    );
  }

  const record = await spawnOwnedSidecar(cwd, scanned.freePort);
  sidecarsByCwd.set(cwd, record);

  try {
    const scope = await getScope(record.baseUrl, STARTUP_TIMEOUT_MS).catch(async () => {
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          return await getScope(record.baseUrl, HEALTH_TIMEOUT_MS);
        } catch {
          await delay(100);
        }
      }
      throw new HttpError({
        baseUrl: record.baseUrl,
        path: "/api/scope",
        message: `Executor sidecar startup timed out after ${STARTUP_TIMEOUT_MS}ms`,
      });
    });

    if (scope.dir !== cwd) {
      throw new SidecarError("SCOPE_MISMATCH", `Executor sidecar scope mismatch for ${cwd}`, {
        expectedDir: cwd,
        actualDir: scope.dir,
        port: record.port,
      });
    }

    record.scope = scope;
    await registerRuntimeSidecar(record);
    return record;
  } catch (error) {
    await stopSidecar(record);
    if (error instanceof SidecarError) {
      throw error;
    }
    if (error instanceof HttpError) {
      throw new SidecarError(
        "STARTUP_TIMEOUT",
        `${error.message}. stdout: ${joinTail(record.stdoutTail)} stderr: ${joinTail(record.stderrTail)}`,
        { port: record.port },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SidecarError("STARTUP_TIMEOUT", `Executor sidecar failed to start: ${message}`, {
      port: record.port,
    });
  }
};

export const stopSidecar = async (record: SidecarRecord): Promise<void> => {
  const current = sidecarsByCwd.get(record.cwd);
  if (current === record) {
    sidecarsByCwd.delete(record.cwd);
  }

  if (record.pid) {
    await unregisterSidecarForCwd(record.cwd, record.pid);
  }

  const child = record.child;
  if (!record.ownedByPi || !child) {
    if (record.pid) {
      await terminatePid(record.pid);
    }
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolveClose) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveClose();
    }, SHUTDOWN_TIMEOUT_MS);

    child.once("close", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
};

export const getSidecarRecord = (cwdInput: string): SidecarRecord | undefined =>
  sidecarsByCwd.get(normalizeDir(cwdInput));

export const stopSidecarForCwd = async (cwdInput: string): Promise<"stopped" | "missing"> => {
  const cwd = normalizeDir(cwdInput);
  const running = await findRunningSidecarForCwd(cwd);
  if (running && (running.ownedByPi || running.pid !== undefined)) {
    await stopSidecar(running);
    return "stopped";
  }
  if (running) {
    sidecarsByCwd.delete(cwd);
  }

  const registered = await getRegisteredSidecar(cwd);
  if (!registered) {
    return "missing";
  }

  if (!isPidRunning(registered.pid)) {
    await unregisterSidecarForCwd(cwd, registered.pid);
    return "missing";
  }

  try {
    const scope = await getScope(registered.baseUrl, HEALTH_TIMEOUT_MS);
    if (scope.dir !== cwd) {
      return "missing";
    }
  } catch {
    await unregisterSidecarForCwd(cwd, registered.pid);
    return "missing";
  }

  sidecarsByCwd.delete(cwd);
  await unregisterSidecarForCwd(cwd, registered.pid);
  await terminatePid(registered.pid);
  return "stopped";
};

export const shutdownOwnedSidecars = async (): Promise<void> => {
  const owned = collectOwnedSidecars(sidecarsByCwd.values());
  await Promise.all(owned.map((record) => stopSidecar(record)));
};

export const getSidecarRecords = (): SidecarRecord[] => Array.from(sidecarsByCwd.values());
