import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutorOAuthProvider } from "../src/oauth-auth.ts";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-executor-oauth-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Executor OAuth provider", () => {
  test("persists OAuth state by server origin with private file permissions", async () => {
    const storageRoot = await createTemporaryDirectory();
    const provider = createExecutorOAuthProvider({
      serverUrl: "https://executor.example/mcp",
      storageRoot,
      redirectUrl: "http://127.0.0.1:12345/callback",
      state: "state-1",
      redirectToAuthorization: async () => undefined,
    });

    await provider.saveClientInformation?.({
      client_id: "client-1",
      client_secret: "client-secret",
    });
    await provider.saveTokens({ access_token: "access-secret", token_type: "Bearer" });
    await provider.saveCodeVerifier("pkce-verifier");

    const reloaded = createExecutorOAuthProvider({
      serverUrl: "https://executor.example/another-path",
      storageRoot,
      redirectUrl: "http://127.0.0.1:12345/callback",
      state: "state-1",
      redirectToAuthorization: async () => undefined,
    });
    expect(await reloaded.clientInformation()).toEqual({
      client_id: "client-1",
      client_secret: "client-secret",
    });
    expect(await reloaded.tokens()).toEqual({
      access_token: "access-secret",
      token_type: "Bearer",
    });
    expect(await reloaded.codeVerifier()).toBe("pkce-verifier");

    const files = await Array.fromAsync(
      new Bun.Glob("*.json").scan({ cwd: storageRoot, onlyFiles: true }),
    );
    expect(files).toHaveLength(1);
    expect(await readFile(join(storageRoot, files[0]!), "utf8")).toContain("access-secret");
    if (process.platform !== "win32") {
      expect((await stat(join(storageRoot, files[0]!))).mode & 0o777).toBe(0o600);
    }
  });

  test("keeps credentials isolated by origin", async () => {
    const storageRoot = await createTemporaryDirectory();
    const createProvider = (serverUrl: string) =>
      createExecutorOAuthProvider({
        serverUrl,
        storageRoot,
        redirectUrl: "http://127.0.0.1:12345/callback",
        state: "state-1",
        redirectToAuthorization: async () => undefined,
      });

    await createProvider("https://one.example/mcp").saveTokens({
      access_token: "one-token",
      token_type: "Bearer",
    });
    expect(await createProvider("https://two.example/mcp").tokens()).toBeUndefined();
  });

  test("does not reuse a client registration bound to another callback port", async () => {
    const storageRoot = await createTemporaryDirectory();
    const first = createExecutorOAuthProvider({
      serverUrl: "https://executor.example/mcp",
      storageRoot,
      redirectUrl: "http://127.0.0.1:12345/callback",
      state: "state-1",
      redirectToAuthorization: async () => undefined,
    });
    await first.saveClientInformation?.({
      client_id: "client-1",
      redirect_uris: ["http://127.0.0.1:12345/callback"],
    });
    const nextSession = createExecutorOAuthProvider({
      serverUrl: "https://executor.example/mcp",
      storageRoot,
      redirectUrl: "http://127.0.0.1:54321/callback",
      state: "state-2",
      redirectToAuthorization: async () => undefined,
    });

    expect(await nextSession.clientInformation()).toBeUndefined();
  });

  test("opens the authorization URL through the supplied browser callback", async () => {
    const storageRoot = await createTemporaryDirectory();
    const opened: URL[] = [];
    const provider = createExecutorOAuthProvider({
      serverUrl: "https://executor.example/mcp",
      storageRoot,
      redirectUrl: "http://127.0.0.1:12345/callback",
      state: "state-1",
      redirectToAuthorization: async (url) => {
        opened.push(url);
      },
    });

    await provider.redirectToAuthorization(new URL("https://login.example/authorize"));
    expect(opened.map((url) => url.href)).toEqual(["https://login.example/authorize"]);
  });
});
