import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EXECUTOR_COMMAND, DEFAULT_REACHABILITY_POLL_INTERVAL_MS, GLOBAL_CONFIG_FILE_NAME, INSTANCE_DIRECTORY_NAME, INSTANCE_LOCAL_DATA_DIRECTORY, INSTANCE_LOG_FILE_NAME, INSTANCE_PID_FILE_NAME, INSTANCE_RECORD_FILE_NAME, } from "./constants.js";
import { getAgentDir } from "./config.js";
const DEFAULT_FETCH = fetch;
const DEFAULT_SPAWN = (command, args, options) => spawn(command, args, options);
const fileExists = async (filePath) => {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
};
const isValidPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65_535;
const sleep = async (durationMs, signal) => {
    if (durationMs <= 0) {
        return;
    }
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, durationMs);
        const onAbort = () => {
            cleanup();
            reject(new Error("Operation aborted"));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        if (signal?.aborted) {
            cleanup();
            reject(new Error("Operation aborted"));
            return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
};
const deriveInstance = (cwdRealpath, port, agentDir) => {
    const instanceId = createHash("sha256").update(cwdRealpath).digest("hex").slice(0, 16);
    const instanceDirectory = join(agentDir, INSTANCE_DIRECTORY_NAME, "instances", instanceId);
    return {
        instanceId,
        cwdRealpath,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        localDataDir: join(instanceDirectory, INSTANCE_LOCAL_DATA_DIRECTORY),
        pidFile: join(instanceDirectory, INSTANCE_PID_FILE_NAME),
        logFile: join(instanceDirectory, INSTANCE_LOG_FILE_NAME),
    };
};
const readInstanceRecord = async (filePath) => {
    if (!(await fileExists(filePath))) {
        return null;
    }
    try {
        const text = await readFile(filePath, "utf8");
        const parsed = JSON.parse(text);
        if (typeof parsed.instanceId !== "string"
            || typeof parsed.cwdRealpath !== "string"
            || typeof parsed.port !== "number"
            || typeof parsed.baseUrl !== "string"
            || typeof parsed.localDataDir !== "string"
            || typeof parsed.pidFile !== "string"
            || typeof parsed.logFile !== "string"
            || !isValidPort(parsed.port)) {
            return null;
        }
        return {
            instanceId: parsed.instanceId,
            cwdRealpath: parsed.cwdRealpath,
            port: parsed.port,
            baseUrl: parsed.baseUrl,
            localDataDir: parsed.localDataDir,
            pidFile: parsed.pidFile,
            logFile: parsed.logFile,
        };
    }
    catch {
        return null;
    }
};
const writeInstanceRecord = async (instance, agentDir) => {
    const instanceDirectory = join(agentDir, INSTANCE_DIRECTORY_NAME, "instances", instance.instanceId);
    await mkdir(instanceDirectory, { recursive: true });
    await mkdir(instance.localDataDir, { recursive: true });
    const recordFile = join(instanceDirectory, INSTANCE_RECORD_FILE_NAME);
    const tempFile = `${recordFile}.tmp`;
    await writeFile(tempFile, JSON.stringify(instance, null, 2), "utf8");
    await rename(tempFile, recordFile);
};
export const allocatePort = async () => await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
            server.close(() => reject(new Error("Failed to allocate a localhost port")));
            return;
        }
        const port = address.port;
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(port);
        });
    });
});
export const isPortAvailable = async (port) => await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
        resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
    });
});
export const resolveExecutorInstance = async (cwd, config, options) => {
    const agentDir = getAgentDir(options?.agentDir);
    const cwdRealpath = await (options?.realpathFn ?? realpath)(cwd);
    const instanceId = createHash("sha256").update(cwdRealpath).digest("hex").slice(0, 16);
    const instanceDirectory = join(agentDir, INSTANCE_DIRECTORY_NAME, "instances", instanceId);
    const recordFile = join(instanceDirectory, INSTANCE_RECORD_FILE_NAME);
    const existing = await readInstanceRecord(recordFile);
    const configuredPort = config.port;
    let port = configuredPort;
    if (port === undefined && existing && existing.cwdRealpath === cwdRealpath) {
        port = existing.port;
    }
    if (port === undefined) {
        const allocator = options?.allocatePort ?? allocatePort;
        const availability = options?.isPortAvailable ?? isPortAvailable;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const candidate = await allocator();
            if (await availability(candidate)) {
                port = candidate;
                break;
            }
        }
    }
    if (port === undefined || !isValidPort(port)) {
        throw new Error(`Unable to determine a valid executor port for ${cwdRealpath}`);
    }
    const derived = deriveInstance(cwdRealpath, port, agentDir);
    if (!existing
        || existing.cwdRealpath !== derived.cwdRealpath
        || existing.port !== derived.port
        || existing.baseUrl !== derived.baseUrl
        || existing.localDataDir !== derived.localDataDir
        || existing.pidFile !== derived.pidFile
        || existing.logFile !== derived.logFile) {
        await writeInstanceRecord(derived, agentDir);
    }
    return derived;
};
export const isReachable = async (baseUrl, options) => {
    try {
        const response = await (options?.fetchImpl ?? DEFAULT_FETCH)(`${baseUrl}/v1/local/installation`, {
            method: "GET",
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        return response.ok;
    }
    catch {
        return false;
    }
};
export const waitForReachability = async (baseUrl, expected, timeoutMs, options) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if ((await isReachable(baseUrl, options)) === expected) {
            return;
        }
        await sleep(options?.intervalMs ?? DEFAULT_REACHABILITY_POLL_INTERVAL_MS, options?.signal);
    }
    throw new Error(`Timed out waiting for executor reachability at ${baseUrl} after ${timeoutMs}ms`);
};
export const startExecutorWebDetached = async (cwd, instance, command = DEFAULT_EXECUTOR_COMMAND, options) => await new Promise((resolve, reject) => {
    const child = (options?.spawnImpl ?? DEFAULT_SPAWN)(command, ["server", "start", "--port", String(instance.port)], {
        cwd,
        env: {
            ...process.env,
            EXECUTOR_LOCAL_DATA_DIR: instance.localDataDir,
            EXECUTOR_SERVER_PID_FILE: instance.pidFile,
            EXECUTOR_SERVER_LOG_FILE: instance.logFile,
        },
        detached: true,
        stdio: "ignore",
    });
    child.once("error", (error) => {
        reject(error);
    });
    child.once("spawn", () => {
        child.unref();
        resolve();
    });
});
export const ensureExecutorRunning = async (cwd, config, options) => {
    const instance = await resolveExecutorInstance(cwd, config, options);
    if (await isReachable(instance.baseUrl, options)) {
        return instance;
    }
    const availability = options?.isPortAvailable ?? isPortAvailable;
    if (!(await availability(instance.port))) {
        throw new Error(`Port ${instance.port} is already in use by another process. Refusing to reuse a random reachable executor for ${instance.cwdRealpath}.`);
    }
    try {
        await startExecutorWebDetached(cwd, instance, config.executorCommand, options);
    }
    catch (error) {
        if (error instanceof Error && /ENOENT/.test(error.message)) {
            throw new Error(`Executor command "${config.executorCommand}" was not found. Install executor first.`);
        }
        throw error;
    }
    try {
        await waitForReachability(instance.baseUrl, true, config.startupTimeoutMs, options);
    }
    catch {
        throw new Error(`Executor did not become reachable at ${instance.baseUrl} (port ${instance.port}) within ${config.startupTimeoutMs}ms. Check ${instance.logFile}.`);
    }
    return instance;
};
const getOpenCommand = (url) => {
    if (process.platform === "darwin") {
        return { command: "open", args: [url] };
    }
    if (process.platform === "win32") {
        return { command: "cmd", args: ["/c", "start", "", url] };
    }
    return { command: "xdg-open", args: [url] };
};
export const openBrowser = async (url, options) => await new Promise((resolve, reject) => {
    const { command, args } = getOpenCommand(url);
    const child = (options?.spawnImpl ?? DEFAULT_SPAWN)(command, args, {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
        child.unref();
        resolve();
    });
});
export const getInstanceRecordPath = (instanceId, agentDir) => join(getAgentDir(agentDir), INSTANCE_DIRECTORY_NAME, "instances", instanceId, INSTANCE_RECORD_FILE_NAME);
export const getConfigPaths = (cwd, agentDir) => ({
    global: join(getAgentDir(agentDir), GLOBAL_CONFIG_FILE_NAME),
    project: join(cwd, ".pi", GLOBAL_CONFIG_FILE_NAME),
});
