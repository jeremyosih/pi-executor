import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getScope } from "./http.ts";
import type { ExecutorSettings } from "./settings.ts";
import { findRunningSidecarForCwd } from "./sidecar.ts";

export type ExecutorRuntimeState =
  | { kind: "idle" }
  | { kind: "connecting"; mode: "local" | "remote" }
  | { kind: "ready"; mode: "local" | "remote"; baseUrl: string }
  | { kind: "error"; message: string };

const statesByCwd = new Map<string, ExecutorRuntimeState>();

export const getExecutorState = (cwd: string): ExecutorRuntimeState =>
  statesByCwd.get(cwd) ?? { kind: "idle" };

export const setExecutorState = (cwd: string, state: ExecutorRuntimeState): void => {
  statesByCwd.set(cwd, state);
};

export const clearExecutorState = (cwd: string): void => {
  statesByCwd.delete(cwd);
};

export const renderExecutorStatus = (
  ctx: ExtensionContext,
  settings: ExecutorSettings,
  cwd: string,
): void => {
  if (!settings.showFooterStatus) {
    ctx.ui.setStatus("executor", undefined);
    return;
  }

  const state = getExecutorState(cwd);
  const theme = ctx.ui.theme;

  switch (state.kind) {
    case "ready":
      ctx.ui.setStatus("executor", theme.fg("success", "●") + theme.fg("dim", " executor ready"));
      return;
    case "connecting":
      ctx.ui.setStatus(
        "executor",
        theme.fg("warning", "●") + theme.fg("dim", " executor connecting"),
      );
      return;
    case "error":
      ctx.ui.setStatus("executor", theme.fg("error", "●") + theme.fg("dim", " executor error"));
      return;
    default:
      ctx.ui.setStatus("executor", theme.fg("dim", "○") + theme.fg("dim", " executor down"));
  }
};

export const refreshExecutorStatus = async (
  ctx: ExtensionContext,
  settings: ExecutorSettings,
  cwd: string,
): Promise<void> => {
  if (!settings.showFooterStatus) {
    ctx.ui.setStatus("executor", undefined);
    return;
  }

  if (settings.mode === "remote") {
    if (settings.remoteUrl.length === 0) {
      setExecutorState(cwd, { kind: "idle" });
      renderExecutorStatus(ctx, settings, cwd);
      return;
    }

    try {
      await getScope(settings.remoteUrl);
      setExecutorState(cwd, { kind: "ready", mode: "remote", baseUrl: settings.remoteUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExecutorState(cwd, { kind: "error", message });
    }

    renderExecutorStatus(ctx, settings, cwd);
    return;
  }

  const sidecar = await findRunningSidecarForCwd(cwd);
  if (sidecar) {
    setExecutorState(cwd, { kind: "ready", mode: "local", baseUrl: sidecar.baseUrl });
  } else {
    setExecutorState(cwd, { kind: "idle" });
  }

  renderExecutorStatus(ctx, settings, cwd);
};
