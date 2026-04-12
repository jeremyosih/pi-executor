import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject, JsonValue } from "./http.ts";

export type ResumeAction = "accept" | "decline" | "cancel";

export type ExecutorElicitationRequest =
  | {
      mode: "form";
      message: string;
      requestedSchema: JsonObject;
    }
  | {
      mode: "url";
      message: string;
      url: string;
      elicitationId: string;
    };

export type ExecutorElicitationResponse = {
  action: ResumeAction;
  content?: JsonObject;
};

export type ExecutorMcpToolMetadata = {
  name: string;
  description?: string;
};

export type ExecutorMcpInspection = {
  instructions?: string;
  tools: ExecutorMcpToolMetadata[];
};

export type ExecutorMcpToolResult = {
  text: string;
  structuredContent: JsonValue;
  isError: boolean;
};

type ExecutorMcpClientOptions = {
  hasUI: boolean;
  onElicitation?: (request: ExecutorElicitationRequest) => Promise<ExecutorElicitationResponse>;
};

type ConnectedExecutorMcpClient = {
  inspect: () => Promise<ExecutorMcpInspection>;
  execute: (code: string) => Promise<ExecutorMcpToolResult>;
  resume: (
    executionId: string,
    action: ResumeAction,
    content?: JsonObject,
  ) => Promise<ExecutorMcpToolResult>;
  close: () => Promise<void>;
};

const DEFAULT_TEXT_RESULT = "(no result)";

const buildCapabilities = (hasUI: boolean): ClientCapabilities =>
  hasUI
    ? {
        elicitation: {
          form: {},
          url: {},
        },
      }
    : {};

const cloneJsonObject = (value: object): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;

const collectText = (content: Array<{ type: string } & Record<string, string>>): string => {
  const textParts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
    }
  }
  return textParts.join("\n").trim();
};

const normalizeToolResult = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): ExecutorMcpToolResult => {
  if (!("content" in result)) {
    return {
      text: JSON.stringify(result.toolResult, null, 2),
      structuredContent: null,
      isError: false,
    };
  }

  const structuredContent = result.structuredContent
    ? cloneJsonObject(result.structuredContent)
    : null;
  const text = collectText(result.content as Array<{ type: string } & Record<string, string>>);

  return {
    text:
      text.length > 0
        ? text
        : structuredContent
          ? JSON.stringify(structuredContent, null, 2)
          : DEFAULT_TEXT_RESULT,
    structuredContent,
    isError: result.isError === true,
  };
};

const connectExecutorMcpClient = async (
  baseUrl: string,
  options: ExecutorMcpClientOptions,
): Promise<ConnectedExecutorMcpClient> => {
  const client = new Client(
    { name: "pi-executor", version: "0.0.1" },
    { capabilities: buildCapabilities(options.hasUI) },
  );
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl));

  const onElicitation = options.onElicitation;
  if (onElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params;
      const response = await onElicitation(
        params.mode === "url"
          ? {
              mode: "url",
              message: params.message,
              url: params.url,
              elicitationId: params.elicitationId,
            }
          : {
              mode: "form",
              message: params.message,
              requestedSchema: cloneJsonObject(params.requestedSchema),
            },
      );

      return response.content
        ? { action: response.action, content: response.content }
        : { action: response.action };
    });
  }

  await client.connect(transport);

  const listTools = async (): Promise<ExecutorMcpToolMetadata[]> => {
    const tools: ExecutorMcpToolMetadata[] = [];
    let cursor: string | undefined;

    do {
      const response = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(
        ...response.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      );
      cursor = response.nextCursor;
    } while (cursor);

    return tools;
  };

  return {
    inspect: async () => ({
      instructions: client.getInstructions(),
      tools: await listTools(),
    }),
    execute: async (code) =>
      normalizeToolResult(
        await client.callTool({
          name: "execute",
          arguments: { code },
        }),
      ),
    resume: async (executionId, action, content) =>
      normalizeToolResult(
        await client.callTool({
          name: "resume",
          arguments: {
            executionId,
            action,
            content: content ? JSON.stringify(content) : "{}",
          },
        }),
      ),
    close: async () => {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
};

export const withExecutorMcpClient = async <T>(
  baseUrl: string,
  options: ExecutorMcpClientOptions,
  callback: (client: ConnectedExecutorMcpClient) => Promise<T>,
): Promise<T> => {
  const client = await connectExecutorMcpClient(baseUrl, options);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
};

export const inspectExecutorMcp = async (
  baseUrl: string,
  hasUI: boolean,
): Promise<ExecutorMcpInspection> =>
  withExecutorMcpClient(baseUrl, { hasUI }, async (client) => client.inspect());
