import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { inspectExecutorMcp, withExecutorMcpClient } from "../src/mcp-client.ts";

const servers: Array<{ stop: () => Promise<void> | void }> = [];

const createTestMcpServer = (): McpServer => {
  const server = new McpServer(
    { name: "executor", version: "1.0.0" },
    { instructions: "Use execute for Executor work." },
  );

  const executeTool = server.registerTool(
    "execute",
    {
      description: "Execute code through MCP.",
      inputSchema: { code: z.string() },
    },
    async ({ code }) => {
      if (code === "pause") {
        return {
          content: [{ type: "text", text: "Execution paused: Need approval\n\nexecutionId: exec_1" }],
          structuredContent: {
            status: "waiting_for_interaction",
            executionId: "exec_1",
            interaction: {
              kind: "form",
              message: "Need approval",
              requestedSchema: {
                type: "object",
                properties: {
                  approved: { type: "boolean" },
                },
              },
            },
          },
        };
      }

      if (code === "error") {
        return {
          content: [{ type: "text", text: "boom" }],
          structuredContent: { status: "error" },
          isError: true,
        };
      }

      if (code === "ask-form") {
        const response = await server.server.elicitInput({
          message: "Approve this action?",
          requestedSchema: {
            type: "object",
            properties: {
              approved: { type: "boolean" },
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: response.action === "accept" && response.content?.approved ? "approved" : response.action,
            },
          ],
          structuredContent: { status: "completed", result: response.content ?? null },
        };
      }

      if (code === "ask-url") {
        const response = await server.server.elicitInput({
          mode: "url",
          message: "Authenticate",
          url: "https://example.com/auth",
          elicitationId: "elic-1",
        });

        return {
          content: [{ type: "text", text: response.action }],
          structuredContent: { status: "completed", result: response.action },
        };
      }

      return {
        content: [{ type: "text", text: `ran:${code}` }],
        structuredContent: { status: "completed", result: `ran:${code}` },
      };
    },
  );

  const resumeTool = server.registerTool(
    "resume",
    {
      description: "Resume a paused execution.",
      inputSchema: {
        executionId: z.string(),
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.string().default("{}"),
      },
    },
    async ({ executionId, action, content }) => {
      if (executionId !== "exec_1") {
        return {
          content: [{ type: "text", text: `No paused execution: ${executionId}` }],
          structuredContent: { status: "error", executionId },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `resumed:${action}:${content}` }],
        structuredContent: { status: "completed", result: action },
      };
    },
  );

  const syncToolAvailability = (): void => {
    executeTool.enable();
    const capabilities = server.server.getClientCapabilities();
    if (capabilities?.elicitation && "form" in capabilities.elicitation) {
      resumeTool.disable();
      return;
    }
    resumeTool.enable();
  };

  syncToolAvailability();
  server.server.oninitialized = syncToolAvailability;

  return server;
};

const startServer = (): string => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const sessions = new Map<string, McpServer>();

  const closeSession = async (sessionId: string): Promise<void> => {
    const transport = transports.get(sessionId);
    const server = sessions.get(sessionId);
    transports.delete(sessionId);
    sessions.delete(sessionId);
    await transport?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  };

  const instance = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          return new Response("session not found", { status: 404 });
        }
        return transport.handleRequest(request);
      }

      let createdServer: McpServer | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (createdSessionId) => {
          transports.set(createdSessionId, transport);
          if (createdServer) {
            sessions.set(createdSessionId, createdServer);
          }
        },
        onsessionclosed: (createdSessionId) => closeSession(createdSessionId),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          void closeSession(transport.sessionId);
        }
      };

      createdServer = createTestMcpServer();
      await createdServer.connect(transport);
      return transport.handleRequest(request);
    },
  });

  servers.push({
    stop: async () => {
      instance.stop(true);
      await Promise.all([...transports.keys()].map((sessionId) => closeSession(sessionId)));
    },
  });

  return `http://127.0.0.1:${instance.port}`;
};

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
});

describe("mcp client bridge", () => {
  test("loads instructions and hides resume when UI capabilities are advertised", async () => {
    const baseUrl = startServer();

    const inspection = await inspectExecutorMcp(baseUrl, true);

    expect(inspection.instructions).toBe("Use execute for Executor work.");
    expect(inspection.tools.map((tool) => tool.name)).toEqual(["execute"]);
  });

  test("shows resume when no elicitation capabilities are advertised", async () => {
    const baseUrl = startServer();

    const inspection = await inspectExecutorMcp(baseUrl, false);

    expect(inspection.tools.map((tool) => tool.name)).toEqual(["execute", "resume"]);
  });

  test("executes through MCP and propagates tool errors", async () => {
    const baseUrl = startServer();

    const completed = await withExecutorMcpClient(baseUrl, { hasUI: false }, async (client) =>
      client.execute("return 1"),
    );
    expect(completed).toEqual({
      text: "ran:return 1",
      structuredContent: { status: "completed", result: "ran:return 1" },
      isError: false,
    });

    const failed = await withExecutorMcpClient(baseUrl, { hasUI: false }, async (client) =>
      client.execute("error"),
    );
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe("boom");
  });

  test("resumes paused executions through MCP", async () => {
    const baseUrl = startServer();

    const paused = await withExecutorMcpClient(baseUrl, { hasUI: false }, async (client) =>
      client.execute("pause"),
    );
    expect(paused.structuredContent).toEqual({
      status: "waiting_for_interaction",
      executionId: "exec_1",
      interaction: {
        kind: "form",
        message: "Need approval",
        requestedSchema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
          },
        },
      },
    });

    const resumed = await withExecutorMcpClient(baseUrl, { hasUI: false }, async (client) =>
      client.resume("exec_1", "accept", { approved: true }),
    );
    expect(resumed.text).toBe('resumed:accept:{"approved":true}');
    expect(resumed.isError).toBe(false);
  });

  test("bridges form elicitation through the provided callback", async () => {
    const baseUrl = startServer();
    const prompts: string[] = [];

    const result = await withExecutorMcpClient(
      baseUrl,
      {
        hasUI: true,
        onElicitation: async (request) => {
          prompts.push(request.message);
          if (request.mode !== "form") {
            throw new Error("Expected form elicitation");
          }
          return { action: "accept", content: { approved: true } };
        },
      },
      async (client) => client.execute("ask-form"),
    );

    expect(prompts).toEqual(["Approve this action?"]);
    expect(result.text).toBe("approved");
  });

  test("bridges URL elicitation through the provided callback", async () => {
    const baseUrl = startServer();

    const result = await withExecutorMcpClient(
      baseUrl,
      {
        hasUI: true,
        onElicitation: async (request) => {
          expect(request).toEqual({
            mode: "url",
            message: "Authenticate",
            url: "https://example.com/auth",
            elicitationId: "elic-1",
          });
          return { action: "accept" };
        },
      },
      async (client) => client.execute("ask-url"),
    );

    expect(result.text).toBe("accept");
  });
});
