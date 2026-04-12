# pi-executor MCP-parity plan

status: completed. implemented and checked against refs on 2026-04-11.

current date: 2026-04-11
cwd: `/Users/jeremy/Developer/pi-executor`

---

## goal

make Pi tool UX match Executor MCP host UX as closely as Pi allows.

target UX:

- model sees `execute` as the primary tool
- model sees `resume` only when inline elicitation is not available
- `execute` carries the same workflow guidance as MCP host
- result text / structured payloads match MCP host formatting
- paused / resumed behavior matches MCP host semantics
- helper discovery remains available to code running inside Executor, not as separate Pi-facing tools

non-goal:

- no code changes in this plan
- no assumptions without refs

---

## read this first. mandatory

fresh agent should read these before touching code.

### current Pi extension

- `src/index.ts` — extension entry. current registration point for tools + commands.
- `src/tools.ts` — current Pi-facing tool surface. main delta vs MCP.
- `src/http.ts` — current HTTP transport wrapper over local Executor `/api`.
- `src/sidecar.ts` — sidecar bootstrap/reuse/ownership. should mostly stay boundary layer.
- `src/commands.ts` — human/admin slash commands. not model-facing parity target.
- `README.md` — current shipped UX docs.
- `test/executor-tools.test.ts` — current tool helper tests.
- `test/executor-http.test.ts` — current HTTP wrapper tests.
- `test/executor-commands.test.ts` — current command tests.
- `test/executor-sidecar.test.ts` — current sidecar tests.

### shared Executor core

- `docs/executor/apps/local/src/server/executor.ts` — builds shared `createExecutor(...)` object from plugins + storage.
- `docs/executor/apps/local/src/server/main.ts` — wires one shared `executor` + one shared `engine` into both HTTP + MCP adapters.
- `docs/executor/packages/core/execution/src/engine.ts` — shared execute/pause/resume formatting + helper dispatch.
- `docs/executor/packages/core/execution/src/description.ts` — dynamic MCP execute guidance.
- `docs/executor/packages/core/execution/src/tool-invoker.ts` — shared SDK-backed search/describe/source-list/tool invoke behavior.

### HTTP adapter

- `docs/executor/packages/core/api/src/api.ts` — core HTTP groups.
- `docs/executor/packages/core/api/src/services.ts` — `ExecutorService` + `ExecutionEngineService`.
- `docs/executor/packages/core/api/src/handlers/executions.ts` — HTTP execute/resume adapter over shared engine.
- `docs/executor/packages/core/api/src/handlers/tools.ts` — HTTP tools list/schema adapter over shared executor.
- `docs/executor/packages/core/api/src/handlers/sources.ts` — HTTP sources list/tools adapter over shared executor.
- `docs/executor/packages/core/api/src/handlers/scope.ts` — HTTP scope info adapter.
- `docs/executor/apps/local/src/serve.ts` — mounts `/api` and `/mcp` in local server.

### MCP adapter

- `docs/executor/packages/hosts/mcp/src/server.ts` — MCP execute/resume tool registration. primary parity source.
- `docs/executor/packages/hosts/mcp/src/server.test.ts` — parity behavior source of truth.
- `docs/executor/packages/hosts/mcp/src/stdio-integration.test.ts` — end-to-end MCP execute behavior.
- `docs/executor/apps/local/src/server/mcp.ts` — mounts MCP host over transport.

### Pi extension constraints

- `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` — tool definition shape, `before_agent_start.systemPrompt`, UI types.
- `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js` — how prompt snippets/guidelines are incorporated into system prompt.
- `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` — UI primitives + extension lifecycle docs.
- `node_modules/@mariozechner/pi-coding-agent/examples/extensions/dynamic-tools.ts` — dynamic tool registration example.

rule:

- if a phase mentions a ref, re-read it right before implementation. do not rely on this plan’s summary alone.

---

## truth. source-backed

### 1. MCP host exposes only 2 tools: `execute`, `resume`

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const executeTool = server.registerTool("execute", ...)
const resumeTool = server.registerTool("resume", ...)
```

current Pi extension exposes 5 tools:

ref: `src/tools.ts`

```ts
export const executorTools = [
  executeTool,
  resumeTool,
  searchTool,
  describeTool,
  listSourcesTool,
] satisfies ToolDefinition[];
```

gap:

- Pi surface is wider than MCP surface
- model has to choose between helper tools + execute, unlike MCP

---

### 2. MCP `execute` tool description is dynamic. built from current sources + namespaces

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const description = await engine.getDescription();
...
description,
```

ref: `docs/executor/packages/core/execution/src/description.ts`

```ts
const lines: string[] = [
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
  ...'1. `const matches = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
  ..."5. Use `tools.executor.sources.list()` when you need configured source inventory.",
  "6. Call the tool: `const result = await tools.<path>(input);`",
];
```

and it appends live namespaces:

```ts
for (const ns of sorted) {
  const source = sources.find((s) => s.id === ns);
  lines.push(`- \`${ns}\`${label !== ns ? ` — ${label}` : ""}`);
}
```

current Pi `executor_execute` description is static + thin.

ref: `src/tools.ts`

```ts
const executeTool = defineTool({
  name: "executor_execute",
  description: "Execute JavaScript code in the local Executor sidecar for the current working directory.",
  promptSnippet: "Execute JavaScript in the local Executor sidecar for the current working directory.",
  promptGuidelines: ["Use this when you need Executor's runtime instead of Pi's built-in tools."],
```

gap:

- no live namespace inventory
- no MCP workflow guidance
- no lazy-proxy rules
- no “don’t use fetch / use search first” guidance

---

### 3. MCP hides `resume` when client supports managed elicitation

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const syncToolAvailability = () => {
  executeTool.enable();
  if (supportsManagedElicitation(server)) {
    resumeTool.disable();
  } else {
    resumeTool.enable();
  }
};
```

tests prove this.

ref: `docs/executor/packages/hosts/mcp/src/server.test.ts`

```ts
expect(names).toContain("execute");
expect(names).not.toContain("resume");
```

current Pi always registers `executor_resume`.

ref: `src/tools.ts`

```ts
export const executorTools = [
  executeTool,
  resumeTool,
  ...
]
```

gap:

- Pi does not mirror MCP capability-based visibility

note:

- Pi extension API has static `registerTool()`.
- tool definitions have static `description`, `promptSnippet`, `promptGuidelines`.

ref: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

```ts
export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
```

so exact MCP-style tool enable/disable must be mapped to Pi session/runtime behavior, not copied 1:1.

---

### 4. MCP uses managed elicitation when client supports it; pause/resume only when not supported

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
if (supportsManagedElicitation(server)) {
  const result = await engine.execute(code, {
    onElicitation: makeMcpElicitationHandler(server),
  });
  return toMcpResult(formatExecuteResult(result));
}

const outcome = await engine.executeWithPause(code);
return outcome.status === "completed"
  ? toMcpResult(formatExecuteResult(outcome.result))
  : toMcpPausedResult(formatPausedExecution(outcome.execution));
```

current Pi wrapper always uses HTTP `/api/executions` and exposes paused state back to the model.

ref: `src/tools.ts`

```ts
const result = await execute(sidecar.baseUrl, params.code);
return {
  content: [{ type: "text", text: jsonIndent(result) }],
  details: { ... }
}
```

gap:

- no inline Pi-side elicitation bridge
- paused interaction leaks back to model even when human UI exists

---

### 5. MCP formats result text with `formatExecuteResult()` and paused text with `formatPausedExecution()`

ref: `docs/executor/packages/core/execution/src/engine.ts`

```ts
export const formatExecuteResult = (result: ExecuteResult) => {
  ...
  return {
    text: parts.join("\n"),
    structured: { status: "completed", result: result.result ?? null, logs: result.logs ?? [] },
    isError: false,
  };
}
```

```ts
export const formatPausedExecution = (paused: PausedExecution) => {
  ...
  return {
    text: lines.join("\n"),
    structured: {
      status: "waiting_for_interaction",
      executionId: paused.id,
      interaction: { ... }
    },
  };
}
```

MCP tool result then becomes:

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const toMcpResult = (formatted) => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
  isError: formatted.isError || undefined,
});
```

current Pi returns raw HTTP envelope JSON:

ref: `src/tools.ts`

```ts
content: [{ type: "text", text: jsonIndent(result) }];
```

and current HTTP shape is:

ref: `src/http.ts`

```ts
export type ExecuteCompleted = {
  status: "completed";
  text: string;
  structured: JsonValue;
  isError: boolean;
};
```

gap:

- Pi text UX differs from MCP text UX
- Pi structured details differ from MCP `structuredContent`
- user/model sees transport envelope, not final MCP-shaped result

---

### 6. MCP `resume` input is tolerant. invalid / array JSON does not throw.

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const parseJsonContent = (raw: string): Record<string, unknown> | undefined => {
  if (raw === "{}") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
};
```

tests prove this:

ref: `docs/executor/packages/hosts/mcp/src/server.test.ts`

```ts
it("invalid JSON is handled gracefully (not thrown)", async () => {
```

current Pi resume parsing throws hard on invalid JSON / non-object JSON.

ref: `src/tools.ts`

```ts
const parseJsonObjectString = (text: string): JsonObject => {
  const parsed = JSON.parse(text) as JsonValue;
  if (!isJsonObject(parsed)) {
    throw new Error("contentJson must parse to a JSON object");
  }
  return parsed;
};
```

gap:

- Pi resume semantics differ from MCP resume semantics

---

### 7. MCP workflow keeps search/describe/source-list _inside_ execute runtime, not as top-level model-facing tools

ref: `docs/executor/packages/core/execution/src/engine.ts`

```ts
if (path === "search") { ... }
if (path === "executor.sources.list") { ... }
if (path === "describe.tool") { ... }
```

this is how code running _inside_ `execute` discovers tools.

current Pi lifts those helpers into first-class tools:

ref: `src/tools.ts`

```ts
name: "executor_search";
name: "executor_describe";
name: "executor_list_sources";
```

gap:

- model has a different interaction model than MCP
- agent can bypass the intended “write code in execute” path

---

### 8. Pi can do dynamic-ish behavior, but via different primitives than MCP

Pi facts:

- tools can be registered during `session_start`
- tools have static metadata once registered
- extensions can inject/replace system prompt per turn via `before_agent_start`
- tools can use UI when `ctx.hasUI`

refs:

`node_modules/@mariozechner/pi-coding-agent/examples/extensions/dynamic-tools.ts`

```ts
pi.on("session_start", (_event, ctx) => {
  registerEchoTool("echo_session", ...)
})
```

`node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

```ts
export interface BeforeAgentStartEventResult {
  systemPrompt?: string;
}
```

`node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`

```md
ctx.hasUI
ctx.ui.confirm(...)
ctx.ui.input(...)
ctx.ui.editor(...)
```

constraint:

- MCP client-capability negotiation != Pi extension runtime model
- exact parity must be semantic parity, not protocol parity

---

## exact parity target. practical

### model-facing tools

target:

- `execute`
- `resume` only in no-UI / fallback mode

not target:

- `executor_search`
- `executor_describe`
- `executor_list_sources`

these helper ops stay available _inside Executor code_ via `tools.search`, `tools.describe.tool`, `tools.executor.sources.list`.

### execution UX

target:

- `execute` text/structured result should match MCP host output
- when Pi has UI, `execute` should bridge elicitation inline, then continue execution, like MCP managed elicitation
- when Pi has no usable UI, `execute` should return paused interaction text/structured payload, and `resume` stays available

### prompt UX

target:

- inject the same workflow guidance MCP uses
- inject live namespace list from current sources
- keep tool descriptions minimal but aligned

---

## reuse directly

keep reusing:

1. sidecar + local HTTP transport
   - already works
   - avoids embedding Bun/local runtime in Pi extension

2. HTTP `/api/executions` and `/api/executions/:id/resume`
   - they already use shared engine formatting
   - good enough transport-wise

3. HTTP tools/sources/schema endpoints
   - useful for building live prompt/namespace data
   - useful as fallback/debug paths

refs:

- `src/http.ts`
- `docs/executor/packages/core/api/src/handlers/executions.ts`
- `docs/executor/packages/core/api/src/handlers/tools.ts`
- `docs/executor/packages/core/api/src/handlers/sources.ts`
- `docs/executor/apps/local/src/server/main.ts`

## mimic, not directly reuse

we should mimic MCP behavior for:

1. tool surface
   - `execute`
   - `resume` only when fallback needed

2. dynamic execute guidance
   - same workflow/rules as MCP `engine.getDescription()`

3. managed elicitation
   - if Pi has UI, do inline human interaction
   - don’t force model-visible pause/resume unless needed

4. result UX
   - text + structured output should look like MCP results, not raw HTTP envelopes

refs:

- `docs/executor/packages/hosts/mcp/src/server.ts`
- `docs/executor/packages/core/execution/src/description.ts`
- `docs/executor/packages/core/execution/src/engine.ts`
- `docs/executor/packages/hosts/mcp/src/server.test.ts`

## likely implementation shape

keep current sidecar + HTTP transport. do not embed Executor runtime directly.

why:

- existing sidecar/http works
- local Executor server/runtime is Bun-backed; embedding it in Pi extension is the wrong boundary
- MCP parity issue is tool UX + result shaping, not sidecar transport itself

proof refs:

- `docs/executor/apps/local/src/server/executor.ts`
- `docs/executor/apps/cli/src/main.ts`

probable file map after migration:

```text
src/
  index.ts       # register only MCP-parity tools + admin slash commands
  sidecar.ts     # mostly unchanged; maybe small helpers
  http.ts        # keep execute/resume + scope/tools/sources reads
  tools.ts       # major rewrite around execute/resume parity
  commands.ts    # keep admin commands only
```

optional add only if pressure forces it:

```text
src/mcp-parity.ts   # description builder + paused/result formatting + elicitation bridge
```

### current implementation entry points

fresh agent should start in these exact locations when implementing:

- `src/index.ts`
  - current extension bootstrap
  - current place where tools + admin commands are registered
- `src/tools.ts`
  - current Pi tool definitions
  - current helper-tool exposure that likely must be collapsed
  - current raw execute/resume result shaping that must change
- `src/http.ts`
  - current transport contracts to keep reusing
- `src/sidecar.ts`
  - current sidecar ownership/reuse/cleanup boundary. avoid unnecessary churn here.
- `src/commands.ts`
  - current admin-only slash commands. should stay separate from model-facing parity work.
- `test/executor-tools.test.ts`
  - current best starting point for parity tests
- `test/executor-http.test.ts`
  - current HTTP contract tests

---

## parity matrix

| area | MCP host | previous Pi | shipped Pi |
| --- | --- | --- | --- |
| model-facing tools | `execute`, conditional `resume` | `executor_execute`, `executor_resume`, helper tools | `execute`, plus `resume` only for no-UI sessions |
| execute guidance | dynamic workflow + namespace list | static thin description | dynamic MCP-style guidance via tool description + per-turn prompt injection |
| discovery helpers | inside execute runtime | top-level Pi tools | inside execute runtime only |
| execute result text | formatted by shared MCP helpers | raw HTTP envelope JSON | MCP-style text from HTTP formatted payload |
| paused behavior | managed elicitation when supported, pause/resume otherwise | always surfaced paused state | inline UI bridge when Pi has UI, pause/resume fallback otherwise |
| resume parsing | tolerant: `{}`, invalid JSON, arrays -> `undefined` | strict object parser | tolerant MCP-style parser |
| resume not found | `No paused execution: <id>` + error bit | transport error | normalized MCP-style error text |

## implementation decisions

- tool names ship as exact MCP names: `execute` and `resume`
- helper tools were removed from the default model-facing surface
- dynamic registration happens during `session_start`
- live guidance is reinforced with `before_agent_start.systemPrompt`
- `resume` is only registered for no-UI sessions
- managed interaction loops internally until completion when UI is available

## detailed todo list

## phase 0 — lock parity contract before code

goal: freeze what “same UX as MCP” means in Pi terms.

read first:

- `docs/executor/packages/hosts/mcp/src/server.ts`
- `docs/executor/packages/hosts/mcp/src/server.test.ts`
- `src/tools.ts`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

- [x] Create parity matrix in this file: MCP host behavior vs current Pi behavior vs target Pi behavior. Impl files: `plan.md`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `src/tools.ts`.
- [x] Decide tool names. preferred parity: `execute` / `resume`. verify no built-in collision. Impl files: `plan.md`, later `src/tools.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/**`, `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`.
- [x] Decide helper-tool fate: remove from active model-facing tool list vs keep hidden/internal only. Impl files: `plan.md`. Refs: `src/tools.ts`, `docs/executor/packages/core/execution/src/engine.ts`.
- [x] Define parity boundaries where Pi cannot be literal MCP: client capability negotiation, MCP `structuredContent`, transport-level tool hiding. Impl files: `plan.md`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`.

exit criteria:

- parity scope frozen
- no later phase invents new surface area casually

---

## phase 1 — port MCP result semantics into local helpers

goal: make Pi use MCP text/structured behavior, not raw HTTP envelopes.

read first:

- `docs/executor/packages/core/execution/src/engine.ts`
- `docs/executor/packages/hosts/mcp/src/server.ts`
- `docs/executor/packages/core/api/src/handlers/executions.ts`
- `src/http.ts`
- `src/tools.ts`

- [x] Vendor/adapt `formatExecuteResult()` behavior into local code. Impl files: `src/tools.ts` or `src/mcp-parity.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`.
- [x] Vendor/adapt `formatPausedExecution()` behavior into local code. Impl files: `src/tools.ts` or `src/mcp-parity.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`.
- [x] Map HTTP `/api/executions` response into MCP-style text + structured payload, not `jsonIndent(result)`. Impl files: `src/tools.ts`, maybe `src/http.ts`. Refs: `src/http.ts`, `docs/executor/packages/core/execution/src/engine.ts`.
- [x] Map HTTP `/api/executions/:id/resume` response into MCP-style text + structured payload. Impl files: `src/tools.ts`, maybe `src/http.ts`. Refs: `src/http.ts`, `docs/executor/packages/hosts/mcp/src/server.ts`.
- [x] Preserve MCP error semantics: `isError` on result, no extra transport noise in primary text. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `docs/executor/packages/core/execution/src/engine.ts`.

exit criteria:

- execute/resume output from Pi reads like MCP output
- no raw envelope JSON in normal path

---

## phase 2 — port MCP resume input semantics

goal: make Pi resume behavior match MCP tolerance rules.

read first:

- `docs/executor/packages/hosts/mcp/src/server.ts`
- `docs/executor/packages/hosts/mcp/src/server.test.ts`
- `src/tools.ts`
- `src/http.ts`

- [x] Replace strict JSON-object parser with MCP-like `parseJsonContent()` behavior. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`.
- [x] Treat `{}` as `undefined` content. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`.
- [x] Treat invalid JSON as `undefined`, not thrown error. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `docs/executor/packages/hosts/mcp/src/server.test.ts`.
- [x] Treat array JSON as `undefined`, not thrown error. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.test.ts`.
- [x] Match unknown execution-id behavior to MCP host text + error bit. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `docs/executor/packages/hosts/mcp/src/server.test.ts`.

exit criteria:

- Pi resume edge cases match MCP tests semantically

---

## phase 3 — port MCP execute description into Pi

goal: model gets the same playbook MCP provides.

read first:

- `docs/executor/packages/core/execution/src/description.ts`
- `docs/executor/packages/core/execution/src/tool-invoker.ts`
- `docs/executor/packages/hosts/mcp/src/server.ts`
- `src/tools.ts`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

- [x] Create local description builder mirroring `buildExecuteDescription()`. Impl files: `src/tools.ts` or `src/mcp-parity.ts`. Refs: `docs/executor/packages/core/execution/src/description.ts`.
- [x] Reuse exact workflow bullets where possible. Impl files: same. Refs: `docs/executor/packages/core/execution/src/description.ts`.
- [x] Reuse exact rules where possible: short queries, namespace narrowing, lazy proxy warning, no `fetch`, etc. Impl files: same. Refs: `docs/executor/packages/core/execution/src/description.ts`.
- [x] Build live namespace list from current scope sources, not hardcoded strings. Impl files: `src/tools.ts`, maybe `src/http.ts`. Refs: `docs/executor/packages/core/execution/src/description.ts`, `src/http.ts`.
- [x] Decide where this guidance lives in Pi:
  - tool `description`
  - tool `promptSnippet` / `promptGuidelines`
  - per-turn `before_agent_start.systemPrompt`
    Impl files: `plan.md`, later `src/index.ts`, `src/tools.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`.
- [x] If tool metadata cannot stay fresh enough, inject dynamic parity prompt on each turn via `before_agent_start`. Impl files: `src/index.ts` or new helper. Refs: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`.

exit criteria:

- model sees MCP-like workflow guidance before using execute
- current namespaces are visible somewhere in prompt path

---

## phase 4 — design Pi-side elicitation bridge

goal: when Pi has UI, `execute` behaves like MCP managed elicitation instead of forcing model-visible pause/resume.

read first:

- `docs/executor/packages/hosts/mcp/src/server.ts`
- `docs/executor/packages/hosts/mcp/src/server.test.ts`
- `docs/executor/packages/core/execution/src/engine.ts`
- `src/tools.ts`
- `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

- [x] Audit Pi UI primitives usable from a tool execution context: `ctx.hasUI`, `ctx.ui.confirm`, `ctx.ui.input`, `ctx.ui.editor`, optional `ctx.ui.custom`. Impl files: `plan.md`, later `src/tools.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`, `src/tools.ts`.
- [x] Define mapping from Executor interaction kinds to Pi UI:
  - approval-only form -> confirm
  - simple form schema -> generated dialog / editor-backed JSON
  - URL elicitation -> open browser + confirm done
    Impl files: `plan.md`, later `src/tools.ts`, maybe `src/commands.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `docs/executor/packages/core/execution/src/engine.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `src/tools.ts`, `src/commands.ts`.
- [x] Define fallback for no-UI mode: surface paused text/structured payload exactly like MCP no-capabilities path. Impl files: `plan.md`, later `src/tools.ts`, maybe `src/index.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.test.ts`, `src/tools.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`.
- [x] Decide whether UI bridge loops internally until execution completes, including multiple elicitations. it should, to match MCP. Impl files: `plan.md`, later `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.test.ts` (`engine can elicit multiple times during a single execute call`), `src/tools.ts`.
- [x] Define safety/abort behavior if user closes or cancels UI. map to `cancel`. Impl files: `plan.md`, later `src/tools.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `src/tools.ts`.

exit criteria:

- clear parity algorithm for execute-with-managed-elicitation
- clear fallback algorithm for execute-with-pause

---

## phase 5 — collapse model-facing surface to MCP shape

goal: make Pi agent interact with Executor like MCP client does.

read first:

- `docs/executor/packages/hosts/mcp/src/server.ts`
- `docs/executor/packages/core/execution/src/description.ts`
- `src/tools.ts`
- `src/index.ts`
- `src/commands.ts`
- `README.md`

- [x] Replace `executor_execute` with `execute` (or alias during migration, then remove old name). Impl files: `src/tools.ts`, `src/index.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `src/tools.ts`, `src/index.ts`.
- [x] Replace `executor_resume` with `resume` only for fallback/no-UI path if feasible. Impl files: `src/tools.ts`, `src/index.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.ts`, `src/tools.ts`, `src/index.ts`.
- [x] Remove `executor_search`, `executor_describe`, `executor_list_sources` from model-facing default tool list. Impl files: `src/tools.ts`, `src/index.ts`. Refs: `docs/executor/packages/core/execution/src/description.ts`, `src/tools.ts`, `src/index.ts`.
- [x] Decide migration compatibility policy:
  - hard rename now
  - temp aliases with deprecation guidance
    Impl files: `plan.md`, later `src/tools.ts`, `README.md`. Refs: current tool names in `src/tools.ts`.
- [x] Keep slash commands human/admin only; do not re-expose call/resume as user commands. Impl files: `src/commands.ts`, `README.md`. Refs: `src/commands.ts`, `README.md`.

exit criteria:

- model sees MCP-like tool surface
- humans keep admin commands separate

---

## phase 6 — runtime registration strategy

goal: work around Pi static tool metadata so UX stays close to MCP.

read first:

- `src/index.ts`
- `src/tools.ts`
- `node_modules/@mariozechner/pi-coding-agent/examples/extensions/dynamic-tools.ts`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
- `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`

- [x] Decide whether to register tools once at extension init or during `session_start` with live description. Impl files: `plan.md`, later `src/index.ts`, `src/tools.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/examples/extensions/dynamic-tools.ts`, `src/index.ts`, `src/tools.ts`.
- [x] If session-start registration is chosen, design idempotent registration and reload behavior. Impl files: `plan.md`, later `src/index.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/examples/extensions/dynamic-tools.ts`, `src/index.ts`.
- [x] If live source changes during session matter, design supplemental `before_agent_start` prompt injection rather than trying to mutate tool descriptions after registration. Impl files: `plan.md`, later `src/index.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`, `src/index.ts`.
- [x] Decide whether hidden/internal helper tools remain registered for debugging only or are removed entirely. Impl files: `plan.md`, later `src/tools.ts`, `src/index.ts`. Refs: `src/tools.ts`, `src/index.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`.

exit criteria:

- parity prompt path chosen
- registration timing chosen

---

## phase 7 — tests. parity-first

goal: lock behavior against MCP host semantics, not just current local helpers.

read first:

- `docs/executor/packages/hosts/mcp/src/server.test.ts`
- `docs/executor/packages/hosts/mcp/src/stdio-integration.test.ts`
- `test/executor-tools.test.ts`
- `test/executor-http.test.ts`
- `test/executor-commands.test.ts`
- `test/executor-sidecar.test.ts`

- [x] Add test fixtures copied/adapted from MCP host tests for execute/resume semantics. Impl files: `test/executor-tools.test.ts` or new `test/mcp-parity.test.ts`. Refs: `docs/executor/packages/hosts/mcp/src/server.test.ts`, `test/executor-tools.test.ts`, `src/tools.ts`.
- [x] Test managed-elicitation path in Pi wrapper with fake UI bridge. Impl files: new tests under `test/`. Refs: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`, `docs/executor/packages/hosts/mcp/src/server.test.ts`, `src/tools.ts`.
- [x] Test no-UI path returns paused text + structured payload with `status: "waiting_for_interaction"` and `interaction.kind`. Impl files: tests under `test/`. Refs: `docs/executor/packages/hosts/mcp/src/server.test.ts`, `docs/executor/packages/core/execution/src/engine.ts`, `src/tools.ts`.
- [x] Test `resume` hidden/disabled policy at whatever Pi equivalent layer we choose. Impl files: tests under `test/`. Refs: `docs/executor/packages/hosts/mcp/src/server.test.ts`, `src/index.ts`, `src/tools.ts`, final design.
- [x] Test resume JSON parsing parity: `{}`, invalid JSON, arrays, object JSON. Impl files: tests. Refs: `docs/executor/packages/hosts/mcp/src/server.test.ts`.
- [x] Test dynamic description builder against fixture sources/namespaces. Impl files: tests under `test/`. Refs: `docs/executor/packages/core/execution/src/description.ts`, `src/tools.ts` or `src/mcp-parity.ts`.
- [x] Test that broad helper tools are no longer model-facing if that is the chosen target. Impl files: tests under `test/`. Refs: `src/index.ts`, `src/tools.ts`, final tool registry.

exit criteria:

- parity claims backed by tests, not eyeballing

---

## phase 8 — docs + migration notes

goal: README and plan match shipped parity design.

read first:

- `README.md`
- `src/tools.ts`
- `src/commands.ts`
- `docs/executor/packages/core/execution/src/description.ts`
- `docs/executor/packages/hosts/mcp/src/server.ts`

- [x] Rewrite README tool section to match final `execute` / `resume` UX. Impl files: `README.md`. Refs: `src/tools.ts`, `src/index.ts`, `docs/executor/packages/hosts/mcp/src/server.ts`.
- [x] Document when `resume` appears vs when execute handles interaction inline. Impl files: `README.md`. Refs: `src/tools.ts`, `src/index.ts`, final design.
- [x] Document that discovery helpers live inside Executor runtime, not as top-level Pi tools. Impl files: `README.md`. Refs: `docs/executor/packages/core/execution/src/description.ts`.
- [x] Document admin slash commands separately from agent-facing tools. Impl files: `README.md`. Refs: `src/commands.ts`, `README.md`.
- [x] If helper tools remain as deprecated aliases, document sunset plan. Impl files: `README.md`, maybe `CHANGELOG.md`. Refs: `src/tools.ts`, `README.md`.

exit criteria:

- docs describe MCP-parity mental model, not current 5-tool bridge mental model

---

## decisions to make before implementation

### D1. rename tools to exact MCP names?

recommended: yes.

why:

- “exact same UX” argues for `execute` / `resume`
- MCP tests and docs all speak those names

risk:

- migration break for existing prompts/scripts using `executor_execute`

mitigation:

- temp aliases one release

### D2. keep helper tools at all?

recommended: no for model-facing default.

why:

- MCP does not expose them
- they distort the model’s workflow

possible compromise:

- keep hidden/dev-only registration behind a flag

### D3. skill needed?

recommended: not first.

why:

- MCP parity should come from core extension behavior
- skill can later reinforce best practices, but should not be required for core UX

### D4. exact parity possible?

truth: not literal 1:1.

reasons:

- MCP has explicit client capability negotiation for elicitation
- Pi exposes `ctx.hasUI` + UI primitives, not MCP client capabilities
- Pi tool metadata is static after registration

best achievable target:

- semantic parity for model + human experience
- same tool names
- same workflow guidance
- same result formatting
- same managed-vs-paused interaction split, mapped to Pi capabilities

---

## critical evidence snippets

### MCP host dynamic description

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const description = await engine.getDescription();
const executeTool = server.registerTool("execute", {
  description,
  inputSchema: { code: z.string().trim().min(1) },
}, ...)
```

### MCP host conditional resume visibility

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
if (supportsManagedElicitation(server)) {
  resumeTool.disable();
} else {
  resumeTool.enable();
}
```

### MCP host inline elicitation path

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const result = await engine.execute(code, {
  onElicitation: makeMcpElicitationHandler(server),
});
```

### MCP host pause/resume path

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const outcome = await engine.executeWithPause(code);
```

### MCP execute workflow guidance

ref: `docs/executor/packages/core/execution/src/description.ts`

```ts
'1. `const matches = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
"3. `const details = await tools.describe.tool({ path });`",
"5. Use `tools.executor.sources.list()` when you need configured source inventory.",
"6. Call the tool: `const result = await tools.<path>(input);`",
```

### current Pi raw execute output

ref: `src/tools.ts`

```ts
return {
  content: [{ type: "text", text: jsonIndent(result) }],
  details: {
    baseUrl: sidecar.baseUrl,
    scopeId: sidecar.scope?.id,
    executionId,
  },
};
```

---

## ship checklist for parity work

- [x] agent-facing tools reduced to MCP-shape
- [x] `execute` prompt/description mirrors MCP guidance + namespaces
- [x] managed elicitation path exists for Pi UI sessions
- [x] paused fallback path matches MCP no-capabilities behavior
- [x] `resume` semantics match MCP parsing + output rules
- [x] tests mirror MCP host tests where applicable
- [x] README rewritten to MCP mental model

---

## cut order if scope slips

cut last, not first:

1. pretty admin commands
2. deprecated alias tools
3. custom form renderer polish
4. dynamic live namespace refresh every turn

do not cut:

1. MCP result formatting parity
2. MCP execute workflow guidance parity
3. helper tools removed from default model-facing surface
4. managed elicitation vs paused fallback split
5. MCP-like resume parsing semantics
