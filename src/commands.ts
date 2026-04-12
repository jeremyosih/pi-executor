import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { JsonObject } from "./http.ts";
import { resolveExecutorEndpoint } from "./connection.ts";
import { resolveExecutorSettings, updateExecutorSettings, type SettingsScope } from "./settings.ts";
import { refreshExecutorStatus, renderExecutorStatus, setExecutorState } from "./status.ts";
import { SidecarError, stopSidecarForCwd } from "./sidecar.ts";

const assertNoArgs = (commandName: string, args: string): void => {
  if (args.trim().length > 0) {
    throw new Error(`Usage: /${commandName}`);
  }
};

const launchBrowser = async (url: string): Promise<void> => {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  const launcher =
    platform === "darwin"
      ? { command: "open", args: [url] }
      : platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(launcher.command, launcher.args, {
      stdio: "ignore",
      detached: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new SidecarError("LAUNCHER_FAILED", `Failed to open browser for ${url}: ${message}`);
  });
};

const notifyResult = (
  pi: ExtensionAPI,
  customType: string,
  text: string,
  details: JsonObject,
): void => {
  pi.sendMessage({
    customType,
    content: text,
    display: true,
    details,
  });
};

const connectExecutor = async (ctx: ExtensionCommandContext) => {
  const settings = await resolveExecutorSettings(ctx.cwd);
  setExecutorState(ctx.cwd, { kind: "connecting", mode: settings.mode });
  renderExecutorStatus(ctx, settings, ctx.cwd);

  try {
    const endpoint = await resolveExecutorEndpoint(ctx.cwd);
    setExecutorState(ctx.cwd, {
      kind: "ready",
      mode: endpoint.mode,
      baseUrl: endpoint.baseUrl,
    });
    renderExecutorStatus(ctx, settings, ctx.cwd);
    return { endpoint, settings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setExecutorState(ctx.cwd, { kind: "error", message });
    renderExecutorStatus(ctx, settings, ctx.cwd);
    throw error;
  }
};

const handleExecutorWeb = async (pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> => {
  const { endpoint } = await connectExecutor(ctx);

  try {
    await launchBrowser(endpoint.baseUrl);
    notifyResult(pi, "executor-web", `Executor UI: ${endpoint.baseUrl}`, {
      baseUrl: endpoint.baseUrl,
      scopeId: endpoint.scope.id,
      launched: true,
      mode: endpoint.mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyResult(
      pi,
      "executor-web",
      `Executor UI: ${endpoint.baseUrl}\n\nBrowser launch failed: ${message}`,
      {
        baseUrl: endpoint.baseUrl,
        scopeId: endpoint.scope.id,
        launched: false,
        mode: endpoint.mode,
      },
    );
  }
};

const handleExecutorStart = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const { endpoint } = await connectExecutor(ctx);
  const label =
    endpoint.mode === "remote" ? "Executor remote endpoint ready" : "Executor sidecar ready";

  notifyResult(pi, "executor-start", `${label}: ${endpoint.baseUrl}`, {
    baseUrl: endpoint.baseUrl,
    scopeId: endpoint.scope.id,
    ownedByPi: endpoint.ownedByPi,
    mode: endpoint.mode,
  });
};

const handleExecutorStop = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const settings = await resolveExecutorSettings(ctx.cwd);
  if (settings.mode === "remote") {
    notifyResult(
      pi,
      "executor-stop",
      "Remote executor mode is enabled, so there is no local sidecar for Pi to stop.",
      {
        cwd: ctx.cwd,
        stopped: false,
        reason: "remote",
      },
    );
    return;
  }

  const outcome = await stopSidecarForCwd(ctx.cwd);

  if (outcome === "stopped") {
    setExecutorState(ctx.cwd, { kind: "idle" });
    renderExecutorStatus(ctx, settings, ctx.cwd);
    notifyResult(pi, "executor-stop", "Stopped Executor sidecar for this cwd.", {
      cwd: ctx.cwd,
      stopped: true,
    });
    return;
  }

  await refreshExecutorStatus(ctx, settings, ctx.cwd);
  notifyResult(pi, "executor-stop", "No Executor sidecar is currently running for this cwd.", {
    cwd: ctx.cwd,
    stopped: false,
    reason: "missing",
  });
};

const chooseSettingsScope = async (
  ctx: ExtensionCommandContext,
): Promise<SettingsScope | undefined> => {
  const scope = await ctx.ui.select("Save executor setting where?", ["project", "global"], {
    timeout: undefined,
  });
  return scope === "project" || scope === "global" ? scope : undefined;
};

const showSettingsSummary = (
  pi: ExtensionAPI,
  cwd: string,
  settings: Awaited<ReturnType<typeof resolveExecutorSettings>>,
): void => {
  notifyResult(
    pi,
    "executor-settings",
    [
      "Executor settings",
      `mode: ${settings.mode}`,
      `autoStart: ${settings.autoStart}`,
      `remoteUrl: ${settings.remoteUrl || "(not set)"}`,
      `showFooterStatus: ${settings.showFooterStatus}`,
      `stopLocalOnShutdown: ${settings.stopLocalOnShutdown}`,
      `cwd: ${cwd}`,
    ].join("\n"),
    {
      cwd,
      mode: settings.mode,
      autoStart: settings.autoStart,
      remoteUrl: settings.remoteUrl,
      showFooterStatus: settings.showFooterStatus,
      stopLocalOnShutdown: settings.stopLocalOnShutdown,
    },
  );
};

const handleExecutorSettings = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  for (;;) {
    const settings = await resolveExecutorSettings(ctx.cwd);
    await refreshExecutorStatus(ctx, settings, ctx.cwd);

    const action = await ctx.ui.select(
      "Executor settings",
      [
        `show current (${settings.mode})`,
        `set mode (${settings.mode})`,
        `toggle autoStart (${settings.autoStart})`,
        `set remoteUrl (${settings.remoteUrl || "not set"})`,
        `toggle footer status (${settings.showFooterStatus})`,
        `toggle stop on shutdown (${settings.stopLocalOnShutdown})`,
        "done",
      ],
      { timeout: undefined },
    );

    if (!action || action === "done") {
      return;
    }

    if (action.startsWith("show current")) {
      showSettingsSummary(pi, ctx.cwd, settings);
      continue;
    }

    const scope = await chooseSettingsScope(ctx);
    if (!scope) {
      return;
    }

    if (action.startsWith("set mode")) {
      const mode = await ctx.ui.select("Executor mode", ["local", "remote"], {
        timeout: undefined,
      });
      if (!mode || (mode !== "local" && mode !== "remote")) {
        continue;
      }
      const next = await updateExecutorSettings(ctx.cwd, scope, { mode });
      if (mode === "local") {
        setExecutorState(ctx.cwd, { kind: "idle" });
      }
      await refreshExecutorStatus(ctx, next, ctx.cwd);
      showSettingsSummary(pi, ctx.cwd, next);
      continue;
    }

    if (action.startsWith("toggle autoStart")) {
      const next = await updateExecutorSettings(ctx.cwd, scope, {
        autoStart: !settings.autoStart,
      });
      await refreshExecutorStatus(ctx, next, ctx.cwd);
      showSettingsSummary(pi, ctx.cwd, next);
      continue;
    }

    if (action.startsWith("set remoteUrl")) {
      const remoteUrl = await ctx.ui.input("Remote executor URL", settings.remoteUrl || "https://");
      if (remoteUrl === undefined) {
        continue;
      }
      const next = await updateExecutorSettings(ctx.cwd, scope, { remoteUrl });
      await refreshExecutorStatus(ctx, next, ctx.cwd);
      showSettingsSummary(pi, ctx.cwd, next);
      continue;
    }

    if (action.startsWith("toggle footer status")) {
      const next = await updateExecutorSettings(ctx.cwd, scope, {
        showFooterStatus: !settings.showFooterStatus,
      });
      await refreshExecutorStatus(ctx, next, ctx.cwd);
      showSettingsSummary(pi, ctx.cwd, next);
      continue;
    }

    if (action.startsWith("toggle stop on shutdown")) {
      const next = await updateExecutorSettings(ctx.cwd, scope, {
        stopLocalOnShutdown: !settings.stopLocalOnShutdown,
      });
      await refreshExecutorStatus(ctx, next, ctx.cwd);
      showSettingsSummary(pi, ctx.cwd, next);
    }
  }
};

export const registerExecutorCommands = (pi: ExtensionAPI): void => {
  pi.registerCommand("executor-web", {
    description: "Open the configured Executor UI for this project.",
    handler: async (args, ctx) => {
      assertNoArgs("executor-web", args);
      await handleExecutorWeb(pi, ctx);
    },
  });

  pi.registerCommand("executor-start", {
    description: "Connect to the configured Executor endpoint and print its URL.",
    handler: async (args, ctx) => {
      assertNoArgs("executor-start", args);
      await handleExecutorStart(pi, ctx);
    },
  });

  pi.registerCommand("executor-stop", {
    description:
      "Stop the local Executor sidecar for the current working directory, even if another Pi session started it.",
    handler: async (args, ctx) => {
      assertNoArgs("executor-stop", args);
      await handleExecutorStop(pi, ctx);
    },
  });

  pi.registerCommand("executor-settings", {
    description: "Inspect and update pi-executor settings.",
    handler: async (args, ctx) => {
      assertNoArgs("executor-settings", args);
      await handleExecutorSettings(pi, ctx);
    },
  });
};
