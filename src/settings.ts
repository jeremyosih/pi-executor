import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ExecutorMode = "local" | "remote";
export type SettingsScope = "global" | "project";

export type ExecutorSettings = {
  mode: ExecutorMode;
  autoStart: boolean;
  remoteUrl: string;
  showFooterStatus: boolean;
  stopLocalOnShutdown: boolean;
};

type RootSettings = {
  piExecutor?: Partial<ExecutorSettings>;
  [key: string]: unknown;
};

const DEFAULT_SETTINGS: ExecutorSettings = {
  mode: "local",
  autoStart: true,
  remoteUrl: "",
  showFooterStatus: true,
  stopLocalOnShutdown: true,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeRemoteUrl = (remoteUrl: string): string => remoteUrl.trim().replace(/\/+$/, "");

const sanitizeSettings = (
  value: Partial<ExecutorSettings> | undefined,
): Partial<ExecutorSettings> => {
  if (!value) {
    return {};
  }

  const sanitized: Partial<ExecutorSettings> = {};

  if (value.mode === "local" || value.mode === "remote") {
    sanitized.mode = value.mode;
  }
  if (typeof value.autoStart === "boolean") {
    sanitized.autoStart = value.autoStart;
  }
  if (typeof value.remoteUrl === "string") {
    sanitized.remoteUrl = normalizeRemoteUrl(value.remoteUrl);
  }
  if (typeof value.showFooterStatus === "boolean") {
    sanitized.showFooterStatus = value.showFooterStatus;
  }
  if (typeof value.stopLocalOnShutdown === "boolean") {
    sanitized.stopLocalOnShutdown = value.stopLocalOnShutdown;
  }

  return sanitized;
};

const getGlobalSettingsPath = (): string =>
  join(process.env.HOME || homedir(), ".pi", "agent", "settings.json");
const getProjectSettingsPath = (cwd: string): string => join(resolve(cwd), ".pi", "settings.json");

const getSettingsPath = (cwd: string, scope: SettingsScope): string =>
  scope === "global" ? getGlobalSettingsPath() : getProjectSettingsPath(cwd);

const readRootSettings = async (path: string): Promise<RootSettings> => {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? (parsed as RootSettings) : {};
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const mergeSettings = (
  base: ExecutorSettings,
  override: Partial<ExecutorSettings> | undefined,
): ExecutorSettings => ({
  ...base,
  ...sanitizeSettings(override),
});

export const getDefaultExecutorSettings = (): ExecutorSettings => ({ ...DEFAULT_SETTINGS });

export const resolveExecutorSettings = async (cwd: string): Promise<ExecutorSettings> => {
  const globalSettings = await readRootSettings(getGlobalSettingsPath());
  const projectSettings = await readRootSettings(getProjectSettingsPath(cwd));

  return mergeSettings(
    mergeSettings(getDefaultExecutorSettings(), globalSettings.piExecutor),
    projectSettings.piExecutor,
  );
};

export const getScopedExecutorSettings = async (
  cwd: string,
  scope: SettingsScope,
): Promise<Partial<ExecutorSettings>> => {
  const settings = await readRootSettings(getSettingsPath(cwd, scope));
  return sanitizeSettings(settings.piExecutor);
};

export const updateExecutorSettings = async (
  cwd: string,
  scope: SettingsScope,
  patch: Partial<ExecutorSettings>,
): Promise<ExecutorSettings> => {
  const path = getSettingsPath(cwd, scope);
  const root = await readRootSettings(path);
  const nextPiExecutor = {
    ...sanitizeSettings(root.piExecutor),
    ...sanitizeSettings(patch),
  } satisfies Partial<ExecutorSettings>;

  const nextRoot: RootSettings = {
    ...root,
    piExecutor: nextPiExecutor,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(nextRoot, null, 2) + "\n", "utf8");

  return resolveExecutorSettings(cwd);
};

export const formatExecutorSettings = (settings: ExecutorSettings): string[] => [
  `mode: ${settings.mode}`,
  `autoStart: ${settings.autoStart}`,
  `remoteUrl: ${settings.remoteUrl || "(not set)"}`,
  `showFooterStatus: ${settings.showFooterStatus}`,
  `stopLocalOnShutdown: ${settings.stopLocalOnShutdown}`,
];
