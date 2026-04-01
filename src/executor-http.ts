import {
	DEFAULT_BRIEF_POLL_TIMEOUT_MS,
	DEFAULT_EXECUTION_POLL_TIMEOUT_MS,
	DEFAULT_POLL_INTERVAL_MS,
} from "./constants.js";
import type {
	Execution,
	ExecutionEnvelope,
	ExecutionInteraction,
	ExecutionStatus,
	InteractionMode,
	JsonObject,
	JsonValue,
	LocalInstallation,
} from "./types.js";

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

const DEFAULT_FETCH: FetchLike = fetch;

const TERMINAL_STATUSES: ExecutionStatus[] = ["completed", "failed", "cancelled"];

const isJsonObject = (value: JsonValue): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const sleep = async (durationMs: number, signal?: AbortSignal): Promise<void> => {
	if (durationMs <= 0) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
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

const isExecutionStatus = (value: JsonValue): value is ExecutionStatus =>
	value === "pending"
	|| value === "running"
	|| value === "waiting_for_interaction"
	|| value === "completed"
	|| value === "failed"
	|| value === "cancelled";

const parseExecution = (value: JsonValue): Execution => {
	if (!isJsonObject(value)) {
		throw new Error("Malformed executor response: execution must be an object");
	}
	const status = value.status ?? null;

	if (
		typeof value.id !== "string"
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
		|| typeof value.updatedAt !== "number"
	) {
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

const parseExecutionInteraction = (value: JsonValue): ExecutionInteraction => {
	if (!isJsonObject(value)) {
		throw new Error("Malformed executor response: pendingInteraction must be an object");
	}

	if (
		typeof value.id !== "string"
		|| typeof value.executionId !== "string"
		|| (value.status !== "pending" && value.status !== "resolved" && value.status !== "cancelled")
		|| typeof value.kind !== "string"
		|| typeof value.purpose !== "string"
		|| typeof value.payloadJson !== "string"
		|| (value.responseJson !== null && typeof value.responseJson !== "string")
		|| (value.responsePrivateJson !== null && typeof value.responsePrivateJson !== "string")
		|| typeof value.createdAt !== "number"
		|| typeof value.updatedAt !== "number"
	) {
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

const parseExecutionEnvelope = (value: JsonValue): ExecutionEnvelope => {
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

const parseLocalInstallation = (value: JsonValue): LocalInstallation => {
	if (!isJsonObject(value)) {
		throw new Error("Malformed executor response: installation must be an object");
	}

	if (
		typeof value.scopeId !== "string"
		|| typeof value.actorScopeId !== "string"
		|| !Array.isArray(value.resolutionScopeIds)
		|| value.resolutionScopeIds.some((item) => typeof item !== "string")
	) {
		throw new Error("Malformed executor response: installation shape is invalid");
	}

	const resolutionScopeIds: string[] = [];
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

const createRequestSignal = (
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; cleanup(): void } => {
	if (timeoutMs === undefined) {
		return {
			signal,
			cleanup() {},
		};
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

	const onAbort = () => controller.abort(new Error("Operation aborted"));
	if (signal) {
		if (signal.aborted) {
			controller.abort(new Error("Operation aborted"));
		} else {
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

const requestJson = async (
	baseUrl: string,
	path: string,
	init: RequestInit | undefined,
	options: RequestOptions,
): Promise<JsonValue> => {
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

		return responseText.length === 0 ? null : (JSON.parse(responseText) as JsonValue);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Malformed executor response from ${path}`);
		}
		if (error instanceof Error) {
			throw error;
		}
		throw new Error(String(error));
	} finally {
		cleanup();
	}
};

export const isTerminalStatus = (status: ExecutionStatus): boolean => TERMINAL_STATUSES.includes(status);

export const getInstallation = async (
	baseUrl: string,
	options: RequestOptions = {},
): Promise<LocalInstallation> => parseLocalInstallation(await requestJson(baseUrl, "/v1/local/installation", undefined, options));

export const createExecution = async (
	baseUrl: string,
	workspaceId: string,
	code: string,
	options: RequestOptions = {},
): Promise<ExecutionEnvelope> =>
	parseExecutionEnvelope(
		await requestJson(
			baseUrl,
			`/v1/workspaces/${workspaceId}/executions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					code,
					interactionMode: "detach",
				}),
			},
			options,
		),
	);

export const getExecution = async (
	baseUrl: string,
	workspaceId: string,
	executionId: string,
	options: RequestOptions = {},
): Promise<ExecutionEnvelope> =>
	parseExecutionEnvelope(
		await requestJson(baseUrl, `/v1/workspaces/${workspaceId}/executions/${executionId}`, undefined, options),
	);

export const resumeExecution = async (
	baseUrl: string,
	workspaceId: string,
	executionId: string,
	responseJson: string | undefined,
	options: RequestOptions = {},
): Promise<ExecutionEnvelope> =>
	parseExecutionEnvelope(
		await requestJson(
			baseUrl,
			`/v1/workspaces/${workspaceId}/executions/${executionId}/resume`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					...(responseJson === undefined ? {} : { responseJson }),
					interactionMode: "detach",
				}),
			},
			options,
		),
	);

export const parseInteractionPayload = (interaction: ExecutionInteraction): ParsedInteractionPayload | null => {
	try {
		const payload = JSON.parse(interaction.payloadJson) as JsonValue;
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

		const mode: InteractionMode = elicitation.mode === "url" ? "url" : "form";
		const url = typeof elicitation.url === "string" ? elicitation.url : null;
		const requestedSchemaValue = elicitation.requestedSchema ?? null;
		const requestedSchema = isJsonObject(requestedSchemaValue) ? requestedSchemaValue : null;

		return {
			message: elicitation.message,
			mode,
			url,
			requestedSchema,
		};
	} catch {
		return null;
	}
};

export const pollExecution = async (
	baseUrl: string,
	workspaceId: string,
	executionId: string,
	options: PollExecutionOptions = {},
): Promise<ExecutionEnvelope> => {
	let current = options.initialEnvelope ?? (await getExecution(baseUrl, workspaceId, executionId, options));
	const startedAt = Date.now();

	while (true) {
		if (options.untilChangeFrom) {
			const interactionId = current.pendingInteraction?.id ?? null;
			if (
				current.execution.status !== options.untilChangeFrom.status
				|| interactionId !== options.untilChangeFrom.interactionId
			) {
				return current;
			}
		} else if (isTerminalStatus(current.execution.status) || current.execution.status === "waiting_for_interaction") {
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
