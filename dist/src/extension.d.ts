import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ExecutionEnvelope, ExecutionStatus, ExecutorInstance, LocalInstallation, ResolvedPiExecutorConfig } from "./types.js";
export type PiExecutorServices = {
    loadConfig(cwd: string): Promise<ResolvedPiExecutorConfig>;
    resolveExecutorInstance(cwd: string, config: ResolvedPiExecutorConfig): Promise<ExecutorInstance>;
    ensureExecutorRunning(cwd: string, config: ResolvedPiExecutorConfig): Promise<ExecutorInstance>;
    isReachable(baseUrl: string): Promise<boolean>;
    openBrowser(url: string): Promise<void>;
    getInstallation(baseUrl: string, options?: {
        signal?: AbortSignal;
    }): Promise<LocalInstallation>;
    createExecution(baseUrl: string, workspaceId: string, code: string, options?: {
        signal?: AbortSignal;
    }): Promise<ExecutionEnvelope>;
    getExecution(baseUrl: string, workspaceId: string, executionId: string, options?: {
        signal?: AbortSignal;
    }): Promise<ExecutionEnvelope>;
    resumeExecution(baseUrl: string, workspaceId: string, executionId: string, responseJson: string | undefined, options?: {
        signal?: AbortSignal;
    }): Promise<ExecutionEnvelope>;
    pollExecution(baseUrl: string, workspaceId: string, executionId: string, options?: {
        signal?: AbortSignal;
        initialEnvelope?: ExecutionEnvelope;
        untilChangeFrom?: {
            status: ExecutionStatus;
            interactionId: string | null;
        };
        returnLastOnTimeout?: boolean;
    }): Promise<ExecutionEnvelope>;
};
export declare const createPiExecutorExtension: (overrides?: Partial<PiExecutorServices>) => (pi: ExtensionAPI) => void;
declare const _default: (pi: ExtensionAPI) => void;
export default _default;
