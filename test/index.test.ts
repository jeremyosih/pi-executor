import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { createPiExecutorExtension, type PiExecutorServices } from "../src/index.js";
import type { ExecutionEnvelope, ExecutorInstance, LocalInstallation, PiExecutorSessionState, ResolvedPiExecutorConfig } from "../src/types.js";

class FakeUI implements ExtensionUIContext {
	readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	readonly statuses = new Map<string, string | undefined>();
	readonly editor = {};

	notify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === undefined) {
			this.notifications.push({ message });
			return;
		}
		this.notifications.push({ message, type });
	}

	setStatus(key: string, text: string | undefined): void {
		this.statuses.set(key, text);
	}

	confirm(): Promise<boolean> {
		return Promise.resolve(false);
	}

	custom(): Promise<never> {
		return Promise.reject(new Error("not implemented"));
	}

	input(): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}

	onTerminalInput(): () => void {
		return () => {};
	}

	select(): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}

	setFooter(): void {}
	setHeader(): void {}
	setHiddenThinkingLabel(): void {}
	setTitle(): void {}
	setWidget(): void {}
	setWorkingMessage(): void {}
	pasteToEditor(): void {}
	setEditorText(): void {}
	getEditorText(): string {
		return "";
	}
}

class FakeSessionManager {
	constructor(private readonly entries: Array<{ type: "custom"; customType: string; data?: PiExecutorSessionState } | { type: string }>) {}

	getBranch(): Array<{ type: "custom"; customType: string; data?: PiExecutorSessionState } | { type: string }> {
		return this.entries;
	}

	getCwd(): string {
		return "/workspace";
	}

	getEntries(): Array<{ type: "custom"; customType: string; data?: PiExecutorSessionState } | { type: string }> {
		return this.entries;
	}

	getEntry(): undefined {
		return undefined;
	}

	getHeader(): { cwd: string; id: string; timestamp: string; type: "session" } {
		return {
			type: "session",
			cwd: "/workspace",
			id: "session-1",
			timestamp: new Date(0).toISOString(),
		};
	}

	getLabel(): undefined {
		return undefined;
	}

	getLeafEntry(): undefined {
		return undefined;
	}

	getLeafId(): undefined {
		return undefined;
	}

	getSessionDir(): string {
		return "/workspace/.pi/sessions";
	}

	getSessionFile(): string {
		return "/workspace/.pi/sessions/session.jsonl";
	}

	getSessionId(): string {
		return "session-1";
	}

	getSessionName(): undefined {
		return undefined;
	}

	getTree(): [] {
		return [];
	}
}

class FakePi {
	readonly commands = new Map<string, { description?: string; handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	readonly tools = new Map<string, RegisteredToolRecord>();
	readonly handlers = new Map<string, Array<(_event: { type: string }, ctx: ExtensionContext) => void | Promise<void>>>();
	readonly appended: Array<{ customType: string; data?: PiExecutorSessionState }> = [];

	registerCommand(name: string, command: { description?: string; handler(args: string, ctx: ExtensionContext): Promise<void> }): void {
		this.commands.set(name, command);
	}

	registerTool(tool: RegisteredToolRecord): void {
		this.tools.set(tool.name, tool);
	}

	appendEntry(customType: string, data?: PiExecutorSessionState): void {
		if (data === undefined) {
			this.appended.push({ customType });
			return;
		}
		this.appended.push({ customType, data });
	}

	on(event: "session_start" | "session_switch" | "session_fork" | "session_shutdown", handler: (_event: { type: string }, ctx: ExtensionContext) => void | Promise<void>): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	async trigger(event: "session_start" | "session_switch" | "session_fork" | "session_shutdown", ctx: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler({ type: event }, ctx);
		}
	}
}

type RegisteredToolRecord = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, string | undefined>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details: {
			status: string;
			interaction: { requestedSchema?: object | null } | null;
			nextAction: { kind: string };
		};
	}>;
};

const config: ResolvedPiExecutorConfig = {
	executorCommand: "executor",
	startupTimeoutMs: 30_000,
	loginPath: "/sources/add",
	autoProbeOnSessionStart: true,
};

const instance: ExecutorInstance = {
	instanceId: "instance-1",
	cwdRealpath: "/workspace",
	port: 8788,
	baseUrl: "http://127.0.0.1:8788",
	localDataDir: "/workspace/.executor",
	pidFile: "/workspace/server.pid",
	logFile: "/workspace/server.log",
};

const installation: LocalInstallation = {
	scopeId: "workspace-1",
	actorScopeId: "actor-1",
	resolutionScopeIds: ["workspace-1"],
};

const completedEnvelope = (): ExecutionEnvelope => ({
	execution: {
		id: "exec-1",
		scopeId: "workspace-1",
		createdByScopeId: "workspace-1",
		status: "completed",
		code: "return 1",
		resultJson: "{\"ok\":true}",
		errorText: null,
		logsJson: null,
		startedAt: 1,
		completedAt: 2,
		createdAt: 1,
		updatedAt: 2,
	},
	pendingInteraction: null,
});

const waitingFormEnvelope = (): ExecutionEnvelope => ({
	...completedEnvelope(),
	execution: {
		...completedEnvelope().execution,
		status: "waiting_for_interaction",
		resultJson: null,
		completedAt: null,
	},
	pendingInteraction: {
		id: "interaction-form",
		executionId: "exec-1",
		status: "pending",
		kind: "form",
		purpose: "tool_execution_gate",
		payloadJson: JSON.stringify({
			elicitation: {
				message: "Need confirmation",
				mode: "form",
				requestedSchema: {
					type: "object",
					properties: {
						approved: {
							type: "boolean",
						},
					},
					required: ["approved"],
				},
			},
		}),
		responseJson: null,
		responsePrivateJson: null,
		createdAt: 1,
		updatedAt: 2,
	},
});

const waitingUrlEnvelope = (): ExecutionEnvelope => ({
	...waitingFormEnvelope(),
	pendingInteraction: {
		...waitingFormEnvelope().pendingInteraction!,
		id: "interaction-url",
		kind: "url",
		payloadJson: JSON.stringify({
			elicitation: {
				message: "Approve browser login",
				mode: "url",
				url: "https://example.com/approve",
			},
		}),
	},
});

const createContext = (entries: Array<{ type: "custom"; customType: string; data?: PiExecutorSessionState } | { type: string }> = []): {
	ctx: ExtensionContext;
	ui: FakeUI;
} => {
	const ui = new FakeUI();
	return {
		ctx: {
			cwd: "/workspace",
			sessionManager: new FakeSessionManager(entries),
			ui,
			hasUI: true,
			modelRegistry: { getApiKey: () => undefined },
			model: undefined,
			isIdle: () => true,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		} as ExtensionContext,
		ui,
	};
};

const createServices = (overrides?: Partial<PiExecutorServices>): PiExecutorServices => ({
	loadConfig: async () => config,
	resolveExecutorInstance: async () => instance,
	ensureExecutorRunning: async () => instance,
	isReachable: async () => true,
	openBrowser: async () => {},
	getInstallation: async () => installation,
	createExecution: async () => completedEnvelope(),
	getExecution: async () => completedEnvelope(),
	resumeExecution: async () => completedEnvelope(),
	pollExecution: async (_baseUrl, _workspaceId, _executionId, options) => options?.initialEnvelope ?? completedEnvelope(),
	...overrides,
});

test("extension registers commands and tools", () => {
	const pi = new FakePi();
	createPiExecutorExtension(createServices())(pi as ExtensionAPI);

	assert.deepEqual([...pi.commands.keys()].sort(), ["executor-login", "executor-status", "executor-web"]);
	assert.deepEqual([...pi.tools.keys()].sort(), ["executor_execute", "executor_resume"]);
});

test("/executor-web opens the workspace-local base URL", async () => {
	const opened: string[] = [];
	const pi = new FakePi();
	createPiExecutorExtension(createServices({ openBrowser: async (url) => void opened.push(url) }))(pi as ExtensionAPI);
	const { ctx, ui } = createContext();

	await pi.commands.get("executor-web")!.handler("", ctx);

	assert.deepEqual(opened, ["http://127.0.0.1:8788"]);
	assert.match(ui.notifications[0]?.message ?? "", /Executor is ready/);
});

test("/executor-login opens the configured login path", async () => {
	const opened: string[] = [];
	const pi = new FakePi();
	createPiExecutorExtension(createServices({ openBrowser: async (url) => void opened.push(url) }))(pi as ExtensionAPI);
	const { ctx } = createContext();

	await pi.commands.get("executor-login")!.handler("", ctx);

	assert.deepEqual(opened, ["http://127.0.0.1:8788/sources/add"]);
});

test("/executor-status reports online and offline states", async () => {
	const onlinePi = new FakePi();
	createPiExecutorExtension(createServices())(onlinePi as ExtensionAPI);
	const online = createContext();
	await onlinePi.commands.get("executor-status")!.handler("", online.ctx);
	assert.match(online.ui.notifications[0]?.message ?? "", /scopeId: workspace-1/);

	const offlinePi = new FakePi();
	createPiExecutorExtension(createServices({ isReachable: async () => false }))(offlinePi as ExtensionAPI);
	const offline = createContext();
	await offlinePi.commands.get("executor-status")!.handler("", offline.ctx);
	assert.match(offline.ui.notifications[0]?.message ?? "", /Executor is not running/);
});

test("executor_execute returns completed results and persists branch-local state", async () => {
	const pi = new FakePi();
	createPiExecutorExtension(
		createServices({
			createExecution: async () => ({
				...completedEnvelope(),
				execution: {
					...completedEnvelope().execution,
					status: "running",
				},
			}),
			pollExecution: async () => completedEnvelope(),
		}),
	)(pi as ExtensionAPI);
	const { ctx, ui } = createContext();

	const result = await pi.tools.get("executor_execute")!.execute("tool-1", { code: "return 1" }, undefined, undefined, ctx);

	assert.equal(result.details.status, "completed");
	assert.equal(pi.appended[0]?.customType, "pi-executor-state");
	assert.equal(pi.appended[0]?.data?.lastExecutionId, "exec-1");
	assert.equal(ui.statuses.get("pi-executor"), "executor: ready");
});

test("executor_execute returns waiting_for_interaction details", async () => {
	const pi = new FakePi();
	createPiExecutorExtension(
		createServices({
			createExecution: async () => waitingFormEnvelope(),
			pollExecution: async () => waitingFormEnvelope(),
		}),
	)(pi as ExtensionAPI);
	const { ctx, ui } = createContext();

	const result = await pi.tools.get("executor_execute")!.execute("tool-1", { code: "return 1" }, undefined, undefined, ctx);

	assert.equal(result.details.status, "waiting_for_interaction");
	assert.deepEqual(result.details.interaction?.requestedSchema, {
		type: "object",
		properties: {
			approved: {
				type: "boolean",
			},
		},
		required: ["approved"],
	});
	assert.equal(ui.statuses.get("pi-executor"), "executor: waiting");
});

test("executor_resume does not POST resume for terminal executions", async () => {
	const resumes: string[] = [];
	const pi = new FakePi();
	createPiExecutorExtension(
		createServices({
			getExecution: async () => completedEnvelope(),
			resumeExecution: async () => {
				resumes.push("resume");
				return completedEnvelope();
			},
		}),
	)(pi as ExtensionAPI);
	const { ctx } = createContext();

	const result = await pi.tools.get("executor_resume")!.execute(
		"tool-2",
		{ executionId: "exec-1", responseJson: undefined },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.details.status, "completed");
	assert.deepEqual(resumes, []);
});

test("executor_resume requires explicit responseJson for form interactions", async () => {
	const resumes: string[] = [];
	const pi = new FakePi();
	createPiExecutorExtension(
		createServices({
			getExecution: async () => waitingFormEnvelope(),
			resumeExecution: async () => {
				resumes.push("resume");
				return completedEnvelope();
			},
		}),
	)(pi as ExtensionAPI);
	const { ctx, ui } = createContext();

	const result = await pi.tools.get("executor_resume")!.execute(
		"tool-3",
		{ executionId: "exec-1", responseJson: undefined },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.details.status, "waiting_for_interaction");
	assert.equal(result.details.nextAction.kind, "resume_with_responseJson");
	assert.deepEqual(resumes, []);
	assert.equal(ui.statuses.get("pi-executor"), "executor: waiting");
});

test("executor_resume opens URL interactions without implicitly submitting a form response", async () => {
	const opened: string[] = [];
	const pi = new FakePi();
	createPiExecutorExtension(
		createServices({
			getExecution: async () => waitingUrlEnvelope(),
			openBrowser: async (url) => void opened.push(url),
			pollExecution: async () => waitingUrlEnvelope(),
		}),
	)(pi as ExtensionAPI);
	const { ctx } = createContext();

	const result = await pi.tools.get("executor_resume")!.execute(
		"tool-4",
		{ executionId: "exec-1", responseJson: undefined },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.details.status, "waiting_for_interaction");
	assert.equal(result.details.nextAction.kind, "open_url_or_resume");
	assert.deepEqual(opened, ["https://example.com/approve"]);
});

test("executor_resume submits explicit responseJson and returns the settled result", async () => {
	const pi = new FakePi();
	let resumedWith: string | undefined;
	createPiExecutorExtension(
		createServices({
			getExecution: async () => waitingFormEnvelope(),
			resumeExecution: async (_baseUrl, _workspaceId, _executionId, responseJson) => {
				resumedWith = responseJson;
				return completedEnvelope();
			},
			pollExecution: async () => completedEnvelope(),
		}),
	)(pi as ExtensionAPI);
	const { ctx } = createContext();

	const result = await pi.tools.get("executor_resume")!.execute(
		"tool-5",
		{ executionId: "exec-1", responseJson: "{\"approved\":true}" },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(resumedWith, "{\"approved\":true}");
	assert.equal(result.details.status, "completed");
});

test("executor_resume polls executions that are already running", async () => {
	const pi = new FakePi();
	let pollCount = 0;
	createPiExecutorExtension(
		createServices({
			getExecution: async () => ({
				...completedEnvelope(),
				execution: {
					...completedEnvelope().execution,
					status: "running",
					resultJson: null,
					completedAt: null,
				},
			}),
			pollExecution: async () => {
				pollCount += 1;
				return completedEnvelope();
			},
		}),
	)(pi as ExtensionAPI);
	const { ctx, ui } = createContext();

	const result = await pi.tools.get("executor_resume")!.execute(
		"tool-6",
		{ executionId: "exec-1", responseJson: undefined },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(pollCount, 1);
	assert.equal(result.details.status, "completed");
	assert.equal(ui.statuses.get("pi-executor"), "executor: ready");
});

test("session hooks restore branch-local waiting state and clear status on shutdown", async () => {
	const pi = new FakePi();
	createPiExecutorExtension(createServices())(pi as ExtensionAPI);
	const restoredState: PiExecutorSessionState = {
		lastExecutionId: "exec-1",
		lastSeenStatus: "waiting_for_interaction",
		lastInteractionId: "interaction-form",
	};
	const { ctx, ui } = createContext([
		{ type: "custom", customType: "pi-executor-state", data: restoredState },
	]);

	await pi.trigger("session_start", ctx);
	await delay(0);
	assert.equal(ui.statuses.get("pi-executor"), "executor: waiting");

	await pi.trigger("session_shutdown", ctx);
	assert.equal(ui.statuses.get("pi-executor"), undefined);
});
