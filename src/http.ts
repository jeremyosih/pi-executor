import { setTimeout as delay } from "node:timers/promises";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ScopeInfo = {
  id: string;
  name: string;
  dir: string;
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
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
  );

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

export const getScope = async (baseUrl: string, timeoutMs?: number): Promise<ScopeInfo> =>
  fetchJson(baseUrl, "/api/scope", parseScopeInfo, { timeoutMs });

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
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new HttpError({
    baseUrl,
    path: "/api/scope",
    message: `Executor did not become healthy for ${expectedDir} within ${timeoutMs}ms`,
  });
};
