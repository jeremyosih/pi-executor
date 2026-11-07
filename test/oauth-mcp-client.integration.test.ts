import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutorOAuthProvider } from "../src/oauth-auth.ts";
import { withExecutorMcpClient } from "../src/mcp-client.ts";

test("recovers from an OAuth challenge and calls MCP with the exchanged bearer token", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "executor-mcp-oauth-"));
  const requests: string[] = [];
  let authorized = false;
  let registrationCount = 0;
  let baseUrl = "";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        registrationCount += 1;
        const registration = (await request.json()) as { redirect_uris: string[] };
        return Response.json({
          client_id: "test-client",
          redirect_uris: registration.redirect_uris,
        });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("auth-code");
        expect(form.get("code_verifier")).toBeTruthy();
        authorized = true;
        return Response.json({
          access_token: "integration-token",
          token_type: "Bearer",
        });
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      if (!authorized) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
          },
        });
      }
      if (request.headers.get("authorization") !== "Bearer integration-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method === "GET") return new Response("Method not allowed", { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 200 });

      const message = (await request.json()) as {
        id?: string | number;
        method: string;
      };
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-test", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? { tools: [{ name: "execute", description: "Run code" }] }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: "authenticated execution" }] }
              : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  const provider = createExecutorOAuthProvider({
    serverUrl: baseUrl,
    storageRoot,
    redirectUrl: "http://127.0.0.1:12345/callback",
    state: "integration-state",
    redirectToAuthorization: async (authorizationUrl) => {
      expect(authorizationUrl.searchParams.get("state")).toBe("integration-state");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    },
  });

  try {
    const result = await withExecutorMcpClient(
      baseUrl,
      {
        hasUI: true,
        oauthProvider: provider,
        waitForAuthorizationCode: async () => "auth-code",
      },
      (client) => client.execute("return 1"),
    );
    expect(result.text).toBe("authenticated execution");
    const reconnected = await withExecutorMcpClient(
      baseUrl,
      {
        hasUI: true,
        oauthProvider: {
          ...provider,
          redirectToAuthorization: async () => {
            throw new Error("Saved OAuth credentials should avoid a new browser login.");
          },
        },
      },
      (client) => client.execute("return 2"),
    );
    expect(reconnected.text).toBe("authenticated execution");
    expect(registrationCount).toBe(1);
    expect(requests).toContain("POST /token");
    expect(requests.filter((request) => request === "POST /mcp").length).toBeGreaterThan(1);
    expect(await provider.tokens()).toMatchObject({ access_token: "integration-token" });
  } finally {
    server.stop(true);
    await rm(storageRoot, { recursive: true, force: true });
  }
});
