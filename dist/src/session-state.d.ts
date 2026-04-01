import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ExecutorToolDetails, PiExecutorSessionState } from "./types.js";
export declare const createState: (details: ExecutorToolDetails) => PiExecutorSessionState;
export declare const restoreState: (ctx: ExtensionContext) => PiExecutorSessionState | null;
