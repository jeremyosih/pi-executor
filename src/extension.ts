import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DEFAULT_LOGIN_PATH, STATUS_ERROR, STATUS_KEY, STATUS_OFFLINE, STATUS_READY, STATUS_WAITING, SESSION_ENTRY_TYPE } from "./constants.js";
import { loadConfig } from "./config.js";
import {
	createExecution,
	getExecution,
	getInstallation,
	isTerminalStatus,
	pollExecution,
	resumeExecution,
} from "./executor-http.js";
import { ensureExecutorRunning, isReachable, openBrowser, resolveExecutorInstance } from "./instance.js";
import { createState, restoreState } from "./session-state.js";
import { buildToolResult, normalizeDetails, summarizeInteraction } from "./tool-result.js";
import type {
	ExecutionEnvelope,
	ExecutionStatus,
	ExecutorInstance,
	ExecutorToolDetails,
	LocalInstallation,
	ResolvedPiExecutorConfig,
} from "./types.js";

export type PiExecutorServices = {
	loadConfig(cwd: string): Promise<ResolvedPiExecutorConfig>;
	resolveExecutorInstance(cwd: string, config: ResolvedPiExecutorConfig): Promise<ExecutorInstance>;
	ensureExecutorRunning(cwd: string, config: ResolvedPiExecutorConfig): Promise<ExecutorInstance>;
	isReachable(baseUrl: string): Promise<boolean>;
	openBrowser(url: string): Promise<void>;
	getInstallation(baseUrl: string, options?: { signal?: AbortSignal }): Promise<LocalInstallation>;
	createExecution(
		baseUrl: string,
		workspaceId: string,
		code: string,
		options?: { signal?: AbortSignal },
	): Promise<ExecutionEnvelope>;
	getExecution(
		baseUrl: string,
		workspaceId: string,
		executionId: string,
		options?: { signal?: AbortSignal },
	): Promise<ExecutionEnvelope>;
	resumeExecution(
		baseUrl: string,
		workspaceId: string,
		executionId: string,
		responseJson: string | undefined,
		options?: { signal?: AbortSignal },
	): Promise<ExecutionEnvelope>;
	pollExecution(
		baseUrl: string,
		workspaceId: string,
		executionId: string,
		options?: {
			signal?: AbortSignal;
			initialEnvelope?: ExecutionEnvelope;
			untilChangeFrom?: {
				status: ExecutionStatus;
				interactionId: string | null;
			};
			returnLastOnTimeout?: boolean;
		},
	): Promise<ExecutionEnvelope>;
};

const defaultServices: PiExecutorServices = {
	loadConfig,
	resolveExecutorInstance,
	ensureExecutorRunning,
	isReachable,
	openBrowser,
	getInstallation,
	createExecution,
	getExecution,
	resumeExecution,
	pollExecution,
};

const EXECUTE_TOOL_DESCRIPTION =
	"Run TypeScript code in executor. Use executor's discovery workflow: discover tools, inspect schemas, then call tools.*.";

const EXECUTE_TOOL_GUIDELINES = [
	"Write TypeScript, not shell pipelines.",
	"Use tools.* inside executor code, not fetch.",
	"Use tools.discover first when the exact tool path is unknown.",
	"Inspect schemas before calling complex tools.",
];

const setExecutorStatus = (ctx: ExtensionContext, status: ExecutionStatus): void => {
	ctx.ui.setStatus(STATUS_KEY, status === "waiting_for_interaction" ? STATUS_WAITING : STATUS_READY);
};

const updateStatus = async (
	ctx: ExtensionContext,
	services: PiExecutorServices,
): Promise<void> => {
	try {
		const config = await services.loadConfig(ctx.cwd);
		const instance = await services.resolveExecutorInstance(ctx.cwd, config);
		const restored = restoreState(ctx);

		if (!config.autoProbeOnSessionStart) {
			ctx.ui.setStatus(STATUS_KEY, restored?.lastSeenStatus === "waiting_for_interaction" ? STATUS_WAITING : undefined);
			return;
		}

		const reachable = await services.isReachable(instance.baseUrl);
		if (!reachable) {
			ctx.ui.setStatus(STATUS_KEY, STATUS_OFFLINE);
			return;
		}

		ctx.ui.setStatus(
			STATUS_KEY,
			restored?.lastSeenStatus === "waiting_for_interaction" ? STATUS_WAITING : STATUS_READY,
		);
	} catch {
		ctx.ui.setStatus(STATUS_KEY, STATUS_ERROR);
	}
};

const openBrowserUrl = async (services: PiExecutorServices, url: string): Promise<string | null> => {
	try {
		await services.openBrowser(url);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

const formatStatusMessage = (
	instance: ExecutorInstance,
	reachable: boolean,
	scopeId: string | null,
): string =>
	reachable
		? [`Executor is running.`, `instanceId: ${instance.instanceId}`, `baseUrl: ${instance.baseUrl}`, `scopeId: ${scopeId ?? "unknown"}`].join("\n")
		: [
				"Executor is not running.",
				`instanceId: ${instance.instanceId}`,
				`baseUrl: ${instance.baseUrl}`,
				`port: ${instance.port}`,
				`dataDir: ${instance.localDataDir}`,
				`pidFile: ${instance.pidFile}`,
				`logFile: ${instance.logFile}`,
			].join("\n");

const createRegisteredExtension = (services: PiExecutorServices) => (pi: ExtensionAPI): void => {
	const persistState = (details: ExecutorToolDetails): void => {
		pi.appendEntry(SESSION_ENTRY_TYPE, createState(details));
	};

	const getRunningContext = async (
		cwd: string,
		signal?: AbortSignal,
	): Promise<{ config: ResolvedPiExecutorConfig; instance: ExecutorInstance; installation: LocalInstallation }> => {
		const config = await services.loadConfig(cwd);
		const instance = await services.ensureExecutorRunning(cwd, config);
		const installation = await services.getInstallation(instance.baseUrl, signal ? { signal } : undefined);
		return {
			config,
			instance,
			installation,
		};
	};

	pi.registerCommand("executor-web", {
		description: "Start or reuse the workspace-local executor web instance",
		handler: async (_args, ctx) => {
			const config = await services.loadConfig(ctx.cwd);
			const instance = await services.ensureExecutorRunning(ctx.cwd, config);
			const openError = await openBrowserUrl(services, instance.baseUrl);
			ctx.ui.setStatus(STATUS_KEY, STATUS_READY);
			ctx.ui.notify(
				openError
					? `Executor is ready at ${instance.baseUrl}. Browser open failed: ${openError}`
					: `Executor is ready at ${instance.baseUrl}`,
				openError ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("executor-login", {
		description: "Open the workspace-local executor login/setup flow",
		handler: async (_args, ctx) => {
			const config = await services.loadConfig(ctx.cwd);
			const instance = await services.ensureExecutorRunning(ctx.cwd, config);
			const loginUrl = `${instance.baseUrl}${config.loginPath || DEFAULT_LOGIN_PATH}`;
			const openError = await openBrowserUrl(services, loginUrl);
			ctx.ui.setStatus(STATUS_KEY, STATUS_READY);
			ctx.ui.notify(
				openError
					? `Executor is ready at ${loginUrl}. Browser open failed: ${openError}`
					: `Executor login opened at ${loginUrl}`,
				openError ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("executor-status", {
		description: "Show status for the workspace-local executor instance",
		handler: async (_args, ctx) => {
			const config = await services.loadConfig(ctx.cwd);
			const instance = await services.resolveExecutorInstance(ctx.cwd, config);
			const reachable = await services.isReachable(instance.baseUrl);
			const installation = reachable ? await services.getInstallation(instance.baseUrl) : null;
			ctx.ui.setStatus(STATUS_KEY, reachable ? STATUS_READY : STATUS_OFFLINE);
			ctx.ui.notify(formatStatusMessage(instance, reachable, installation?.scopeId ?? null), "info");
		},
	});

	pi.registerTool({
		name: "executor_execute",
		label: "Executor Execute",
		description: EXECUTE_TOOL_DESCRIPTION,
		promptSnippet: "Run code inside executor to access the user's connected tool catalog.",
		promptGuidelines: EXECUTE_TOOL_GUIDELINES,
		parameters: Type.Object({
			code: Type.String({
				description: "TypeScript to run in executor",
			}),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const { instance, installation } = await getRunningContext(ctx.cwd, signal);
			const created = await services.createExecution(
				instance.baseUrl,
				installation.scopeId,
				params.code,
				signal ? { signal } : undefined,
			);
			const settled = await services.pollExecution(instance.baseUrl, installation.scopeId, created.execution.id, {
				...(signal ? { signal } : {}),
				initialEnvelope: created,
			});
			const details = normalizeDetails(instance, installation, settled);
			persistState(details);
			setExecutorStatus(ctx, details.status);
			return buildToolResult(details);
		},
	});

	pi.registerTool({
		name: "executor_resume",
		label: "Executor Resume",
		description: "Resume a detached executor execution that is waiting for interaction.",
		parameters: Type.Object({
			executionId: Type.String(),
			responseJson: Type.Optional(
				Type.String({
					description: "JSON-encoded interaction response. Required for form interactions.",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const { instance, installation } = await getRunningContext(ctx.cwd, signal);
			const current = await services.getExecution(
				instance.baseUrl,
				installation.scopeId,
				params.executionId,
				signal ? { signal } : undefined,
			);
			const currentDetails = normalizeDetails(instance, installation, current);

			if (isTerminalStatus(current.execution.status)) {
				persistState(currentDetails);
				setExecutorStatus(ctx, current.execution.status);
				return buildToolResult(currentDetails);
			}

			if (current.execution.status !== "waiting_for_interaction") {
				const settled = await services.pollExecution(instance.baseUrl, installation.scopeId, params.executionId, {
					...(signal ? { signal } : {}),
					initialEnvelope: current,
				});
				const details = normalizeDetails(instance, installation, settled);
				persistState(details);
				setExecutorStatus(ctx, details.status);
				return buildToolResult(details);
			}

			if (params.responseJson !== undefined) {
				const resumed = await services.resumeExecution(
					instance.baseUrl,
					installation.scopeId,
					params.executionId,
					params.responseJson,
					signal ? { signal } : undefined,
				);
				const settled = await services.pollExecution(instance.baseUrl, installation.scopeId, params.executionId, {
					...(signal ? { signal } : {}),
					initialEnvelope: resumed,
				});
				const details = normalizeDetails(instance, installation, settled);
				persistState(details);
				setExecutorStatus(ctx, details.status);
				return buildToolResult(details);
			}

			const interaction = summarizeInteraction(current);
			if (interaction?.mode === "url" && interaction.url) {
				await openBrowserUrl(services, interaction.url);
				const settled = await services.pollExecution(instance.baseUrl, installation.scopeId, params.executionId, {
					...(signal ? { signal } : {}),
					initialEnvelope: current,
					untilChangeFrom: {
						status: current.execution.status,
						interactionId: current.pendingInteraction?.id ?? null,
					},
					returnLastOnTimeout: true,
				});
				const details = normalizeDetails(instance, installation, settled);
				persistState(details);
				setExecutorStatus(ctx, details.status);
				return buildToolResult(details);
			}

			persistState(currentDetails);
			ctx.ui.setStatus(STATUS_KEY, STATUS_WAITING);
			return buildToolResult(currentDetails);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		void updateStatus(ctx, services);
	});

	pi.on("session_switch", (_event, ctx) => {
		void updateStatus(ctx, services);
	});

	pi.on("session_fork", (_event, ctx) => {
		void updateStatus(ctx, services);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
};

export const createPiExecutorExtension = (overrides?: Partial<PiExecutorServices>) =>
	createRegisteredExtension({
		...defaultServices,
		...overrides,
	});

export default createPiExecutorExtension();
