import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import {
  execute,
  getToolSchema,
  listSources,
  listTools,
  type ExecuteCompleted,
  type ExecuteResponse,
  type JsonObject,
  type JsonValue,
  type ResumeAction,
  resume,
} from "./http.ts";
import { ensureSidecar } from "./sidecar.ts";
// Use Type from @mariozechner/pi-ai so the package only needs Pi core peers, not a direct typebox peer.
import { StringEnum, Type, type Static } from "@mariozechner/pi-ai";

export type SearchSnippetInput = {
  query: string;
  namespace?: string;
  limit?: number;
};

export type DescribeSnippetInput = {
  path: string;
};

export type ListSourcesSnippetInput = {
  query?: string;
  limit?: number;
};

export type DescribeResult = {
  path: string;
  name: string;
  description?: string;
  inputTypeScript?: string;
  outputTypeScript?: string;
  typeScriptDefinitions?: Record<string, string>;
};

export type SourceListResult = {
  id: string;
  name: string;
  kind: string;
  runtime?: boolean;
  canRemove?: boolean;
  canRefresh?: boolean;
  canEdit?: boolean;
};

export type TruncatedOutput = {
  text: string;
  fullOutputPath?: string;
};

const jsonIndent = (value: JsonValue): string => JSON.stringify(value, null, 2);

const buildObjectLiteral = (input: Record<string, JsonValue | undefined>): string => {
  const filteredEntries = Object.entries(input).filter(([, value]) => value !== undefined);
  const objectValue = Object.fromEntries(filteredEntries) as Record<string, JsonValue>;
  return JSON.stringify(objectValue, null, 2);
};

export const buildSearchSnippet = (input: SearchSnippetInput): string =>
  `return tools.search(${buildObjectLiteral({
    query: input.query,
    namespace: input.namespace,
    limit: input.limit,
  })});`;

export const buildDescribeSnippet = (input: DescribeSnippetInput): string =>
  `return tools.describe.tool(${buildObjectLiteral({ path: input.path })});`;

export const buildListSourcesSnippet = (input: ListSourcesSnippetInput): string =>
  `return tools.executor.sources.list(${buildObjectLiteral({
    query: input.query,
    limit: input.limit,
  })});`;

export const isExecuteCompleted = (result: ExecuteResponse): result is ExecuteCompleted =>
  result.status === "completed";

export const isCompletedNonError = (result: ExecuteResponse): result is ExecuteCompleted =>
  result.status === "completed" && result.isError === false;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const unwrapStructuredResult = (result: ExecuteCompleted): JsonValue | undefined => {
  if (!isJsonObject(result.structured)) {
    return undefined;
  }
  return result.structured.result;
};

const readString = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const readBoolean = (value: JsonValue | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const readStringRecord = (value: JsonValue | undefined): Record<string, string> | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(([, entry]) => typeof entry === "string") as [string, string][];
  return Object.fromEntries(entries);
};

const toDescribeResult = (value: JsonValue, fallbackPath: string): DescribeResult | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  return {
    path: readString(value.path) ?? fallbackPath,
    name: readString(value.name) ?? fallbackPath,
    description: readString(value.description),
    inputTypeScript: readString(value.inputTypeScript),
    outputTypeScript: readString(value.outputTypeScript),
    typeScriptDefinitions: readStringRecord(value.typeScriptDefinitions),
  };
};

const toSourceList = (value: JsonValue): SourceListResult[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) => {
    if (!isJsonObject(entry)) {
      return [];
    }

    const id = readString(entry.id);
    const name = readString(entry.name);
    const kind = readString(entry.kind);
    if (!id || !name || !kind) {
      return [];
    }

    return [
      {
        id,
        name,
        kind,
        runtime: readBoolean(entry.runtime),
        canRemove: readBoolean(entry.canRemove),
        canRefresh: readBoolean(entry.canRefresh),
        canEdit: readBoolean(entry.canEdit),
      },
    ];
  });
};

export const truncateToolOutput = async (text: string, tempPrefix: string): Promise<TruncatedOutput> => {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content };
  }

  const tempDir = await mkdtemp(join(tmpdir(), tempPrefix));
  const fullOutputPath = join(tempDir, "output.txt");
  await withFileMutationQueue(fullOutputPath, async () => {
    await writeFile(fullOutputPath, text, "utf8");
  });

  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  const suffix = [
    "",
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    `${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`,
    `Full output saved to: ${fullOutputPath}]`,
  ].join(" ");

  return {
    text: `${truncation.content}\n\n${suffix.trim()}`,
    fullOutputPath,
  };
};

const formatJsonResult = async (value: JsonValue, tempPrefix: string): Promise<TruncatedOutput> =>
  truncateToolOutput(jsonIndent(value), tempPrefix);

export const describeViaHttp = async (baseUrl: string, scopeId: string, path: string): Promise<DescribeResult> => {
  const tools = await listTools(baseUrl, scopeId);
  const metadata = tools.find((tool) => tool.id === path);
  const schema = await getToolSchema(baseUrl, scopeId, path);
  return {
    path,
    name: metadata?.name ?? path,
    description: metadata?.description,
    inputTypeScript: schema.inputTypeScript,
    outputTypeScript: schema.outputTypeScript,
    typeScriptDefinitions: schema.typeScriptDefinitions,
  };
};

export const listSourcesViaHttp = async (baseUrl: string, scopeId: string): Promise<SourceListResult[]> => {
  const sources = await listSources(baseUrl, scopeId);
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    runtime: source.runtime,
    canRemove: source.canRemove,
    canRefresh: source.canRefresh,
    canEdit: source.canEdit,
  }));
};

const executeSnippet = async (cwd: string, code: string): Promise<{ baseUrl: string; scopeId: string; result: ExecuteResponse }> => {
  const sidecar = await ensureSidecar(cwd);
  const scopeId = sidecar.scope?.id ?? (await ensureSidecar(cwd)).scope?.id;
  if (!scopeId) {
    throw new Error(`Executor sidecar scope id missing for ${cwd}`);
  }
  return {
    baseUrl: sidecar.baseUrl,
    scopeId,
    result: await execute(sidecar.baseUrl, code),
  };
};

const jsonStringSchema = Type.String({ description: "JSON object string" });

const executeTool = defineTool({
  name: "executor_execute",
  label: "Executor Execute",
  description: "Execute JavaScript code in the local Executor sidecar for the current working directory.",
  promptSnippet: "Execute JavaScript in the local Executor sidecar for the current working directory.",
  promptGuidelines: ["Use this when you need Executor's runtime instead of Pi's built-in tools."],
  parameters: Type.Object({
    code: Type.String({ description: "JavaScript code to execute" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const sidecar = await ensureSidecar(ctx.cwd);
    const result = await execute(sidecar.baseUrl, params.code);
    const executionId =
      result.status === "paused" && isJsonObject(result.structured) && typeof result.structured.executionId === "string"
        ? result.structured.executionId
        : undefined;

    return {
      content: [{ type: "text", text: jsonIndent(result) }],
      details: {
        baseUrl: sidecar.baseUrl,
        scopeId: sidecar.scope?.id,
        executionId,
      },
    };
  },
});

const resumeTool = defineTool({
  name: "executor_resume",
  label: "Executor Resume",
  description: "Resume a paused Executor execution by id.",
  promptSnippet: "Resume a paused Executor execution after user interaction is complete.",
  promptGuidelines: ["Use the exact executionId returned by executor_execute or /executor call."],
  parameters: Type.Object({
    executionId: Type.String({ description: "Paused execution id" }),
    action: StringEnum(["accept", "decline", "cancel"] as const),
    contentJson: Type.Optional(jsonStringSchema),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const sidecar = await ensureSidecar(ctx.cwd);
    const content = params.contentJson ? parseJsonObjectString(params.contentJson) : undefined;
    const result = await resume(sidecar.baseUrl, params.executionId, {
      action: params.action as ResumeAction,
      content,
    });

    return {
      content: [{ type: "text", text: jsonIndent(result) }],
      details: {
        baseUrl: sidecar.baseUrl,
        scopeId: sidecar.scope?.id,
        executionId: params.executionId,
      },
    };
  },
});

const searchTool = defineTool({
  name: "executor_search",
  label: "Executor Search",
  description: "Search Executor tools using Executor's built-in helper path.",
  promptSnippet: "Search available Executor tools by keyword or namespace.",
  promptGuidelines: ["Prefer this before guessing Executor tool ids."],
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    namespace: Type.Optional(Type.String({ description: "Optional namespace prefix" })),
    limit: Type.Optional(Type.Number({ description: "Maximum results" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { baseUrl, scopeId, result } = await executeSnippet(ctx.cwd, buildSearchSnippet(params));
    if (!isCompletedNonError(result)) {
      return {
        content: [{ type: "text", text: jsonIndent(result) }],
        details: { baseUrl, scopeId },
      };
    }

    const unwrapped = unwrapStructuredResult(result) ?? result.structured;
    const truncated = await formatJsonResult(unwrapped, "pi-executor-search-");
    return {
      content: [{ type: "text", text: truncated.text }],
      details: {
        baseUrl,
        scopeId,
        fullOutputPath: truncated.fullOutputPath,
      },
    };
  },
});

const describeTool = defineTool({
  name: "executor_describe",
  label: "Executor Describe",
  description: "Describe an Executor tool, preferring Executor's helper path and falling back to HTTP metadata/schema endpoints.",
  promptSnippet: "Describe a specific Executor tool id and return its TypeScript-facing shape.",
  promptGuidelines: ["Use this after executor_search when you need a tool's exact schema or description."],
  parameters: Type.Object({
    path: Type.String({ description: "Executor tool path" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { baseUrl, scopeId, result } = await executeSnippet(ctx.cwd, buildDescribeSnippet(params));

    let described: DescribeResult;
    if (isCompletedNonError(result)) {
      const helperResult = toDescribeResult(unwrapStructuredResult(result) ?? result.structured, params.path);
      described = helperResult ?? (await describeViaHttp(baseUrl, scopeId, params.path));
    } else {
      described = await describeViaHttp(baseUrl, scopeId, params.path);
    }

    const truncated = await formatJsonResult(described, "pi-executor-describe-");
    return {
      content: [{ type: "text", text: truncated.text }],
      details: {
        baseUrl,
        scopeId,
        fullOutputPath: truncated.fullOutputPath,
      },
    };
  },
});

const listSourcesTool = defineTool({
  name: "executor_list_sources",
  label: "Executor List Sources",
  description: "List Executor sources, preferring Executor's helper path and falling back to HTTP source listing.",
  promptSnippet: "List configured Executor sources for the current working directory.",
  promptGuidelines: ["Use this before asking Executor to access source-backed tools."],
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Optional source search query" })),
    limit: Type.Optional(Type.Number({ description: "Maximum results" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const { baseUrl, scopeId, result } = await executeSnippet(ctx.cwd, buildListSourcesSnippet(params));

    let sources: SourceListResult[];
    if (isCompletedNonError(result)) {
      sources = toSourceList(unwrapStructuredResult(result) ?? result.structured) ?? (await listSourcesViaHttp(baseUrl, scopeId));
    } else {
      sources = await listSourcesViaHttp(baseUrl, scopeId);
    }

    const truncated = await formatJsonResult(sources, "pi-executor-sources-");
    return {
      content: [{ type: "text", text: truncated.text }],
      details: {
        baseUrl,
        scopeId,
        fullOutputPath: truncated.fullOutputPath,
      },
    };
  },
});

const parseJsonObjectString = (text: string): JsonObject => {
  const parsed = JSON.parse(text) as JsonValue;
  if (!isJsonObject(parsed)) {
    throw new Error("contentJson must parse to a JSON object");
  }
  return parsed;
};

export const executorTools = [
  executeTool,
  resumeTool,
  searchTool,
  describeTool,
  listSourcesTool,
] satisfies ToolDefinition[];

export const registerExecutorTools = (pi: ExtensionAPI): void => {
  for (const tool of executorTools) {
    pi.registerTool(tool);
  }
};

export type ExecuteToolInput = Static<(typeof executeTool)["parameters"]>;
export type ResumeToolInput = Static<(typeof resumeTool)["parameters"]>;
export type SearchToolInput = Static<(typeof searchTool)["parameters"]>;
export type DescribeToolInput = Static<(typeof describeTool)["parameters"]>;
export type ListSourcesToolInput = Static<(typeof listSourcesTool)["parameters"]>;
