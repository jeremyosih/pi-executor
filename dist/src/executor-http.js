import { DEFAULT_BRIEF_POLL_TIMEOUT_MS, DEFAULT_EXECUTION_POLL_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, } from "./constants.js";
const DEFAULT_FETCH = fetch;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
const isJsonObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = async (durationMs, signal) => {
    if (durationMs <= 0) {
        return;
    }
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, durationMs);
        const onAbort = () => {
            cleanup();
            reject(new Error("Operation aborted"));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        if (signal?.aborted) {
            cleanup();
            reject(new Error("Operation aborted"));
            return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
};
const isExecutionStatus = (value) => value === "pending"
    || value === "running"
    || value === "waiting_for_interaction"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
const parseExecution = (value) => {
    if (!isJsonObject(value)) {
        throw new Error("Malformed executor response: execution must be an object");
    }
    const status = value.status ?? null;
    if (typeof value.id !== "string"
        || typeof value.scopeId !== "string"
        || typeof value.createdByScopeId !== "string"
        || !isExecutionStatus(status)
        || typeof value.code !== "string"
        || (value.resultJson !== null && typeof value.resultJson !== "string")
        || (value.errorText !== null && typeof value.errorText !== "string")
        || (value.logsJson !== null && typeof value.logsJson !== "string")
        || (value.startedAt !== null && typeof value.startedAt !== "number")
        || (value.completedAt !== null && typeof value.completedAt !== "number")
        || typeof value.createdAt !== "number"
        || typeof value.updatedAt !== "number") {
        throw new Error("Malformed executor response: execution shape is invalid");
    }
    return {
        id: value.id,
        scopeId: value.scopeId,
        createdByScopeId: value.createdByScopeId,
        status,
        code: value.code,
        resultJson: value.resultJson,
        errorText: value.errorText,
        logsJson: value.logsJson,
        startedAt: value.startedAt,
        completedAt: value.completedAt,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
};
const parseExecutionInteraction = (value) => {
    if (!isJsonObject(value)) {
        throw new Error("Malformed executor response: pendingInteraction must be an object");
    }
    if (typeof value.id !== "string"
        || typeof value.executionId !== "string"
        || (value.status !== "pending" && value.status !== "resolved" && value.status !== "cancelled")
        || typeof value.kind !== "string"
        || typeof value.purpose !== "string"
        || typeof value.payloadJson !== "string"
        || (value.responseJson !== null && typeof value.responseJson !== "string")
        || (value.responsePrivateJson !== null && typeof value.responsePrivateJson !== "string")
        || typeof value.createdAt !== "number"
        || typeof value.updatedAt !== "number") {
        throw new Error("Malformed executor response: pendingInteraction shape is invalid");
    }
    return {
        id: value.id,
        executionId: value.executionId,
        status: value.status,
        kind: value.kind,
        purpose: value.purpose,
        payloadJson: value.payloadJson,
        responseJson: value.responseJson,
        responsePrivateJson: value.responsePrivateJson,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
};
const parseExecutionEnvelope = (value) => {
    if (!isJsonObject(value)) {
        throw new Error("Malformed executor response: execution envelope must be an object");
    }
    const executionValue = value.execution ?? null;
    const pendingInteractionValue = value.pendingInteraction ?? null;
    return {
        execution: parseExecution(executionValue),
        pendingInteraction: pendingInteractionValue === null ? null : parseExecutionInteraction(pendingInteractionValue),
    };
};
const parseLocalInstallation = (value) => {
    if (!isJsonObject(value)) {
        throw new Error("Malformed executor response: installation must be an object");
    }
    if (typeof value.scopeId !== "string"
        || typeof value.actorScopeId !== "string"
        || !Array.isArray(value.resolutionScopeIds)
        || value.resolutionScopeIds.some((item) => typeof item !== "string")) {
        throw new Error("Malformed executor response: installation shape is invalid");
    }
    const resolutionScopeIds = [];
    for (const item of value.resolutionScopeIds) {
        if (typeof item === "string") {
            resolutionScopeIds.push(item);
        }
    }
    return {
        scopeId: value.scopeId,
        actorScopeId: value.actorScopeId,
        resolutionScopeIds,
    };
};
const createRequestSignal = (timeoutMs, signal) => {
    if (timeoutMs === undefined) {
        return {
            signal,
            cleanup() { },
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort(new Error("Operation aborted"));
    if (signal) {
        if (signal.aborted) {
            controller.abort(new Error("Operation aborted"));
        }
        else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        },
    };
};
const requestJson = async (baseUrl, path, init, options) => {
    const { signal, cleanup } = createRequestSignal(options.timeoutMs, options.signal);
    try {
        const response = await (options.fetchImpl ?? DEFAULT_FETCH)(`${baseUrl}${path}`, {
            ...(init ?? {}),
            ...(signal ? { signal } : {}),
        });
        const responseText = await response.text();
        if (!response.ok) {
            const suffix = responseText.length > 0 ? `: ${responseText}` : "";
            throw new Error(`${response.status} ${response.statusText}${suffix}`);
        }
        return responseText.length === 0 ? null : JSON.parse(responseText);
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Malformed executor response from ${path}`);
        }
        if (error instanceof Error) {
            throw error;
        }
        throw new Error(String(error));
    }
    finally {
        cleanup();
    }
};
export const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);
export const getInstallation = async (baseUrl, options = {}) => parseLocalInstallation(await requestJson(baseUrl, "/v1/local/installation", undefined, options));
export const createExecution = async (baseUrl, workspaceId, code, options = {}) => parseExecutionEnvelope(await requestJson(baseUrl, `/v1/workspaces/${workspaceId}/executions`, {
    method: "POST",
    headers: {
        "content-type": "application/json",
    },
    body: JSON.stringify({
        code,
        interactionMode: "detach",
    }),
}, options));
export const getExecution = async (baseUrl, workspaceId, executionId, options = {}) => parseExecutionEnvelope(await requestJson(baseUrl, `/v1/workspaces/${workspaceId}/executions/${executionId}`, undefined, options));
export const resumeExecution = async (baseUrl, workspaceId, executionId, responseJson, options = {}) => parseExecutionEnvelope(await requestJson(baseUrl, `/v1/workspaces/${workspaceId}/executions/${executionId}/resume`, {
    method: "POST",
    headers: {
        "content-type": "application/json",
    },
    body: JSON.stringify({
        ...(responseJson === undefined ? {} : { responseJson }),
        interactionMode: "detach",
    }),
}, options));
export const parseInteractionPayload = (interaction) => {
    try {
        const payload = JSON.parse(interaction.payloadJson);
        if (!isJsonObject(payload)) {
            return null;
        }
        const elicitationValue = payload.elicitation ?? null;
        if (!isJsonObject(elicitationValue)) {
            return null;
        }
        const elicitation = elicitationValue;
        if (typeof elicitation.message !== "string") {
            return null;
        }
        const mode = elicitation.mode === "url" ? "url" : "form";
        const url = typeof elicitation.url === "string" ? elicitation.url : null;
        const requestedSchemaValue = elicitation.requestedSchema ?? null;
        const requestedSchema = isJsonObject(requestedSchemaValue) ? requestedSchemaValue : null;
        return {
            message: elicitation.message,
            mode,
            url,
            requestedSchema,
        };
    }
    catch {
        return null;
    }
};
export const pollExecution = async (baseUrl, workspaceId, executionId, options = {}) => {
    let current = options.initialEnvelope ?? (await getExecution(baseUrl, workspaceId, executionId, options));
    const startedAt = Date.now();
    while (true) {
        if (options.untilChangeFrom) {
            const interactionId = current.pendingInteraction?.id ?? null;
            if (current.execution.status !== options.untilChangeFrom.status
                || interactionId !== options.untilChangeFrom.interactionId) {
                return current;
            }
        }
        else if (isTerminalStatus(current.execution.status) || current.execution.status === "waiting_for_interaction") {
            return current;
        }
        const timeoutMs = options.untilChangeFrom ? DEFAULT_BRIEF_POLL_TIMEOUT_MS : DEFAULT_EXECUTION_POLL_TIMEOUT_MS;
        if (Date.now() - startedAt >= timeoutMs) {
            if (options.returnLastOnTimeout) {
                return current;
            }
            throw new Error(`Execution polling timed out for ${executionId} after ${timeoutMs}ms`);
        }
        await sleep(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, options.signal);
        current = await getExecution(baseUrl, workspaceId, executionId, options);
    }
};
