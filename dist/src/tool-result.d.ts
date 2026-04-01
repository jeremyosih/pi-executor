import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { ExecutionEnvelope, ExecutorInstance, ExecutorToolDetails, InteractionSummary, LocalInstallation } from "./types.js";
export declare const summarizeInteraction: (envelope: ExecutionEnvelope) => InteractionSummary | null;
export declare const normalizeDetails: (instance: ExecutorInstance, installation: LocalInstallation, envelope: ExecutionEnvelope) => ExecutorToolDetails;
export declare const buildToolResult: (details: ExecutorToolDetails) => AgentToolResult<ExecutorToolDetails>;
