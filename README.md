# pi-executor

Pi extension that runs a cwd-scoped local [Executor](https://executor.sh) sidecar and exposes an MCP-parity tool UX on top of it.

## What ships

### Agent-facing tools

- `execute`
- `resume` only in headless / no-UI sessions

Executor discovery helpers stay inside Executor's runtime and are meant to be used from code executed via `execute`:

- `tools.search(...)`
- `tools.describe.tool(...)`
- `tools.executor.sources.list()`

### Slash commands

- `/executor-web`
- `/executor-start`
- `/executor-stop`
- `/executor-settings`

## Runtime model

- configurable local or remote Executor endpoint per project
- local mode uses one cwd-scoped Executor sidecar per working directory
- healthy same-cwd local sidecars are reused across calls
- Pi supervises only local sidecars it started itself
- remote mode connects to `piExecutor.remoteUrl` and never spawns a local sidecar
- the extension talks to Executor over HTTP
- browser auth, source setup, and secret management stay in Executor's UI
- `execute` mirrors MCP guidance and namespace discovery as closely as Pi allows
- when Pi has UI, `execute` handles Executor interaction inline
- when Pi has no UI, `execute` returns a paused interaction and `resume` is available

## Install

```bash
bun install
```

## Reference docs submodules

This repo keeps upstream reference repos checked out under `docs/`:

- `docs/executor`
- `docs/pi-mono`
- `docs/pi-diff-review`
- `docs/typescript-sdk` — upstream MCP TypeScript SDK reference

If you clone the repo fresh, initialize them with:

```bash
git submodule update --init --recursive
```

## Use in Pi

## Settings

Configure the extension in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "piExecutor": {
    "mode": "local",
    "autoStart": true,
    "remoteUrl": "",
    "showFooterStatus": true,
    "stopLocalOnShutdown": true
  }
}
```

- `mode`: `"local"` or `"remote"`
- `autoStart`: connect on session start
- `remoteUrl`: required for remote mode
- `showFooterStatus`: show the footer readiness dot
- `stopLocalOnShutdown`: stop Pi-owned local sidecars on session shutdown

You can also manage these interactively with `/executor-settings`.

## Use in Pi

Quick test with an explicit extension path:

```bash
pi -e ./src/index.ts
```

Project-local auto-discovery:

```bash
mkdir -p .pi/extensions
ln -sf ../../src/index.ts .pi/extensions/pi-executor.ts
pi
```

## Example flows

Open the Executor UI:

```text
/executor-web
```

Start the cwd-scoped sidecar without opening the browser:

```text
/executor-start
```

Stop the Pi-owned sidecar for the current cwd:

```text
/executor-stop
```

Let the agent use Executor:

```text
Use execute to search for the right tool, inspect its shape, and call it.
```

Headless fallback:

1. `execute` returns `waiting_for_interaction` with an `executionId`
2. the agent calls `resume` with that exact id

## Development

Typecheck:

```bash
bun run typecheck
```

Run this package's tests:

```bash
bun run tesst
```

## Troubleshooting

### `resume` is missing

That is expected when Pi has UI available. In UI sessions, `execute` handles interaction inline.

### Executor runtime bootstrap failed

The extension resolves `executor/package.json`, then uses `postinstall.cjs` to install the runtime binary into `node_modules/executor/bin/runtime/` when needed.

Try:

```bash
bun install
```

If the binary is still missing, reinstall `executor` or rerun its install step.

### No free sidecar port found

v1 scans ports `4788..4819`.
If that window is full, stop stale local Executor processes or widen the port window in code.

### Browser launch failed

`/executor-web` still reports the local URL even if `open`, `xdg-open`, or `cmd /c start` fails.
Open the printed URL manually.

### Sidecar startup timed out

The extension waits for `GET /api/scope` to succeed and match the current cwd.
If startup times out, inspect the sidecar stderr/stdout included in the thrown error and verify Executor itself runs locally.

### Scope mismatch

The extension only reuses a sidecar when `/api/scope.dir` matches the current cwd exactly.
If reuse fails, a new sidecar is started for the current project.
