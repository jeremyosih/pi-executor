export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = {
	[key: string]: JsonValue;
};

export type ExecutionStatus =
	| "pending"
	| "running"
	| "waiting_for_interaction"
	| "completed"
	| "failed"
	| "cancelled";

export type PiExecutorConfig = {
	executorCommand?: string;
	startupTimeoutMs?: number;
	loginPath?: string;
	autoProbeOnSessionStart?: boolean;
	port?: number;
};

export type ResolvedPiExecutorConfig = {
	executorCommand: string;
	startupTimeoutMs: number;
	loginPath: string;
	autoProbeOnSessionStart: boolean;
	port?: number;
};

export type ExecutorInstance = {
	instanceId: string;
	cwdRealpath: string;
	port: number;
	baseUrl: string;
	localDataDir: string;
	pidFile: string;
	logFile: string;
};

export type PiExecutorSessionState = {
	lastExecutionId: string | null;
	lastSeenStatus: ExecutionStatus | null;
	lastInteractionId: string | null;
};

export type LocalInstallation = {
	scopeId: string;
	actorScopeId: string;
	resolutionScopeIds: string[];
};

export type Execution = {
	id: string;
	scopeId: string;
	createdByScopeId: string;
	status: ExecutionStatus;
	code: string;
	resultJson: string | null;
	errorText: string | null;
	logsJson: string | null;
	startedAt: number | null;
	completedAt: number | null;
	createdAt: number;
	updatedAt: number;
};

export type ExecutionInteraction = {
	id: string;
	executionId: string;
	status: "pending" | "resolved" | "cancelled";
	kind: string;
	purpose: string;
	payloadJson: string;
	responseJson: string | null;
	responsePrivateJson: string | null;
	createdAt: number;
	updatedAt: number;
};

export type ExecutionEnvelope = {
	execution: Execution;
	pendingInteraction: ExecutionInteraction | null;
};

export type InteractionMode = "form" | "url";

export type InteractionSummary = {
	id: string;
	purpose: string;
	kind: string;
	message: string;
	mode: InteractionMode | null;
	url: string | null;
	requestedSchema: JsonObject | null;
};

export type NextAction =
	| {
			kind: "none";
	  }
	| {
			kind: "open_url_or_resume";
			url: string | null;
	  }
	| {
			kind: "resume_with_responseJson";
	  };

export type ExecutorToolDetails = {
	instanceId: string;
	baseUrl: string;
	scopeId: string;
	executionId: string;
	status: ExecutionStatus;
	resultJson: string | null;
	errorText: string | null;
	logsJson: string | null;
	interaction: InteractionSummary | null;
	nextAction: NextAction;
};
