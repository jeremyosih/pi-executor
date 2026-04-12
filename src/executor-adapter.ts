import type { JsonObject, JsonValue } from "./http.ts";

export type ExecuteToolDetails = {
  baseUrl: string;
  scopeId: string;
  structuredContent: JsonValue;
  isError: boolean;
  executionId?: string;
};

export type ExecuteToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ExecuteToolDetails;
};

type ExecutorToolOutcome = {
  text: string;
  structuredContent: JsonValue;
  isError: boolean;
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readExecutionId = (structuredContent: JsonValue): string | undefined => {
  if (!isJsonObject(structuredContent)) {
    return undefined;
  }

  return structuredContent.status === "waiting_for_interaction" &&
    typeof structuredContent.executionId === "string"
    ? structuredContent.executionId
    : undefined;
};

export const parseJsonContent = (raw: string | undefined): JsonObject | undefined => {
  if (!raw || raw === "{}") {
    return undefined;
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }

  return isJsonObject(parsed) ? parsed : undefined;
};

export const toToolResult = (
  outcome: ExecutorToolOutcome,
  meta: { baseUrl: string; scopeId: string },
): ExecuteToolResult => ({
  content: [{ type: "text", text: outcome.text }],
  details: {
    baseUrl: meta.baseUrl,
    scopeId: meta.scopeId,
    structuredContent: outcome.structuredContent,
    isError: outcome.isError,
    executionId: readExecutionId(outcome.structuredContent),
  },
});

export const buildExecutorSystemPrompt = (description: string, hasResume: boolean): string =>
  [
    "Executor MCP parity guidance:",
    description,
    "",
    hasResume
      ? "This Pi session has no managed elicitation path available. If execute returns waiting_for_interaction, call resume with the exact executionId."
      : "This Pi session has UI available. Use execute for Executor work and let it handle any interaction inline. Do not call resume unless execute explicitly cannot complete inline.",
  ].join("\n");
