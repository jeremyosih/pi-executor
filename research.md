# Pi + Executor extension research

## Scope

I read the local source trees and docs for:

- `docs/pi-mono/**` — especially Pi extension, SDK, TUI, package, settings, and RPC docs, plus extension runtime source
- `docs/executor/**` — especially SDK/core abstractions, local server/runtime, React UI, execution layer, and plugin packages
- `docs/pi-diff-review/**` — the concrete Glimpse-based Pi extension example
- the current repo itself (`package.json`, `src/index.ts`, `.gitmodules`)

This report is evidence-driven and focused on what matters for building **a Pi extension that embeds an Executor instance** and gives the user a UI for adding/managing sources.

---

## Current repo state

This repo is still effectively empty as a product:

- `src/index.ts` is just `console.log("hello world")`
- `package.json` already has the correct Pi package manifest:

```json
"pi": {
  "extensions": ["./src/index.ts"]
}
```

- the repo depends on `@executor-js/sdk` `^0.0.1-beta.2`
- the docs are vendored as git submodules in:
  - `docs/pi-mono`
  - `docs/executor`
  - `docs/pi-diff-review`

So the package shape is already right for a Pi extension package, but there is no real integration yet.

---

# Executive summary

## Bottom line

### 1. Pi already gives you everything you need to ship this as an extension package

Pi’s extension system is much richer than “add a command.” An extension can:

- register commands
- register tools callable by the model
- dynamically register tools after startup
- show dialogs / selectors / editors
- replace the editor with custom TUI
- add widgets / status lines / footers / headers
- launch arbitrary external processes or windows
- persist extension state in the session if needed
- hot-reload from discovered extension locations

The core reference is `docs/pi-mono/packages/coding-agent/docs/extensions.md`, backed by runtime source in `docs/pi-mono/packages/coding-agent/src/core/extensions/**`.

### 2. The clean integration seam is the **Executor SDK in-process**, not MCP and not a subprocess hop

Executor’s own architecture strongly points toward embedding:

- `createExecutor(...)` builds an in-process runtime from `tools`, `sources`, `secrets`, `policies`, and `plugins`
- plugins contribute typed extensions directly onto the executor object
- the local server and CLI are thin wrappers around a single shared executor handle

The key files are:

- `docs/executor/packages/core/sdk/src/executor.ts`
- `docs/executor/packages/core/sdk/src/promise-executor.ts`
- `docs/executor/apps/local/src/server/executor.ts`
- `docs/executor/apps/local/src/server/main.ts`

So for Pi, the right architectural move is:

- **embed the executor SDK inside the extension host process**
- use Pi only as the shell/agent harness
- optionally open a richer UI for humans when source setup/auth is needed

### 3. For the human UI, the evidence-backed best first choice is **localhost browser UI**, not Glimpse

Why:

- Executor’s existing source-management UX is already browser-oriented
- Google Discovery and MCP flows explicitly use popup OAuth, `window.open(...)`, callback pages, `postMessage`, and `BroadcastChannel`
- that is exactly the kind of flow where access to the **real browser** is valuable (password manager, existing OAuth sessions, popup behavior)

Evidence:

- `docs/executor/packages/plugins/google-discovery/src/react/AddGoogleDiscoverySource.tsx`
- `docs/executor/packages/plugins/mcp/src/react/AddMcpSource.tsx`
- `docs/executor/packages/plugins/google-discovery/src/api/handlers.ts`
- `docs/executor/packages/plugins/mcp/src/api/handlers.ts`
- `docs/executor/apps/local/src/serve.ts`

### 4. Glimpse is still viable, but only as a richer native window shell — not as the best auth-heavy first UX

`pi-diff-review` proves that a Pi extension can:

- open a native window
- inject HTML/JS
- maintain a host↔window bridge
- lazy-load data on demand
- return the result back into Pi

That pattern is solid.

But `pi-diff-review` does **not** prove that a Glimpse webview shares the user’s real browser session, password manager, or OAuth state. The example is auth-free and CDN-based.

So:

- **Glimpse is proven for rich native UI**
- **browser reuse is proven for OAuth/password-manager flows**
- therefore the safer first product choice is browser-based UI, with Glimpse still available later if you want a more “inside Pi” feeling

### 5. Reusing Executor’s current local web app is possible as source code, but **not as a clean public npm surface**

This is one of the most important findings.

A lot of the interesting Executor UI/server stack is **private/internal in the monorepo**:

- `@executor/local` → `private: true`
- `@executor/react` → `private: true`
- `@executor/api` → `private: true`
- `@executor/execution` → `private: true`

Also, several plugin packages have source exports for `./react` and `./api`, but their publish config only keeps the root/core surfaces for npm publication.

Implication:

- you **can** study and reuse the source from `docs/executor/**`
- you **cannot assume** you can just `bun add @executor/local` / `@executor/react` and reuse the entire browser app as a stable public dependency

So if you want the current Executor browser UI, you likely need to **vendor/adapt code**, not just install public packages.

### 6. Executor package/docs naming is currently in flux; treat the public API as moving

There is clear churn between the installed/public package and the monorepo source:

- this repo depends on `@executor-js/sdk`
- the monorepo now uses `@executor/sdk`
- source examples often use `@executor/sdk/promise`
- source package exports and publish config don’t line up perfectly
- product README and current code also drift on tool-discovery API names

Implication:

- build conservatively
- pin versions tightly
- expect adaptation work
- avoid designing around unstable internal/private subpaths unless you vendor them

---

# 1. What Pi can actually do for this project

## 1.1 Package/discovery model

Pi extensions are just TypeScript modules discovered from:

- `~/.pi/agent/extensions/*.ts`
- `.pi/extensions/*.ts`
- package manifests under `pi.extensions`
- explicit `--extension/-e` paths

Relevant docs/source:

- `docs/pi-mono/packages/coding-agent/README.md`
- `docs/pi-mono/packages/coding-agent/docs/extensions.md`
- `docs/pi-mono/packages/coding-agent/docs/packages.md`
- `docs/pi-mono/packages/coding-agent/src/core/extensions/loader.ts`

Important details:

- Pi loads TypeScript directly via **jiti**, so no build step is required for development
- package manifests work exactly the way this repo is already configured
- hot-reload via `/reload` only works naturally for discovered extension locations, not just ad-hoc `-e` usage
- extension directories can have their own `package.json` and dependencies

### Practical implication

Your repo shape is already correct for a shared Pi extension package. The fastest development loop is:

- keep the extension in the package manifest
- install/use it in an auto-discovered location or via package install
- rely on `/reload` during development

## 1.2 Extension runtime model

The extension API is not a toy wrapper. Pi creates:

- an `ExtensionRuntime`
- per-extension `ExtensionAPI`
- an `ExtensionRunner` that binds UI, session state, commands, and runtime actions

Relevant source:

- `docs/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `docs/pi-mono/packages/coding-agent/src/core/extensions/loader.ts`
- `docs/pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- `docs/pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts`

Important runtime behavior:

- `pi.registerTool()` can happen during load **and later at runtime**
- post-start registrations refresh immediately in-session
- provider registration calls during load are queued and then flushed when the runner binds
- the runner injects a mode-specific `ExtensionUIContext`

### Practical implication

This matters a lot for `pi-executor`.

After the user adds/removes sources from your UI, the extension can immediately:

- update its commands/status/widgets
- dynamically register or unregister Pi tools
- change active tools via `pi.setActiveTools(...)`

…without requiring a `/reload`.

## 1.3 Lifecycle and session behavior

The extension event lifecycle is rich and explicit.

Important events for this project:

- `session_start`
- `resources_discover`
- `input`
- `before_agent_start`
- `tool_call`
- `tool_result`
- `session_before_switch`
- `session_before_fork`
- `session_shutdown`

Reference:

- `docs/pi-mono/packages/coding-agent/docs/extensions.md`

Crucial lifecycle rule:

- on `/new`, `/resume`, `/fork`, Pi emits `session_shutdown` for the old extension instance, then reloads/rebinds extensions for the new session

### Practical implication

If `pi-executor` owns a long-lived singleton like:

- an Executor instance
- a local HTTP server
- a Glimpse window

…you should explicitly clean it up on `session_shutdown`, and be deliberate about whether the executor is:

- session-scoped,
- project-scoped,
- or process-scoped.

For this product, **project-scoped / process-scoped** makes more sense than session-scoped, because sources/secrets are not conversational state.

## 1.4 UI surface available to extensions

Pi’s extension UI API is strong enough for both lightweight and complex UX.

### Basic UI

Via `ctx.ui` / `ExtensionUIContext`:

- `select(...)`
- `confirm(...)`
- `input(...)`
- `editor(...)`
- `notify(...)`
- `setStatus(...)`
- `setWorkingMessage(...)`
- `setWidget(...)`
- `setFooter(...)`
- `setHeader(...)`
- `setTitle(...)`
- `setEditorText(...)`
- `pasteToEditor(...)`
- `setEditorComponent(...)`
- `getAllThemes()/setTheme(...)`
- `setToolsExpanded(...)`

References:

- `docs/pi-mono/packages/coding-agent/docs/extensions.md`
- `docs/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `docs/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts`

### Complex UI

`ctx.ui.custom(...)` can temporarily replace the editor with a custom TUI component.

That component can be:

- full-screen replacement
- overlay/floating modal
- custom selector/settings panel
- custom editor

References:

- `docs/pi-mono/packages/coding-agent/docs/extensions.md`
- `docs/pi-mono/packages/coding-agent/docs/tui.md`

### Practical implication

For `pi-executor`, Pi’s native TUI is strong enough for:

- launching the executor UI
- showing current source/status summary
- showing a “connected sources” widget
- lightweight approvals or source pickers
- fallback flows when browser UI is unavailable

But Pi TUI is **not** the best fit for:

- multi-step OAuth-heavy setup
- password-manager-driven credential entry
- rich schema/source browsing comparable to Executor’s existing browser UI

## 1.5 RPC mode matters, but with important limits

Pi’s RPC mode supports an extension UI sub-protocol, but not full custom TUI behavior.

Key facts:

- dialog methods work over RPC (`select`, `confirm`, `input`, `editor`)
- fire-and-forget methods also work (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`)
- **`custom()` is unsupported in RPC mode**
- custom footer/header/editor/theme switching are degraded or unsupported in RPC mode

References:

- `docs/pi-mono/packages/coding-agent/docs/rpc.md`
- `docs/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts`

### Practical implication

If you want `pi-executor` to remain useful when Pi itself is embedded elsewhere, a browser-based UI is more portable than a heavy `ctx.ui.custom(...)` workflow.

## 1.6 Pi feature implications for this project

These are the most relevant Pi-specific design levers for `pi-executor`:

### Dynamic tool registration is supported

This is useful if you decide to expose executor-backed Pi tools dynamically.

### But mirroring the full executor catalog into Pi would likely be a mistake

Pi tools are part of the model-visible tool surface. Executor sources can expand into **many** operations.

If you mirror every executor tool into Pi:

- prompt/tool surface grows fast
- source churn means constant register/unregister pressure
- the model gets a noisy flat API catalog

### Better Pi-facing shapes

Evidence-based better options are:

1. a small fixed Pi tool surface:
   - `executor_sources`
   - `executor_search`
   - `executor_describe`
   - `executor_invoke`

2. or a single higher-level Pi tool that internally uses Executor’s execution/search layer

This is especially attractive because Executor’s own execution layer already assumes lazy discovery (`tools.search`, `tools.describe.tool`) instead of exposing the entire catalog eagerly.

---

# 2. What Executor actually is

## 2.1 Core architecture

Executor is not “just an MCP server.” It is a typed integration runtime built around four registries/services plus plugins:

- `ToolRegistry`
- `SourceRegistry`
- `SecretStore`
- `PolicyEngine`
- plugins layered on top of them

Core files:

- `docs/executor/packages/core/sdk/src/executor.ts`
- `docs/executor/packages/core/sdk/src/tools.ts`
- `docs/executor/packages/core/sdk/src/sources.ts`
- `docs/executor/packages/core/sdk/src/secrets.ts`
- `docs/executor/packages/core/sdk/src/policies.ts`
- `docs/executor/packages/core/sdk/src/plugin.ts`

### Executor object shape

`createExecutor(...)` produces an object with:

- `executor.tools.{list,schema,definitions,invoke}`
- `executor.sources.{list,remove,refresh,detect}`
- `executor.policies.{list,add,remove}`
- `executor.secrets.{list,resolve,status,set,remove,addProvider,providers}`
- `executor.close()`
- plus plugin-contributed namespaces like `executor.openapi`, `executor.mcp`, `executor.googleDiscovery`, etc.

### Practical implication

This is exactly the kind of object a Pi extension host can own in memory.

You do **not** need MCP to talk to it.

## 2.2 Plugin model

Executor plugins are very small conceptually:

- unique `key`
- `init(ctx)`
- return `{ extension, close? }`

This makes them easy to embed into another host.

### Practical implication

`pi-executor` can construct an executor with whatever subset of plugins it wants, then expose a Pi-native UX on top.

## 2.3 Tool model

Executor tools are stored as registration data plus plugin-keyed invokers.

Important properties:

- `ToolMetadata` is lightweight
- `ToolSchema` can include compact TypeScript previews and schema definitions
- tools can declare `mayElicit`
- approval requirements can also be resolved dynamically through annotations

Relevant files:

- `docs/executor/packages/core/sdk/src/tools.ts`
- `docs/executor/packages/core/sdk/src/schema-refs.ts`
- `docs/executor/packages/react/src/components/tool-detail.tsx`

### Practical implication

This is great for UI work because:

- source browsing can stay metadata-first
- detailed schema rendering is only needed on-demand
- tool invocation is orthogonal to browsing

## 2.4 Elicitation / approvals

Executor has a real elicitation model.

Important pieces:

- `FormElicitation`
- `UrlElicitation`
- `ElicitationHandler`
- `onElicitation` in invoke options

In `executor.tools.invoke(...)`, policy/annotation checks can require approval and use the caller-provided elicitation handler.

Key file:

- `docs/executor/packages/core/sdk/src/executor.ts`

### Important nuance

The public SDK has elicitation at the tool invocation level.

But the higher-level **execution layer** that turns the catalog into a sandboxed `tools.*` object is a separate package (`@executor/execution`) and that package is currently **private** in the monorepo.

---

# 3. Executor public surface vs source-only surface

This is one of the most important practical findings.

## 3.1 What is actually public/consumable

### Public-ish / designed to be published

- `@executor-js/sdk` in this repo today
- newer monorepo name: `@executor/sdk`
- plugin packages like:
  - `@executor/plugin-openapi`
  - `@executor/plugin-mcp`
  - `@executor/plugin-graphql`
  - `@executor/plugin-google-discovery`
  - `@executor/plugin-keychain`
  - `@executor/plugin-file-secrets`
  - `@executor/plugin-onepassword`

### Private/internal in the monorepo

- `@executor/local`
- `@executor/react`
- `@executor/api`
- `@executor/execution`
- cloud/local app packages

Evidence:

- `docs/executor/apps/local/package.json` → `private: true`
- `docs/executor/packages/react/package.json` → `private: true`
- `docs/executor/packages/core/api/package.json` → `private: true`
- `docs/executor/packages/core/execution/package.json` → `private: true`

## 3.2 Why this matters

The most reusable-looking code in the repo — the local server, typed HTTP API, React pages, and sandbox execution layer — is **not a stable npm integration surface today**.

So there are really two paths:

### Path A: build only on public SDK/plugin packages

Pros:

- cleaner dependency story
- less coupling to internal churn

Cons:

- you do **not** get the current local browser app “for free”
- you do **not** get the current execution package “for free”
- you must build your own UI/server glue

### Path B: vendor/adapt source from the executor monorepo

Pros:

- fastest route to source-management UI parity
- can reuse browser flows/patterns

Cons:

- you now own internal code drift
- you are depending on unpublished/private surfaces
- updates will be manual / source-merge style

### My conclusion

For `pi-executor`, **SDK + selective source vendoring** is the realistic path if you want the browser UX.

---

# 4. Executor package/version/API churn you should know about

## 4.1 Name churn: `@executor-js/*` vs `@executor/*`

Current repo dependency:

- `@executor-js/sdk`

Monorepo source/docs:

- `@executor/sdk`

This is clearly an ongoing rename/rebrand.

## 4.2 Root export churn: promise vs Effect

There is also export-shape churn.

### In monorepo source package config

`docs/executor/packages/core/sdk/package.json` exports:

- `.` → `./src/index.ts`
- `./promise` → `./src/promise.ts`

Where:

- `src/index.ts` is the **Effect/core** API
- `src/promise.ts` is the **async/await wrapper**

### In publish config

The publish config maps:

- npm root `.` → built promise wrapper
- `./core` → built Effect API

### In installed package in this repo

`node_modules/@executor-js/sdk/package.json` exposes:

- `.` → promise wrapper
- `./core` → Effect API

### Practical implication

If you read the monorepo source and implement against the installed npm package naively, you can get confused.

The stable mental model should be:

- **installed public root = promise API**
- **installed `/core` = Effect API**

## 4.3 README/examples drift

There is also doc drift in higher-level Executor docs.

### Drift examples

- root product README uses `tools.discover(...)`
- current execution layer source uses `tools.search(...)`
- root README shows `tools.describe.tool({ path, includeSchemas: true })`
- current execution engine explicitly rejects `includeSchemas`

Evidence:

- `docs/executor/README.md`
- `docs/executor/packages/core/execution/src/description.ts`
- `docs/executor/packages/core/execution/src/engine.ts`

### Practical implication

Do not treat the top-level README as the canonical implementation contract.

For actual work, trust:

- SDK source
- plugin source
- local server source
- package.json export maps

---

# 5. Executor local runtime, storage, and project scoping

## 5.1 Local runtime shape

The local app creates a single shared executor handle backed by SQLite and a cwd-based scope.

Key file:

- `docs/executor/apps/local/src/server/executor.ts`

Important details:

- DB path defaults to `~/.executor/data.db`
- scope directory defaults to `process.cwd()` or `EXECUTOR_SCOPE_DIR`
- config file path is `<cwd>/executor.jsonc`
- local plugin set includes:
  - openapi
  - mcp
  - googleDiscovery
  - graphql
  - keychain
  - fileSecrets
  - onepassword

## 5.2 Storage model

`makeKvConfig(...)` from `@executor/storage-file` creates a fully scoped config from a KV store.

Key file:

- `docs/executor/packages/core/storage-file/src/index.ts`

Important details:

- scope id is derived from cwd hash
- KV namespaces are prefixed by full cwd
- tools/defs/secrets/policies are persisted
- source-specific stores are plugin-specific

## 5.3 Secret model

Secret refs are persisted; values are delegated to providers.

Key file:

- `docs/executor/packages/core/storage-file/src/secret-store.ts`

Important behaviors:

- secret refs are stored in KV
- providers are registered dynamically
- setting a secret chooses either the requested provider or the first writable provider that actually succeeds on write+readback
- this is a good design for keychain → file fallback behavior

## 5.4 Policy model is present but currently not enforced

This is a real caveat.

Both in-memory and KV policy engines currently implement `check(...)` as a no-op.

Evidence:

- `docs/executor/packages/core/sdk/src/in-memory/policy-engine.ts`
- `docs/executor/packages/core/storage-file/src/policy-engine.ts`

### Practical implication

If `pi-executor` promises approval/policy enforcement via Executor today, that promise would be misleading unless you add your own enforcement layer.

## 5.5 Source/config persistence is asymmetric by plugin

Local plugin wiring in `apps/local/src/server/executor.ts` does:

- OpenAPI → wrapped with config file persistence
- MCP → wrapped with config file persistence
- GraphQL → wrapped with config file persistence
- Google Discovery → **not** wrapped with config file persistence

So Google Discovery sources are persisted through the binding store/SQLite path, but not mirrored into `executor.jsonc` the same way.

### Practical implication

If your product promise is “project-config portable source definitions,” note that today Executor’s local wiring is not fully symmetrical across source types.

## 5.6 Scope API is mostly single-scope in practice

The typed HTTP API includes `scopeId` path params everywhere, but the local server only wires one executor instance for one current scope.

Also, handlers like sources/tools/secrets do not use the incoming `scopeId` to select a different executor; they just use the current injected executor.

Evidence:

- `docs/executor/packages/core/api/src/handlers/sources.ts`
- `docs/executor/packages/core/api/src/handlers/secrets.ts`
- `docs/executor/apps/local/src/server/main.ts`

### Practical implication

For `pi-executor`, assume **one active scope per extension host instance**, not a real multi-scope backend.

That is actually a reasonable fit for Pi, because Pi itself is project/cwd-centric.

---

# 6. What the current Executor browser UI actually does

## 6.1 It is primarily a source/secrets/tool-browser UI

The current local browser app is not a general-purpose interactive execution console.

Main routes/pages:

- `SourcesPage`
- `SourcesAddPage`
- `SourceDetailPage`
- `SecretsPage`
- tools/schema browser components

Relevant files:

- `docs/executor/apps/local/src/routes/index.tsx`
- `docs/executor/apps/local/src/routes/sources.add.$pluginKey.tsx`
- `docs/executor/apps/local/src/routes/sources.$namespace.tsx`
- `docs/executor/apps/local/src/routes/secrets.tsx`
- `docs/executor/packages/react/src/pages/sources.tsx`
- `docs/executor/packages/react/src/pages/sources-add.tsx`
- `docs/executor/packages/react/src/pages/source-detail.tsx`
- `docs/executor/packages/react/src/pages/secrets.tsx`
- `docs/executor/packages/react/src/components/tool-detail.tsx`

### Practical implication

That browser UI is already very relevant for the **human setup/configuration half** of `pi-executor`.

But it does **not** solve the **agent invocation half** by itself.

## 6.2 Source UI is plugin-driven

The browser UI has a `SourcePlugin` contract:

- `key`
- `label`
- `add`
- `edit`
- optional `summary`
- optional `presets`

Key file:

- `docs/executor/packages/react/src/plugins/source-plugin.tsx`

The shell owns:

- overall routing
- source list page
- detail chrome

The plugin owns:

- add wizard
- edit view
- optional summary/presets

### Practical implication

This is a very strong pattern to copy into `pi-executor` if you want browser UI.

You do **not** need to design one giant monolithic source-management screen.

## 6.3 Browser UX is especially strong for auth-heavy sources

### OpenAPI

The add flow:

- analyzes a spec URL or pasted spec
- previews tags/operations
- suggests auth headers
- lets the user map headers to secrets

File:

- `docs/executor/packages/plugins/openapi/src/react/AddOpenApiSource.tsx`

### GraphQL

Same overall direction: endpoint + auth → introspection → source add.

### Google Discovery

This is the strongest evidence for browser-first UX.

The add flow:

- probes the discovery doc
- lists OAuth scopes
- lets the user create/select a client secret
- starts popup OAuth using the current browser window context
- receives auth result via `postMessage` / `BroadcastChannel`
- stores tokens as secrets

Files:

- `docs/executor/packages/plugins/google-discovery/src/react/AddGoogleDiscoverySource.tsx`
- `docs/executor/packages/plugins/google-discovery/src/api/handlers.ts`

### MCP

The MCP add flow is similar for remote OAuth-capable MCP servers.

Files:

- `docs/executor/packages/plugins/mcp/src/react/AddMcpSource.tsx`
- `docs/executor/packages/plugins/mcp/src/api/handlers.ts`

### Practical implication

This is the clearest reason to prefer a **real browser** over Glimpse as the first UI path.

---

# 7. Executor local server architecture

## 7.1 Server shape

The local app serves three things from one Bun server:

- static SPA assets
- typed `/api` routes
- `/mcp` endpoint

Key file:

- `docs/executor/apps/local/src/serve.ts`

Important details:

- binds to `127.0.0.1`
- checks the host header against a localhost allowlist
- serves SPA fallback for non-API paths

### Practical implication

This is a good pattern to reuse inside a Pi extension if you open a browser tab.

It keeps the surface local-only and reasonably safe by default.

## 7.2 API layer

The typed API is a thin wrapper over the executor instance and plugin extensions.

Key file:

- `docs/executor/apps/local/src/server/main.ts`

It injects:

- core handlers
- plugin handlers
- execution engine
- MCP request handler

### Practical implication

If you want browser UI inside `pi-executor`, you do **not** necessarily need the whole local app.

A thinner local server tailored to Pi could be enough:

- `/sources`
- `/secrets`
- `/oauth/callback`
- maybe `/invoke`

…but the local app source is a strong reference.

---

# 8. What the current Executor execution layer actually gives you

## 8.1 There is a separate execution package

Executor’s “run code against the tool catalog” layer lives in:

- `docs/executor/packages/core/execution/src/**`

Key files:

- `engine.ts`
- `tool-invoker.ts`
- `description.ts`

It builds a sandbox runtime around:

- `tools.search(...)`
- `tools.describe.tool(...)`
- `tools.executor.sources.list()`
- proxy invocation of `tools.<namespace>.<tool>(args)`

It also supports pause/resume around elicitation.

## 8.2 Important caveat: this package is private

`@executor/execution` is `private: true` in the monorepo.

### Practical implication

If you want this exact “lazy tool catalog in sandbox” behavior inside `pi-executor`, you likely need to:

- vendor/adapt the execution code,
- or reimplement the smaller pieces yourself on top of the public SDK.

## 8.3 Why this matters for Pi specifically

This execution model is a better fit for Pi than mirroring hundreds of executor tools into Pi directly.

Because it gives you a compact indirection layer:

- discover → describe → invoke

Instead of:

- register every external API operation as a first-class Pi tool

### My take

Long-term, the best Pi-facing executor integration is probably:

- one or a few Pi tools backed by Executor search/describe/invoke semantics,
- not direct mirroring of the full external tool catalog.

---

# 9. What `pi-diff-review` teaches us

## 9.1 It is the clearest example of a rich Pi extension with an external UI

Structure:

- `src/index.ts` — Pi extension host logic
- `src/git.ts` — data collection / lazy file loading
- `src/types.ts` — shared protocol
- `src/ui.ts` — inline HTML assembly
- `web/index.html` + `web/app.js` — client UI

Package shape:

- normal Pi package manifest in `package.json`
- peer dep on `@mariozechner/pi-coding-agent`
- runtime dep on `glimpseui`

## 9.2 The host/window pattern is very good

The core pattern in `src/index.ts` is:

1. gather initial metadata in the extension host
2. build inline HTML
3. open a Glimpse window
4. keep a small waiting/cancel TUI in Pi via `ctx.ui.custom()`
5. let the external window request data lazily
6. return the result into Pi with `ctx.ui.setEditorText(...)`

This is a very strong reference architecture.

## 9.3 The bridge pattern is tiny and reusable

Window → host:

- Glimpse `message` events

Host → window:

- `window.send(...)` injecting JS that calls a global receiver

The example uses:

- `request-file`
- `file-data`
- `file-error`
- `submit`
- `cancel`

This is a good minimal protocol style for `pi-executor` too.

## 9.4 The example deliberately avoids a local server

`pi-diff-review` inlines HTML + JS directly and reads static assets from disk.

That keeps deployment simple.

### But the tradeoff is important

It is ideal when:

- the UI is self-contained
- the host owns all data
- there is no real browser identity/session dependency

It is less ideal when:

- you want popup OAuth against real browser state
- you want password manager autofill
- you want to reuse a larger browser-oriented React app with routing/state

## 9.5 What is reusable from `pi-diff-review`

Highly reusable:

- package shape
- one-command entrypoint pattern
- host/window protocol
- session cleanup on `session_shutdown`
- “waiting UI in Pi while external window is open”
- lazy data loading

Less reusable directly:

- the exact Glimpse assumptions for auth/session use cases
- CDN/no-build browser approach

---

# 10. UI options for `pi-executor`

## Option A — Pure Pi TUI (`ctx.ui.custom`, widgets, dialogs)

### Pros

- simplest runtime model
- no extra window/server/port
- fully inside Pi
- easiest packaging story

### Cons

- weakest fit for OAuth/password-manager flows
- weakest fit for rich source configuration and schema browsing
- hardest to match Executor’s current UX quality for source management

### Verdict

Good for lightweight controls and status.
Not the best primary UX for this product.

---

## Option B — Glimpse / native webview window

### Pros

- proven by `pi-diff-review`
- feels integrated with Pi
- easy host↔window messaging
- no localhost server needed

### Cons

- no evidence that it shares the user’s real browser session/password manager
- you would likely need to build a bespoke web app shell
- reusing Executor’s current browser UI is harder than with a real localhost app

### Verdict

Technically viable.
Best if the product goal is “native-feeling Pi sidecar window.”
Not the strongest first choice for auth-heavy source setup.

---

## Option C — Localhost server + real browser tab/window

### Pros

- best fit for password manager + OAuth session reuse
- closest to Executor’s existing UX architecture
- popup auth flows are already source-proven in this model
- easier reuse/adaptation of Executor’s browser patterns

### Cons

- more moving parts: server lifecycle, port, open-browser behavior
- less “all inside Pi” feeling
- if you want exact Executor UI, you likely need vendored/internal code

### Verdict

**Best first implementation path based on the evidence in the repos.**

---

## Option D — Hybrid

This is the option I would recommend.

### Shape

- **Executor SDK lives in-process inside the Pi extension host**
- **real browser localhost UI** is used for source/secrets/auth management
- **Pi TUI widgets/status/commands** give in-terminal awareness and launch controls
- optional **Glimpse** can be added later if you want a more integrated native shell

### Why this wins

It combines:

- the clean embedding story from Pi extensions
- the clean SDK seam from Executor
- the best auth UX from browser flows
- the ability to stay lightweight in Pi itself

---

# 11. Recommended architecture for `pi-executor`

## 11.1 Host/runtime

Inside the Pi extension module, own a singleton-ish runtime object:

- executor instance
- source/plugin configuration
- optional local HTTP server
- optional UI state / active browser session metadata

Back it with:

- project scope = Pi cwd (or configurable)
- persistent executor data under a stable dir
- cleanup on `session_shutdown`

## 11.2 Human-facing UI

### First version

Use a localhost browser UI.

Responsibilities:

- add sources
- inspect sources
- manage secrets
- run OAuth flows
- maybe inspect tool schemas

### Pi-side companion UI

Use Pi for:

- `/executor` or `/executor-ui` command to open the browser UI
- status widget showing connected source count / health
- notifications when sources are added/removed
- maybe a lightweight quick picker for existing sources

## 11.3 Agent-facing tool surface

I would **not** mirror every executor tool into Pi.

I would start with a small fixed Pi tool surface, e.g.:

- `executor_list_sources`
- `executor_search_tools`
- `executor_describe_tool`
- `executor_invoke`

And only later consider a higher-level execution wrapper.

## 11.4 Reuse strategy

### If you want maximum stability

Build on public SDK/plugin packages only and write your own UI/server glue.

### If you want fastest path to good browser UX

Vendor/adapt selected code from:

- `apps/local/src/server/**`
- `packages/react/src/**`
- relevant plugin `src/react/**` add/edit flows

But do it knowingly, because those are not stable public package surfaces.

---

# 12. Key caveats / risks

## 12.1 Executor public/private boundary is messy right now

- package rename churn
- export-map churn
- private packages contain the nicest UI/server code
- README/docs drift exists

## 12.2 Policy enforcement is not really there yet

If approvals/policies are central to your Pi story, plan to own that behavior yourself for now.

## 12.3 Browser UI reuse is source-level reuse, not dependency-level reuse

You can copy/adapt it.
You likely cannot just depend on it cleanly from npm.

## 12.4 Glimpse is proven as a windowing pattern, not as a browser identity/session story

That distinction matters for this project.

## 12.5 Executor’s nicest search/execute abstraction is private today

If you want that experience in Pi, you may need to vendor it or recreate it.

---

# 13. My recommendation

## Recommended product direction

Build `pi-executor` as:

1. **a normal Pi extension package**
2. that **embeds the Executor SDK in-process**
3. and opens a **localhost browser UI** for source/secrets/auth management
4. while exposing a **small fixed Pi tool surface** for the model
5. and using **Pi widgets/status/commands** as the terminal-native control layer

## Why I would not start with Glimpse

Not because Glimpse is bad — `pi-diff-review` proves it works.

I would not start there because the specific user value you called out —

- access to password manager
- OAuth session reuse
- better auth UX

—is already clearly aligned with the **real browser** path in Executor’s own source.

## Why I would not start by mirroring the full executor catalog into Pi tools

Because Pi extensions are good at dynamic tools, but Executor catalogs can get large and noisy.

A lazy search/describe/invoke bridge is a better fit than exploding the entire external API surface into the Pi prompt.

---

# 14. Suggested next design questions before implementation

1. **Public-only vs vendored-internal?**
   - Do we want to depend only on public `@executor-js/*` / `@executor/*` packages?
   - Or are we okay vendoring selected browser/server code from `docs/executor`?

2. **Primary UI target?**
   - Browser-first now, Glimpse later?
   - Or do we want to pay the integration cost to make a native window first?

3. **Pi agent tool surface?**
   - Small fixed bridge tools?
   - Or a vendored version of Executor’s private execution/search package?

4. **Scope model?**
   - One executor scope per Pi cwd?
   - Global shared catalog?
   - Configurable per-project override?

5. **Persistence contract?**
   - Do we want `executor.jsonc` as a portable project artifact?
   - If yes, how do we want to handle Google Discovery asymmetry?

---

# 15. Highest-value files to revisit during implementation

## Pi

- `docs/pi-mono/packages/coding-agent/docs/extensions.md`
- `docs/pi-mono/packages/coding-agent/docs/tui.md`
- `docs/pi-mono/packages/coding-agent/docs/sdk.md`
- `docs/pi-mono/packages/coding-agent/docs/rpc.md`
- `docs/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `docs/pi-mono/packages/coding-agent/src/core/extensions/loader.ts`
- `docs/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts`

## Executor

- `docs/executor/packages/core/sdk/src/executor.ts`
- `docs/executor/packages/core/sdk/src/promise-executor.ts`
- `docs/executor/apps/local/src/server/executor.ts`
- `docs/executor/apps/local/src/server/main.ts`
- `docs/executor/apps/local/src/serve.ts`
- `docs/executor/packages/react/src/plugins/source-plugin.tsx`
- `docs/executor/packages/react/src/pages/sources.tsx`
- `docs/executor/packages/react/src/pages/source-detail.tsx`
- `docs/executor/packages/react/src/pages/secrets.tsx`
- `docs/executor/packages/plugins/openapi/src/react/AddOpenApiSource.tsx`
- `docs/executor/packages/plugins/mcp/src/react/AddMcpSource.tsx`
- `docs/executor/packages/plugins/google-discovery/src/react/AddGoogleDiscoverySource.tsx`
- `docs/executor/packages/plugins/google-discovery/src/api/handlers.ts`
- `docs/executor/packages/plugins/mcp/src/api/handlers.ts`

## Glimpse example

- `docs/pi-diff-review/src/index.ts`
- `docs/pi-diff-review/src/ui.ts`
- `docs/pi-diff-review/src/types.ts`
- `docs/pi-diff-review/src/git.ts`
- `docs/pi-diff-review/web/app.js`

---

## Final conclusion

If the goal is:

> "a built-in executor instance inside Pi using the executor SDK, with the ability to add sources via a UI"

then the strongest architecture from what I read is:

- **Pi extension host + embedded Executor SDK**
- **browser UI for source/auth/secrets management**
- **small Pi-native bridge tools + widgets/commands**
- optional **Glimpse later** if you want a more native windowed shell

That path matches the actual strengths of all three codebases:

- Pi extension system
- Executor SDK/runtime architecture
- pi-diff-review’s proof that external UI from a Pi extension is totally viable
