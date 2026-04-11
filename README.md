# pi-executor

Pi extension that runs a cwd-scoped local [Executor](https://executor.sh) sidecar and exposes a small Pi surface on top of it.

## What ships in v1

### Tools

- `executor_execute`
- `executor_resume`
- `executor_search`
- `executor_describe`
- `executor_list_sources`

### Slash commands

- `/executor-web`
- `/executor-start`
- `/executor-stop`

## Runtime model

- one local Executor sidecar per working directory
- healthy same-cwd sidecars are reused across calls
- Pi supervises only sidecars it started itself
- the extension talks to Executor over local HTTP
- browser auth, source setup, and secret management stay in Executor's UI

## Install

```bash
bun install
```

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

## Development

Typecheck:

```bash
bun run typecheck
```

Run only this package's tests:

```bash
bun run test ./test/executor-sidecar.test.ts ./test/executor-http.test.ts ./test/executor-tools.test.ts ./test/executor-commands.test.ts
```

## Troubleshooting

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
