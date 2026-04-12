import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createExecutorTools, loadExecutorPrompt } from "../src/tools.ts";

const servers: Array<{ stop: () => Promise<void> | void }> = [];
const tempDirs: string[] = [];

const EXECUTE_DESCRIPTION = [
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
  "",
  "## Workflow",
  "",
  '1. `const matches = await tools.search({ query: "linear issues", limit: 5 });`',
  '2. `const path = matches[0]?.path;`',
  '3. `const details = await tools.describe.tool({ path });`',
  '4. `const result = await tools.mcp_linear_app.list_issues({ project: "proj", limit: 5 });`',
].join("\n");

const RESUME_DESCRIPTION = "Resume a paused execution using the executionId returned by execute.";

const createExecutorHost = (): McpServer => {
  const server = new McpServer({ name: "executor", version: "1.0.0" });

  const executeTool = server.registerTool(
    "execute",
    {
      description: EXECUTE_DESCRIPTION,
      inputSchema: { code: z.string() },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );

  const resumeTool = server.registerTool(
    "resume",
    {
      description: RESUME_DESCRIPTION,
      inputSchema: {
        executionId: z.string(),
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.string().default("{}"),
      },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
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

      createdServer = createExecutorHost();
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

const createRemoteExecutorProject = async (baseUrl: string): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-executor-prompt-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify(
      {
        piExecutor: {
          mode: "remote",
          remoteUrl: baseUrl,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return cwd;
};

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }

  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("executor prompt + tool descriptions", () => {
  test("loadExecutorPrompt uses the upstream execute tool description", async () => {
    const baseUrl = startServer();
    const cwd = await createRemoteExecutorProject(baseUrl);

    const prompt = await loadExecutorPrompt(cwd, true);

    expect(prompt).toContain(EXECUTE_DESCRIPTION);
    expect(prompt).toContain("Use execute for Executor work and let it handle any interaction inline.");
  });

  test("createExecutorTools uses inspected MCP descriptions for execute and resume", async () => {
    const baseUrl = startServer();
    const cwd = await createRemoteExecutorProject(baseUrl);

    const tools = await createExecutorTools(cwd, false);
    const executeTool = tools.find((tool) => tool.name === "execute");
    const resumeTool = tools.find((tool) => tool.name === "resume");

    expect(executeTool?.description).toBe(EXECUTE_DESCRIPTION);
    expect(resumeTool?.description).toBe(RESUME_DESCRIPTION);
  });
});
