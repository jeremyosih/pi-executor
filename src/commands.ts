import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { JsonObject } from "./http.ts";
import { ensureSidecar, SidecarError, stopOwnedSidecarForCwd } from "./sidecar.ts";

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

const notifyResult = (pi: ExtensionAPI, customType: string, text: string, details: JsonObject): void => {
  pi.sendMessage({
    customType,
    content: text,
    display: true,
    details,
  });
};

const handleExecutorWeb = async (pi: ExtensionAPI, cwd: string): Promise<void> => {
  const sidecar = await ensureSidecar(cwd);

  // We do not shell out to `executor web` here because upstream `executor web`
  // starts a new foreground server process and waits for Ctrl+C. In Pi we already
  // have a cwd-scoped sidecar, so the command should reuse that server and just
  // reveal/open its URL.
  try {
    await launchBrowser(sidecar.baseUrl);
    notifyResult(pi, "executor-web", `Executor UI: ${sidecar.baseUrl}`, {
      baseUrl: sidecar.baseUrl,
      scopeId: sidecar.scope?.id ?? "",
      launched: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyResult(pi, "executor-web", `Executor UI: ${sidecar.baseUrl}\n\nBrowser launch failed: ${message}`, {
      baseUrl: sidecar.baseUrl,
      scopeId: sidecar.scope?.id ?? "",
      launched: false,
    });
  }
};

const handleExecutorStart = async (pi: ExtensionAPI, cwd: string): Promise<void> => {
  const sidecar = await ensureSidecar(cwd);
  notifyResult(pi, "executor-start", `Executor sidecar ready: ${sidecar.baseUrl}`, {
    baseUrl: sidecar.baseUrl,
    scopeId: sidecar.scope?.id ?? "",
    ownedByPi: sidecar.ownedByPi,
  });
};

const handleExecutorStop = async (pi: ExtensionAPI, cwd: string): Promise<void> => {
  const outcome = await stopOwnedSidecarForCwd(cwd);

  if (outcome === "stopped") {
    notifyResult(pi, "executor-stop", "Stopped Pi-owned Executor sidecar for this cwd.", {
      cwd,
      stopped: true,
    });
    return;
  }

  if (outcome === "unowned") {
    notifyResult(pi, "executor-stop", "Found an Executor sidecar for this cwd, but Pi did not start it, so it was left running.", {
      cwd,
      stopped: false,
      reason: "unowned",
    });
    return;
  }

  notifyResult(pi, "executor-stop", "No Pi-owned Executor sidecar is currently tracked for this cwd.", {
    cwd,
    stopped: false,
    reason: "missing",
  });
};

export const registerExecutorCommands = (pi: ExtensionAPI): void => {
  pi.registerCommand("executor-web", {
    description: "Ensure the cwd-scoped Executor sidecar and open its web UI.",
    handler: async (args, ctx) => {
      assertNoArgs("executor-web", args);
      await handleExecutorWeb(pi, ctx.cwd);
    },
  });

  pi.registerCommand("executor-start", {
    description: "Ensure the cwd-scoped Executor sidecar is running and print its URL.",
    handler: async (args, ctx) => {
      assertNoArgs("executor-start", args);
      await handleExecutorStart(pi, ctx.cwd);
    },
  });

  pi.registerCommand("executor-stop", {
    description: "Stop the Pi-owned Executor sidecar for the current working directory.",
    handler: async (args, ctx) => {
      assertNoArgs("executor-stop", args);
      await handleExecutorStop(pi, ctx.cwd);
    },
  });
};
