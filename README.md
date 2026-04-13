# pi-executor

# Pi MCP Adapter

Use any MCP / OpenAPI or GRAPHQL api with [Pi](https://github.com/badlogic/pi-mono/) securely and without burning your context window. (code-mode)

https://github.com/user-attachments/assets/b6287e44-be8f-450a-bca0-a7728f1ed7b7

## Why This Exists

Mario wrote about [why you might not need MCP](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/). The problem: tool definitions are verbose. A single MCP server can burn 10k+ tokens, and you're paying that cost whether you use those tools or not. Connect a few servers and you've burned half your context window before the conversation starts.

His take: skip MCP entirely, write simple CLI tools instead.

Rhys wrote about [the execution layer](https://x.com/RhysSullivan/status/2030903539871154193). The problem: MCP and CLI tools are usually just APIs with extra ceremony on top. Bash helped because it gave models an execution surface, but it doesn't solve the real problems: auth, approvals, permissions, state, and discoverability.

His take: use a real execution layer.

This adapter gives you access to that execution layer without the bloat.

## Install

```bash
pi install npm:pi-executor
```

Restart or /Reload Pi after installation.

Pi extension that runs a cwd-scoped local [Executor](https://executor.sh) sidecar and exposes two agent facing tools and one skill to guide you agent into using executor.

### Agent-facing tools

- `execute`
- `resume` only in headless / no-UI sessions

Executor discovery helpers stay inside Executor's runtime and are meant to be used from code executed via `execute`:

- `tools.search(...)`
- `tools.describe.tool(...)`
- `tools.executor.sources.list()`

### Commands

| Command              | What it does                     |
| -------------------- | -------------------------------- |
| `/executor-web`      | Open the Web UI (manage sources) |
| `/executor-start`    | Start the executor sidecar       |
| `/executor-stop`     | Stop the executor sidecar        |
| `/executor-settings` | Executor local & global settings |

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

Isolated project mode (loads only `pi-executor`, with no skills and no other extensions):

Project-local settings in `.pi/settings.json` also disable project-local skills/prompts/themes and point Pi at `src/index.ts`, but global Pi resources can still load unless you use the isolated command above.
