declare module "@mariozechner/pi-coding-agent" {
	import type { Static, TSchema } from "@sinclair/typebox";

	export interface AgentToolResult<TDetails = object> {
		content: Array<{ type: "text"; text: string }>;
		details: TDetails;
	}

	export interface ContextUsage {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	}

	export interface CompactOptions {
		customInstructions?: string;
		onComplete?: () => void;
		onError?: (error: Error) => void;
	}

	export interface ExtensionUIContext {
		select(title: string, options: string[], opts?: object): Promise<string | undefined>;
		confirm(title: string, message: string, opts?: object): Promise<boolean>;
		input(title: string, placeholder?: string, opts?: object): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
		setStatus(key: string, text: string | undefined): void;
		setWorkingMessage(message?: string): void;
		setHiddenThinkingLabel(label?: string): void;
		setWidget(key: string, content: string[] | undefined, options?: object): void;
		setFooter(factory: object | undefined): void;
		setHeader(factory: object | undefined): void;
		setTitle(title: string): void;
		custom<T>(factory: object, options?: object): Promise<T>;
		pasteToEditor(text: string): void;
		setEditorText(text: string): void;
		getEditorText(): string;
		editor: object;
	}

	export type SessionEntry =
		| {
				type: "custom";
				customType: string;
				data?: object;
		  }
		| {
				type: string;
		  };

	export interface ReadonlySessionManager {
		getCwd(): string;
		getSessionDir(): string;
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getLeafId(): string | undefined;
		getLeafEntry(): SessionEntry | undefined;
		getEntry(id: string): SessionEntry | undefined;
		getLabel(id: string): string | undefined;
		getBranch(fromId?: string): SessionEntry[];
		getHeader(): { type: "session"; cwd: string; id: string; timestamp: string };
		getEntries(): SessionEntry[];
		getTree(): object[];
		getSessionName(): string | undefined;
	}

	export interface ExtensionContext {
		ui: ExtensionUIContext;
		hasUI: boolean;
		cwd: string;
		sessionManager: ReadonlySessionManager;
		modelRegistry: {
			getApiKey(provider: string): string | undefined;
		};
		model: object | undefined;
		isIdle(): boolean;
		signal: AbortSignal | undefined;
		abort(): void;
		hasPendingMessages(): boolean;
		shutdown(): void;
		getContextUsage(): ContextUsage | undefined;
		compact(options?: CompactOptions): void;
		getSystemPrompt(): string;
	}

	export interface ExtensionCommandContext extends ExtensionContext {}

	export interface RegisteredCommand {
		description?: string;
		handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
	}

	export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = object> {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: TParams;
		execute(
			toolCallId: string,
			params: Static<TParams>,
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<TDetails>>;
	}

	export interface ExtensionAPI {
		registerCommand(name: string, options: RegisteredCommand): void;
		registerTool<TParams extends TSchema = TSchema, TDetails = object>(tool: ToolDefinition<TParams, TDetails>): void;
		appendEntry<TEntryData>(customType: string, data?: TEntryData): void;
		on(
			event: "session_start" | "session_switch" | "session_fork" | "session_shutdown",
			handler: (_event: { type: string }, ctx: ExtensionContext) => void | Promise<void>,
		): void;
	}
}
