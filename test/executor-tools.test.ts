import { describe, expect, test } from "bun:test";
import { HttpError, type ResumePayload, type ResumeResponse } from "../src/http.ts";
import {
  buildExecuteDescriptionFromData,
  normalizeExecuteResponse,
  normalizeResumeNotFound,
  normalizeResumeResponse,
  parseJsonContent,
  runManagedExecution,
  type ExecutionTransport,
} from "../src/executor-adapter.ts";
import { getToolNamesForSession } from "../src/tools.ts";

describe("executor MCP parity helpers", () => {
  test("builds MCP-style execute guidance with live namespaces", () => {
    const description = buildExecuteDescriptionFromData(["zeta", "alpha"], [
      { id: "alpha", name: "Alpha Source" },
      { id: "zeta", name: "zeta" },
    ]);

    expect(description).toContain("## Workflow");
    expect(description).toContain("tools.search");
    expect(description).toContain("## Available namespaces");
    expect(description).toContain("Code is executed as a script snippet/body, not as an ES module file.");
    expect(description).toContain("Use `return ...` for the final result");
    expect(description).toContain("Do not use `export`, `export default`, `import`, or `module.exports`");
    expect(description.indexOf("`alpha` — Alpha Source")).toBeLessThan(
      description.indexOf("`zeta`"),
    );
  });

  test("parses resume content like the MCP host", () => {
    expect(parseJsonContent(undefined)).toBeUndefined();
    expect(parseJsonContent("{}")).toBeUndefined();
    expect(parseJsonContent("not-json")).toBeUndefined();
    expect(parseJsonContent("[1,2,3]")).toBeUndefined();
    expect(parseJsonContent('{"approved":true}')).toEqual({ approved: true });
  });

  test("normalizes paused execute responses into waiting_for_interaction outcomes", () => {
    const outcome = normalizeExecuteResponse({
      status: "paused",
      text: "Execution paused: Need approval",
      structured: {
        status: "waiting_for_interaction",
        executionId: "exec_42",
        interaction: {
          kind: "form",
          message: "Need approval",
          requestedSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
          },
        },
      },
    });

    expect(outcome.status).toBe("waiting_for_interaction");
    if (outcome.status !== "waiting_for_interaction") {
      throw new Error("Expected waiting_for_interaction outcome");
    }
    expect(outcome.interaction.executionId).toBe("exec_42");
    expect(outcome.interaction.kind).toBe("form");
  });

  test("normalizes paused resume responses into waiting_for_interaction outcomes", () => {
    const outcome = normalizeResumeResponse({
      text: "Execution paused: Open URL",
      structured: {
        status: "waiting_for_interaction",
        executionId: "exec_7",
        interaction: {
          kind: "url",
          message: "Authenticate",
          url: "https://example.com/oauth",
        },
      },
      isError: false,
    });

    expect(outcome.status).toBe("waiting_for_interaction");
    if (outcome.status !== "waiting_for_interaction") {
      throw new Error("Expected waiting_for_interaction outcome");
    }
    expect(outcome.interaction.url).toBe("https://example.com/oauth");
  });

  test("runs managed execution through multiple interactions", async () => {
    const prompts: string[] = [];
    const transport: ExecutionTransport = {
      execute: async () => ({
          status: "paused",
          text: "first",
          structured: {
            status: "waiting_for_interaction",
            executionId: "exec_1",
            interaction: {
              kind: "form",
              message: "What is your name?",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        }),
        resume: async (executionId, payload): Promise<ResumeResponse> => {
          if (executionId === "exec_1") {
            prompts.push(String(payload.content?.name));
            return {
              text: "second",
              structured: {
                status: "waiting_for_interaction" as const,
                executionId: "exec_2",
                interaction: {
                  kind: "form" as const,
                  message: "Confirm?",
                  requestedSchema: {
                    type: "object",
                    properties: { confirmed: { type: "boolean" } },
                  },
                },
              },
              isError: false,
            };
          }

          prompts.push(String(payload.content?.confirmed));
          return {
            text: "done",
            structured: {
              status: "completed" as const,
              result: "name=Alice,confirmed=true",
              logs: [],
            },
            isError: false,
          };
        },
      };

    const outcome = await runManagedExecution(
      transport,
      "multi",
      async (interaction): Promise<ResumePayload> => {
        if (interaction.executionId === "exec_1") {
          return { action: "accept", content: { name: "Alice" } };
        }
        return { action: "accept", content: { confirmed: true } };
      },
    );

    expect(prompts).toEqual(["Alice", "true"]);
    expect(outcome).toEqual({
      status: "completed",
      text: "done",
      structuredContent: {
        status: "completed",
        result: "name=Alice,confirmed=true",
        logs: [],
      },
      isError: false,
    });
  });

  test("normalizes unknown execution ids to MCP-style error text", () => {
    const result = normalizeResumeNotFound(
      new HttpError({
        baseUrl: "http://127.0.0.1:4788",
        path: "/api/executions/missing/resume",
        message: "Executor HTTP 404 from /api/executions/missing/resume",
        status: 404,
      }),
      "missing",
    );

    expect(result).toBeDefined();
    expect(result?.content[0]?.text).toBe("No paused execution: missing");
    expect(result?.details.isError).toBe(true);
  });
});

describe("tool surface", () => {
  test("matches MCP visibility by session capability", () => {
    expect(getToolNamesForSession(true)).toEqual(["execute"]);
    expect(getToolNamesForSession(false)).toEqual(["execute", "resume"]);
  });
});
