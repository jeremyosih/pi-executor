import type { ExecutionEnvelope, ExecutionInteraction, ExecutionStatus, InteractionMode, JsonObject, LocalInstallation } from "./types.js";
type FetchLike = typeof fetch;
type RequestOptions = {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    timeoutMs?: number;
};
type PollExecutionOptions = RequestOptions & {
    initialEnvelope?: ExecutionEnvelope;
    intervalMs?: number;
    untilChangeFrom?: {
        status: ExecutionStatus;
        interactionId: string | null;
    };
    returnLastOnTimeout?: boolean;
};
export type ParsedInteractionPayload = {
    message: string;
    mode: InteractionMode;
    url: string | null;
    requestedSchema: JsonObject | null;
};
export declare const isTerminalStatus: (status: ExecutionStatus) => boolean;
export declare const getInstallation: (baseUrl: string, options?: RequestOptions) => Promise<LocalInstallation>;
export declare const createExecution: (baseUrl: string, workspaceId: string, code: string, options?: RequestOptions) => Promise<ExecutionEnvelope>;
export declare const getExecution: (baseUrl: string, workspaceId: string, executionId: string, options?: RequestOptions) => Promise<ExecutionEnvelope>;
export declare const resumeExecution: (baseUrl: string, workspaceId: string, executionId: string, responseJson: string | undefined, options?: RequestOptions) => Promise<ExecutionEnvelope>;
export declare const parseInteractionPayload: (interaction: ExecutionInteraction) => ParsedInteractionPayload | null;
export declare const pollExecution: (baseUrl: string, workspaceId: string, executionId: string, options?: PollExecutionOptions) => Promise<ExecutionEnvelope>;
export {};
