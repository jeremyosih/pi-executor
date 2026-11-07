import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type RawData } from "ws";
import {
  getExecutorClientChannelToken,
  listWorkspaceFiles,
  readWorkspaceFile,
  startExecutorClientChannel,
} from "../src/client-channel.ts";
import type { ExecutorEndpoint } from "../src/connection.ts";
import { getDefaultExecutorSettings } from "../src/settings.ts";

const originalAccessToken = process.env.EXECUTOR_ACCESS_TOKEN;
const workspaces: string[] = [];
const servers: Array<{ http: Server; websocket: WebSocketServer }> = [];

afterEach(async () => {
  if (originalAccessToken === undefined) delete process.env.EXECUTOR_ACCESS_TOKEN;
  else process.env.EXECUTOR_ACCESS_TOKEN = originalAccessToken;

  await Promise.all(
    servers.splice(0).map(async ({ http, websocket }) => {
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolveClose) => websocket.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
    }),
  );
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const createWorkspace = async (): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-executor-channel-"));
  workspaces.push(cwd);
  await writeFile(join(cwd, "README.md"), "workspace contents", "utf8");
  return cwd;
};

const listen = async (
  protocol: "cloud" | "self-host",
  closeAfterResponses = false,
  includeAdapterCapability = false,
): Promise<{
  baseUrl: string;
  connections: () => number;
  received: Promise<unknown[]>;
  reconnected: Promise<void>;
}> => {
  const http = createServer((request, response) => {
    if (protocol !== "cloud" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      expect(request.headers.authorization).toBe("Bearer test-access-token");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        manifest?: { tools?: unknown[]; resources?: unknown[]; prompts?: unknown[] };
      };
      expect(body.manifest?.tools).toHaveLength(includeAdapterCapability ? 3 : 2);
      expect(body.manifest?.resources).toHaveLength(1);
      expect(body.manifest?.prompts).toHaveLength(1);
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
      response.writeHead(201, { "content-type": "application/json" }).end(
        JSON.stringify({
          token: "opaque-client-token",
          websocket: `http://127.0.0.1:${address.port}/mcp/client-channel`,
          generation: 0,
        }),
      );
    });
  });
  const websocket = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    websocket.handleUpgrade(request, socket, head, (client) => {
      websocket.emit("connection", client, request);
    });
  });
  await new Promise<void>((resolveListen) => http.listen(0, "127.0.0.1", resolveListen));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  servers.push({ http, websocket });

  let connectionCount = 0;
  let resolveReconnected: () => void = () => {};
  const reconnected = new Promise<void>((resolveResult) => {
    resolveReconnected = resolveResult;
  });
  let resolveReceived: (value: unknown[]) => void = () => {};
  const received = new Promise<unknown[]>((resolveResult) => {
    resolveReceived = resolveResult;
  });
  websocket.on("connection", (client, request) => {
    connectionCount += 1;
    expect(request.headers.authorization).toBe("Bearer test-access-token");
    if (protocol === "cloud") {
      expect(request.headers["x-executor-client-token"]).toBe("opaque-client-token");
    }
    let requestSent = false;
    const requests = [
      {
        id: "read-1",
        method: "tools/call",
        params: { name: "read_workspace_file", arguments: { path: "README.md" } },
      },
      { id: "resource-1", method: "resources/read", params: { uri: "workspace://root" } },
      { id: "prompt-1", method: "prompts/get", params: { name: "workspace_overview" } },
      ...(includeAdapterCapability
        ? [
            {
              id: "adapter-1",
              method: "tools/call",
              params: { name: "mcp1:odd%20server:tool__with__delimiters", arguments: { x: 1 } },
            },
          ]
        : []),
    ];
    const replies: unknown[] = [];
    const sendNextRequest = (): void => {
      const next = requests[replies.length];
      if (next && client.readyState === 1) client.send(JSON.stringify(next));
      else {
        resolveReceived(replies);
        if (closeAfterResponses) client.close();
      }
    };
    client.on("message", (raw: RawData) => {
      const frame = JSON.parse(raw.toString()) as { type?: string; id?: string };
      if (frame.type === "initialize") {
        client.send(
          JSON.stringify({
            type: "bound",
            bindingToken: "self-host-binding",
            clientIdentity: "server-client",
            manifestGeneration: 1,
          }),
        );
        if (connectionCount >= 2) resolveReconnected();
      } else if (frame.id === requests[replies.length]?.id) {
        replies.push(JSON.parse(raw.toString()));
        sendNextRequest();
      }
      if (!requestSent && (protocol === "cloud" || frame.type === "initialize")) {
        requestSent = true;
        setTimeout(sendNextRequest, 20);
      }
    });
    if (protocol === "cloud") {
      requestSent = true;
      setTimeout(sendNextRequest, 20);
    }
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    connections: () => connectionCount,
    received,
    reconnected,
  };
};

const endpoint = (baseUrl: string, mode: ExecutorEndpoint["mode"]): ExecutorEndpoint => ({
  mode,
  baseUrl,
  ownedByPi: false,
  scope: { id: "scope", name: "test", dir: process.cwd() },
});

describe("Executor persistent client channel", () => {
  test("limits workspace access and omits local secrets", async () => {
    const cwd = await createWorkspace();
    await writeFile(join(cwd, ".env"), "secret", "utf8");

    expect(await readWorkspaceFile(cwd, "README.md")).toBe("workspace contents");
    await expect(readWorkspaceFile(cwd, ".env")).rejects.toThrow("not available");
    await expect(readWorkspaceFile(cwd, "../outside.txt")).rejects.toThrow("outside");
    expect(await listWorkspaceFiles(cwd)).toEqual(["README.md"]);
  });

  test.each(["self-host", "cloud"] as const)(
    "registers, binds, and serves workspace tools with the %s protocol",
    async (protocol) => {
      const cwd = await createWorkspace();
      process.env.EXECUTOR_ACCESS_TOKEN = "test-access-token";
      const server = await listen(protocol);
      const settings = {
        ...getDefaultExecutorSettings(),
        clientChannelEnabled: true,
        clientChannelProtocol: protocol,
      };
      const controller = startExecutorClientChannel(
        cwd,
        endpoint(server.baseUrl, protocol === "cloud" ? "remote" : "local"),
        settings,
        undefined,
      );

      try {
        expect(await getExecutorClientChannelToken(cwd)).toBe(
          protocol === "cloud" ? "opaque-client-token" : "self-host-binding",
        );
        const result = await Promise.race([
          server.received,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("Timed out waiting for client tool response.")),
              5_000,
            ),
          ),
        ]);
        expect(result).toEqual([
          {
            id: "read-1",
            result: {
              content: [{ type: "text", text: "workspace contents" }],
              isError: false,
            },
          },
          {
            id: "resource-1",
            result: {
              contents: [{ uri: "workspace://root", mimeType: "text/plain", text: "README.md" }],
            },
          },
          {
            id: "prompt-1",
            result: {
              description: "Workspace overview prompt",
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: "Review this workspace and provide a concise overview. Files:\nREADME.md",
                  },
                },
              ],
            },
          },
        ]);
      } finally {
        await controller.stop();
      }
    },
  );

  test("sends session context to adapter and forwards its manifest and calls", async () => {
    const cwd = await createWorkspace();
    process.env.EXECUTOR_ACCESS_TOKEN = "test-access-token";
    const server = await listen("cloud", false, true);
    const context = { cwd, sessionId: "bridge-test" };
    const requests: Array<{ channel: string; payload: any }> = [];
    const pi = {
      events: {
        emit(channel: string, payload: any) {
          requests.push({ channel, payload });
          payload.result =
            payload.operation === "manifest"
              ? Promise.resolve({
                  tools: [
                    {
                      name: "mcp1:odd%20server:tool__with__delimiters",
                      description: "adapter",
                      inputSchema: { type: "object" },
                    },
                  ],
                  resources: [],
                  prompts: [],
                })
              : Promise.resolve({ content: [{ type: "text", text: "adapter result" }] });
        },
      },
    };
    const controller = startExecutorClientChannel(
      cwd,
      endpoint(server.baseUrl, "remote"),
      {
        ...getDefaultExecutorSettings(),
        clientChannelEnabled: true,
        clientChannelProtocol: "cloud",
      },
      undefined,
      pi,
      context,
    );
    try {
      const result = await server.received;
      expect(result.at(-1)).toEqual({
        id: "adapter-1",
        result: { content: [{ type: "text", text: "adapter result" }] },
      });
      expect(requests.map(({ payload }) => payload.operation)).toEqual(["manifest", "dispatch"]);
      expect(requests.every(({ channel }) => channel === "pi-mcp-adapter:client-bridge:v1")).toBe(
        true,
      );
      expect(requests.every(({ payload }) => payload.context === context)).toBe(true);
      expect(requests[1]?.payload.params.name).toBe("mcp1:odd%20server:tool__with__delimiters");
    } finally {
      await controller.stop();
    }
  });

  test("continues workspace-only when no adapter bridge listener is installed", async () => {
    const cwd = await createWorkspace();
    process.env.EXECUTOR_ACCESS_TOKEN = "test-access-token";
    const server = await listen("cloud");
    const controller = startExecutorClientChannel(cwd, endpoint(server.baseUrl, "remote"), {
      ...getDefaultExecutorSettings(),
      clientChannelEnabled: true,
      clientChannelProtocol: "cloud",
    });
    try {
      const result = await server.received;
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ id: "read-1", result: { isError: false } });
    } finally {
      await controller.stop();
    }
  });

  test("reconnects and rebinds after the WebSocket closes", async () => {
    const cwd = await createWorkspace();
    process.env.EXECUTOR_ACCESS_TOKEN = "test-access-token";
    const server = await listen("self-host", true);
    const controller = startExecutorClientChannel(
      cwd,
      endpoint(server.baseUrl, "local"),
      {
        ...getDefaultExecutorSettings(),
        clientChannelEnabled: true,
        clientChannelProtocol: "self-host",
      },
      undefined,
    );

    try {
      await Promise.race([
        server.reconnected,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Client channel did not reconnect.")), 6_000),
        ),
      ]);
      expect(server.connections()).toBeGreaterThanOrEqual(2);
      expect(await getExecutorClientChannelToken(cwd)).toBe("self-host-binding");
    } finally {
      await controller.stop();
    }
  });

  test("rejects an insecure remote client-channel URL", async () => {
    process.env.EXECUTOR_ACCESS_TOKEN = "test-access-token";
    expect(() =>
      startExecutorClientChannel(process.cwd(), endpoint("http://executor.example", "remote"), {
        ...getDefaultExecutorSettings(),
        clientChannelEnabled: true,
        clientChannelProtocol: "self-host",
      }),
    ).toThrow("requires HTTPS/WSS outside localhost");
  });

  test("rejects an insecure websocket URL returned by cloud registration", async () => {
    process.env.EXECUTOR_ACCESS_TOKEN = "test-access-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          token: "opaque-client-token",
          websocket: "ws://executor.example/client-channel",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    let rejectState: (message: string) => void = () => {};
    const failed = new Promise<string>((resolve) => {
      rejectState = resolve;
    });
    const controller = startExecutorClientChannel(
      process.cwd(),
      endpoint("https://executor.example", "remote"),
      {
        ...getDefaultExecutorSettings(),
        clientChannelEnabled: true,
        clientChannelProtocol: "cloud",
      },
      (state, message) => {
        if (state === "error") rejectState(message ?? "");
      },
    );
    try {
      expect(await failed).toContain("requires HTTPS/WSS outside localhost");
    } finally {
      await controller.stop();
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a cross-origin websocket URL returned by cloud registration", async () => {
    process.env.EXECUTOR_ACCESS_TOKEN = "test-access-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          token: "opaque-client-token",
          websocket: "wss://attacker.example/client-channel",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    let rejectState: (message: string) => void = () => {};
    const failed = new Promise<string>((resolve) => {
      rejectState = resolve;
    });
    const controller = startExecutorClientChannel(
      process.cwd(),
      endpoint("https://executor.example", "remote"),
      {
        ...getDefaultExecutorSettings(),
        clientChannelEnabled: true,
        clientChannelProtocol: "cloud",
      },
      (state, message) => {
        if (state === "error") rejectState(message ?? "");
      },
    );
    try {
      expect(await failed).toContain("outside the configured origin");
    } finally {
      await controller.stop();
      globalThis.fetch = originalFetch;
    }
  });
});
