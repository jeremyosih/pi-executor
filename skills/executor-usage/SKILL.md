---
name: executor-usage
description: >-
  Load this skill before using the `execute` tool. It teaches the Executor sandbox
  calling model: discover tools with `tools.search({ query, limit })`, inspect them
  with `tools.describe.tool({ path })`, inspect configured sources with
  `tools.executor.sources.list({})`, then call the real tool as
  `tools.<namespace>.<tool>(args)`. Use when working with third-party services,
  SaaS APIs, MCP/OpenAPI/GraphQL tools, auth-managed actions, or remote data that
  should go through Executor instead of direct shell scripts or ad hoc HTTP code.
metadata:
  short-description: Required calling pattern for Executor `execute`
---

# Executor Usage

Use this skill **before any `execute` call**.

This skill exists to prevent trial-and-error inside the Executor sandbox.
The runtime is a **lazy proxy over Executor tools**, not a normal JS object, so naive probing (`Object.keys`, `globalThis`, random namespace guesses, `tools()`) is misleading.

## Source of truth

Before calling `execute`, read the `execute` tool definition in the current prompt/context.
That definition is the session-specific source of truth.

This skill summarizes the current Executor calling model exposed by the `execute` tool definition in your session.
Avoid baking in repository-specific file paths or local implementation details.

## Mental model

Inside `execute`:

- Pi exposes **Executor's sandbox**, not arbitrary top-level JS globals.
- The `tools` object is a **lazy proxy**.
- You **discover** tools with helper functions first.
- You then call the real tool by its **full path** as nested properties:
  - `tools.mcp_linear_app.list_issues({...})`
  - not `tools.linear(...)`
  - not `tools()`
- Built-in helper paths are:
  - `tools.search({ query, namespace?, limit? })`
  - `tools.describe.tool({ path })`
  - `tools.executor.sources.list({ query?, limit? })`

## Non-negotiable workflow

Follow this order inside every `execute` snippet unless you already know the exact tool path with high confidence.

1. **Search** for the tool.
2. **Pick the best path** from the search results.
3. **Describe** the tool to get compact TypeScript shapes.
4. **Call** the tool using the full namespace path.
5. **Normalize** the result before returning it when the tool returns MCP-style content blocks.

## Canonical pattern

```ts
const matches = await tools.search({ query: "linear issues", limit: 5 });
const path = matches[0]?.path;
if (!path) return "No matching tools found.";

const details = await tools.describe.tool({ path });
console.log(details.inputTypeScript);
console.log(details.outputTypeScript);

const result = await tools.mcp_linear_app.list_issues({
  project: "<project-id>",
  limit: 5,
});

return result;
```

## Result normalization pattern

Many MCP-backed tools return an MCP payload like:

```ts
{
  content: [{ type: "text", text: "{...json...}" }],
  structuredContent?: {...}
}
```

Prefer `structuredContent` when present. Otherwise, parse the first text block if it looks like JSON.

```ts
const unwrap = (value: any) => {
  if (value?.structuredContent) return value.structuredContent;

  const text = value?.content?.find?.((item: any) => item?.type === "text")?.text;
  if (typeof text !== "string") return value;

  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
};
```

Use it like:

```ts
const raw = await tools.mcp_linear_app.list_projects({ query: "gitinspect", limit: 10 });
return unwrap(raw);
```

## Hard rules

### Required

- Always start with `tools.search({ ... })` for unknown integrations.
- Always pass an **object** to helper tools.
- Always use the **full namespace prefix** when invoking the real tool.
- Use `tools.describe.tool({ path })` before invoking unfamiliar tools.
- Use `tools.executor.sources.list({})` when you need source inventory or namespace confirmation.
- Let `execute` handle inline elicitation in Pi UI sessions.

### Forbidden

- Do **not** call `tools()`.
- Do **not** probe with `Object.keys(tools)` or rely on `globalThis` for discovery.
- Do **not** guess namespaces from property names like `tools.linear` or `tools.mcp`.
- Do **not** pass string args to `tools.search`; pass an object.
- Do **not** use `includeSchemas` with `tools.describe.tool()`; that parameter is no longer accepted.
- Do **not** assume tool results are already plain JSON objects.
- Do **not** use `fetch` when Executor already has the integration you need.

## Good search patterns

Use short intent phrases with key nouns:

- `linear issues`
- `github pull requests`
- `calendar event`
- `slack channel messages`

When you know the namespace, narrow it:

```ts
await tools.search({ namespace: "mcp_linear_app", query: "issues", limit: 10 });
```

## Decision rule

Use Executor when the task is mostly **outside the repo**:
- SaaS APIs
- remote systems
- configured MCP / OpenAPI / GraphQL integrations
- auth- or approval-managed actions

Use Pi's native file tools when the task is mostly **inside the repo**:
- reading files
- editing code
- refactors
- local tests and builds

## Interaction rule

In Pi UI sessions, let `execute` handle Executor interaction inline.
Do **not** call `resume` unless `execute` explicitly cannot finish inline and gives you an execution ID to resume.

## Quick recovery checklist

If an `execute` snippet behaves strangely, check these first:

1. Did you forget to load this skill before using `execute`?
2. Did you call `tools.search({ ... })` instead of guessing?
3. Did you pass an object to helper tools?
4. Did you use `tools.describe.tool({ path })` before calling an unfamiliar tool?
5. Did you invoke the real tool with its full namespace path?
6. Did you unwrap `structuredContent` / JSON text if the result looked nested?
