# pi-executor implementation plan

## Status

Implementation complete. Core runtime, tools, slash command, tests, smoke checks, and README are done.

Pinned target now:

- runtime package: `executor@1.4.4` from root `package.json` + `bun.lock`
- source mirror: `docs/executor` at `ec8d8865` (`v1.4.5-beta.0-8`)

Trust rules:

- trust `node_modules/executor/*` for package/bootstrap/runtime layout
- trust `docs/executor/*` only where behavior was re-checked against `v1.4.4`
- trust `node_modules/@mariozechner/pi-coding-agent/{docs,dist}/*` for Pi extension/runtime constraints

---

## Summary

Ship v1 as a Pi extension that:

- ensures a local Executor sidecar per cwd
- talks to Executor over local HTTP
- exposes 5 Pi tools:
  - `executor_execute`
  - `executor_resume`
  - `executor_search`
  - `executor_describe`
  - `executor_list_sources`
- exposes 1 slash command with subcommands:
  - `/executor web`
  - `/executor call`
  - `/executor resume`
- keeps source/secrets/auth mutation in Executor’s browser UI

Hard v1 boundaries:

- no direct SDK runtime embedding
- no CLI stdout parsing as primary API
- no `/executor mcp`
- no full dynamic mirroring of Executor’s catalog into Pi tools
- no extension settings UI / persisted knobs in v1
- no arbitrary external server attach as main contract

---

## Locked decisions

### Runtime model

- sidecar-first
- Node-compatible Pi extension code only
- use package files to bootstrap runtime
- supervise extracted runtime binary directly for long-lived `web` process
- one local Executor server per cwd
- reuse healthy same-cwd local sidecars when found

### UX model

- human admin/setup/auth flows live in browser UI
- model-facing surface stays small: execute/resume/search/describe/list_sources
- `/executor web` always prints URL; browser open is best-effort
- `/executor call` and `/executor resume` are inline-arg commands in v1

### API model

- raw `fetch` wrappers + local TS types
- helper tools use Executor helper snippets where that gives richer data
- formal HTTP read endpoints stay available as fallback
- preserve upstream execute/resume envelopes; do not invent new wire contracts

---

## Source-backed constraints

| Fact | Evidence | Implementation effect |
|---|---|---|
| `executor` package exposes wrapper/bootstrap files, not a typed HTTP client | `node_modules/executor/package.json`, file list under `node_modules/executor/` | use raw `fetch` wrappers + local TS types |
| package wrapper is sync-spawn based | `node_modules/executor/bin/executor` | use wrapper/bootstrap only for short-lived install path; do **not** supervise wrapper as long-lived sidecar |
| runtime binary is installed under `bin/runtime/` | `node_modules/executor/postinstall.cjs` | spawn extracted runtime directly for `web` child |
| Pi extensions load via `jiti`; Node built-ins are documented | `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` | shipped extension code must stay Node-compatible |
| Pi extension API exposes `registerTool`, `registerCommand`, `exec`; no public settings registration or open-url helper | `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` | implement command/tool surface directly; use Node process APIs where needed |
| Pi `exec()` is buffered only | `node_modules/@mariozechner/pi-coding-agent/dist/core/exec.d.ts` | use `node:child_process.spawn`, not `pi.exec()`, for long-lived sidecar |
| upstream CLI commands are `call`, `resume`, `web`, `mcp` | `docs/executor/apps/cli/src/main.ts` | mirror only commands that fit Pi; exclude `mcp` |
| local server exposes `/api` and `/mcp` | `docs/executor/apps/local/src/serve.ts` | one sidecar powers browser UI + HTTP ops |
| scope is cwd-based | `docs/executor/apps/local/src/server/executor.ts`, `docs/executor/packages/core/storage-file/src/index.ts` | key reuse by cwd; verify `/api/scope.dir` matches cwd |
| execute vs resume HTTP envelopes differ | `docs/executor/packages/core/api/src/executions/api.ts` | keep separate TS types; do **not** add synthetic `status` to resume |
| helper paths exist in execution engine | `docs/executor/packages/core/execution/src/engine.ts`, `tool-invoker.ts` | implement search/describe/list_sources via execute helpers first |
| formal tools/sources endpoints exist | `docs/executor/packages/core/api/src/tools/api.ts`, `sources/api.ts` | fallback path available if helper names drift |
| helper outputs are richer than direct read endpoints | `tool-invoker.ts` vs `tools/api.ts` + `sources/api.ts` | prefer execute-helper path for `describe` + `list_sources` |
| custom tools must truncate large outputs | `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `examples/extensions/truncated-tool.ts` | helper tools that unwrap JSON need truncation guard |
| Pi docs show direct `@sinclair/typebox` import; examples also use `Type` re-export from `@mariozechner/pi-ai` | `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/examples/extensions/hello.ts`, `node_modules/@mariozechner/pi-ai/dist/index.d.ts` | choose one schema import style, then align peer deps accordingly |
| Pi package docs require core imports to be peer deps | `node_modules/@mariozechner/pi-coding-agent/docs/packages.md` | whichever core package we import directly must be in `peerDependencies` |

### Critical snippets

```js
// node_modules/executor/bin/executor
const result = childProcess.spawnSync(target, process.argv.slice(2), { stdio: "inherit" });
```

```ts
// docs/executor/packages/core/api/src/executions/api.ts
const ExecuteResponse = Schema.Union(CompletedResult, PausedResult);
const ResumeResponse = Schema.Struct({
  text: Schema.String,
  structured: Schema.Unknown,
  isError: Schema.Boolean,
});
```

```ts
// docs/executor/packages/core/execution/src/engine.ts
if (path === "search") { ... }
if (path === "executor.sources.list") { ... }
if (path === "describe.tool") { ... }
```

```ts
// node_modules/@mariozechner/pi-ai/dist/index.d.ts
export { Type } from "@sinclair/typebox";
```

```md
// node_modules/@mariozechner/pi-coding-agent/docs/extensions.md
- pi.registerTool()
- pi.registerCommand()
- Node.js built-ins (`node:fs`, `node:path`, etc.) are also available.
```

---

## Implementation guidelines

- keep shipped extension code Node-20-compatible
- use `node:child_process.spawn` for long-lived sidecar + best-effort browser launch
- use raw `fetch` for HTTP; keep wrappers thin
- do not import Bun-only runtime APIs in shipped extension code
- do not parse CLI stdout as transport
- do not use `pi.exec()` for sidecar lifecycle
- do not use `pi.appendEntry()` for pid/process handles; use module-global in-memory state only
- keep file split small; target **5 source files** unless pressure forces a 6th
- always verify sidecar via `GET /api/scope` before using it
- always verify returned `dir` matches `ctx.cwd` before reusing a server
- always preserve upstream envelope differences:
  - execute => completed/paused union
  - resume => `{ text, structured, isError }`
- helper tools may unwrap JSON, but must add local truncation guard before returning large text
- browser launch is best-effort only; URL must stay visible even on launcher failure
- v1 config stays hardcoded constants in code; no settings UI, no persisted config file unless implementation proves it is unavoidable
- kill only children Pi started; never kill reused sidecars Pi did not spawn
- use `bun test` for automated tests; no live OAuth/service automation in tests
- prefer minimal diff over early abstraction; if a helper is only used once, inline it

---

## Target file map

Start here. do not split further unless necessary.

```text
src/
  index.ts       # extension entry; wires commands + tools + shutdown hook
  sidecar.ts     # package resolution, bootstrap, reuse scan, spawn, health, cleanup
  http.ts        # HTTP types + fetch wrappers
  tools.ts       # tool defs, helper snippet builders, result shaping, truncation
  commands.ts    # /executor parser, subcommands, browser open helper

test/
  *.test.ts      # bun test files
```

Rule:

- if `http.ts` gets too type-heavy, add `src/contracts.ts`
- otherwise keep it to 5 source files

---

## V1 behavior contract

### Sidecar contract

- default port seed: `4788`
- bounded scan window: `4788..4819` (32 ports)
- sidecar key = cwd
- readiness check = `GET /api/scope`
- healthy reusable sidecar must return `dir === cwd`

### Tool contract

- `executor_execute`
  - ensures sidecar
  - POST `/api/executions`
  - returns upstream execute envelope unchanged
- `executor_resume`
  - ensures sidecar
  - POST `/api/executions/:executionId/resume`
  - returns upstream resume envelope unchanged
- `executor_search`
  - executes helper snippet using `tools.search(...)`
  - unwraps `structured.result` only on completed non-error result
- `executor_describe`
  - executes helper snippet using `tools.describe.tool(...)`
  - fallback = tools list + tool schema HTTP endpoints if helper path drifts
- `executor_list_sources`
  - executes helper snippet using `tools.executor.sources.list(...)`
  - fallback = sources list (+ per-source tool counts only if truly needed)

### Slash command contract

- `/executor web`
  - ensure sidecar
  - print URL
  - attempt best-effort platform launcher
- `/executor call <code>`
  - v1 = inline code only
  - no editor fallback in v1
- `/executor resume <executionId> <accept|decline|cancel> [contentJson]`
  - v1 = inline args only
  - optional `contentJson` must parse as JSON object

---

## Detailed implementation todo list

Each checkbox includes:

- **Impl files** = local files to touch
- **Refs** = source files to read before doing the task

## Phase 0 — repo/package prep

**Goal:** replace stub, lock imports, make repo ready for later code.

- [x] Replace `src/index.ts` hello-world stub with extension-entry scaffold exporting `default function (pi: ExtensionAPI) {}`. Impl files: `src/index.ts`. Refs: `src/index.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/examples/extensions/hello.ts`.
- [x] Decide schema import style for tool params: direct `@sinclair/typebox` vs `Type` re-export from `@mariozechner/pi-ai`; document the choice in code comments at first import site. Impl files: `src/index.ts`, later `src/tools.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/examples/extensions/hello.ts`, `node_modules/@mariozechner/pi-ai/dist/index.d.ts`.
- [x] Align `peerDependencies` to whichever direct Pi-core/schema packages we import. Impl files: `package.json`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/packages.md`, `package.json`.
- [x] Add test runner script `bun test` and keep existing `typecheck` path intact. Impl files: `package.json`. Refs: `package.json`, `CLAUDE.md`.
- [x] Lock local source layout to `index.ts`, `sidecar.ts`, `http.ts`, `tools.ts`, `commands.ts`; only add `contracts.ts` if `http.ts` gets too dense. Impl files: `src/`. Refs: this plan, current `src/` tree.
- [x] Keep `pi.extensions` pointing at `./src/index.ts`; do not introduce a build step for the extension. Impl files: `package.json`. Refs: `package.json`, `node_modules/@mariozechner/pi-coding-agent/docs/packages.md`.
- [x] Leave README/CHANGELOG alone in this phase; code first, docs later. Impl files: none. Refs: `README.md`, `CHANGELOG.md`.

**Exit criteria**

- entry file is real extension scaffold
- import/peer-dep policy is explicit
- test script exists

---

## Phase 1 — local contracts + constants

**Goal:** define exact local types/constants before process or HTTP code.

- [x] Define local TS contracts for `ScopeInfo`, `ExecuteCompleted`, `ExecutePaused`, `ExecuteResponse`, `ResumeResponse`. Impl files: `src/http.ts` or `src/contracts.ts`. Refs: `docs/executor/packages/core/api/src/scope/api.ts`, `docs/executor/packages/core/api/src/executions/api.ts`.
- [x] Define local TS contracts for `ToolMetadataResponse`, `ToolSchemaResponse`, `SourceResponse`. Impl files: `src/http.ts` or `src/contracts.ts`. Refs: `docs/executor/packages/core/api/src/tools/api.ts`, `docs/executor/packages/core/api/src/sources/api.ts`.
- [x] Define sidecar constants: `DEFAULT_PORT_SEED`, `PORT_SCAN_LIMIT`, `HEALTH_TIMEOUT_MS`, `STARTUP_TIMEOUT_MS`, `LOG_RING_BUFFER_LINES`. Impl files: `src/sidecar.ts`. Refs: `docs/executor/apps/cli/src/main.ts` (default port), this plan.
- [x] Define `SidecarRecord` shape for cwd/port/baseUrl/pid/child ownership/scope cache/stdout tail/stderr tail. Impl files: `src/sidecar.ts`. Refs: `docs/executor/apps/local/src/server/executor.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (`session_shutdown` cleanup guidance).
- [x] Add normalized error helpers for package resolution, unsupported platform, bootstrap failure, runtime missing, startup timeout, scope mismatch, launcher failure, HTTP failure. Impl files: `src/sidecar.ts`, `src/http.ts`, maybe `src/commands.ts`. Refs: `node_modules/executor/bin/executor`, `node_modules/executor/postinstall.cjs`, `docs/executor/packages/core/api/src/executions/api.ts`.

**Exit criteria**

- no later phase needs to invent ad-hoc response shapes
- no `any` for core transport/process paths

---

## Phase 2 — package resolution + bootstrap

**Goal:** reliably locate/install the real Executor runtime.

- [x] Resolve installed `executor/package.json` via module resolution from this package, not cwd-relative path guessing. Impl files: `src/sidecar.ts`. Refs: `package.json`, `node_modules/executor/package.json`.
- [x] Derive package root, wrapper path (`bin/executor`), installer path (`postinstall.cjs`), runtime path (`bin/runtime/<platform-binary>`). Impl files: `src/sidecar.ts`. Refs: `node_modules/executor/package.json`, `node_modules/executor/bin/executor`, `node_modules/executor/postinstall.cjs`.
- [x] Implement runtime binary name resolution per platform and fail early on unsupported platform/arch. Impl files: `src/sidecar.ts`. Refs: `node_modules/executor/bin/executor`, `node_modules/executor/postinstall.cjs`.
- [x] If runtime binary already exists, short-circuit bootstrap. Impl files: `src/sidecar.ts`. Refs: `node_modules/executor/bin/executor`.
- [x] If runtime binary is missing, run the installer path as a short-lived child and capture stdout/stderr into bounded buffers. Impl files: `src/sidecar.ts`. Refs: `node_modules/executor/bin/executor`, `node_modules/executor/postinstall.cjs`.
- [x] Re-check runtime existence after installer exit and throw actionable error if still missing. Impl files: `src/sidecar.ts`. Refs: `node_modules/executor/postinstall.cjs`, `docs/executor/tests/release-bootstrap-smoke.test.ts`.
- [x] Do **not** reuse the wrapper as the long-lived `web` child once runtime exists. Impl files: `src/sidecar.ts`. Refs: `node_modules/executor/bin/executor` (`spawnSync(...)`), `docs/executor/tests/release-bootstrap-smoke.test.ts`.

**Exit criteria**

- `resolveRuntimeBinary()` returns a real executable path or fails with debuggable context

---

## Phase 3 — sidecar lifecycle + reuse

**Goal:** ensure one healthy same-cwd sidecar is reused when possible.

- [x] Create module-global in-memory state keyed by cwd for owned/reused sidecars. Impl files: `src/sidecar.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (`session_start`, `session_shutdown`), `docs/executor/apps/local/src/server/executor.ts`.
- [x] Implement `getScope(baseUrl)` with timeout using `GET /api/scope`. Impl files: `src/http.ts`, `src/sidecar.ts`. Refs: `docs/executor/packages/core/api/src/scope/api.ts`, `docs/executor/packages/core/api/src/handlers/scope.ts`.
- [x] Implement bounded port scan from `4788` upward and distinguish `free port` from `occupied by healthy same-cwd sidecar`. Impl files: `src/sidecar.ts`. Refs: `docs/executor/apps/cli/src/main.ts` (default `4788`), `docs/executor/apps/local/src/server/executor.ts` (cwd-scoped scope data).
- [x] Define reuse order: in-memory healthy record first, scanned healthy same-cwd sidecar second, fresh spawn last. Impl files: `src/sidecar.ts`. Refs: `docs/executor/apps/local/src/server/executor.ts`, `docs/executor/packages/core/api/src/handlers/scope.ts`.
- [x] Spawn the extracted runtime as `web --port <port>` with child `cwd` set to the project cwd and stdio piped for logs. Impl files: `src/sidecar.ts`. Refs: `docs/executor/apps/cli/src/main.ts`, `docs/executor/tests/release-bootstrap-smoke.test.ts`.
- [x] Poll `/api/scope` until ready or timeout; only mark child healthy if returned `dir === cwd`. Impl files: `src/sidecar.ts`, `src/http.ts`. Refs: `docs/executor/packages/core/api/src/handlers/scope.ts`, `docs/executor/apps/local/src/server/executor.ts`.
- [x] Track child stdout/stderr in bounded ring buffers and clear/revoke stale records on child exit. Impl files: `src/sidecar.ts`. Refs: `node_modules/executor/bin/executor` (bootstrap output expectations), `docs/executor/tests/release-bootstrap-smoke.test.ts`.
- [x] Register cleanup on `session_shutdown` and kill only children marked `ownedByPi`. Impl files: `src/index.ts`, `src/sidecar.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (`session_shutdown`), `node_modules/@mariozechner/pi-coding-agent/examples/extensions/auto-commit-on-exit.ts`, `examples/extensions/system-prompt-header.ts`.

**Exit criteria**

- same-cwd calls reuse healthy sidecars
- owned children are cleaned up on shutdown
- reused foreign sidecars are never killed

---

## Phase 4 — HTTP wrappers

**Goal:** expose exact local HTTP operations with minimal translation.

- [x] Implement one thin `fetchJson()` helper with timeout, JSON parse, non-2xx normalization, and body-text fallback for bad JSON. Impl files: `src/http.ts`. Refs: `docs/executor/packages/core/api/src/executions/api.ts`, `scope/api.ts`, `tools/api.ts`, `sources/api.ts`.
- [x] Implement `getScope(baseUrl)`. Impl files: `src/http.ts`. Refs: `docs/executor/packages/core/api/src/scope/api.ts`, `docs/executor/packages/core/api/src/handlers/scope.ts`.
- [x] Implement `execute(baseUrl, code)` preserving execute union shape exactly. Impl files: `src/http.ts`. Refs: `docs/executor/packages/core/api/src/executions/api.ts`, `docs/executor/packages/core/api/src/handlers/executions.ts`.
- [x] Implement `resume(baseUrl, executionId, payload)` preserving resume shape exactly. Impl files: `src/http.ts`. Refs: `docs/executor/packages/core/api/src/executions/api.ts`, `docs/executor/packages/core/api/src/handlers/executions.ts`.
- [x] Implement `listTools(baseUrl, scopeId)` and `getToolSchema(baseUrl, scopeId, toolId)`. Impl files: `src/http.ts`. Refs: `docs/executor/packages/core/api/src/tools/api.ts`, `docs/executor/packages/core/api/src/handlers/tools.ts`.
- [x] Implement `listSources(baseUrl, scopeId)` and keep room for per-source tool queries only if fallback parity truly needs it. Impl files: `src/http.ts`. Refs: `docs/executor/packages/core/api/src/sources/api.ts`, `docs/executor/packages/core/api/src/handlers/sources.ts`.
- [x] Cache `scopeId` from `/api/scope` into sidecar state to avoid unnecessary repeat reads. Impl files: `src/sidecar.ts`, `src/http.ts`. Refs: `docs/executor/packages/core/api/src/handlers/scope.ts`.

**Exit criteria**

- every v1 HTTP call exists as a typed local function
- execute/resume shape mismatch is preserved, not hidden

---

## Phase 5 — helper snippets + fallback readers

**Goal:** build stable helper-tool behavior on top of `execute`, keep HTTP fallbacks ready.

- [x] Add pure snippet builders for search/describe/list_sources that omit undefined fields so Executor defaults survive. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`, `docs/executor/packages/core/execution/src/tool-invoker.ts`.
- [x] Add execute-result helpers: completed/non-error guard, structured-result unwrap, paused/error pass-through. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/core/api/src/executions/api.ts`, `docs/executor/packages/core/api/src/handlers/executions.ts`, `docs/executor/packages/core/execution/src/engine.ts`.
- [x] Implement truncation for helper-tool outputs before returning text to Pi, including temp-file spill for full output when needed. Impl files: `src/tools.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (truncation section), `node_modules/@mariozechner/pi-coding-agent/examples/extensions/truncated-tool.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts` (truncate exports).
- [x] Implement `describeViaHttp()` fallback by combining tool metadata + tool schema endpoints. Impl files: `src/tools.ts`, `src/http.ts`. Refs: `docs/executor/packages/core/api/src/tools/api.ts`, `docs/executor/packages/core/api/src/handlers/tools.ts`.
- [x] Implement `listSourcesViaHttp()` fallback starting with plain source list; only add per-source tool counts if parity is actually required after smoke tests. Impl files: `src/tools.ts`, `src/http.ts`. Refs: `docs/executor/packages/core/api/src/sources/api.ts`, `docs/executor/packages/core/api/src/handlers/sources.ts`, `docs/executor/packages/core/execution/src/tool-invoker.ts`.
- [x] Keep fallback path internal so Pi tool names stay stable even if Executor helper paths drift. Impl files: `src/tools.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`, `docs/executor/packages/core/api/src/tools/api.ts`, `sources/api.ts`.

**Exit criteria**

- helper builders are pure + unit-testable
- helper tools can degrade to HTTP readers without surface changes

---

## Phase 6 — Pi tools

**Goal:** expose minimal model-facing bridge tools.

- [x] Register `executor_execute` and wire it to `ensureSidecar(ctx.cwd)` + HTTP execute, returning upstream execute envelope unchanged. Impl files: `src/tools.ts`, `src/index.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/examples/extensions/hello.ts`, `docs/executor/packages/core/api/src/executions/api.ts`.
- [x] Register `executor_resume` and wire it to `ensureSidecar(ctx.cwd)` + HTTP resume, returning upstream resume envelope unchanged. Impl files: `src/tools.ts`, `src/index.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `docs/executor/packages/core/api/src/executions/api.ts`, `docs/executor/packages/core/api/src/handlers/executions.ts`.
- [x] Register `executor_search` using execute-helper path and unwrap only completed non-error `structured.result`. Impl files: `src/tools.ts`, `src/index.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`, `tool-invoker.ts`, `docs/executor/packages/core/api/src/executions/api.ts`.
- [x] Register `executor_describe` using execute-helper path first and HTTP fallback second. Impl files: `src/tools.ts`, `src/index.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`, `tool-invoker.ts`, `docs/executor/packages/core/api/src/tools/api.ts`.
- [x] Register `executor_list_sources` using execute-helper path first and HTTP fallback second. Impl files: `src/tools.ts`, `src/index.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`, `tool-invoker.ts`, `docs/executor/packages/core/api/src/sources/api.ts`.
- [x] Add concise tool descriptions, prompt snippets, and only useful `details` fields (`baseUrl`, `scopeId`, `executionId`, `fullOutputPath`). Impl files: `src/tools.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/examples/extensions/dynamic-tools.ts`, `examples/extensions/truncated-tool.ts`.

**Exit criteria**

- five tools register cleanly in Pi
- all tool calls resolve sidecar by `ctx.cwd`

---

## Phase 7 — `/executor` slash command

**Goal:** give humans a small command surface matching Pi, not raw Executor CLI.

- [x] Register one slash command `/executor` with subcommand parsing for `web`, `call`, `resume`. Impl files: `src/commands.ts`, `src/index.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/examples/extensions/commands.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/tui.md` (`registerCommand` examples).
- [x] Add `getArgumentCompletions()` for the three subcommands and basic argument completions for actions on `resume`. Impl files: `src/commands.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (`getArgumentCompletions`), `node_modules/@mariozechner/pi-coding-agent/examples/extensions/commands.ts`.
- [x] Implement `/executor web`: ensure sidecar, print URL, attempt best-effort platform launcher, keep URL visible on launcher failure. Impl files: `src/commands.ts`, `src/sidecar.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` (no open-url helper), `docs/executor/apps/local/src/serve.ts` (server shape), `docs/executor/packages/core/api/src/scope/api.ts`.
- [x] Implement `/executor call <code>` as inline-arg-only wrapper around the same HTTP execute path the tool uses. Impl files: `src/commands.ts`, `src/http.ts`, `src/sidecar.ts`. Refs: `docs/executor/apps/cli/src/main.ts`, `docs/executor/packages/core/api/src/executions/api.ts`.
- [x] Implement `/executor resume <executionId> <accept|decline|cancel> [contentJson]` as inline-arg-only wrapper around the same HTTP resume path the tool uses. Impl files: `src/commands.ts`, `src/http.ts`, `src/sidecar.ts`. Refs: `docs/executor/apps/cli/src/main.ts`, `docs/executor/packages/core/api/src/executions/api.ts`, `docs/executor/packages/core/api/src/handlers/executions.ts`.
- [x] Explicitly reject or ignore `/executor mcp` in v1 rather than half-supporting it. Impl files: `src/commands.ts`. Refs: `docs/executor/apps/cli/src/main.ts`, `docs/executor/apps/local/src/serve.ts`.

**Exit criteria**

- humans can open UI, run code, resume paused executions
- no slash command depends on interactive-only UI widgets

---

## Phase 8 — automated tests

**Goal:** lock behavior before manual smoke against real Executor runtime.

- [x] Add pure tests for package-root resolution, runtime path derivation, platform binary naming, and bootstrap-needed vs bootstrap-skipped behavior. Impl files: `test/sidecar*.test.ts`. Refs: `node_modules/executor/package.json`, `node_modules/executor/bin/executor`, `node_modules/executor/postinstall.cjs`.
- [x] Add pure tests for port scanning, reuse selection, scope mismatch rejection, and owned-vs-reused cleanup behavior. Impl files: `test/sidecar*.test.ts`. Refs: `docs/executor/packages/core/api/src/handlers/scope.ts`, `docs/executor/apps/local/src/server/executor.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (`session_shutdown`).
- [x] Add fake-server tests for HTTP wrappers covering `/api/scope`, execute completed, execute paused, resume success, resume error/not-found. Impl files: `test/http*.test.ts`. Refs: `docs/executor/packages/core/api/src/scope/api.ts`, `docs/executor/packages/core/api/src/executions/api.ts`, `handlers/executions.ts`.
- [x] Add pure tests for snippet builders and execute-result unwrapping rules. Impl files: `test/tools*.test.ts`. Refs: `docs/executor/packages/core/execution/src/engine.ts`, `tool-invoker.ts`, `docs/executor/packages/core/api/src/executions/api.ts`.
- [x] Add pure tests for helper-output truncation and temp-file spill behavior. Impl files: `test/tools*.test.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/examples/extensions/truncated-tool.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts`.
- [x] Add pure tests for `/executor` command parsing, usage errors, and unsupported-subcommand behavior. Impl files: `test/commands*.test.ts`. Refs: `node_modules/@mariozechner/pi-coding-agent/examples/extensions/commands.ts`, `docs/extensions.md`.

**Exit criteria**

- `bun test` covers pure logic + transport shaping
- no automated test requires live OAuth or external services

---

## Phase 9 — manual smoke path

**Goal:** prove real end-to-end behavior against installed `executor@1.4.4`.

- [x] Load the extension in Pi using `pi -e ./src/index.ts` or project-local extension discovery; do not rely on `bun run src/index.ts`. Impl files: none. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, current `README.md` (to replace later).
- [x] Force missing-runtime path and verify first use bootstraps runtime successfully. Impl files: none. Refs: `node_modules/executor/bin/executor`, `node_modules/executor/postinstall.cjs`, `docs/executor/tests/release-bootstrap-smoke.test.ts`.
- [x] Verify first tool/command starts sidecar and passes `GET /api/scope` with returned `dir === cwd`. Impl files: none. Refs: `docs/executor/packages/core/api/src/handlers/scope.ts`, `docs/executor/apps/local/src/server/executor.ts`.
- [x] Verify `executor_execute` and `/executor call` both succeed with `return 2+2`. Impl files: none. Refs: `docs/executor/tests/release-bootstrap-smoke.test.ts`, `docs/executor/packages/core/api/src/executions/api.ts`.
- [x] Verify `/executor web` always prints a usable URL and best-effort browser launch failure is non-fatal. Impl files: none. Refs: `docs/executor/apps/local/src/serve.ts`, `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` (no helper).
- [x] Reload Pi and confirm same-cwd sidecar is reused rather than duplicated. Impl files: none. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (`/reload` + session lifecycle), `docs/executor/packages/core/api/src/handlers/scope.ts`.
- [x] Kill the sidecar manually and confirm next tool call auto-recovers. Impl files: none. Refs: this plan’s sidecar contract, `docs/executor/apps/local/src/serve.ts`.
- [x] With a real configured Executor setup, verify `executor_search`, `executor_describe`, `executor_list_sources`, plus at least one paused execution requiring `executor_resume`. Impl files: none. Refs: `docs/executor/packages/core/execution/src/tool-invoker.ts`, `docs/executor/packages/core/api/src/handlers/executions.ts`.

**Exit criteria**

- real installed package works end-to-end
- reload/recovery behavior is sane

---

## Phase 10 — docs + release cleanup

**Goal:** make repo/package usable by someone who did not watch implementation happen.

- [x] Update README install/run instructions to real Pi extension flows. Impl files: `README.md`. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `node_modules/@mariozechner/pi-coding-agent/docs/packages.md`, final code paths.
- [x] Replace fake `bun run src/index.ts` guidance with `pi -e ./src/index.ts` / project-local extension usage. Impl files: `README.md`. Refs: current `README.md`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`.
- [x] Document shipped tools, slash commands, runtime model, and cwd-scoped sidecar behavior. Impl files: `README.md`. Refs: final `src/{index,sidecar,http,tools,commands}.ts`, `docs/executor/apps/local/src/server/executor.ts`.
- [x] Document troubleshooting for bootstrap failure, port window exhaustion, launcher failure, startup timeout, scope mismatch. Impl files: `README.md`. Refs: final error helpers in `src/sidecar.ts` + `src/http.ts`, `node_modules/executor/postinstall.cjs`.
- [x] Update CHANGELOG only if release process requires it after code lands. Impl files: `CHANGELOG.md`. Refs: repository release conventions, final shipped diff.

**Exit criteria**

- README matches shipped behavior
- user can install/use extension without source-diving

---

## Ship checklist

- [x] `bun test` passes. Refs: `package.json`, test files.
- [x] `bun run typecheck` passes. Refs: `package.json`, `tsconfig.json`.
- [x] Extension loads in Pi. Refs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`, `package.json`, `src/index.ts`.
- [x] No Bun-only APIs in shipped extension source. Refs: `src/**/*.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`.
- [x] No orphan owned children on normal shutdown. Refs: `src/sidecar.ts`, `src/index.ts`, `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` (`session_shutdown`).
- [x] `executor_execute` + `/executor call` both work with `return 2+2`. Refs: `docs/executor/tests/release-bootstrap-smoke.test.ts`, final smoke notes.
- [x] Helper tools work against a real configured Executor setup. Refs: `src/tools.ts`, `docs/executor/packages/core/execution/src/tool-invoker.ts`.
- [x] README updated. Refs: `README.md`, final code paths.

---

## Not in scope for v1

- `/executor mcp`
- status widget / restart / stop command surface
- persisted extension settings or settings UI
- full dynamic mirroring of Executor catalog into Pi tools
- direct embedded Executor SDK runtime path
- arbitrary external server attach as primary workflow
- model-facing source/secrets/admin mutation tools
- editor/prompt-driven `/executor call` UX
- rich TUI widgets/custom renderers unless smoke testing proves default rendering insufficient

---

## If scope slips, cut in this order

Cut last, not first:

1. `executor_execute`
2. `executor_resume`
3. sidecar bootstrap/spawn/reuse correctness
4. `/executor web`
5. `/executor call`
6. helper tools (`search`, `describe`, `list_sources`)
7. pretty docs / niceties

Do **not** cut:

- direct runtime supervision
- health checks via `/api/scope`
- exact execute/resume envelope handling
- automated tests for snippet/result shaping
- shutdown cleanup for owned children
