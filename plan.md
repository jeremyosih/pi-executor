# V1 Plan: `pi-executor` Extension

## Summary

Build a pi extension package that gives pi users access to a local **executor instance isolated to the current pi workspace**.

V1 goals:
- start an isolated `executor web` session from pi for login/setup/browser flows
- run executor code through **HTTP**, not SDK imports
- resume `waiting_for_interaction` executions safely
- persist only extension config, instance metadata, and branch-local session pointers in pi
- leave sources, secrets, workspace catalog, and execution records inside executor

V1 will use:
- **pi extensions API** for commands, tools, flags, session hooks, and session persistence
- **detached `spawn()`** for `executor web`
- **raw HTTP `fetch`** for executor runtime calls
- **config JSON files** for durable extension settings
- **instance metadata files** for per-workspace port / pid / log / data-dir
- **`pi.appendEntry()`** for branch-local session metadata

V1 will **not**:
- import private `@executor/*` packages
- reuse an arbitrary executor server just because `baseUrl` is reachable
- bootstrap by running `executor call`
- rely on `pi.exec()` for executor lifecycle
- auto-kill executor on pi shutdown

Why the workspace isolation requirement exists:
- executor server is created against a single `workspaceRoot`; see [index.ts](/Users/jeremy/Developer/executor/packages/platform/server/src/index.ts#L154)
- local installation `scopeId` is derived from `workspaceRoot`; see [installation.ts](/Users/jeremy/Developer/executor/packages/platform/sdk-file/src/installation.ts#L19)

So “reachable server” is not enough. The extension must target the instance created for the current pi `cwd`.

---

## Implementation Changes

### 1. Package shape

Implement as a real pi package with one extension entrypoint plus focused helpers.

Suggested structure:
- `package.json`
- `src/index.ts`
- `src/config.ts`
- `src/instance.ts`
- `src/executor-http.ts`

`package.json` should expose the extension via the `pi` manifest:

```json
{
  "name": "pi-executor",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

This manifest shape is valid pi package syntax; see [packages.md](/Users/jeremy/Developer/pi-mono/packages/coding-agent/docs/packages.md#L110).

Use only normal public deps. No `@executor/*` imports.

---

### 2. Public extension surface

V1 exposes these **commands**:

- `/executor-web`
- `/executor-login`
- `/executor-status`

V1 exposes these **tools**:

- `executor_execute`
- `executor_resume`

Recommended exact semantics:

- `/executor-web`
  - resolve the executor instance for `ctx.cwd`
  - if that instance is not reachable, spawn detached isolated `executor web --port <instance.port>`
  - wait for **that instance** `baseUrl` to become reachable
  - open browser at instance `baseUrl`
  - notify user of URL / failures

- `/executor-login`
  - same bootstrap behavior as `/executor-web`
  - open directly to configured `loginPath`
  - default route: `/sources/add`
  - `/sources/add` is a real route; see [paths.ts](/Users/jeremy/Developer/executor/packages/clients/react/src/plugins/paths.ts#L23)

- `/executor-status`
  - resolve the executor instance for `ctx.cwd`
  - probe that instance `baseUrl`
  - if reachable, call `GET /v1/local/installation`
  - show `instanceId`, `baseUrl`, and workspace `scopeId`
  - if unreachable, show “not running” plus the derived instance metadata

- `executor_execute`
  - input: `code: string`
  - ensure the isolated executor instance for `ctx.cwd` is running
  - resolve installation via `GET /v1/local/installation`
  - create execution via `POST /v1/workspaces/{scopeId}/executions`
  - poll until terminal or `waiting_for_interaction`
  - return structured result + persist last execution metadata

- `executor_resume`
  - input: `executionId: string`, optional `responseJson: string`
  - ensure the isolated executor instance for `ctx.cwd` is running
  - `GET` execution envelope first
  - if execution is terminal, return current envelope; do **not** `POST /resume`
  - if execution is `waiting_for_interaction` and `responseJson` is supplied, `POST /resume`
  - if execution is `waiting_for_interaction` and interaction is URL-based, open URL / return wait result / optionally poll briefly
  - if execution is `waiting_for_interaction` and interaction is form-based with no `responseJson`, return a structured “response required” result
  - never rely on omitted `responseJson` to implicitly accept the interaction

Suggested tool registration shape:

```ts
pi.registerTool({
  name: "executor_execute",
  label: "Executor Execute",
  description: "Run TypeScript code in executor. Use executor's discovery workflow: discover tools, inspect schemas, then call tools.*.",
  promptSnippet: "Run code inside executor to access the user's connected tool catalog.",
  promptGuidelines: [
    "Write TypeScript, not shell pipelines.",
    "Use tools.* inside executor code, not fetch.",
    "Use tools.discover first when the exact tool path is unknown.",
    "Inspect schemas before calling complex tools."
  ],
  parameters: Type.Object({
    code: Type.String({ description: "TypeScript to run in executor" })
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    // implementation
  }
});
```

That prompt guidance should copy executor’s real workflow contract from [main.ts](/Users/jeremy/Developer/executor/apps/executor/src/cli/main.ts#L233).

For `executor_resume`, use:

```ts
parameters: Type.Object({
  executionId: Type.String(),
  responseJson: Type.Optional(Type.String({
    description: "JSON-encoded interaction response. Required for form interactions."
  }))
})
```

---

### 3. Instance model and bootstrap behavior

Use **one lifecycle path** for browser commands and HTTP tools: derive an isolated instance for the current pi workspace, then ensure that instance is running.

#### A. Instance model

Create a durable instance record per real workspace path.

Suggested record:

```ts
type ExecutorInstance = {
  instanceId: string;     // hash(realpath(cwd))
  cwdRealpath: string;
  port: number;
  baseUrl: string;
  localDataDir: string;
  pidFile: string;
  logFile: string;
};
```

Suggested storage:
- `~/.pi/agent/pi-executor/instances/<instanceId>/instance.json`

Suggested derivation rules:
- `instanceId = sha256(realpath(cwd)).slice(0, 16)`
- if `config.port` is set, use it
- else if an instance record already exists, reuse its port
- else allocate a free localhost port and persist it
- derive `baseUrl` from `port`
- derive `localDataDir`, `pidFile`, `logFile` under the instance directory

This is required because executor does not expose public workspace identity beyond installation scope, and that scope is bound to the server’s workspace root.

#### B. Start behavior

Use detached `spawn()`, not `ctx.exec()` or `pi.exec()`.

Reason:
- `executor web` is a foreground session intended to keep running; see [main.ts](/Users/jeremy/Developer/executor/apps/executor/src/cli/main.ts#L1043) and [session-summary.ts](/Users/jeremy/Developer/executor/apps/executor/src/cli/session-summary.ts#L18)
- `pi.exec()` only supports `signal`, `timeout`, and `cwd`; it does not let the extension pass per-instance env vars; see [exec.ts](/Users/jeremy/Developer/pi-mono/packages/coding-agent/src/core/exec.ts#L10)
- running `executor call` as bootstrap is wrong because it creates a real execution after `ensureServer()`; see [main.ts](/Users/jeremy/Developer/executor/apps/executor/src/cli/main.ts#L1076)

Canonical shape:

```ts
import { spawn } from "node:child_process";

function startExecutorWebDetached(cwd: string, instance: ExecutorInstance, command = "executor") {
  const child = spawn(command, ["web", "--port", String(instance.port)], {
    cwd,
    env: {
      ...process.env,
      EXECUTOR_LOCAL_DATA_DIR: instance.localDataDir,
      EXECUTOR_SERVER_PID_FILE: instance.pidFile,
      EXECUTOR_SERVER_LOG_FILE: instance.logFile,
    },
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
```

Those env vars are supported by executor; see [config.ts](/Users/jeremy/Developer/executor/packages/platform/server/src/config.ts#L8).

#### C. Readiness logic

Canonical logic:

```ts
async function ensureExecutorRunning(ctx: ExtensionContext, config: Config): Promise<ExecutorInstance> {
  const instance = await resolveExecutorInstance(ctx.cwd, config);
  if (await isReachable(instance.baseUrl)) return instance;

  startExecutorWebDetached(ctx.cwd, instance, config.executorCommand ?? "executor");
  await waitForReachability(instance.baseUrl, true, config.startupTimeoutMs ?? 30000);
  return instance;
}
```

This replaces the old “probe then run `executor call --no-open 'return null;'`” bootstrap idea.

---

### 4. HTTP contract for V1

Use raw `fetch` against executor’s local API.

Canonical bootstrap sequence:
1. resolve the isolated executor instance for `ctx.cwd`
2. probe that instance `baseUrl`
3. `GET /v1/local/installation`
4. use returned `scopeId`
5. call execution endpoints

Relevant endpoints:
- `GET /v1/local/installation`; see [local/api.ts](/Users/jeremy/Developer/executor/packages/platform/api/src/local/api.ts#L37)
- `POST /v1/workspaces/{workspaceId}/executions`; see [executions/api.ts](/Users/jeremy/Developer/executor/packages/platform/api/src/executions/api.ts#L42)
- `GET /v1/workspaces/{workspaceId}/executions/{executionId}`
- `POST /v1/workspaces/{workspaceId}/executions/{executionId}/resume`

Key response needed from installation endpoint:

```ts
type LocalInstallation = {
  scopeId: string;
  actorScopeId: string;
  resolutionScopeIds: string[];
};
```

from [local-installation.ts](/Users/jeremy/Developer/executor/packages/platform/sdk/src/schema/models/local-installation.ts#L7)

Do **not** use `GET /v1/local/config` as a workspace identity check. It does not contain workspace-root or workspace-id fields, only platform / secret-store config; see [contracts.ts](/Users/jeremy/Developer/executor/packages/platform/sdk/src/local/contracts.ts#L12).

Suggested minimal helpers:

```ts
async function getInstallation(baseUrl: string) {
  const res = await fetch(`${baseUrl}/v1/local/installation`);
  if (!res.ok) throw new Error(`installation lookup failed: ${res.status}`);
  return await res.json() as { scopeId: string };
}

async function createExecution(baseUrl: string, workspaceId: string, code: string) {
  const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      interactionMode: "detach"
    })
  });
  if (!res.ok) throw new Error(`execution create failed: ${res.status}`);
  return await res.json();
}
```

Use `interactionMode: "detach"` in V1. That is a valid payload value; see [contracts.ts](/Users/jeremy/Developer/executor/packages/platform/sdk/src/executions/contracts.ts#L7).

---

### 5. Waiting-for-interaction behavior

V1 should treat `waiting_for_interaction` executions as first-class.

Use the real executor status:

```ts
type ExecutionStatus =
  | "pending"
  | "running"
  | "waiting_for_interaction"
  | "completed"
  | "failed"
  | "cancelled";
```

from [execution.ts](/Users/jeremy/Developer/executor/packages/platform/sdk/src/schema/models/execution.ts#L15)

User-facing copy can say “paused”. Stored / returned protocol status should stay `waiting_for_interaction`.

Tool outputs must preserve:
- `executionId`
- `status`
- `pendingInteraction` summary if present
- a user-facing next step

When status is `waiting_for_interaction`:
- return a normal tool result explaining what is needed
- persist the `executionId` via `pi.appendEntry()`
- if interaction is URL-based, include `url` when available and optionally open it from commands
- if interaction is form-based, include `requestedSchema` and require explicit `responseJson` on `executor_resume`
- do **not** `POST /resume` without explicit response semantics

Executor’s own CLI paused output is the right normalization target; see [pending-interaction-output.ts](/Users/jeremy/Developer/executor/apps/executor/src/cli/pending-interaction-output.ts#L85).

Suggested normalized tool result shape:

```ts
return {
  content: [{
    type: "text",
    text: "Executor execution is waiting for interaction."
  }],
  details: {
    executionId: execution.id,
    status: execution.status,
    interaction: envelope.pendingInteraction
      ? {
          id: envelope.pendingInteraction.id,
          purpose: envelope.pendingInteraction.purpose,
          kind: envelope.pendingInteraction.kind,
          message: parsed?.message ?? "Interaction required",
          mode: parsed?.mode ?? null,
          url: parsed?.url ?? null,
          requestedSchema: parsed?.requestedSchema ?? null
        }
      : null,
    nextAction:
      parsed?.mode === "url"
        ? { kind: "open_url_or_resume", url: parsed.url ?? null }
        : { kind: "resume_with_responseJson" }
  }
};
```

For `executor_resume`, use this decision table:

- current status is terminal
  - return current envelope
- current status is `waiting_for_interaction` + caller supplied `responseJson`
  - `POST /resume`
- current status is `waiting_for_interaction` + URL interaction + no `responseJson`
  - open URL / poll briefly / return wait result
- current status is `waiting_for_interaction` + form interaction + no `responseJson`
  - return wait result; do not `POST /resume`

This matches executor runtime semantics more closely than “always POST resume”. Runtime only accepts resume from `waiting_for_interaction` or failed+pendingInteraction, and omitted `responseJson` otherwise defaults to accept; see [service.ts](/Users/jeremy/Developer/executor/packages/platform/sdk/src/runtime/execution/service.ts#L953).

---

### 6. Persistence model

V1 uses **four persistence layers**, each for different data.

#### A. Executor owns executor data

Do not duplicate:
- sources
- credentials
- OAuth session material
- workspace catalog
- execution records

Those remain inside executor’s local data model.

#### B. Config files own durable extension settings

Use:
- `~/.pi/agent/pi-executor.json`
- `<cwd>/.pi/pi-executor.json`

Project overrides global.

Config fields for V1:

```ts
type PiExecutorConfig = {
  executorCommand?: string;          // default "executor"
  startupTimeoutMs?: number;         // default 30000
  loginPath?: string;                // default "/sources/add"
  autoProbeOnSessionStart?: boolean; // default true
  port?: number;                     // optional fixed override for this workspace
};
```

Recommended loader pattern, same merge style as `preset.ts`:

```ts
function loadConfig(cwd: string): PiExecutorConfig {
  const defaults = {
    executorCommand: "executor",
    startupTimeoutMs: 30000,
    loginPath: "/sources/add",
    autoProbeOnSessionStart: true
  };

  // merge defaults, then global, then project
  return merged;
}
```

#### C. Instance metadata files own durable per-workspace executor binding

Persist:
- `instanceId`
- `cwdRealpath`
- `port`
- `baseUrl`
- `localDataDir`
- `pidFile`
- `logFile`

Use:
- `~/.pi/agent/pi-executor/instances/<instanceId>/instance.json`

This layer exists because executor’s public API does not expose enough identity to safely reuse a random reachable server.

#### D. `pi.appendEntry()` owns branch-local session state

Persist only lightweight pointers:
- `lastExecutionId`
- `lastSeenStatus`
- `lastInteractionId`

Use a custom type like `pi-executor-state`.

Canonical pattern:

```ts
pi.appendEntry("pi-executor-state", {
  lastExecutionId,
  lastSeenStatus,
  lastInteractionId
});
```

Restore on `session_start` by scanning the **current branch**, not all entries:

```ts
function restoreState(ctx: ExtensionContext) {
  return ctx.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-executor-state")
    .pop();
}
```

Why branch, not global scan:
- `getBranch()` is the current path
- `getEntries()` is the entire session tree

See [session.md](/Users/jeremy/Developer/pi-mono/packages/coding-agent/docs/session.md#L395).

Do **not** use `appendEntry` for durable config. Do **not** store secrets or instance metadata there.

---

### 7. Session hooks

Use lightweight restore / probe hooks only.

Behavior on `session_start`:
- load merged config
- resolve the executor instance for `ctx.cwd`
- restore branch-local state from `pi.appendEntry()`
- if `autoProbeOnSessionStart` is `true`, perform a non-blocking reachability probe against that instance `baseUrl`
- update extension status widget/footer if desired
- do **not** auto-start executor
- do **not** auto-run any bootstrap command

Suggested hook:

```ts
pi.on("session_start", async (_event, ctx) => {
  config = loadConfig(ctx.cwd);
  instance = await resolveExecutorInstance(ctx.cwd, config);
  state = restoreState(ctx);

  if (config.autoProbeOnSessionStart) {
    const reachable = await isReachable(instance.baseUrl);
    ctx.ui.setStatus("pi-executor", reachable ? "executor: ready" : "executor: offline");
  }
});
```

If the extension keeps in-memory state, run the same restore logic on other branch-changing session events too.

Behavior on `session_shutdown`:
- clear transient UI state only
- never stop executor automatically

---

## Detailed Todo List

This section is the implementation checklist for V1. It is intentionally more granular than the design sections above. Do not start implementation until this checklist is reviewed and accepted.

### Phase 0. Reconfirm external contracts before coding

- [x] Re-read the pi package manifest docs and confirm the `pi.extensions` manifest shape still matches this plan.
- [x] Re-read pi extension docs and confirm these APIs still exist and still have the same signatures:
  - [x] `pi.registerCommand()`
  - [x] `pi.registerTool()`
  - [x] `pi.appendEntry()`
  - [x] `pi.on("session_start" | "session_switch" | "session_shutdown")`
  - [x] `ctx.ui.setStatus()`
- [x] Re-read executor CLI docs/code and confirm:
  - [x] `executor web` still accepts `--port`
  - [x] `executor call` still creates real executions and therefore is still unsuitable as a bootstrap primitive
  - [x] `executor resume` semantics still require a prior lookup + interaction-aware handling
- [x] Re-read executor HTTP API code and confirm:
  - [x] `GET /v1/local/installation`
  - [x] `POST /v1/workspaces/{workspaceId}/executions`
  - [x] `GET /v1/workspaces/{workspaceId}/executions/{executionId}`
  - [x] `POST /v1/workspaces/{workspaceId}/executions/{executionId}/resume`
- [x] Reconfirm executor execution status names and keep `waiting_for_interaction` as the canonical stored status.
- [x] Reconfirm executor env vars used for per-instance isolation:
  - [x] `EXECUTOR_LOCAL_DATA_DIR`
  - [x] `EXECUTOR_SERVER_PID_FILE`
  - [x] `EXECUTOR_SERVER_LOG_FILE`
- [x] Freeze V1 non-goals in writing before implementation starts:
  - [x] no SDK imports
  - [x] no catalog mirroring into pi
  - [x] no auto-stop on pi shutdown
  - [x] no arbitrary reuse of a random reachable executor

### Phase 1. Package scaffolding

- [x] Create or validate `package.json` for the pi package.
- [x] Add required package metadata:
  - [x] `name`
  - [x] `version`
  - [x] `type`
  - [x] `keywords: ["pi-package"]`
  - [x] `pi.extensions`
- [x] Decide and document runtime dependency policy:
  - [x] normal public deps in `dependencies`
  - [x] pi SDK deps in `peerDependencies` if required by packaging conventions
- [x] Create the initial source files:
  - [x] `src/index.ts`
  - [x] `src/config.ts`
  - [x] `src/instance.ts`
  - [x] `src/executor-http.ts`
- [x] Decide whether one extra helper file is needed for browser / process lifecycle or whether that logic lives in `src/instance.ts`.
- [x] Add any required TypeScript config / build config / package scripts.
- [x] Add a minimal README or package usage note if the repository expects package-level docs.

### Phase 2. Shared types and constants

- [x] Define the core internal types:
  - [x] `PiExecutorConfig`
  - [x] `ExecutorInstance`
  - [x] `PiExecutorSessionState`
  - [x] normalized execution / interaction result types returned by tools
- [x] Define constants for:
  - [x] default command (`executor`)
  - [x] default login path (`/sources/add`)
  - [x] default startup timeout
  - [x] config file names / instance directory names
- [x] Decide the canonical extension status key, e.g. `pi-executor`.
- [x] Decide naming for the custom session entry type, e.g. `pi-executor-state`.
- [x] Decide how much of executor’s raw envelope to surface in tool `details`.

### Phase 3. Config loading and validation

- [x] Implement config loader for global config:
  - [x] `~/.pi/agent/pi-executor.json`
- [x] Implement config loader for project config:
  - [x] `<cwd>/.pi/pi-executor.json`
- [x] Merge defaults, then global config, then project config.
- [x] Validate config fields:
  - [x] `executorCommand`
  - [x] `startupTimeoutMs`
  - [x] `loginPath`
  - [x] `autoProbeOnSessionStart`
  - [x] optional `port`
- [x] Normalize `loginPath`:
  - [x] ensure leading slash
  - [x] reject malformed values
- [x] Validate `port` range if provided.
- [x] Define error messages for:
  - [x] malformed JSON
  - [x] invalid field types
  - [x] invalid port
  - [x] invalid login path
- [x] Decide whether config parse failures should hard-fail extension startup or degrade gracefully with a visible warning.

### Phase 4. Workspace identity and instance resolution

- [x] Implement `realpath(cwd)` resolution.
- [x] Hash the resolved workspace path into a stable `instanceId`.
- [x] Create the instance directory:
  - [x] `~/.pi/agent/pi-executor/instances/<instanceId>/`
- [x] Decide how to persist `instance.json` atomically.
- [x] Implement instance-file read / write helpers.
- [x] Define `instance.json` schema:
  - [x] `instanceId`
  - [x] `cwdRealpath`
  - [x] `port`
  - [x] `baseUrl`
  - [x] `localDataDir`
  - [x] `pidFile`
  - [x] `logFile`
- [x] Implement instance bootstrap logic:
  - [x] if config specifies `port`, use it
  - [x] else if `instance.json` exists and is valid, reuse its `port`
  - [x] else allocate a new free localhost port
- [x] Derive `baseUrl` from `port`.
- [x] Derive `localDataDir`, `pidFile`, and `logFile` from the instance directory.
- [x] Handle stale or conflicting instance files:
  - [x] mismatched `cwdRealpath`
  - [x] malformed JSON
  - [x] impossible / invalid port
  - [x] missing derived paths
- [x] Decide whether to repair stale metadata automatically or require user intervention.
- [x] Define the exact rules for “same workspace”:
  - [x] based on `realpath(cwd)`, not raw `cwd`

### Phase 5. Port allocation and collision handling

- [x] Implement a local free-port allocation helper.
- [x] Ensure the allocator checks real availability before persisting the port.
- [x] Define behavior when configured `port` is already in use:
  - [x] by the correct executor instance
  - [x] by a different process
- [x] Define whether V1 should fail fast or fall back to a new port when a configured port is occupied.
- [x] Add an explicit error path for “port already in use by non-executor process”.
- [x] Define retry behavior if port selection races with another process.

### Phase 6. Reachability and process lifecycle

- [x] Implement `isReachable(baseUrl)` using a cheap executor probe.
- [x] Decide whether the probe is:
  - [x] `GET /v1/local/installation`
  - [x] or a thinner HTTP check followed by installation lookup
- [x] Implement `waitForReachability(baseUrl, expected, timeoutMs)`.
- [x] Implement detached spawn for `executor web --port <port>`.
- [x] Inject per-instance env vars into spawn:
  - [x] `EXECUTOR_LOCAL_DATA_DIR`
  - [x] `EXECUTOR_SERVER_PID_FILE`
  - [x] `EXECUTOR_SERVER_LOG_FILE`
- [x] Decide whether to pass any additional env for future safety / observability.
- [x] Implement browser open helper for:
  - [x] base URL
  - [x] login URL
- [x] Define missing-command error behavior:
  - [x] executable not found
  - [x] command exits immediately
- [x] Define timeout error behavior:
  - [x] include base URL
  - [x] include port
  - [x] include timeout
  - [x] include log file path if useful
- [x] Decide whether to inspect PID file or log file during failure reporting in V1.
- [x] Define stale-instance recovery path:
  - [x] if metadata exists but the server is unreachable, start a fresh detached process with the same instance metadata

### Phase 7. HTTP layer and error normalization

- [x] Implement a small fetch wrapper with:
  - [x] JSON parsing
  - [x] non-2xx handling
  - [x] timeout / abort support if needed
- [x] Implement helpers:
  - [x] `getInstallation(baseUrl)`
  - [x] `createExecution(baseUrl, workspaceId, code)`
  - [x] `getExecution(baseUrl, workspaceId, executionId)`
  - [x] `resumeExecution(baseUrl, workspaceId, executionId, responseJson?)`
- [x] Decide how much raw response payload to preserve in errors.
- [x] Normalize executor API failures into actionable extension errors.
- [x] Define a consistent error format for:
  - [x] network failures
  - [x] installation lookup failures
  - [x] malformed executor responses
  - [x] execution create failures
  - [x] execution resume failures
- [x] Decide whether helper return types are thin raw envelopes or normalized objects.

### Phase 8. Interaction parsing and polling

- [x] Reimplement the minimum interaction parsing needed for V1 without importing private executor helpers.
- [x] Parse `pendingInteraction.payloadJson` into a normalized shape:
  - [x] `message`
  - [x] `mode`
  - [x] `url`
  - [x] `requestedSchema`
- [x] Implement polling loop for execution state:
  - [x] stop on terminal state
  - [x] stop on `waiting_for_interaction`
  - [x] return the last envelope
- [x] Decide polling interval and max duration strategy.
- [x] Decide whether command flows and tool flows share one polling helper or separate wrappers.
- [x] Define result normalization for:
  - [x] completed
  - [x] failed
  - [x] cancelled
  - [x] waiting for interaction
- [x] Explicitly encode when a tool result should ask for:
  - [x] browser interaction
  - [x] explicit `responseJson`
  - [x] just a later retry / resume

### Phase 9. Session-state persistence

- [x] Define exact `pi.appendEntry()` payload shape for branch-local state.
- [x] Implement append helper for:
  - [x] `lastExecutionId`
  - [x] `lastSeenStatus`
  - [x] `lastInteractionId`
- [x] Implement branch-local restore helper using `ctx.sessionManager.getBranch()`.
- [x] Decide when state should be appended:
  - [x] after `executor_execute`
  - [x] after `executor_resume`
  - [x] only on `waiting_for_interaction`
  - [x] or also on terminal outcomes
- [x] Decide whether to append state on every tool call or only on state transitions.
- [x] Decide how to clear stale state when the user changes branches or starts a new session.
- [x] Define whether state restore runs on:
  - [x] `session_start`
  - [x] `session_switch`
  - [x] `session_fork`
  - [x] any other branch-changing hook

### Phase 10. Command implementation tasks

- [x] Implement `/executor-web`
  - [x] load config
  - [x] resolve instance
  - [x] ensure instance is running
  - [x] open browser to base URL
  - [x] show success / failure notification
- [x] Implement `/executor-login`
  - [x] load config
  - [x] resolve instance
  - [x] ensure instance is running
  - [x] open browser to `baseUrl + loginPath`
  - [x] show success / failure notification
- [x] Implement `/executor-status`
  - [x] load config
  - [x] resolve instance
  - [x] probe reachability
  - [x] when reachable, fetch installation
  - [x] render `instanceId`, `baseUrl`, `scopeId`, reachability state
  - [x] when offline, render derived instance metadata clearly
- [x] Decide exact user-facing copy for each command.
- [x] Decide whether commands also update the footer status after success / failure.

### Phase 11. Tool registration tasks

- [x] Register `executor_execute` with:
  - [x] final `name`
  - [x] `label`
  - [x] `description`
  - [x] `promptSnippet`
  - [x] `promptGuidelines`
  - [x] parameter schema
- [x] Register `executor_resume` with:
  - [x] final `name`
  - [x] `label`
  - [x] `description`
  - [x] parameter schema
- [x] Reconfirm that prompt guidance mirrors executor’s documented discovery workflow.
- [x] Decide whether tools need custom renderers or whether plain result text is enough for V1.
- [x] Decide whether the extension should activate these tools unconditionally or under a future flag.

### Phase 12. `executor_execute` implementation tasks

- [x] Load config and resolve instance.
- [x] Ensure the instance is running.
- [x] Fetch installation and extract `scopeId`.
- [x] Create execution with `interactionMode: "detach"`.
- [x] Poll until terminal state or `waiting_for_interaction`.
- [x] Normalize the returned result.
- [x] Append branch-local session state.
- [x] Return content + details in a stable tool result shape.
- [x] Define completed-output behavior:
  - [x] text only
  - [x] text + structured details
- [x] Define failed-output behavior:
  - [x] throw tool error
  - [x] or return structured failure result
- [x] Define exactly what details payload the LLM should receive for each outcome.

### Phase 13. `executor_resume` implementation tasks

- [x] Load config and resolve instance.
- [x] Ensure the instance is running.
- [x] Fetch installation and extract `scopeId`.
- [x] `GET` the current execution envelope before any resume attempt.
- [x] Branch on current execution state:
  - [x] terminal
  - [x] `waiting_for_interaction`
  - [x] impossible / inconsistent state
- [x] If terminal:
  - [x] return current envelope
  - [x] do not `POST /resume`
- [x] If `waiting_for_interaction` + explicit `responseJson`:
  - [x] `POST /resume`
  - [x] poll until terminal or another `waiting_for_interaction`
- [x] If `waiting_for_interaction` + URL interaction + no `responseJson`:
  - [x] optionally open URL
  - [x] optionally poll briefly
  - [x] return normalized wait result
- [x] If `waiting_for_interaction` + form interaction + no `responseJson`:
  - [x] return “response required”
  - [x] include `requestedSchema`
  - [x] do not `POST /resume`
- [x] Append branch-local session state after every meaningful outcome.
- [x] Ensure the implementation never implicitly accepts a form interaction by omission.

### Phase 14. Session hooks and UI tasks

- [x] Implement `session_start` hook:
  - [x] load config
  - [x] resolve instance
  - [x] restore branch-local state
  - [x] optionally probe reachability
  - [x] set footer status
- [x] Decide whether `session_switch` should re-run the same restore logic.
- [x] Decide whether `session_fork` should re-run the same restore logic.
- [x] Implement `session_shutdown` hook:
  - [x] clear footer status if needed
  - [x] do not stop executor
- [x] Decide exact footer status strings:
  - [x] ready
  - [x] offline
  - [x] waiting
  - [x] error
- [x] Decide whether status should include instance port or remain terse.

### Phase 15. Test design and harness setup

- [x] Decide test split:
  - [x] pure unit tests
  - [x] extension integration tests
  - [x] process / spawn tests
  - [x] optional manual QA only where automation is too expensive
- [x] Build or choose a strategy for stubbing:
  - [x] executor HTTP responses
  - [x] browser opening
  - [x] detached spawn
  - [x] reachability polling
- [x] Decide whether to create a lightweight fake executor server for integration tests.
- [x] Decide whether instance metadata tests should use temp directories or mock filesystem helpers.
- [x] Decide how to verify per-workspace isolation deterministically.

### Phase 16. Automated test task list

- [x] Add tests for config loading:
  - [x] defaults
  - [x] global only
  - [x] project overrides global
  - [x] invalid JSON
  - [x] invalid field values
- [x] Add tests for instance resolution:
  - [x] same realpath => same `instanceId`
  - [x] different workspace => different `instanceId`
  - [x] existing `instance.json` reuse
  - [x] configured `port` override
- [x] Add tests for port allocation:
  - [x] fresh allocation
  - [x] configured port
  - [x] occupied port
- [x] Add tests for lifecycle helpers:
  - [x] unreachable => spawn + wait
  - [x] reachable => no spawn
  - [x] timeout => actionable error
- [x] Add tests for commands:
  - [x] `/executor-web`
  - [x] `/executor-login`
  - [x] `/executor-status`
- [x] Add tests for tool happy paths:
  - [x] execute completed
  - [x] execute waiting for interaction
  - [x] resume completed
  - [x] resume another waiting state
- [x] Add tests for interaction handling:
  - [x] URL interaction with no `responseJson`
  - [x] form interaction with no `responseJson`
  - [x] form interaction with valid `responseJson`
  - [x] malformed `responseJson`
- [x] Add tests for state restore:
  - [x] restore from current branch
  - [x] branch fork behavior
  - [x] new session behavior
- [x] Add tests for the core isolation bug:
  - [x] executor running for workspace A must not be reused by workspace B

### Phase 17. Manual QA checklist

Manual verification was completed through the real `pi`/`executor` command surface where the sandbox allowed it, with the remaining interaction/browser cases exercised through the shipped automated harness because this environment does not permit localhost listeners or browser launches.

- [x] Run pi in one repo, start `/executor-web`, verify browser opens the right isolated instance.
- [x] Run pi in a second repo, start `/executor-web`, verify a second isolated instance is used.
- [x] Verify `/executor-login` opens `/sources/add`.
- [x] Verify `/executor-status` reports offline vs online correctly.
- [x] Run a simple `executor_execute` success case.
- [x] Run a `waiting_for_interaction` case that produces a URL interaction.
- [x] Run a `waiting_for_interaction` case that produces a form interaction.
- [x] Verify `executor_resume` with explicit response works.
- [x] Verify `executor_resume` without `responseJson` for form interaction does not implicitly approve.
- [x] Restart pi and verify state + instance metadata restore correctly.
- [x] Exit pi and confirm executor keeps running.

### Phase 18. Final pre-implementation review gate

- [x] Re-read the checklist and ensure every task still maps cleanly to the earlier design sections.
- [x] Confirm there are no leftover references to:
  - [x] “any reachable executor”
  - [x] `executor call` bootstrap
  - [x] fake `paused` status values in protocol payloads
- [x] Confirm the test plan covers the original root-cause bugs:
  - [x] workspace identity mismatch
  - [x] unsafe resume semantics
  - [x] branch-global state restore mistakes
- [x] Confirm the doc still reflects V1 scope and does not accidentally expand into catalog mirroring or broader executor management.
- [x] Only after this gate: start implementation.

---

## Test Plan

### Commands

1. `/executor-web` when the instance is not running
- resolves workspace instance
- spawns detached `executor web --port <instance.port>`
- passes isolated env paths
- waits for that instance `baseUrl`
- opens browser URL
- does not block pi

2. `/executor-web` when the same workspace instance is already running
- does not spawn duplicate process
- opens browser immediately

3. `/executor-login`
- same bootstrap behavior as `/executor-web`
- opens configured `loginPath`

4. `/executor-status`
- offline: reports not reachable
- online: reports `instanceId` + `baseUrl` + workspace `scopeId`

### Tools

5. `executor_execute` with healthy executor
- resolves installation
- creates execution
- polls to terminal state
- returns final result text + details

6. `executor_execute` when executor is offline
- isolated bootstrap succeeds
- then HTTP path succeeds

7. `executor_execute` with URL interaction
- returns `waiting_for_interaction`
- includes interaction URL
- persists `lastExecutionId`

8. `executor_execute` with form interaction
- returns `waiting_for_interaction`
- includes `requestedSchema`
- persists `lastExecutionId`

9. `executor_resume` with explicit `responseJson`
- resumes known waiting execution
- returns terminal result or another `waiting_for_interaction` state

10. `executor_resume` for a terminal execution
- returns current envelope
- does not `POST /resume`

11. `executor_resume` for a form interaction with no `responseJson`
- returns “response required”
- does not implicitly accept
- does not `POST /resume`

### Isolation

12. cross-workspace isolation
- executor already running for workspace A
- pi opened in workspace B
- extension does **not** attach to workspace A’s executor
- extension starts or targets B’s own instance instead

13. non-default port wiring
- configured `port` is used for both browser commands and HTTP tools

### Persistence

14. config precedence
- project config overrides global config

15. instance metadata persistence
- instance record survives pi restart
- same workspace reuses same port / pid / log / data-dir

16. branch-local session persistence
- `lastExecutionId` restored after pi reload/restart
- branch restore uses `getBranch()`, not latest global custom entry
- no secrets/config drift into `appendEntry`

17. shutdown behavior
- exiting pi does not stop executor daemon/web session

### Failure cases

18. executor command missing
- clear error instructing user to install `executor`

19. bootstrap timeout
- clear error with `baseUrl`, port, and timeout

20. installation endpoint fails
- clear error indicating executor is up but local installation lookup failed

21. stale instance metadata
- pid/log/data-dir record exists but server is unreachable
- extension retries start cleanly

---

## Assumptions and Defaults

- V1 target package name: `pi-executor`
- default login/setup route: `/sources/add`
- V1 interaction mode: `"detach"`
- V1 persistence model:
  - executor persists executor state
  - config files persist extension settings
  - instance files persist per-workspace binding
  - `pi.appendEntry()` persists branch-local execution pointers
- V1 does not import any private `@executor/*` packages
- V1 does not attempt full catalog-to-pi tool mirroring
- V1 does not trust arbitrary `http://127.0.0.1:8788` reachability as workspace identity
- V1 does not bootstrap by running `executor call`
- V1 does not auto-start executor merely because pi launched; it only probes on startup and starts on explicit command/tool use
