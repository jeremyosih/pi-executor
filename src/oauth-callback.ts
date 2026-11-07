import { createServer, type Server } from "node:http";

export type OAuthCallbackOptions = { state: string; timeoutMs?: number };
export type OAuthCallback = {
  redirectUrl: string;
  waitForCode(): Promise<string>;
  cancel(): void;
  close(): Promise<void>;
};

export async function createOAuthCallback({
  state,
  timeoutMs = 5 * 60_000,
}: OAuthCallbackOptions): Promise<OAuthCallback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  let waiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let server: Server;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Prevent an early timeout/cancel from becoming an unhandled rejection before waiting.
  result.catch(() => undefined);
  const finish = (error?: Error, code?: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (error) rejectCode(error);
    else resolveCode(code!);
    server.close();
  };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const params = url.searchParams;
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found.");
      finish(new Error("Unexpected OAuth callback path."));
      return;
    }
    const fail = (message: string) => {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
      finish(new Error(message));
    };
    if (params.get("state") !== state) return fail("Invalid OAuth state.");
    if (params.has("error"))
      return fail(
        `Authorization failed: ${params.get("error_description") ?? params.get("error")}`,
      );
    const code = params.get("code");
    if (!code) return fail("Missing authorization code.");
    res
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Authorization complete. You can close this window.");
    finish(undefined, code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to determine callback listener address.");
  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    waitForCode() {
      if (waiting) return Promise.reject(new Error("Callback can only be awaited once."));
      waiting = true;
      if (!settled)
        timer = setTimeout(() => finish(new Error("OAuth callback timeout.")), timeoutMs);
      return result;
    },
    cancel() {
      finish(new Error("OAuth callback cancelled."));
    },
    close() {
      if (!settled) finish(new Error("OAuth callback closed."));
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
  };
}
