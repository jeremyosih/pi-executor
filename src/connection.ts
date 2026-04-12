import type { ScopeInfo } from "./http.ts";
import { getScope } from "./http.ts";
import { resolveExecutorSettings } from "./settings.ts";
import { ensureSidecar } from "./sidecar.ts";

export type ExecutorEndpoint = {
  mode: "local" | "remote";
  baseUrl: string;
  ownedByPi: boolean;
  scope: ScopeInfo;
};

const assertRemoteUrl = (remoteUrl: string): string => {
  if (remoteUrl.length === 0) {
    throw new Error("piExecutor.remoteUrl is required when piExecutor.mode is 'remote'");
  }

  try {
    return new URL(remoteUrl).toString().replace(/\/+$/, "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid piExecutor.remoteUrl: ${message}`);
  }
};

export const resolveExecutorEndpoint = async (cwd: string): Promise<ExecutorEndpoint> => {
  const settings = await resolveExecutorSettings(cwd);

  if (settings.mode === "remote") {
    const baseUrl = assertRemoteUrl(settings.remoteUrl);
    const scope = await getScope(baseUrl);
    return {
      mode: "remote",
      baseUrl,
      ownedByPi: false,
      scope,
    };
  }

  const sidecar = await ensureSidecar(cwd);
  if (!sidecar.scope) {
    throw new Error(`Executor sidecar scope id missing for ${cwd}`);
  }

  return {
    mode: "local",
    baseUrl: sidecar.baseUrl,
    ownedByPi: sidecar.ownedByPi,
    scope: sidecar.scope,
  };
};
