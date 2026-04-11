import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  buildDescribeSnippet,
  buildListSourcesSnippet,
  buildSearchSnippet,
  isCompletedNonError,
  truncateToolOutput,
  unwrapStructuredResult,
} from "../src/tools.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("tool helpers", () => {
  test("builds helper snippets without undefined fields", () => {
    expect(buildSearchSnippet({ query: "users" })).toBe(
      'return tools.search({\n  "query": "users"\n});',
    );
    expect(buildDescribeSnippet({ path: "tool.alpha" })).toBe(
      'return tools.describe.tool({\n  "path": "tool.alpha"\n});',
    );
    expect(buildListSourcesSnippet({ limit: 5 })).toBe(
      'return tools.executor.sources.list({\n  "limit": 5\n});',
    );
  });

  test("unwraps completed non-error execute results only", () => {
    const completed = {
      status: "completed" as const,
      text: "ok",
      structured: { result: { ok: true } },
      isError: false,
    };
    const failed = {
      status: "completed" as const,
      text: "nope",
      structured: { error: "boom" },
      isError: true,
    };

    expect(isCompletedNonError(completed)).toBe(true);
    expect(unwrapStructuredResult(completed)).toEqual({ ok: true });
    expect(isCompletedNonError(failed)).toBe(false);
  });

  test("truncates large outputs and spills the full output to disk", async () => {
    const largeOutput = Array.from({ length: 2505 }, (_, index) => `line-${index}`).join("\n");
    const truncated = await truncateToolOutput(largeOutput, "pi-executor-tools-");

    expect(truncated.fullOutputPath).toBeDefined();
    expect(truncated.text).toContain("Output truncated");

    const fullOutputPath = truncated.fullOutputPath;
    if (!fullOutputPath) {
      throw new Error("Expected fullOutputPath to be set");
    }
    cleanupPaths.push(fullOutputPath.replace(/\/output\.txt$/, ""));

    const restored = await Bun.file(fullOutputPath).text();
    expect(restored).toBe(largeOutput);
  });
});
