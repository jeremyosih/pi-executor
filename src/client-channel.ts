import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { ExecutorEndpoint } from "./connection.ts";
import type { JsonObject } from "./http.ts";
import type { ExecutorSettings } from "./settings.ts";

const MAX_FRAME_LENGTH = 65_536;
const MAX_FILE_BYTES = 1_048_576;
const MAX_LIST_ENTRIES = 500;
const RECONNECT_DELAY_MS = 2_000;
const BIND_TIMEOUT_MS = 10_000;
const EXCLUDED_DIRECTORIES = new Set([
  ".aws",
  ".git",
  ".gnupg",
  ".kube",
  ".pi",
  ".secrets",
  ".ssh",
  "node_modules",
]);
const EXCLUDED_FILES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "service-account.json",
]);

type ClientChannelManifest = {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: JsonObject;
  }>;
  resources: Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }>;
  prompts: Array<{
    name: string;
    description: string;
    arguments: Array<{ name: string; description: string; required: boolean }>;
  }>;
};

type ClientChannelRequest = {
  id: string;
  method: string;
  params?: unknown;
};
const MCP_CLIENT_BRIDGE_EVENT = "pi-mcp-adapter:client-bridge:v1";
const requestAdapterBridge = async (
  pi: { events: { emit: (name: string, data: unknown) => void } } | undefined,
  context: unknown,
  operation: "manifest" | "dispatch",
  method?: string,
  params?: Record<string, unknown>,
): Promise<unknown> => {
  if (!pi) throw new Error("MCP adapter bridge is unavailable.");
  const request: {
    version: 1;
    operation: "manifest" | "dispatch";
    context: unknown;
    method?: string;
    params?: Record<string, unknown>;
    result?: Promise<unknown>;
  } = { version: 1, operation, context, method, params };
  pi.events.emit(MCP_CLIENT_BRIDGE_EVENT, request);
  if (!request.result) throw new Error("MCP adapter bridge is unavailable.");
  return request.result;
};

type ChannelProtocol = "cloud" | "self-host";
type OpenedClientChannel = { socket: WebSocket; channelToken: string };

const manifest: ClientChannelManifest = {
  tools: [
    {
      name: "read_workspace_file",
      description: "Read a UTF-8 file inside the Pi workspace (maximum 1 MiB).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "list_workspace_files",
      description: "List workspace files without following symbolic links.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory (default: .)" },
        },
        additionalProperties: false,
      },
    },
  ],
  resources: [
    {
      uri: "workspace://root",
      name: "Workspace file index",
      description: "A bounded list of files in the Pi workspace.",
      mimeType: "text/plain",
    },
  ],
  prompts: [
    {
      name: "workspace_overview",
      description: "Prepare a concise overview of the Pi workspace.",
      arguments: [],
    },
  ],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getToken = (): string => {
  const token = process.env.EXECUTOR_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("Set EXECUTOR_ACCESS_TOKEN to enable the Executor client channel.");
  }
  return token;
};

const isWithinRoot = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
};

const isExcludedPathSegment = (segment: string): boolean => {
  const normalized = segment.toLowerCase();
  return (
    EXCLUDED_DIRECTORIES.has(normalized) ||
    EXCLUDED_FILES.has(normalized) ||
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    /\.(?:pem|key|p12|pfx)$/.test(normalized)
  );
};

const resolveWorkspacePath = async (cwd: string, inputPath: string): Promise<string> => {
  if (isAbsolute(inputPath)) {
    throw new Error("Workspace paths must be relative.");
  }
  const root = await realpath(cwd);
  const target = resolve(root, inputPath);
  if (!isWithinRoot(root, target)) {
    throw new Error("Workspace path is outside the Pi workspace.");
  }

  const segments = relative(root, target).split(sep).filter(Boolean);
  if (segments.some(isExcludedPathSegment)) {
    throw new Error("This workspace path is not available through the Executor client channel.");
  }
  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error("Symbolic links are not available through the Executor client channel.");
    }
  }

  const resolvedTarget = await realpath(target);
  if (!isWithinRoot(root, resolvedTarget)) {
    throw new Error("Workspace path is outside the Pi workspace.");
  }
  return resolvedTarget;
};

export const readWorkspaceFile = async (cwd: string, path: string): Promise<string> => {
  const target = await resolveWorkspacePath(cwd, path);
  const handle = await open(target, "r");
  try {
    const [root, resolvedTarget, openedInfo, pathInfo] = await Promise.all([
      realpath(cwd),
      realpath(target),
      handle.stat(),
      stat(target),
    ]);
    if (
      !isWithinRoot(root, resolvedTarget) ||
      resolvedTarget !== target ||
      openedInfo.dev !== pathInfo.dev ||
      openedInfo.ino !== pathInfo.ino
    ) {
      throw new Error("Workspace path changed while opening the file.");
    }
    if (!openedInfo.isFile()) {
      throw new Error("Workspace path is not a file.");
    }
    if (openedInfo.size > MAX_FILE_BYTES) {
      throw new Error(`Workspace file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
};

export const listWorkspaceFiles = async (cwd: string, path = "."): Promise<string[]> => {
  const root = await realpath(cwd);
  const start = await resolveWorkspacePath(cwd, path);
  const startInfo = await stat(start);
  if (!startInfo.isDirectory()) {
    throw new Error("Workspace path is not a directory.");
  }

  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= MAX_LIST_ENTRIES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_LIST_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!isExcludedPathSegment(entry.name)) {
          await visit(resolve(directory, entry.name), depth + 1);
        }
      } else if (entry.isFile() && !isExcludedPathSegment(entry.name)) {
        files.push(relative(root, resolve(directory, entry.name)).split(sep).join("/"));
      }
    }
  };

  await visit(start, 0);
  return files.sort();
};

const parseRequest = (value: unknown): ClientChannelRequest | undefined => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
    return undefined;
  }
  return { id: value.id, method: value.method, params: value.params };
};

const readParams = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("Request params must be an object.");
  return value;
};

const dispatchRequest = async (
  cwd: string,
  request: ClientChannelRequest,
  pi?: { events: { emit: (name: string, data: unknown) => void } },
  context?: unknown,
): Promise<unknown> => {
  const params = readParams(request.params);
  if (
    (request.method === "tools/call" &&
      typeof params.name === "string" &&
      params.name.startsWith("mcp1:")) ||
    (request.method === "resources/read" &&
      typeof params.uri === "string" &&
      params.uri.startsWith("mcp1:")) ||
    (request.method === "prompts/get" &&
      typeof params.name === "string" &&
      params.name.startsWith("mcp1:"))
  )
    return requestAdapterBridge(pi, context, "dispatch", request.method, params);
  switch (request.method) {
    case "tools/call": {
      if (typeof params.name !== "string") throw new Error("Tool name is required.");
      if (params.name === "read_workspace_file") {
        const args = readParams(params.arguments);
        if (typeof args.path !== "string")
          throw new Error("A workspace-relative path is required.");
        const text = await readWorkspaceFile(cwd, args.path);
        return { content: [{ type: "text", text }], isError: false };
      }
      if (params.name === "list_workspace_files") {
        const args = isRecord(params.arguments) ? params.arguments : {};
        if (args.path !== undefined && typeof args.path !== "string") {
          throw new Error("The directory path must be a string.");
        }
        const files = await listWorkspaceFiles(
          cwd,
          typeof args.path === "string" ? args.path : undefined,
        );
        return { content: [{ type: "text", text: files.join("\n") }], isError: false };
      }
      throw new Error("Unknown client-channel tool.");
    }
    case "resources/read": {
      if (params.uri !== "workspace://root") throw new Error("Unknown client-channel resource.");
      const files = await listWorkspaceFiles(cwd);
      return {
        contents: [{ uri: "workspace://root", mimeType: "text/plain", text: files.join("\n") }],
      };
    }
    case "prompts/get": {
      if (params.name !== "workspace_overview") throw new Error("Unknown client-channel prompt.");
      const files = await listWorkspaceFiles(cwd);
      return {
        description: "Workspace overview prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Review this workspace and provide a concise overview. Files:\n${files.join("\n")}`,
            },
          },
        ],
      };
    }
    default:
      throw new Error(`Unsupported client-channel method: ${request.method}`);
  }
};

const toWebSocketUrl = (url: string): string => {
  const parsed = new URL(url);
  assertSecureUrl(parsed);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
};

const assertSecureUrl = (url: URL): void => {
  if (!["https:", "wss:", "http:", "ws:"].includes(url.protocol)) {
    throw new Error("The Executor client channel URL must use HTTPS/WSS.");
  }
  if (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  ) {
    throw new Error("The Executor client channel requires HTTPS/WSS outside localhost.");
  }
};

const rawDataToText = (raw: WebSocket.RawData): string => {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(raw).toString("utf8");
};

const registerCloudChannel = async (
  baseUrl: string,
  token: string,
  activeManifest: ClientChannelManifest = manifest,
): Promise<{ websocket: string; channelToken: string }> => {
  const registrationUrl = new URL("/mcp/client-channel", baseUrl);
  assertSecureUrl(registrationUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BIND_TIMEOUT_MS);
  const response = await fetch(registrationUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ manifest: activeManifest }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) {
    throw new Error(`Executor client-channel registration failed (HTTP ${response.status}).`);
  }
  const registration: unknown = await response.json();
  if (
    !isRecord(registration) ||
    typeof registration.websocket !== "string" ||
    typeof registration.token !== "string"
  ) {
    throw new Error("Executor returned an invalid client-channel registration.");
  }
  const registeredUrl = new URL(registration.websocket);
  const configuredUrl = new URL(baseUrl);
  assertSecureUrl(registeredUrl);
  const expectedProtocol =
    configuredUrl.protocol === "https:" || configuredUrl.protocol === "wss:" ? "wss:" : "ws:";
  const registeredProtocol =
    registeredUrl.protocol === "https:" || registeredUrl.protocol === "wss:" ? "wss:" : "ws:";
  if (
    registeredProtocol !== expectedProtocol ||
    registeredUrl.origin.replace(/^ws/, "http") !== configuredUrl.origin.replace(/^ws/, "http")
  ) {
    throw new Error("Executor returned a client-channel URL outside the configured origin.");
  }
  return { websocket: registration.websocket, channelToken: registration.token };
};

const openClientChannel = async (
  cwd: string,
  baseUrl: string,
  protocol: ChannelProtocol,
  accessToken: string,
  activeManifest: ClientChannelManifest = manifest,
  pi?: { events: { emit: (name: string, data: unknown) => void } },
  context?: unknown,
): Promise<OpenedClientChannel> => {
  const registration =
    protocol === "cloud"
      ? await registerCloudChannel(baseUrl, accessToken, activeManifest)
      : undefined;
  let channelToken = registration?.channelToken;
  const websocketUrl =
    registration?.websocket ?? new URL("/api/mcp/client-channel", baseUrl).toString();
  const socket = new WebSocket(toWebSocketUrl(websocketUrl), {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(registration ? { "x-executor-client-token": registration.channelToken } : {}),
    },
    handshakeTimeout: BIND_TIMEOUT_MS,
  });

  try {
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", rejectOpen);
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }
  socket.on("error", () => socket.terminate());

  if (protocol === "self-host") {
    try {
      await new Promise<void>((resolveBound, rejectBound) => {
        const timeout = setTimeout(
          () => rejectBound(new Error("Executor client-channel bind timed out.")),
          BIND_TIMEOUT_MS,
        );
        const onMessage = (raw: WebSocket.RawData) => {
          const body = rawDataToText(raw);
          if (body.length > MAX_FRAME_LENGTH) {
            clearTimeout(timeout);
            rejectBound(new Error("Executor client-channel frame is too large."));
            return;
          }
          let frame: unknown;
          try {
            frame = JSON.parse(body);
          } catch {
            return;
          }
          if (!isRecord(frame)) return;
          if (frame.type === "bound" && typeof frame.bindingToken === "string") {
            channelToken = frame.bindingToken;
            clearTimeout(timeout);
            socket.off("message", onMessage);
            resolveBound();
          } else if (frame.type === "error") {
            clearTimeout(timeout);
            socket.off("message", onMessage);
            rejectBound(new Error("Executor rejected the client-channel manifest."));
          }
        };
        socket.on("message", onMessage);
        socket.once("close", () => {
          clearTimeout(timeout);
          rejectBound(new Error("Executor closed the client channel before binding."));
        });
        socket.send(JSON.stringify({ type: "initialize", manifest: activeManifest }));
      });
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }

  socket.on("message", (raw: WebSocket.RawData) => {
    const body = rawDataToText(raw);
    if (body.length > MAX_FRAME_LENGTH) {
      socket.close(1009, "Message too large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      socket.close(1008, "Invalid JSON");
      return;
    }
    const request = parseRequest(parsed);
    if (!request) {
      socket.close(1008, "Invalid request");
      return;
    }

    const sendResponse = (frame: unknown): void => {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      } catch {
        socket.terminate();
      }
    };
    void dispatchRequest(cwd, request, pi, context).then(
      (result) => sendResponse({ id: request.id, result }),
      (error: unknown) => {
        const nodeErrorCode =
          isRecord(error) && typeof error.code === "string" ? error.code : undefined;
        sendResponse({
          id: request.id,
          error: {
            message:
              nodeErrorCode === undefined && error instanceof Error
                ? error.message
                : "Workspace operation failed.",
          },
        });
      },
    );
  });
  if (!channelToken) {
    socket.terminate();
    throw new Error("Executor did not provide a client-channel binding token.");
  }
  return { socket, channelToken };
};

const resolveProtocol = (
  setting: ExecutorSettings["clientChannelProtocol"],
  endpoint: ExecutorEndpoint,
): ChannelProtocol =>
  setting === "auto" ? (endpoint.mode === "local" ? "self-host" : "cloud") : setting;

export type ClientChannelController = {
  stop: () => Promise<void>;
  waitForBinding: () => Promise<string | undefined>;
};

const channelBindings = new Map<string, () => Promise<string | undefined>>();

export const getExecutorClientChannelToken = (cwd: string): Promise<string | undefined> =>
  channelBindings.get(cwd)?.() ?? Promise.resolve(undefined);

export const startExecutorClientChannel = (
  cwd: string,
  endpoint: ExecutorEndpoint,
  settings: ExecutorSettings,
  onState?: (state: "connected" | "disconnected" | "error", message?: string) => void,
  pi?: { events: { emit: (name: string, data: unknown) => void } },
  context?: unknown,
): ClientChannelController => {
  const accessToken = getToken();
  const protocol = resolveProtocol(settings.clientChannelProtocol, endpoint);
  assertSecureUrl(new URL(endpoint.baseUrl));
  let stopped = false;
  let activeSocket: WebSocket | undefined;
  let reconnectDelayController: AbortController | undefined;
  let bindingToken: string | undefined;
  const bindingWaiters = new Set<(token: string | undefined) => void>();

  const publishBinding = (token: string | undefined): void => {
    bindingToken = token;
    if (token !== undefined || stopped) {
      for (const waiter of bindingWaiters) waiter(token);
      bindingWaiters.clear();
    }
  };

  const waitForBinding = (): Promise<string | undefined> => {
    if (bindingToken !== undefined || stopped) return Promise.resolve(bindingToken);
    return new Promise((resolveBinding, rejectBinding) => {
      let timeout: ReturnType<typeof setTimeout>;
      const waiter = (token: string | undefined): void => {
        clearTimeout(timeout);
        bindingWaiters.delete(waiter);
        resolveBinding(token);
      };
      timeout = setTimeout(() => {
        bindingWaiters.delete(waiter);
        rejectBinding(new Error("Executor client channel did not bind before the timeout."));
      }, BIND_TIMEOUT_MS);
      bindingWaiters.add(waiter);
    });
  };

  const run = async (): Promise<void> => {
    let adapterManifest: Partial<ClientChannelManifest> = {};
    if (settings.clientChannelEnabled && pi) {
      try {
        adapterManifest = (await requestAdapterBridge(
          pi,
          context,
          "manifest",
        )) as ClientChannelManifest;
      } catch {
        /* Adapter may be absent; workspace capabilities remain available. */
      }
    }
    const activeManifest = {
      tools: [...manifest.tools, ...(adapterManifest.tools ?? [])],
      resources: [...manifest.resources, ...(adapterManifest.resources ?? [])],
      prompts: [...manifest.prompts, ...(adapterManifest.prompts ?? [])],
    };
    while (!stopped) {
      try {
        const connection = await openClientChannel(
          cwd,
          endpoint.baseUrl,
          protocol,
          accessToken,
          activeManifest,
          pi,
          context,
        );
        activeSocket = connection.socket;
        publishBinding(connection.channelToken);
        onState?.("connected");
        await new Promise<void>((resolveClose) => activeSocket?.once("close", resolveClose));
        activeSocket = undefined;
        publishBinding(undefined);
        if (!stopped) onState?.("disconnected");
      } catch (error) {
        activeSocket?.terminate();
        activeSocket = undefined;
        publishBinding(undefined);
        if (!stopped) {
          onState?.(
            "error",
            error instanceof Error ? error.message : "Executor client-channel connection failed.",
          );
        }
      }
      if (!stopped) {
        reconnectDelayController = new AbortController();
        await delay(RECONNECT_DELAY_MS, undefined, {
          signal: reconnectDelayController.signal,
        }).catch(() => undefined);
        reconnectDelayController = undefined;
      }
    }
  };

  const task = run();
  const controller: ClientChannelController = {
    waitForBinding,
    stop: async () => {
      stopped = true;
      reconnectDelayController?.abort();
      publishBinding(undefined);
      activeSocket?.close(1000, "Pi session ended");
      await task;
      if (channelBindings.get(cwd) === waitForBinding) channelBindings.delete(cwd);
    },
  };
  channelBindings.set(cwd, waitForBinding);
  return controller;
};
