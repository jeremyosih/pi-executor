import { SESSION_ENTRY_TYPE } from "./constants.js";
export const createState = (details) => ({
    lastExecutionId: details.executionId,
    lastSeenStatus: details.status,
    lastInteractionId: details.interaction?.id ?? null,
});
const isSessionStateEntry = (entry) => entry?.type === "custom" && "customType" in entry && "data" in entry && entry.data !== undefined;
export const restoreState = (ctx) => {
    const branchEntries = ctx.sessionManager.getBranch();
    for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
        const entry = branchEntries[index];
        if (!isSessionStateEntry(entry) || entry.customType !== SESSION_ENTRY_TYPE) {
            continue;
        }
        const { data } = entry;
        if (typeof data.lastExecutionId !== "string" && data.lastExecutionId !== null
            || typeof data.lastSeenStatus !== "string" && data.lastSeenStatus !== null
            || typeof data.lastInteractionId !== "string" && data.lastInteractionId !== null) {
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
