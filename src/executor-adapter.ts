import { HttpError, type ExecuteResponse, type JsonObject, type JsonValue, type ResumePayload, type ResumeResponse, listSources, listTools } from "./http.ts";

export type SourceSummary = {
  id: string;
  name: string;
};

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

export type InteractionKind = "form" | "url";

export type WaitingForInteraction = {
  executionId: string;
  kind: InteractionKind;
  message: string;
  url?: string;
  requestedSchema?: JsonObject;
};

export type ExecutionOutcome =
  | {
      status: "completed";
      text: string;
      structuredContent: JsonValue;
      isError: boolean;
    }
  | {
      status: "waiting_for_interaction";
      text: string;
      structuredContent: JsonValue;
      isError: false;
      interaction: WaitingForInteraction;
    };

export type ExecutionTransport = {
  execute: (code: string) => Promise<ExecuteResponse>;
  resume: (executionId: string, payload: ResumePayload) => Promise<ResumeResponse>;
};

export type InteractionHandler = (interaction: WaitingForInteraction) => Promise<ResumePayload>;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const isWaitingStructured = (value: JsonValue): value is JsonObject =>
  isJsonObject(value) && value.status === "waiting_for_interaction";

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

export const parseWaitingForInteraction = (
  structuredContent: JsonValue,
): WaitingForInteraction | undefined => {
  if (!isWaitingStructured(structuredContent)) {
    return undefined;
  }

  const executionId = readString(structuredContent.executionId);
  const interactionValue = structuredContent.interaction;
  if (!executionId || !isJsonObject(interactionValue)) {
    return undefined;
  }

  const kind = interactionValue.kind;
  const message = readString(interactionValue.message);
  if ((kind !== "form" && kind !== "url") || !message) {
    return undefined;
  }

  const waiting: WaitingForInteraction = {
    executionId,
    kind,
    message,
  };

  const url = readString(interactionValue.url);
  if (url) {
    waiting.url = url;
  }

  const requestedSchema = interactionValue.requestedSchema;
  if (isJsonObject(requestedSchema)) {
    waiting.requestedSchema = requestedSchema;
  }

  return waiting;
};

export const normalizeExecuteResponse = (response: ExecuteResponse): ExecutionOutcome => {
  if (response.status === "completed") {
    return {
      status: "completed",
      text: response.text,
      structuredContent: response.structured,
      isError: response.isError,
    };
  }

  const interaction = parseWaitingForInteraction(response.structured);
  if (!interaction) {
    return {
      status: "completed",
      text: response.text,
      structuredContent: response.structured,
      isError: false,
    };
  }

  return {
    status: "waiting_for_interaction",
    text: response.text,
    structuredContent: response.structured,
    isError: false,
    interaction,
  };
};

export const normalizeResumeResponse = (response: ResumeResponse): ExecutionOutcome => {
  const interaction = parseWaitingForInteraction(response.structured);
  if (!interaction) {
    return {
      status: "completed",
      text: response.text,
      structuredContent: response.structured,
      isError: response.isError,
    };
  }

  return {
    status: "waiting_for_interaction",
    text: response.text,
    structuredContent: response.structured,
    isError: false,
    interaction,
  };
};

export const toToolResult = (
  outcome: ExecutionOutcome,
  meta: { baseUrl: string; scopeId: string },
): ExecuteToolResult => ({
  content: [{ type: "text", text: outcome.text }],
  details: {
    baseUrl: meta.baseUrl,
    scopeId: meta.scopeId,
    structuredContent: outcome.structuredContent,
    isError: outcome.isError,
    executionId:
      outcome.status === "waiting_for_interaction" ? outcome.interaction.executionId : undefined,
  },
});

export const buildExecuteDescriptionFromData = (
  namespaces: readonly string[],
  sources: readonly SourceSummary[],
): string => {
  const lines: string[] = [
    "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
    '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
    "3. `const details = await tools.describe.tool({ path });`",
    "4. Use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
    "5. Use `tools.executor.sources.list()` when you need configured source inventory.",
    "6. Call the tool: `const result = await tools.<path>(input);`",
    "",
    "## Rules",
    "",
    "- `tools.search()` returns ranked matches, best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
    '- When you already know the namespace, narrow with `tools.search({ namespace: "github", query: "issues" })`.',
    "- Use `tools.executor.sources.list()` to inspect configured sources and their tool counts. Returns `[{ id, toolCount, ... }]`.",
    "- Always use the namespace prefix when calling tools: `tools.<namespace>.<tool>(args)`. Example: `tools.home_assistant_rest_api.states.getState(...)` — not `tools.states.getState(...)`.",
    "- The `tools` object is a lazy proxy — `Object.keys(tools)` won't work. Use `tools.search()` or `tools.executor.sources.list()` instead.",
    '- Pass an object to system tools, e.g. `tools.search({ query: "..." })`, `tools.executor.sources.list()`, and `tools.describe.tool({ path })`.',
    "- `tools.describe.tool()` returns compact TypeScript shapes. Use `inputTypeScript`, `outputTypeScript`, and `typeScriptDefinitions`.",
    "- Code is executed as a script snippet/body, not as an ES module file.",
    "- Use `return ...` for the final result when you want execute to produce a value.",
    "- Do not use `export`, `export default`, `import`, or `module.exports` inside execute snippets.",
    "- For tools that return large collections (e.g. `getStates`, `getAll`), filter results in code rather than calling per-item tools.",
    "- Do not use `fetch` — all API calls go through `tools.*`.",
    "- If execution pauses for interaction, resume it with the returned `resumePayload`.",
  ];

  if (namespaces.length > 0) {
    lines.push("", "## Available namespaces", "");
    for (const namespace of [...namespaces].sort()) {
      const source = sources.find((entry) => entry.id === namespace);
      const label = source?.name ?? namespace;
      lines.push(`- \`${namespace}\`${label !== namespace ? ` — ${label}` : ""}`);
    }
  }

  return lines.join("\n");
};

export const loadExecuteDescription = async (baseUrl: string, scopeId: string): Promise<string> => {
  const [sources, tools] = await Promise.all([listSources(baseUrl, scopeId), listTools(baseUrl, scopeId)]);
  const namespaces = Array.from(new Set(tools.map((tool) => tool.sourceId)));
  return buildExecuteDescriptionFromData(
    namespaces,
    sources.map((source) => ({ id: source.id, name: source.name })),
  );
};

export const buildExecutorSystemPrompt = (description: string, hasUI: boolean): string =>
  [
    "Executor MCP parity guidance:",
    description,
    "",
    hasUI
      ? "This Pi session has UI available. Use execute for Executor work and let it handle any interaction inline. Do not call resume unless execute explicitly cannot complete inline."
      : "This Pi session has no interactive UI. If execute returns waiting_for_interaction, call resume with the exact executionId.",
  ].join("\n");

export const normalizeResumeNotFound = (
  error: Error,
  executionId: string,
): ExecuteToolResult | undefined => {
  if (!(error instanceof HttpError) || error.status !== 404) {
    return undefined;
  }

  return {
    content: [{ type: "text", text: `No paused execution: ${executionId}` }],
    details: {
      baseUrl: error.baseUrl,
      scopeId: "",
      structuredContent: { status: "error", executionId },
      isError: true,
      executionId,
    },
  };
};

export const runManagedExecution = async (
  transport: ExecutionTransport,
  code: string,
  onInteraction: InteractionHandler,
): Promise<ExecutionOutcome> => {
  let outcome = normalizeExecuteResponse(await transport.execute(code));

  while (outcome.status === "waiting_for_interaction") {
    const payload = await onInteraction(outcome.interaction);
    outcome = normalizeResumeResponse(
      await transport.resume(outcome.interaction.executionId, payload),
    );
  }

  return outcome;
};
