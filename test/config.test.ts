import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const createSandbox = async (): Promise<{ agentDir: string; workspace: string }> => {
	const root = await mkdtemp(join(tmpdir(), "pi-executor-config-"));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	await mkdir(agentDir, { recursive: true });
	await mkdir(workspace, { recursive: true });
	return {
		agentDir,
		workspace,
	};
};

test("loadConfig returns defaults when no config files exist", async () => {
	const sandbox = await createSandbox();
	const config = await loadConfig(sandbox.workspace, { agentDir: sandbox.agentDir });

	assert.equal(config.executorCommand, "executor");
	assert.equal(config.startupTimeoutMs, 30_000);
	assert.equal(config.loginPath, "/sources/add");
	assert.equal(config.autoProbeOnSessionStart, true);
	assert.equal("port" in config, false);
});

test("loadConfig reads global config", async () => {
	const sandbox = await createSandbox();
	await writeFile(
		join(sandbox.agentDir, "pi-executor.json"),
		JSON.stringify({
			executorCommand: "custom-executor",
			startupTimeoutMs: 12_000,
			loginPath: "custom/login",
			autoProbeOnSessionStart: false,
			port: 4321,
		}),
	);

	const config = await loadConfig(sandbox.workspace, { agentDir: sandbox.agentDir });

	assert.equal(config.executorCommand, "custom-executor");
	assert.equal(config.startupTimeoutMs, 12_000);
	assert.equal(config.loginPath, "/custom/login");
	assert.equal(config.autoProbeOnSessionStart, false);
	assert.equal(config.port, 4321);
});

test("project config overrides global config", async () => {
	const sandbox = await createSandbox();
	await writeFile(
		join(sandbox.agentDir, "pi-executor.json"),
		JSON.stringify({
			executorCommand: "global-executor",
			startupTimeoutMs: 10_000,
			loginPath: "/global-login",
			autoProbeOnSessionStart: false,
			port: 3000,
		}),
	);
	await mkdir(join(sandbox.workspace, ".pi"), { recursive: true });
	await writeFile(
		join(sandbox.workspace, ".pi", "pi-executor.json"),
		JSON.stringify({
			startupTimeoutMs: 22_000,
			loginPath: "/project-login",
			autoProbeOnSessionStart: true,
		}),
	);

	const config = await loadConfig(sandbox.workspace, { agentDir: sandbox.agentDir });

	assert.equal(config.executorCommand, "global-executor");
	assert.equal(config.startupTimeoutMs, 22_000);
	assert.equal(config.loginPath, "/project-login");
	assert.equal(config.autoProbeOnSessionStart, true);
	assert.equal(config.port, 3000);
});

test("loadConfig reports malformed JSON", async () => {
	const sandbox = await createSandbox();
	await writeFile(join(sandbox.agentDir, "pi-executor.json"), "{");

	await assert.rejects(
		() => loadConfig(sandbox.workspace, { agentDir: sandbox.agentDir }),
		/malformed JSON/,
	);
});

test("loadConfig validates field values", async () => {
	const sandbox = await createSandbox();
	await writeFile(
		join(sandbox.agentDir, "pi-executor.json"),
		JSON.stringify({
			loginPath: "https://example.com",
			port: 70_000,
		}),
	);

	await assert.rejects(
		() => loadConfig(sandbox.workspace, { agentDir: sandbox.agentDir }),
		/"loginPath" must be a relative path|"port" must be between 1 and 65535/,
	);
});
