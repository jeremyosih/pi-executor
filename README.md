# pi-executor

`pi-executor` is a pi package that boots and targets a workspace-local executor web/runtime instance through raw HTTP instead of private executor SDK imports.

It persists only extension config, per-workspace instance metadata, and branch-local execution pointers. Executor remains the source of truth for sources, credentials, workspace catalog, and execution records.

## Usage

Install the package in pi, then use:

- `/executor-web`
- `/executor-login`
- `/executor-status`
- `executor_execute`
- `executor_resume`

## Dependency policy

The package is intentionally self-contained at runtime:

- no private `@executor/*` imports
- no bundled pi SDK runtime dependency
- no third-party runtime dependencies

It relies only on pi's injected extension API object and executor's public local HTTP endpoints.
