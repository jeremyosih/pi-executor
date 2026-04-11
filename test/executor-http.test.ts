import { afterEach, describe, expect, test } from "bun:test";
import {
  execute,
  getScope,
  getToolSchema,
  HttpError,
  listSources,
  listTools,
  resume,
  type JsonObject,
  type JsonValue,
} from "../src/http.ts";

type TestRouteMap = Record<string, { status?: number; body: JsonValue }>;

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
});

const startServer = (routes: TestRouteMap): string => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;
      const route = routes[key];
      if (!route) {
        return new Response("not found", { status: 404 });
      }
      return Response.json(route.body, { status: route.status ?? 200 });
    },
  });

  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
};

describe("http wrappers", () => {
  test("reads scope info", async () => {
    const baseUrl = startServer({
      "GET /api/scope": {
        body: { id: "scope-1", name: "repo", dir: "/repo" },
      },
    });

    await expect(getScope(baseUrl)).resolves.toEqual({ id: "scope-1", name: "repo", dir: "/repo" });
  });

  test("executes completed and paused responses", async () => {
    const baseUrl = startServer({
      "POST /api/executions": {
        body: { status: "completed", text: "4", structured: { result: 4 }, isError: false },
      },
      "POST /api/executions-paused": {
        body: { status: "paused", text: "waiting", structured: { executionId: "exec_1" } },
      },
    });

    const completed = await execute(baseUrl, "return 2+2");
    expect(completed).toEqual({
      status: "completed",
      text: "4",
      structured: { result: 4 },
      isError: false,
    });

    const pausedServer = startServer({
      "POST /api/executions": {
        body: { status: "paused", text: "waiting", structured: { executionId: "exec_1" } },
      },
    });

    await expect(execute(pausedServer, "pause()")) .resolves.toEqual({
      status: "paused",
      text: "waiting",
      structured: { executionId: "exec_1" },
    });
  });

  test("resumes executions and normalizes not found errors", async () => {
    const baseUrl = startServer({
      "POST /api/executions/exec_1/resume": {
        body: { text: "done", structured: { result: true }, isError: false },
      },
    });

    await expect(
      resume(baseUrl, "exec_1", { action: "accept", content: { approved: true } as JsonObject }),
    ).resolves.toEqual({ text: "done", structured: { result: true }, isError: false });

    const notFoundBaseUrl = startServer({
      "POST /api/executions/missing/resume": {
        status: 404,
        body: { _tag: "ExecutionNotFoundError", executionId: "missing" },
      },
    });

    await expect(resume(notFoundBaseUrl, "missing", { action: "cancel" })).rejects.toBeInstanceOf(HttpError);
  });

  test("lists tools, schemas, and sources", async () => {
    const baseUrl = startServer({
      "GET /api/scopes/scope-1/tools": {
        body: [
          {
            id: "tool.alpha",
            pluginKey: "plugin",
            sourceId: "source-1",
            name: "Alpha",
            description: "Alpha tool",
            mayElicit: false,
          },
        ],
      },
      "GET /api/scopes/scope-1/tools/tool.alpha/schema": {
        body: {
          id: "tool.alpha",
          inputTypeScript: "type Input = { value: string }",
          outputTypeScript: "type Output = { ok: boolean }",
          typeScriptDefinitions: { Shared: "type Shared = string" },
        },
      },
      "GET /api/scopes/scope-1/sources": {
        body: [
          {
            id: "source-1",
            name: "Primary",
            kind: "openapi",
            runtime: true,
            canRemove: true,
            canRefresh: false,
            canEdit: true,
          },
        ],
      },
    });

    await expect(listTools(baseUrl, "scope-1")).resolves.toEqual([
      {
        id: "tool.alpha",
        pluginKey: "plugin",
        sourceId: "source-1",
        name: "Alpha",
        description: "Alpha tool",
        mayElicit: false,
      },
    ]);

    await expect(getToolSchema(baseUrl, "scope-1", "tool.alpha")).resolves.toEqual({
      id: "tool.alpha",
      inputTypeScript: "type Input = { value: string }",
      outputTypeScript: "type Output = { ok: boolean }",
      typeScriptDefinitions: { Shared: "type Shared = string" },
      inputSchema: undefined,
      outputSchema: undefined,
    });

    await expect(listSources(baseUrl, "scope-1")).resolves.toEqual([
      {
        id: "source-1",
        name: "Primary",
        kind: "openapi",
        runtime: true,
        canRemove: true,
        canRefresh: false,
        canEdit: true,
      },
    ]);
  });
});
