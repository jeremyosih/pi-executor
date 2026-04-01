import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXECUTOR_COMMAND, DEFAULT_LOGIN_PATH, DEFAULT_STARTUP_TIMEOUT_MS, GLOBAL_CONFIG_FILE_NAME, PROJECT_CONFIG_DIRECTORY, } from "./constants.js";
const DEFAULT_CONFIG = {
    executorCommand: DEFAULT_EXECUTOR_COMMAND,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    loginPath: DEFAULT_LOGIN_PATH,
    autoProbeOnSessionStart: true,
};
const isJsonObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isFilePresent = async (filePath) => {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
};
const getString = (value, key, source) => {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new Error(`${source}: "${key}" must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`${source}: "${key}" must not be empty`);
    }
    return trimmed;
};
const getBoolean = (value, key, source) => {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throw new Error(`${source}: "${key}" must be a boolean`);
    }
    return value;
};
const getPort = (value, key, source) => {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${source}: "${key}" must be an integer`);
    }
    if (value < 1 || value > 65_535) {
        throw new Error(`${source}: "${key}" must be between 1 and 65535`);
    }
    return value;
};
const normalizeLoginPath = (value, source) => {
    if (value.includes("://") || value.startsWith("//")) {
        throw new Error(`${source}: "loginPath" must be a relative path`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`${source}: "loginPath" must not be empty`);
    }
    const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    try {
        const parsed = new URL(normalized, "http://127.0.0.1");
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    catch {
        throw new Error(`${source}: "loginPath" is malformed`);
    }
};
const getStartupTimeout = (value, source) => {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${source}: "startupTimeoutMs" must be an integer`);
    }
    if (value < 1) {
        throw new Error(`${source}: "startupTimeoutMs" must be greater than 0`);
    }
    return value;
};
const parseConfigObject = (value, source) => {
    if (!isJsonObject(value)) {
        throw new Error(`${source}: expected a JSON object`);
    }
    const executorCommand = getString(value.executorCommand, "executorCommand", source);
    const loginPathValue = getString(value.loginPath, "loginPath", source);
    const parsed = {};
    if (executorCommand !== undefined) {
        parsed.executorCommand = executorCommand;
    }
    const startupTimeoutMs = getStartupTimeout(value.startupTimeoutMs, source);
    if (startupTimeoutMs !== undefined) {
        parsed.startupTimeoutMs = startupTimeoutMs;
    }
    if (loginPathValue !== undefined) {
        parsed.loginPath = normalizeLoginPath(loginPathValue, source);
    }
    const autoProbeOnSessionStart = getBoolean(value.autoProbeOnSessionStart, "autoProbeOnSessionStart", source);
    if (autoProbeOnSessionStart !== undefined) {
        parsed.autoProbeOnSessionStart = autoProbeOnSessionStart;
    }
    const port = getPort(value.port, "port", source);
    if (port !== undefined) {
        parsed.port = port;
    }
    return parsed;
};
const readConfigFile = async (filePath) => {
    if (!(await isFilePresent(filePath))) {
        return null;
    }
    const source = filePath;
    const text = await readFile(filePath, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error(`${source}: malformed JSON`);
    }
    return parseConfigObject(parsed, source);
};
export const getAgentDir = (agentDir) => agentDir ?? join(homedir(), ".pi", "agent");
export const getGlobalConfigPath = (options) => join(getAgentDir(options?.agentDir), GLOBAL_CONFIG_FILE_NAME);
export const getProjectConfigPath = (cwd) => join(cwd, PROJECT_CONFIG_DIRECTORY, GLOBAL_CONFIG_FILE_NAME);
export const loadConfig = async (cwd, options) => {
    const globalConfig = await readConfigFile(getGlobalConfigPath(options));
    const projectConfig = await readConfigFile(getProjectConfigPath(cwd));
    const resolved = {
        executorCommand: projectConfig?.executorCommand ?? globalConfig?.executorCommand ?? DEFAULT_CONFIG.executorCommand,
        startupTimeoutMs: projectConfig?.startupTimeoutMs ?? globalConfig?.startupTimeoutMs ?? DEFAULT_CONFIG.startupTimeoutMs,
        loginPath: projectConfig?.loginPath ?? globalConfig?.loginPath ?? DEFAULT_CONFIG.loginPath,
        autoProbeOnSessionStart: projectConfig?.autoProbeOnSessionStart
            ?? globalConfig?.autoProbeOnSessionStart
            ?? DEFAULT_CONFIG.autoProbeOnSessionStart,
    };
    const port = projectConfig?.port ?? globalConfig?.port;
    if (port !== undefined) {
        resolved.port = port;
    }
    return resolved;
};
