import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SESSION_ENTRY_TYPE } from "./constants.js";
import type { ExecutorToolDetails, PiExecutorSessionState } from "./types.js";

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

export const createState = (details: ExecutorToolDetails): PiExecutorSessionState => ({
	lastExecutionId: details.executionId,
	lastSeenStatus: details.status,
	lastInteractionId: details.interaction?.id ?? null,
});

const isSessionStateEntry = (
	entry: SessionEntry | undefined,
): entry is {
	type: "custom";
	customType: string;
	data: PiExecutorSessionState;
} =>
	entry?.type === "custom" && "customType" in entry && "data" in entry && entry.data !== undefined;

export const restoreState = (ctx: ExtensionContext): PiExecutorSessionState | null => {
	const branchEntries = ctx.sessionManager.getBranch();

	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (!isSessionStateEntry(entry) || entry.customType !== SESSION_ENTRY_TYPE) {
			continue;
		}

		const { data } = entry;
		if (
			typeof data.lastExecutionId !== "string" && data.lastExecutionId !== null
			|| typeof data.lastSeenStatus !== "string" && data.lastSeenStatus !== null
			|| typeof data.lastInteractionId !== "string" && data.lastInteractionId !== null
		) {
			continue;
		}

		return {
			lastExecutionId: data.lastExecutionId,
			lastSeenStatus: data.lastSeenStatus,
			lastInteractionId: data.lastInteractionId,
		};
	}

	return null;
};
