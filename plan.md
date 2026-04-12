# pi-executor plan

status: proposed. do not implement from memory.
current date: 2026-04-11
cwd: `/Users/jeremy/Developer/pi-executor`

---

## summary

implement this:

- static Pi wrapper over the **real Executor MCP endpoint**
- keep **HTTP only** for sidecar bootstrap / reuse / health / scope detection
- use **MCP** for real Executor behavior:
  - `execute`
  - `resume` only when server exposes it
  - server instructions / execute guidance
  - managed elicitation
  - result semantics
- add **one stable MCP client dep max**, only if stable line supports needed features
- no generic MCP mirror
- no hand-rolled MCP protocol client

why:

- 1 real capability only
- drift matters more than flexibility
- current HTTP path duplicates MCP host semantics
- MCP host already owns behavior we want

fallback:

- if stable MCP client cannot do Streamable HTTP + elicitation cleanly, stop, document blocker, keep current HTTP path

---

## guidelines. hard rules

- trust code. not memory. not this plan.
- before each phase, re-read listed refs.
- prefer smallest diff that removes drift.
- keep Pi surface static:
  - `execute`
  - `resume` only if needed
- do **not** add helper Pi-facing tools.
- do **not** implement generic tool mirroring.
- do **not** hand-roll MCP transport unless blocked by dependency reality.
- keep sidecar lifecycle on HTTP. do not move it to MCP.
- source prompt/instructions from MCP host when possible. do not rebuild if server already knows.
- use Bun commands only.
- after each phase: run tests + typecheck.
- if docs and code disagree, trust local code + chosen package version.
- for MCP SDK choice: prefer stable v1.x. docs say v2 is pre-alpha.

---

## required reading. fresh-agent order

read in this order before editing.

### A. current repo. must read

1. `package.json`
2. `src/index.ts`
3. `src/tools.ts`
4. `src/executor-adapter.ts`
5. `src/http.ts`
6. `src/sidecar.ts`
7. `src/commands.ts`
8. `README.md`
9. `test/executor-tools.test.ts`
10. `test/executor-http.test.ts`
11. `test/executor-sidecar.test.ts`
12. `test/executor-commands.test.ts`

### B. executor upstream refs. must read

1. `docs/executor/apps/local/src/serve.ts`
2. `docs/executor/apps/local/src/server/main.ts`
3. `docs/executor/apps/local/src/server/mcp.ts`
4. `docs/executor/packages/hosts/mcp/src/server.ts`
5. `docs/executor/packages/hosts/mcp/src/server.test.ts`
6. `docs/executor/packages/core/execution/src/engine.ts`
7. `docs/executor/packages/core/execution/src/description.ts`
8. `docs/executor/packages/core/api/src/handlers/executions.ts`

### C. MCP client refs. must read

1. `docs/typescript-sdk/README.md`
2. `docs/typescript-sdk/docs/client.md`
3. `docs/typescript-sdk/examples/client/src/simpleStreamableHttp.ts`
4. `docs/typescript-sdk/examples/client/src/elicitationUrlExample.ts`
5. `docs/typescript-sdk/packages/client/src/client/streamableHttp.ts`

### D. Pi extension refs. must read

1. `/Users/jeremy/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
2. `/Users/jeremy/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/extensions/hello.ts`
3. `/Users/jeremy/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/extensions/with-deps/index.ts`

rule:

- before touching a file, re-read that file + its upstream ref.
- do not trust snippets below as sufficient.

---

## truth. source-backed. current state

### 1. Pi currently uses HTTP and rebuilds MCP-ish behavior in repo code

ref: `src/index.ts`

```ts
await registerExecutorTools(pi, ctx.cwd, ctx.hasUI)
systemPrompt: `${event.systemPrompt}\n\n${await loadExecutorPrompt(ctx.cwd, ctx.hasUI)}`
```

ref: `src/tools.ts`

```ts
const outcome = await runManagedExecution(
  {
    execute: (code) => execute(sidecar.baseUrl, code),
    resume: (executionId, payload) => resume(sidecar.baseUrl, executionId, payload),
  },
  params.code,
  async (interaction) => promptForInteraction(interaction, ctx),
)
```

```ts
return hasUI ? [buildExecuteTool(description)] : [buildExecuteTool(description), buildResumeTool()]
```

meaning:

- Pi code currently decides tool visibility
- Pi code currently loops paused/resume interactions itself
- Pi code currently rebuilds prompt guidance itself

### 2. current HTTP adapter is the source of that drift

ref: `src/http.ts`

```ts
export const execute = async (baseUrl: string, code: string): Promise<ExecuteResponse> =>
  fetchJson(baseUrl, "/api/executions", parseExecuteResponse, {
    method: "POST",
    body: { code },
  })
```

```ts
export const resume = async (
  baseUrl: string,
  executionId: string,
  payload: ResumePayload,
): Promise<ResumeResponse> =>
  fetchJson(baseUrl, `/api/executions/${encodeURIComponent(executionId)}/resume`, ...)
```

meaning:

- current execute path is HTTP `/api/executions`
- current resume path is HTTP `/api/executions/:id/resume`
- current code is not calling the real MCP host

### 3. local Executor already exposes `/mcp`

ref: `docs/executor/apps/local/src/serve.ts`

```ts
if (url.pathname.startsWith("/mcp")) {
  return handlers.mcp.handleRequest(req)
}

if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
  url.pathname = url.pathname.slice("/api".length) || "/"
  return handlers.api.handler(new Request(url, req))
}
```

meaning:

- we do not need to invent an MCP server
- same local sidecar already serves `/api` and `/mcp`

### 4. MCP host already owns the behavior we want

ref: `docs/executor/packages/hosts/mcp/src/server.ts`

```ts
const description = await engine.getDescription()
```

```ts
if (supportsManagedElicitation(server)) {
  const result = await engine.execute(code, {
    onElicitation: makeMcpElicitationHandler(server),
  })
  return toMcpResult(formatExecuteResult(result))
}

const outcome = await engine.executeWithPause(code)
return outcome.status === "completed"
  ? toMcpResult(formatExecuteResult(outcome.result))
  : toMcpPausedResult(formatPausedExecution(outcome.execution))
```

```ts
const syncToolAvailability = () => {
  executeTool.enable()
  if (supportsManagedElicitation(server)) {
    resumeTool.disable()
  } else {
    resumeTool.enable()
  }
}
```

meaning:

- description already lives upstream
- managed elicitation already lives upstream
- resume visibility already lives upstream

### 5. engine already owns result formatting

ref: `docs/executor/packages/core/execution/src/engine.ts`

```ts
export const formatExecuteResult = (result: ExecuteResult) => {
  ...
  return {
    text: parts.join("\n"),
    structured: { status: "completed", result: result.result ?? null, logs: result.logs ?? [] },
    isError: false,
  }
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
  }
}
```

meaning:

- do not recreate this formatting in Pi if MCP already returns it

### 6. upstream tests prove MCP visibility + elicitation behavior

ref: `docs/executor/packages/hosts/mcp/src/server.test.ts`

```ts
const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities })
```

```ts
client.setRequestHandler(ElicitRequestSchema, async () => ({
  action: "accept" as const,
  content: { approved: true },
}))
```

```ts
const { tools } = await client.listTools()
expect(names).toContain("execute")
expect(names).not.toContain("resume")
```

meaning:

- actual MCP client capability negotiation controls `resume`
- actual MCP client handler path controls elicitation
- this is the parity source. not our local HTTP shim.

### 7. MCP TS SDK supports what we need. but version choice matters

ref: `docs/typescript-sdk/README.md`

```md
main branch contains v2 of the SDK (currently in development, pre-alpha)
v1.x remains the recommended version for production use
```

ref: `docs/typescript-sdk/docs/client.md`

```ts
const client = new Client({ name: 'my-client', version: '1.0.0' })
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'))
await client.connect(transport)
```

```ts
client.setRequestHandler('elicitation/create', async request => {
  return { action: 'accept', content: { confirm: true } }
})
```

meaning:

- Streamable HTTP client exists
- elicitation handler exists
- must pin to stable line if possible

### 8. repo currently has no MCP client dependency

ref: `package.json`

```json
"dependencies": {
  "@executor-js/sdk": "^0.0.1-beta.2",
  "executor": "^1.4.4"
}
```

meaning:

- any MCP client dep decision is explicit work
- dependency count must be justified

---

## target architecture

### keep

- `src/sidecar.ts` as sidecar lifecycle boundary
- HTTP `GET /api/scope` for health / cwd validation
- `src/commands.ts` for `/executor-web`, `/executor-start`, `/executor-stop`

### replace

replace Pi-side parity logic with a tiny MCP bridge:

- new `src/mcp-client.ts` or equivalent
- static Pi tool wrapper in `src/tools.ts`
- prompt/instructions loaded from MCP host, not rebuilt locally if avoidable
- execute/resume routed through MCP, not `/api/executions`

### do not build

- generic mirror of arbitrary MCP tools
- custom JSON-RPC/MCP transport from scratch
- extra Pi-facing helper tools

---

## detailed todo list. phases + tasks

check box only when code + tests are done.

don't skip phases.

---

## phase 0 — truth pass. dependency gate. no code yet

goal:

- verify recommendation is implementable with low drift + low dep count
- choose exact MCP client package/version from evidence

### tasks

- [ ] re-read: `docs/typescript-sdk/README.md`, `docs/typescript-sdk/docs/client.md`, `docs/typescript-sdk/examples/client/src/simpleStreamableHttp.ts`, `docs/typescript-sdk/examples/client/src/elicitationUrlExample.ts`
- [ ] verify exact package name + API for the **stable** client line. do not assume v2 docs apply verbatim to the chosen stable package.
- [ ] verify chosen stable package supports all required features:
  - Streamable HTTP transport
  - `connect`
  - `listTools`
  - `callTool`
  - server instructions retrieval
  - elicitation request handler
  - explicit close / session termination if needed
- [ ] compare chosen client API against upstream Executor host tests in `docs/executor/packages/hosts/mcp/src/server.test.ts`
- [ ] decide exact dependency strategy:
  - preferred: one stable MCP client package
  - rejected: pre-alpha v2 only
  - rejected: hand-rolled client
- [ ] record the chosen package + version + why in this plan before implementation begins

### done when

- [ ] exact MCP client dep chosen from stable line
- [ ] or blocker documented clearly: stable client missing required features

### stop condition

- [ ] if no viable stable client exists, stop. do not start implementation. update plan to fallback HTTP-only path instead.

---

## phase 1 — map current code to target change set

goal:

- identify exactly what code stays, what code shrinks, what code dies

### tasks

- [ ] re-read: `src/index.ts`, `src/tools.ts`, `src/executor-adapter.ts`, `src/http.ts`, `src/sidecar.ts`, `src/commands.ts`
- [ ] mark `src/sidecar.ts` as keep. only sidecar lifecycle / scope health.
- [ ] mark `src/commands.ts` as keep. maybe no code changes except imports/types if needed.
- [ ] mark `src/tools.ts` as primary integration rewrite target.
- [ ] mark `src/executor-adapter.ts` as likely shrink/delete target. identify which helpers still matter after MCP path exists.
- [ ] mark `src/http.ts` execution/list wrappers as likely delete target. keep only what sidecar lifecycle still needs.
- [ ] map current tests to future state:
  - `test/executor-tools.test.ts` will change a lot
  - `test/executor-http.test.ts` will likely shrink
  - `test/executor-sidecar.test.ts` should mostly stay
  - `test/executor-commands.test.ts` should mostly stay

### done when

- [ ] file-by-file keep/rewrite/delete decision written down
- [ ] no ambiguity left about where MCP logic will live

---

## phase 2 — add tiny MCP bridge module

goal:

- isolate all MCP client lifecycle in one new module
- keep rest of repo dumb

### create

- [ ] add `src/mcp-client.ts`

### required surface

- [ ] one small constructor/helper around `${baseUrl}/mcp`
- [ ] one way to open a client with capabilities based on Pi session
- [ ] one way to close client/transport cleanly
- [ ] one function to read server instructions
- [ ] one function to list exposed tools
- [ ] one function to call `execute`
- [ ] one function to call `resume` when needed
- [ ] one place to bridge server `elicitation/create` requests into caller callbacks

### constraints

- [ ] do **not** expose generic mirror abstractions
- [ ] do **not** let MCP SDK details leak all over `src/tools.ts`
- [ ] prefer `withExecutorMcpClient(...)` / `connectExecutorMcp(...)` style helper over persistent global singleton unless evidence forces persistence
- [ ] if client supports session termination, use it on close when appropriate
- [ ] do not put sidecar boot logic here

### read before coding

- [ ] `docs/typescript-sdk/docs/client.md`
- [ ] `docs/typescript-sdk/packages/client/src/client/streamableHttp.ts`
- [ ] `docs/executor/apps/local/src/server/mcp.ts`
- [ ] `docs/executor/packages/hosts/mcp/src/server.ts`

### done when

- [ ] MCP bridge can connect to `/mcp`
- [ ] MCP bridge can fetch instructions
- [ ] MCP bridge can `listTools`
- [ ] MCP bridge can `callTool('execute', ...)`
- [ ] MCP bridge can accept elicitation callback wiring
- [ ] MCP bridge cleans up transport/client reliably

---

## phase 3 — switch prompt/instruction loading to MCP

goal:

- stop rebuilding execute guidance locally when server can provide it

### tasks

- [ ] re-read: `src/index.ts`, `src/tools.ts`, `src/executor-adapter.ts`, `docs/executor/packages/hosts/mcp/src/server.ts`, `docs/executor/packages/core/execution/src/description.ts`
- [ ] replace `loadExecuteDescription(...)` / local description synthesis path with MCP-sourced instructions or MCP tool description, whichever is actually available from the chosen client API
- [ ] keep fallback text only as a last-resort guard if MCP instruction fetch fails
- [ ] keep prompt injection in `src/index.ts`, but make source of truth MCP-backed
- [ ] verify prompt text still tells model to use `execute` correctly

### explicit delete/shrink targets

- [ ] remove or reduce `buildExecuteDescriptionFromData(...)` if no longer needed
- [ ] remove or reduce `loadExecuteDescription(...)` if no longer needed
- [ ] remove duplicated namespace-description logic if MCP already supplies it

### done when

- [ ] Pi prompt guidance comes from real MCP host behavior
- [ ] local execute-guidance synthesis is gone or fallback-only

---

## phase 4 — switch tool execution path from HTTP to MCP

goal:

- Pi `execute` and `resume` should call the real MCP host

### tasks

- [ ] re-read: `src/tools.ts`, `src/http.ts`, `docs/executor/packages/hosts/mcp/src/server.ts`, `docs/executor/packages/core/execution/src/engine.ts`
- [ ] in `src/tools.ts`, keep static Pi tool registration. do not mirror arbitrary server tools.
- [ ] map Pi `execute` tool to MCP `execute`
- [ ] map Pi `resume` tool to MCP `resume` only when fallback path is needed
- [ ] preserve Pi `details` payload shape or replace it deliberately with a simpler MCP-backed shape. if changed, update `src/index.ts` tool_result logic accordingly.
- [ ] preserve correct `isError` propagation from MCP result into Pi tool result
- [ ] preserve baseUrl/scopeId metadata if still useful for UX/debugging

### tool surface rules

- [ ] `execute` always present
- [ ] `resume` presence must come from reality, not hardcoded `hasUI ? ... : ...` alone
- [ ] prefer asking MCP tool list what exists after client initializes with chosen capabilities

### done when

- [ ] no execution path in `src/tools.ts` calls HTTP `/api/executions`
- [ ] no resume path in `src/tools.ts` calls HTTP `/api/executions/:id/resume`
- [ ] actual Pi-facing behavior follows MCP server tool list + MCP call results

---

## phase 5 — map MCP elicitation into Pi UI

goal:

- inline interaction in Pi UI when possible
- headless fallback still works

### tasks

- [ ] re-read: `src/tools.ts`, `/Users/jeremy/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `docs/typescript-sdk/docs/client.md`, `docs/typescript-sdk/examples/client/src/elicitationUrlExample.ts`, `docs/executor/packages/hosts/mcp/src/server.test.ts`
- [ ] implement form elicitation bridge using Pi UI primitives
- [ ] implement URL elicitation bridge:
  - open browser if possible
  - notify user if launcher fails
  - collect accept / decline / cancel
- [ ] preserve current good UX behavior from `promptForInteraction(...)` where useful; move it to MCP-backed callback path instead of HTTP pause/resume loop
- [ ] keep headless / no-UI path explicit:
  - client capabilities should not advertise managed elicitation
  - MCP server should then expose `resume`
  - Pi should allow `resume` tool in that case
- [ ] verify `resume` uses exact execution id returned by paused MCP result

### done when

- [ ] UI session completes managed elicitation inline through MCP callback path
- [ ] no-UI session gets explicit paused result + usable `resume`
- [ ] Pi no longer manually loops HTTP pause/resume for managed interaction

---

## phase 6 — delete drift-prone HTTP parity code

goal:

- remove code that existed only to imitate MCP

### tasks

- [ ] re-read: `src/executor-adapter.ts`, `src/http.ts`, `test/executor-tools.test.ts`, `test/executor-http.test.ts`
- [ ] delete unused HTTP execute/resume/listTools/schema/source wrappers from `src/http.ts` if sidecar lifecycle no longer needs them
- [ ] keep `getScope` + shared HTTP helpers only if still needed by `src/sidecar.ts`
- [ ] delete unused normalization helpers in `src/executor-adapter.ts`
- [ ] delete unused managed-execution loop helpers in `src/executor-adapter.ts`
- [ ] rename/split modules if file names no longer match responsibilities

### done when

- [ ] repo no longer contains duplicate MCP emulation that serves no purpose
- [ ] HTTP boundary is clearly sidecar-lifecycle-only
- [ ] MCP boundary is clearly execution-behavior-only

---

## phase 7 — tests. replace old parity tests with MCP-backed tests

goal:

- prove behavior from code, not hope

### test work

- [ ] re-read: `test/executor-tools.test.ts`, `test/executor-http.test.ts`, `test/executor-sidecar.test.ts`, `test/executor-commands.test.ts`, `docs/executor/packages/hosts/mcp/src/server.test.ts`
- [ ] add new MCP bridge tests. likely new file: `test/executor-mcp-client.test.ts`
- [ ] test chosen client/bridge against a tiny Streamable HTTP MCP test server. prefer SDK-backed fixture. do not make production code depend on `docs/`.
- [ ] assert prompt/instructions load through MCP path
- [ ] assert `execute` call goes through MCP path
- [ ] assert UI capability path hides `resume` if MCP server hides it
- [ ] assert headless capability path exposes/uses `resume`
- [ ] assert form elicitation maps to Pi callback path
- [ ] assert URL elicitation maps to Pi callback path
- [ ] assert MCP error `isError` propagates to Pi tool_result
- [ ] update/remove old HTTP parity tests that no longer reflect architecture
- [ ] keep sidecar tests green
- [ ] keep command tests green

### commands to run

- [ ] `bun test`
- [ ] `bun run typecheck`

### done when

- [ ] tests prove MCP-backed path
- [ ] stale HTTP-parity tests removed or rewritten
- [ ] no red tests
- [ ] no TS errors

---

## phase 8 — docs cleanup

goal:

- shipped docs match shipped architecture

### tasks

- [ ] update `README.md` runtime model bullets:
  - say sidecar lifecycle uses HTTP `/api/scope`
  - say execute behavior uses MCP `/mcp`
  - remove wording that implies local HTTP execution path if that is no longer true
- [ ] update install/dev docs if new MCP client dep added
- [ ] fix any stale script names or commands in `README.md` while touching docs
- [ ] document `resume` behavior precisely: visible only when managed elicitation is unavailable

### done when

- [ ] README matches actual architecture
- [ ] no stale HTTP-only claims remain

---

## final acceptance checklist

all must be true.

- [ ] sidecar boot/reuse still works via `src/sidecar.ts`
- [ ] Pi tool surface stays minimal: `execute`, plus `resume` only when needed
- [ ] prompt/instructions come from MCP host or MCP-exposed metadata, not hand-built local parity code
- [ ] execute path uses `/mcp`, not `/api/executions`
- [ ] inline elicitation works in UI sessions
- [ ] headless fallback works with `resume`
- [ ] no generic MCP mirror exists
- [ ] no hand-rolled MCP protocol client exists
- [ ] dependency count increased only if stable MCP client was required
- [ ] tests + typecheck green
- [ ] README updated

---

## implementation notes. likely file outcomes

### keep mostly intact

- `src/sidecar.ts`
- `src/commands.ts`
- `test/executor-sidecar.test.ts`
- `test/executor-commands.test.ts`

### rewrite significantly

- `src/tools.ts`
- `src/index.ts`

### shrink or delete

- `src/executor-adapter.ts`
- `src/http.ts`
- `test/executor-tools.test.ts`
- `test/executor-http.test.ts`

### add

- `src/mcp-client.ts`
- `test/executor-mcp-client.test.ts`

---

## if blocked

if blocked by SDK stability or missing stable client features:

- stop
- write exact blocker in this file
- name missing feature
- cite file/docs proving the gap
- do not silently drift back into hand-rolled MCP or expanded HTTP parity logic
