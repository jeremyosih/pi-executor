# pi-executor

Pi extension for using [Executor](https://executor.sh) from [Pi](https://github.com/badlogic/pi-mono/) without loading every MCP, OpenAPI, or GraphQL tool definition into the model context up front.

https://github.com/user-attachments/assets/b6287e44-be8f-450a-bca0-a7728f1ed7b7

## Why This Exists

MCP servers and API adapters can expose a lot of tool metadata. A single server can spend thousands of tokens on definitions before the agent has even decided which tool it needs.

`pi-executor` keeps that surface behind Executor. Pi gets a small, stable extension interface, while Executor handles the larger execution layer: API discovery, auth, approvals, permissions, state, and source management.

## Install

Install the extension in Pi:

```bash
pi install npm:pi-executor
```

Restart Pi or run `/Reload` after installation.

## Quick Start

1. Run `/executor-start` to start or connect to Executor for the current project.
2. Run `/executor-web` to open Executor's UI.
3. Configure the MCP, OpenAPI, or GraphQL sources you want Executor to manage.
4. Ask Pi to use those sources. The extension exposes `execute`, and the bundled `executor-usage` skill teaches the agent how to discover and call Executor tools safely.

## What It Provides

### Agent-Facing Tools

- `execute`: runs TypeScript in Executor's sandbox with access to configured API tools.
- `resume`: resumes a paused Executor interaction in headless or no-UI sessions.

Executor discovery helpers are called from inside `execute`, not as separate Pi tools:

```ts
await tools.search({ query: "github pull requests", limit: 5 });
await tools.describe.tool({ path: "mcp_github.list_pull_requests" });
await tools.executor.sources.list({});
```

### Skill

- `executor-usage`: documents the required discovery-first calling pattern for Executor tools.

### Commands

| Command              | What it does                             |
| -------------------- | ---------------------------------------- |
| `/executor-start`    | Start or connect to Executor             |
| `/executor-web`      | Open Executor's web UI for source setup  |
| `/executor-stop`     | Stop the local sidecar owned by Pi       |
| `/executor-settings` | View or update local and global settings |

## Settings

Configure the extension globally in `~/.pi/agent/settings.json` or per project in `.pi/settings.json`:

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

| Setting               | Default   | Description                                      |
| --------------------- | --------- | ------------------------------------------------ |
| `mode`                | `"local"` | Use `"local"` sidecar mode or `"remote"` mode    |
| `autoStart`           | `true`    | Connect to Executor when a Pi session starts     |
| `remoteUrl`           | `""`      | Executor base URL used when `mode` is `"remote"` |
| `showFooterStatus`    | `true`    | Show Executor readiness in Pi's footer           |
| `stopLocalOnShutdown` | `true`    | Stop Pi-owned local sidecars on session shutdown |

You can also manage these settings interactively with `/executor-settings`.

## Runtime Model

- Local mode runs one cwd-scoped Executor sidecar per working directory.
- Healthy same-cwd local sidecars are reused across calls.
- Pi supervises only the local sidecars it started itself.
- Remote mode connects to `piExecutor.remoteUrl` and never starts a local sidecar.
- Browser auth, source setup, and secret management stay in Executor's UI.
- `execute` handles Executor interactions inline when Pi has UI support.
- In headless sessions, `execute` can return a paused interaction and `resume` is available to continue it.

## Development

Install dependencies:

```bash
bun install
```

Useful checks:

```bash
bun test test
bun run typecheck
bun run lint
bun run fmt:check
```

The package entrypoint is `src/index.ts`, and the bundled Pi skill lives in `skills/executor-usage`.
