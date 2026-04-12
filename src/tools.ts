import { StringEnum, Type, type Static } from "@mariozechner/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { JsonObject, JsonValue } from "./http.ts";
import type { ResumeAction } from "./mcp-client.ts";
import { withExecutorMcpClient } from "./mcp-client.ts";
import {
  buildExecutorSystemPrompt,
  parseJsonContent,
  toToolResult,
  type ExecuteToolDetails,
  type ExecuteToolResult,
} from "./executor-adapter.ts";
import { resolveExecutorEndpoint } from "./connection.ts";
import { resolveExecutorSettings } from "./settings.ts";
import { renderExecutorStatus, setExecutorState } from "./status.ts";

const DEFAULT_EXECUTE_DESCRIPTION =
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.";

const DEFAULT_RESUME_DESCRIPTION = [
  "Resume a paused execution using the executionId returned by execute.",
  "Never call this without user approval unless they explicitly state otherwise.",
].join("\n");

const jsonStringSchema = Type.String({ description: "Optional JSON-encoded response content" });

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasSchemaProperties = (schema: JsonObject | undefined): boolean => {
  if (!schema) {
    return false;
  }

  const properties = schema.properties;
  return isJsonObject(properties) && Object.keys(properties).length > 0;
};

const buildSchemaTemplate = (schema: JsonObject | undefined): JsonObject => {
  if (!schema) {
    return {};
  }

  const properties = schema.properties;
  if (!isJsonObject(properties)) {
    return {};
  }

  const template: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonObject(value)) {
      continue;
    }

    switch (value.type) {
      case "boolean":
        template[key] = false;
        break;
      case "number":
      case "integer":
        template[key] = 0;
        break;
      case "array":
        template[key] = [];
        break;
      case "object":
        template[key] = {};
        break;
      default:
        template[key] = "";
        break;
    }
  }

  return template;
};

const launchBrowser = async (url: string): Promise<void> => {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  const launcher =
    platform === "darwin"
      ? { command: "open", args: [url] }
      : platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(launcher.command, launcher.args, {
      stdio: "ignore",
      detached: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
};

const promptForInteraction = async (
  interaction: {
    mode: "form" | "url";
    message: string;
    requestedSchema?: JsonObject;
    url?: string;
  },
  ctx: ExtensionContext,
): Promise<{ action: ResumeAction; content?: JsonObject }> => {
  if (interaction.mode === "url" && interaction.url) {
    try {
      await launchBrowser(interaction.url);
      ctx.ui.notify(`Opened ${interaction.url}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Open this URL manually: ${interaction.url}\n\n${message}`, "warning");
    }

    const action = await ctx.ui.select(
      "Executor browser interaction",
      ["accept", "decline", "cancel"],
      { timeout: undefined },
    );
    return { action: (action as ResumeAction | undefined) ?? "cancel" };
  }

  if (!hasSchemaProperties(interaction.requestedSchema)) {
    const action = await ctx.ui.select("Executor interaction", ["accept", "decline", "cancel"], {
      timeout: undefined,
    });
    return { action: (action as ResumeAction | undefined) ?? "cancel" };
  }

  ctx.ui.notify(interaction.message, "info");
  const prefill = JSON.stringify(buildSchemaTemplate(interaction.requestedSchema), null, 2);
  const edited = await ctx.ui.editor("Executor response JSON", prefill);
  if (edited === undefined) {
    return { action: "cancel" };
  }

  const action = await ctx.ui.select("Submit Executor response", ["accept", "decline", "cancel"], {
    timeout: undefined,
  });
  const resolvedAction = (action as ResumeAction | undefined) ?? "cancel";
  if (resolvedAction !== "accept") {
    return { action: resolvedAction };
  }

  return {
    action: resolvedAction,
    content: parseJsonContent(edited),
  };
};

const connectExecutor = async (ctx: ExtensionContext) => {
  const settings = await resolveExecutorSettings(ctx.cwd);
  setExecutorState(ctx.cwd, { kind: "connecting", mode: settings.mode });
  renderExecutorStatus(ctx, settings, ctx.cwd);

  try {
    const endpoint = await resolveExecutorEndpoint(ctx.cwd);
    setExecutorState(ctx.cwd, {
      kind: "ready",
      mode: endpoint.mode,
      baseUrl: endpoint.baseUrl,
    });
    renderExecutorStatus(ctx, settings, ctx.cwd);
    return endpoint;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setExecutorState(ctx.cwd, { kind: "error", message });
    renderExecutorStatus(ctx, settings, ctx.cwd);
    throw error;
  }
};

const buildExecuteTool = () =>
  defineTool({
    name: "execute",
    label: "Execute",
    description: DEFAULT_EXECUTE_DESCRIPTION,
    promptSnippet: "Execute TypeScript in Executor's sandboxed runtime with configured API tools.",
    promptGuidelines: [
      "Search inside execute before calling Executor tools directly in code.",
      "Use execute instead of top-level helper tools for Executor discovery and invocation.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript code to execute" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const endpoint = await connectExecutor(ctx);

      const outcome = await withExecutorMcpClient(
        endpoint.baseUrl,
        {
          hasUI: ctx.hasUI,
          onElicitation: ctx.hasUI
            ? (interaction) =>
                promptForInteraction(
                  interaction.mode === "url"
                    ? {
                        mode: "url",
                        message: interaction.message,
                        url: interaction.url,
                      }
                    : {
                        mode: "form",
                        message: interaction.message,
                        requestedSchema: interaction.requestedSchema,
                      },
                  ctx,
                )
            : undefined,
        },
        async (client) => client.execute(params.code),
      );

      return toToolResult(outcome, { baseUrl: endpoint.baseUrl, scopeId: endpoint.scope.id });
    },
  });

const buildResumeTool = () =>
  defineTool({
    name: "resume",
    label: "Resume",
    description: DEFAULT_RESUME_DESCRIPTION,
    promptSnippet:
      "Resume a paused Executor execution after the user has completed the required interaction.",
    promptGuidelines: ["Use the exact executionId returned by execute."],
    parameters: Type.Object({
      executionId: Type.String({ description: "The execution ID from the paused result" }),
      action: StringEnum(["accept", "decline", "cancel"] as const),
      content: Type.Optional(jsonStringSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const endpoint = await connectExecutor(ctx);

      const outcome = await withExecutorMcpClient(
        endpoint.baseUrl,
        { hasUI: false },
        async (client) =>
          client.resume(
            params.executionId,
            params.action as ResumeAction,
            parseJsonContent(params.content),
          ),
      );

      return toToolResult(outcome, {
        baseUrl: endpoint.baseUrl,
        scopeId: endpoint.scope.id,
      });
    },
  });

export const loadExecutorPrompt = async (_cwd: string, hasUI: boolean): Promise<string> =>
  buildExecutorSystemPrompt(DEFAULT_EXECUTE_DESCRIPTION, !hasUI);

export const isExecutorToolDetails = (value: object | null): value is ExecuteToolDetails => {
  if (!value || !("baseUrl" in value) || !("scopeId" in value) || !("isError" in value)) {
    return false;
  }

  return (
    typeof value.baseUrl === "string" &&
    typeof value.scopeId === "string" &&
    typeof value.isError === "boolean"
  );
};

export const createExecutorTools = async (
  _cwd: string,
  hasUI: boolean,
): Promise<ToolDefinition[]> => (hasUI ? [buildExecuteTool()] : [buildExecuteTool(), buildResumeTool()]);

export const registerExecutorTools = async (
  pi: ExtensionAPI,
  cwd: string,
  hasUI: boolean,
): Promise<void> => {
  for (const tool of await createExecutorTools(cwd, hasUI)) {
    pi.registerTool(tool);
  }
};

export type ExecuteToolInput = Static<ReturnType<typeof buildExecuteTool>["parameters"]>;
export type ResumeToolInput = Static<ReturnType<typeof buildResumeTool>["parameters"]>;
