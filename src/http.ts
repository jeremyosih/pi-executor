import { setTimeout as delay } from "node:timers/promises";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ScopeInfo = {
  id: string;
  name: string;
  dir: string;
};

export type ExecuteCompleted = {
  status: "completed";
  text: string;
  structured: JsonValue;
  isError: boolean;
};

export type ExecutePaused = {
  status: "paused";
  text: string;
  structured: JsonValue;
};

export type ExecuteResponse = ExecuteCompleted | ExecutePaused;

export type ResumeAction = "accept" | "decline" | "cancel";

export type ResumePayload = {
  action: ResumeAction;
  content?: JsonObject;
};

export type ResumeResponse = {
  text: string;
  structured: JsonValue;
  isError: boolean;
};

export type ToolMetadataResponse = {
  id: string;
  pluginKey: string;
  sourceId: string;
  name: string;
  description?: string;
  mayElicit?: boolean;
};

export type ToolSchemaResponse = {
  id: string;
  inputTypeScript?: string;
  outputTypeScript?: string;
  typeScriptDefinitions?: Record<string, string>;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
};

export type SourceResponse = {
  id: string;
  name: string;
  kind: string;
  runtime?: boolean;
  canRemove?: boolean;
  canRefresh?: boolean;
  canEdit?: boolean;
};

export type FetchJsonOptions = {
  method?: "GET" | "POST";
  timeoutMs?: number;
  body?: JsonObject;
};

export class HttpError extends Error {
  readonly baseUrl: string;
  readonly path: string;
  readonly status?: number;
  readonly bodyText?: string;

  constructor(input: {
    baseUrl: string;
    path: string;
    message: string;
    status?: number;
    bodyText?: string;
  }) {
    super(input.message);
    this.name = "HttpError";
    this.baseUrl = input.baseUrl;
    this.path = input.path;
    this.status = input.status;
    this.bodyText = input.bodyText;
  }
}

const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: JsonValue | undefined, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }
  return value;
};

const readBoolean = (value: JsonValue | undefined, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${field} to be a boolean`);
  }
  return value;
};

const readOptionalString = (value: JsonValue | undefined, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, field);
};

const readOptionalBoolean = (value: JsonValue | undefined, field: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return readBoolean(value, field);
};

const readOptionalStringRecord = (
  value: JsonValue | undefined,
  field: string,
): Record<string, string> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new Error(`Expected ${field} to be an object`);
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = readString(entry, `${field}.${key}`);
  }
  return record;
};

const parseJson = async (response: Response): Promise<JsonValue> => {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new HttpError({
      baseUrl: new URL(response.url).origin,
      path: new URL(response.url).pathname,
      message: `Executor returned invalid JSON from ${response.url}`,
      status: response.status,
      bodyText: text,
    });
  }
};

export const fetchJson = async <T>(
  baseUrl: string,
  path: string,
  parse: (value: JsonValue) => T,
  options: FetchJsonOptions = {},
): Promise<T> => {
  const url = new URL(path, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new HttpError({
        baseUrl,
        path,
        message: `Executor HTTP ${response.status} from ${path}`,
        status: response.status,
        bodyText,
      });
    }

    const json = await parseJson(response);
    return parse(json);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new HttpError({
        baseUrl,
        path,
        message: `Executor request to ${path} timed out`,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError({
      baseUrl,
      path,
      message: `Executor request to ${path} failed: ${message}`,
    });
  } finally {
    clearTimeout(timeout);
  }
};

export const parseScopeInfo = (value: JsonValue): ScopeInfo => {
  if (!isJsonObject(value)) {
    throw new Error("Expected scope response to be an object");
  }

  return {
    id: readString(value.id, "scope.id"),
    name: readString(value.name, "scope.name"),
    dir: readString(value.dir, "scope.dir"),
  };
};

export const parseExecuteResponse = (value: JsonValue): ExecuteResponse => {
  if (!isJsonObject(value)) {
    throw new Error("Expected execute response to be an object");
  }

  const status = readString(value.status, "execute.status");
  if (status === "completed") {
    return {
      status,
      text: readString(value.text, "execute.text"),
      structured: value.structured ?? null,
      isError: readBoolean(value.isError, "execute.isError"),
    };
  }

  if (status === "paused") {
    return {
      status,
      text: readString(value.text, "execute.text"),
      structured: value.structured ?? null,
    };
  }

  throw new Error(`Unexpected execute status: ${status}`);
};

export const parseResumeResponse = (value: JsonValue): ResumeResponse => {
  if (!isJsonObject(value)) {
    throw new Error("Expected resume response to be an object");
  }

  return {
    text: readString(value.text, "resume.text"),
    structured: value.structured ?? null,
    isError: readBoolean(value.isError, "resume.isError"),
  };
};

export const parseToolMetadataList = (value: JsonValue): ToolMetadataResponse[] => {
  if (!Array.isArray(value)) {
    throw new Error("Expected tools list to be an array");
  }

  return value.map((entry, index) => {
    if (!isJsonObject(entry)) {
      throw new Error(`Expected tools[${index}] to be an object`);
    }

    return {
      id: readString(entry.id, `tools[${index}].id`),
      pluginKey: readString(entry.pluginKey, `tools[${index}].pluginKey`),
      sourceId: readString(entry.sourceId, `tools[${index}].sourceId`),
      name: readString(entry.name, `tools[${index}].name`),
      description: readOptionalString(entry.description, `tools[${index}].description`),
      mayElicit: readOptionalBoolean(entry.mayElicit, `tools[${index}].mayElicit`),
    };
  });
};

export const parseToolSchemaResponse = (value: JsonValue): ToolSchemaResponse => {
  if (!isJsonObject(value)) {
    throw new Error("Expected tool schema response to be an object");
  }

  return {
    id: readString(value.id, "toolSchema.id"),
    inputTypeScript: readOptionalString(value.inputTypeScript, "toolSchema.inputTypeScript"),
    outputTypeScript: readOptionalString(value.outputTypeScript, "toolSchema.outputTypeScript"),
    typeScriptDefinitions: readOptionalStringRecord(
      value.typeScriptDefinitions,
      "toolSchema.typeScriptDefinitions",
    ),
    inputSchema: value.inputSchema,
    outputSchema: value.outputSchema,
  };
};

export const parseSourceList = (value: JsonValue): SourceResponse[] => {
  if (!Array.isArray(value)) {
    throw new Error("Expected sources list to be an array");
  }

  return value.map((entry, index) => {
    if (!isJsonObject(entry)) {
      throw new Error(`Expected sources[${index}] to be an object`);
    }

    return {
      id: readString(entry.id, `sources[${index}].id`),
      name: readString(entry.name, `sources[${index}].name`),
      kind: readString(entry.kind, `sources[${index}].kind`),
      runtime: readOptionalBoolean(entry.runtime, `sources[${index}].runtime`),
      canRemove: readOptionalBoolean(entry.canRemove, `sources[${index}].canRemove`),
      canRefresh: readOptionalBoolean(entry.canRefresh, `sources[${index}].canRefresh`),
      canEdit: readOptionalBoolean(entry.canEdit, `sources[${index}].canEdit`),
    };
  });
};

export const getScope = async (baseUrl: string, timeoutMs?: number): Promise<ScopeInfo> =>
  fetchJson(baseUrl, "/api/scope", parseScopeInfo, { timeoutMs });

export const execute = async (baseUrl: string, code: string): Promise<ExecuteResponse> =>
  fetchJson(baseUrl, "/api/executions", parseExecuteResponse, {
    method: "POST",
    body: { code },
  });

export const resume = async (
  baseUrl: string,
  executionId: string,
  payload: ResumePayload,
): Promise<ResumeResponse> =>
  fetchJson(baseUrl, `/api/executions/${encodeURIComponent(executionId)}/resume`, parseResumeResponse, {
    method: "POST",
    body: payload.content ? { action: payload.action, content: payload.content } : { action: payload.action },
  });

export const listTools = async (baseUrl: string, scopeId: string): Promise<ToolMetadataResponse[]> =>
  fetchJson(
    baseUrl,
    `/api/scopes/${encodeURIComponent(scopeId)}/tools`,
    parseToolMetadataList,
  );

export const getToolSchema = async (
  baseUrl: string,
  scopeId: string,
  toolId: string,
): Promise<ToolSchemaResponse> =>
  fetchJson(
    baseUrl,
    `/api/scopes/${encodeURIComponent(scopeId)}/tools/${encodeURIComponent(toolId)}/schema`,
    parseToolSchemaResponse,
  );

export const listSources = async (baseUrl: string, scopeId: string): Promise<SourceResponse[]> =>
  fetchJson(
    baseUrl,
    `/api/scopes/${encodeURIComponent(scopeId)}/sources`,
    parseSourceList,
  );

export const waitForHealthyScope = async (
  baseUrl: string,
  expectedDir: string,
  timeoutMs: number,
): Promise<ScopeInfo> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const scope = await getScope(baseUrl, Math.min(timeoutMs, DEFAULT_HTTP_TIMEOUT_MS));
      if (scope.dir === expectedDir) {
        return scope;
      }
    } catch {
      // keep polling until timeout
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new HttpError({
    baseUrl,
    path: "/api/scope",
    message: `Executor did not become healthy for ${expectedDir} within ${timeoutMs}ms`,
  });
};
