import assert from "node:assert/strict";
import test from "node:test";
import {
	createExecution,
	getExecution,
	getInstallation,
	parseInteractionPayload,
	pollExecution,
	resumeExecution,
} from "../src/executor-http.js";
import type { ExecutionEnvelope } from "../src/types.js";

type FetchCall = {
	url: string;
	init?: RequestInit;
};

const waitingEnvelope = (): ExecutionEnvelope => ({
	execution: {
		id: "exec-1",
		scopeId: "workspace-1",
		createdByScopeId: "workspace-1",
		status: "waiting_for_interaction",
		code: "return 1",
		resultJson: null,
		errorText: null,
		logsJson: null,
		startedAt: 1,
		completedAt: null,
		createdAt: 1,
		updatedAt: 2,
	},
	pendingInteraction: {
		id: "interaction-1",
		executionId: "exec-1",
		status: "pending",
		kind: "url",
		purpose: "tool_execution_gate",
		payloadJson: JSON.stringify({
			elicitation: {
				message: "Approve browser login",
				mode: "url",
				url: "https://example.com/approve",
			},
		}),
		responseJson: null,
		responsePrivateJson: null,
		createdAt: 1,
		updatedAt: 2,
	},
});

test("executor HTTP helpers use the documented endpoints", async () => {
	const seen: FetchCall[] = [];
	const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		if (init === undefined) {
			seen.push({ url: href });
		} else {
			seen.push({ url: href, init });
		}

		if (href.endsWith("/v1/local/installation")) {
			return new Response(JSON.stringify({ scopeId: "workspace-1", actorScopeId: "actor-1", resolutionScopeIds: ["workspace-1"] }), { status: 200 });
		}

		if (href.endsWith("/v1/workspaces/workspace-1/executions")) {
			assert.match(String(init?.body), /"interactionMode":"detach"/);
			return new Response(JSON.stringify(waitingEnvelope()), { status: 200 });
		}

		if (href.endsWith("/v1/workspaces/workspace-1/executions/exec-1") && init?.method !== "POST") {
			return new Response(JSON.stringify(waitingEnvelope()), { status: 200 });
		}

		if (href.endsWith("/v1/workspaces/workspace-1/executions/exec-1/resume")) {
			assert.match(String(init?.body), /"interactionMode":"detach"/);
			assert.match(String(init?.body), /"responseJson":"\{\\"approved\\":true\}"/);
			return new Response(
				JSON.stringify({
					execution: {
						...waitingEnvelope().execution,
						status: "completed",
						resultJson: "{\"ok\":true}",
						completedAt: 3,
					},
					pendingInteraction: null,
				}),
				{ status: 200 },
			);
		}

		return new Response("not found", { status: 404, statusText: "Not Found" });
	};

	const installation = await getInstallation("http://127.0.0.1:8788", { fetchImpl });
	assert.equal(installation.scopeId, "workspace-1");

	const created = await createExecution("http://127.0.0.1:8788", "workspace-1", "return 1", { fetchImpl });
	assert.equal(created.execution.status, "waiting_for_interaction");

	const fetched = await getExecution("http://127.0.0.1:8788", "workspace-1", "exec-1", { fetchImpl });
	assert.equal(fetched.pendingInteraction?.id, "interaction-1");

	const resumed = await resumeExecution("http://127.0.0.1:8788", "workspace-1", "exec-1", "{\"approved\":true}", { fetchImpl });
	assert.equal(resumed.execution.status, "completed");

	assert.deepEqual(
		seen.map((call) => ({
			url: call.url.replace("http://127.0.0.1:8788", ""),
			method: call.init?.method ?? "GET",
		})),
		[
			{ url: "/v1/local/installation", method: "GET" },
			{ url: "/v1/workspaces/workspace-1/executions", method: "POST" },
			{ url: "/v1/workspaces/workspace-1/executions/exec-1", method: "GET" },
			{ url: "/v1/workspaces/workspace-1/executions/exec-1/resume", method: "POST" },
		],
	);
});

test("pollExecution stops on waiting_for_interaction and terminal states", async () => {
	let calls = 0;
	const fetchImpl = async (): Promise<Response> => {
		calls += 1;
		const envelope =
			calls === 1
				? {
						...waitingEnvelope(),
						execution: {
							...waitingEnvelope().execution,
							status: "running",
						},
						pendingInteraction: null,
					}
				: waitingEnvelope();
		return new Response(JSON.stringify(envelope), { status: 200 });
	};

	const settled = await pollExecution("http://127.0.0.1:8788", "workspace-1", "exec-1", {
		fetchImpl,
	});
	assert.equal(settled.execution.status, "waiting_for_interaction");
	assert.equal(settled.pendingInteraction?.id, "interaction-1");
});

test("parseInteractionPayload normalizes URL and form interactions", () => {
	const urlPayload = parseInteractionPayload(waitingEnvelope().pendingInteraction!);
	assert.deepEqual(urlPayload, {
		message: "Approve browser login",
		mode: "url",
		url: "https://example.com/approve",
		requestedSchema: null,
	});

	const formPayload = parseInteractionPayload({
		...waitingEnvelope().pendingInteraction!,
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
	});
	assert.deepEqual(formPayload, {
		message: "Need confirmation",
		mode: "form",
		url: null,
		requestedSchema: {
			type: "object",
			properties: {
				approved: {
					type: "boolean",
				},
			},
			required: ["approved"],
		},
	});
});

test("executor HTTP helpers reject malformed responses", async () => {
	const fetchImpl = async (): Promise<Response> =>
		new Response(JSON.stringify({ scopeId: "workspace-1", actorScopeId: "actor-1", resolutionScopeIds: [123] }), {
			status: 200,
		});

	await assert.rejects(() => getInstallation("http://127.0.0.1:8788", { fetchImpl }), /installation shape is invalid/);
});

test("executor HTTP helpers preserve non-JSON HTTP errors", async () => {
	const fetchImpl = async (): Promise<Response> => new Response("not found", { status: 404, statusText: "Not Found" });

	await assert.rejects(
		() => getInstallation("http://127.0.0.1:8788", { fetchImpl }),
		/404 Not Found: not found/,
	);
});
