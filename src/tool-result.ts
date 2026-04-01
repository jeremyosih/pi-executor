import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { parseInteractionPayload } from "./executor-http.js";
import type {
	ExecutionEnvelope,
	ExecutorInstance,
	ExecutorToolDetails,
	InteractionSummary,
	LocalInstallation,
} from "./types.js";

export const summarizeInteraction = (envelope: ExecutionEnvelope): InteractionSummary | null => {
	if (!envelope.pendingInteraction) {
		return null;
	}

	const parsed = parseInteractionPayload(envelope.pendingInteraction);

	return {
		id: envelope.pendingInteraction.id,
		purpose: envelope.pendingInteraction.purpose,
		kind: envelope.pendingInteraction.kind,
		message: parsed?.message ?? "Interaction required",
		mode: parsed?.mode ?? null,
		url: parsed?.url ?? null,
		requestedSchema: parsed?.requestedSchema ?? null,
	};
};

export const normalizeDetails = (
	instance: ExecutorInstance,
	installation: LocalInstallation,
	envelope: ExecutionEnvelope,
): ExecutorToolDetails => {
	const interaction = summarizeInteraction(envelope);
	const nextAction =
		envelope.execution.status === "waiting_for_interaction"
			? interaction?.mode === "url"
				? {
						kind: "open_url_or_resume" as const,
						url: interaction.url,
					}
				: {
						kind: "resume_with_responseJson" as const,
					}
			: {
					kind: "none" as const,
				};

	return {
		instanceId: instance.instanceId,
		baseUrl: instance.baseUrl,
		scopeId: installation.scopeId,
		executionId: envelope.execution.id,
		status: envelope.execution.status,
		resultJson: envelope.execution.resultJson,
		errorText: envelope.execution.errorText,
		logsJson: envelope.execution.logsJson,
		interaction,
		nextAction,
	};
};

const buildToolText = (details: ExecutorToolDetails): string => {
	switch (details.status) {
		case "completed":
			return `Executor execution completed: ${details.executionId}.`;
		case "failed":
			return `Executor execution failed: ${details.executionId}.`;
		case "cancelled":
			return `Executor execution was cancelled: ${details.executionId}.`;
		case "waiting_for_interaction":
			return details.nextAction.kind === "open_url_or_resume"
				? "Executor execution is waiting for interaction. Complete the browser flow, then resume if needed."
				: "Executor execution is waiting for interaction. Call executor_resume with responseJson that matches interaction.requestedSchema.";
		case "pending":
		case "running":
			return `Executor execution is still ${details.status}: ${details.executionId}.`;
	}
};

export const buildToolResult = (details: ExecutorToolDetails): AgentToolResult<ExecutorToolDetails> => ({
	content: [
		{
			type: "text",
			text: buildToolText(details),
		},
	],
	details,
});
