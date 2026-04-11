import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerExecutorCommands } from "./commands.ts";
import { shutdownOwnedSidecars } from "./sidecar.ts";
import { registerExecutorTools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
  registerExecutorTools(pi);
  registerExecutorCommands(pi);

  pi.on("session_shutdown", async () => {
    await shutdownOwnedSidecars();
  });
}
