import { StringEnum, Type, type Static } from "@mariozechner/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { execute, resume, type JsonObject, type JsonValue, type ResumeAction } from "./http.ts";
import {
  buildExecutorSystemPrompt,
  loadExecuteDescription,
  normalizeExecuteResponse,
  normalizeResumeNotFound,
  normalizeResumeResponse,
  parseJsonContent,
  runManagedExecution,
  toToolResult,
  type ExecuteToolDetails,
  type ExecuteToolResult,
  type WaitingForInteraction,
} from "./executor-adapter.ts";
import { ensureSidecar } from "./sidecar.ts";

const DEFAULT_EXECUTE_DESCRIPTION =
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.";

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
  interaction: WaitingForInteraction,
  ctx: ExtensionContext,
): Promise<{ action: ResumeAction; content?: JsonObject }> => {
  if (interaction.kind === "url" && interaction.url) {
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

  const requestedSchema = interaction.requestedSchema;
  if (!hasSchemaProperties(requestedSchema)) {
    const action = await ctx.ui.select("Executor interaction", ["accept", "decline", "cancel"], {
      timeout: undefined,
    });
    return { action: (action as ResumeAction | undefined) ?? "cancel" };
  }

  ctx.ui.notify(interaction.message, "info");
  const prefill = JSON.stringify(buildSchemaTemplate(requestedSchema), null, 2);
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

const buildExecuteTool = (description: string) =>
  defineTool({
    name: "execute",
    label: "Execute",
    description,
    promptSnippet: "Execute TypeScript in Executor's sandboxed runtime with configured API tools.",
    promptGuidelines: [
      "Search inside execute before calling Executor tools directly in code.",
      "Use execute instead of top-level helper tools for Executor discovery and invocation.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript code to execute" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const sidecar = await ensureSidecar(ctx.cwd);
      const scopeId = sidecar.scope?.id;
      if (!scopeId) {
        throw new Error(`Executor sidecar scope id missing for ${ctx.cwd}`);
      }

      if (ctx.hasUI) {
        const outcome = await runManagedExecution(
          {
            execute: (code) => execute(sidecar.baseUrl, code),
            resume: (executionId, payload) => resume(sidecar.baseUrl, executionId, payload),
          },
          params.code,
          async (interaction) => promptForInteraction(interaction, ctx),
        );

        return toToolResult(outcome, { baseUrl: sidecar.baseUrl, scopeId });
      }

      return toToolResult(normalizeExecuteResponse(await execute(sidecar.baseUrl, params.code)), {
        baseUrl: sidecar.baseUrl,
        scopeId,
      });
    },
  });

const buildResumeTool = () =>
  defineTool({
    name: "resume",
    label: "Resume",
    description: [
      "Resume a paused execution using the executionId returned by execute.",
      "Never call this without user approval unless they explicitly state otherwise.",
    ].join("\n"),
    promptSnippet:
      "Resume a paused Executor execution after the user has completed the required interaction.",
    promptGuidelines: ["Use the exact executionId returned by execute."],
    parameters: Type.Object({
      executionId: Type.String({ description: "The execution ID from the paused result" }),
      action: StringEnum(["accept", "decline", "cancel"] as const),
      content: Type.Optional(jsonStringSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ExecuteToolResult> {
      const sidecar = await ensureSidecar(ctx.cwd);
      const scopeId = sidecar.scope?.id ?? "";

      try {
        const result = await resume(sidecar.baseUrl, params.executionId, {
          action: params.action as ResumeAction,
          content: parseJsonContent(params.content),
        });

        return toToolResult(normalizeResumeResponse(result), {
          baseUrl: sidecar.baseUrl,
          scopeId,
        });
      } catch (error) {
        const normalized =
          error instanceof Error ? normalizeResumeNotFound(error, params.executionId) : undefined;
        if (normalized) {
          return {
            ...normalized,
            details: {
              ...normalized.details,
              scopeId,
            },
          };
        }
        throw error;
      }
    },
  });

export const getToolNamesForSession = (hasUI: boolean): string[] =>
  hasUI ? ["execute"] : ["execute", "resume"];

export const loadExecutorPrompt = async (cwd: string, hasUI: boolean): Promise<string> => {
  const sidecar = await ensureSidecar(cwd);
  const scopeId = sidecar.scope?.id;
  if (!scopeId) {
    return buildExecutorSystemPrompt(DEFAULT_EXECUTE_DESCRIPTION, hasUI);
  }

  try {
    const description = await loadExecuteDescription(sidecar.baseUrl, scopeId);
    return buildExecutorSystemPrompt(description, hasUI);
  } catch {
    return buildExecutorSystemPrompt(DEFAULT_EXECUTE_DESCRIPTION, hasUI);
  }
};

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
  cwd: string,
  hasUI: boolean,
): Promise<ToolDefinition[]> => {
  const sidecar = await ensureSidecar(cwd);
  const scopeId = sidecar.scope?.id;
  const description = scopeId
    ? await loadExecuteDescription(sidecar.baseUrl, scopeId).catch(
        () => DEFAULT_EXECUTE_DESCRIPTION,
      )
    : DEFAULT_EXECUTE_DESCRIPTION;

  return hasUI
    ? [buildExecuteTool(description)]
    : [buildExecuteTool(description), buildResumeTool()];
};

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
