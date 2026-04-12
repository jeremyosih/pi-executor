import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerExecutorCommands } from "./commands.ts";
import { shutdownOwnedSidecars } from "./sidecar.ts";
import { isExecutorToolDetails, loadExecutorPrompt, registerExecutorTools } from "./tools.ts";

const registeredToolSets = new Set<string>();

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const key = `${ctx.cwd}:${ctx.hasUI ? "ui" : "headless"}`;
    if (registeredToolSets.has(key)) {
      return;
    }

    await registerExecutorTools(pi, ctx.cwd, ctx.hasUI);
    registeredToolSets.add(key);
  });

  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: `${event.systemPrompt}\n\n${await loadExecutorPrompt(ctx.cwd, ctx.hasUI)}`,
  }));

  pi.on("tool_result", async (event) => {
    if (
      (event.toolName === "execute" || event.toolName === "resume") &&
      typeof event.details === "object" &&
      event.details !== null &&
      isExecutorToolDetails(event.details)
    ) {
      return { isError: event.details.isError };
    }
  });

  registerExecutorCommands(pi);

  pi.on("session_shutdown", async () => {
    await shutdownOwnedSidecars();
  });
}
