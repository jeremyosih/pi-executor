import { describe, expect, test } from "bun:test";
import { get } from "node:http";
import { createOAuthCallback } from "../src/oauth-callback.ts";

const request = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });

describe("localhost OAuth callback", () => {
  test("accepts exactly one callback with matching state and returns response", async () => {
    const callback = await createOAuthCallback({ state: "expected", timeoutMs: 1000 });
    try {
      expect(new URL(callback.redirectUrl).hostname).toBe("127.0.0.1");
      const result = callback.waitForCode();
      expect(await request(`${callback.redirectUrl}?code=abc&state=expected`)).toEqual({
        status: 200,
        body: "Authorization complete. You can close this window.",
      });
      await expect(result).resolves.toBe("abc");
    } finally {
      await callback.close();
    }
  });

  test.each([
    ["wrong state", "?code=abc&state=wrong"],
    ["missing code", "?state=expected"],
    ["OAuth error", "?error=access_denied&state=expected"],
  ])("rejects %s", async (_label, query) => {
    const callback = await createOAuthCallback({ state: "expected", timeoutMs: 1000 });
    try {
      const result = callback.waitForCode();
      const response = await request(callback.redirectUrl + query);
      expect(response.status).toBe(400);
      await expect(result).rejects.toThrow();
    } finally {
      await callback.close();
    }
  });

  test("rejects callbacks sent to any path other than /callback", async () => {
    const callback = await createOAuthCallback({ state: "expected", timeoutMs: 1000 });
    try {
      const result = callback.waitForCode();
      const url = new URL(callback.redirectUrl);
      url.pathname = "/other";
      url.search = "?code=abc&state=expected";
      const response = await request(url.href);
      expect(response.status).toBe(404);
      await expect(result).rejects.toThrow("Unexpected OAuth callback path.");
    } finally {
      await callback.close();
    }
  });

  test("rejects after timeout and supports cancellation", async () => {
    const timed = await createOAuthCallback({ state: "s", timeoutMs: 10 });
    await expect(timed.waitForCode()).rejects.toThrow(/timeout/i);
    const cancelled = await createOAuthCallback({ state: "s", timeoutMs: 1000 });
    const result = cancelled.waitForCode();
    cancelled.cancel();
    await expect(result).rejects.toThrow(/cancel/i);
    await cancelled.close();
  });
});
