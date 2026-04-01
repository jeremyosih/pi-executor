import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ensureExecutorRunning,
	resolveExecutorInstance,
} from "../src/instance.js";
import type { ResolvedPiExecutorConfig } from "../src/types.js";

class FakeChildProcess extends EventEmitter {
	override once(event: "error" | "spawn", listener: ((error: Error) => void) | (() => void)): this {
		return super.once(event, listener);
	}

	unref(): void {}
}

const createSandbox = async (): Promise<{ agentDir: string; workspace: string; alias: string; sibling: string }> => {
	const root = await mkdtemp(join(tmpdir(), "pi-executor-instance-"));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	const alias = join(root, "workspace-alias");
	const sibling = join(root, "workspace-b");
	await mkdir(agentDir, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await mkdir(sibling, { recursive: true });
	await symlink(workspace, alias);
	return {
		agentDir,
		workspace,
		alias,
		sibling,
	};
};

const defaultConfig: ResolvedPiExecutorConfig = {
	executorCommand: "executor",
	startupTimeoutMs: 150,
	loginPath: "/sources/add",
	autoProbeOnSessionStart: true,
};

test("resolveExecutorInstance uses realpath for stable workspace identity", async () => {
	const sandbox = await createSandbox();
	const options = { agentDir: sandbox.agentDir, allocatePort: async () => 4101, isPortAvailable: async () => true };
	const fromRealPath = await resolveExecutorInstance(sandbox.workspace, defaultConfig, options);
	const fromAlias = await resolveExecutorInstance(sandbox.alias, defaultConfig, options);

	assert.equal(fromRealPath.instanceId, fromAlias.instanceId);
	assert.equal(fromRealPath.port, fromAlias.port);
});

test("resolveExecutorInstance isolates different workspaces", async () => {
	const sandbox = await createSandbox();
	let port = 4200;
	const options = { agentDir: sandbox.agentDir, allocatePort: async () => port++, isPortAvailable: async () => true };
	const first = await resolveExecutorInstance(sandbox.workspace, defaultConfig, options);
	const second = await resolveExecutorInstance(sandbox.sibling, defaultConfig, options);

	assert.notEqual(first.instanceId, second.instanceId);
	assert.notEqual(first.port, second.port);
});

test("resolveExecutorInstance reuses persisted instance metadata", async () => {
	const sandbox = await createSandbox();
	const options = { agentDir: sandbox.agentDir, allocatePort: async () => 4301, isPortAvailable: async () => true };
	const first = await resolveExecutorInstance(sandbox.workspace, defaultConfig, options);
	const second = await resolveExecutorInstance(sandbox.workspace, defaultConfig, options);

	assert.equal(first.port, second.port);
	assert.equal(first.baseUrl, second.baseUrl);
});

test("resolveExecutorInstance honors configured port override", async () => {
	const sandbox = await createSandbox();
	const instance = await resolveExecutorInstance(sandbox.workspace, { ...defaultConfig, port: 4141 }, { agentDir: sandbox.agentDir, isPortAvailable: async () => true });

	assert.equal(instance.port, 4141);
	assert.equal(instance.baseUrl, "http://127.0.0.1:4141");
});

test("ensureExecutorRunning reuses a reachable instance without spawning", async () => {
	const sandbox = await createSandbox();
	let spawnCount = 0;
	const instance = await ensureExecutorRunning(sandbox.workspace, defaultConfig, {
		agentDir: sandbox.agentDir,
		allocatePort: async () => 4401,
		isPortAvailable: async () => true,
		fetchImpl: async () => new Response("{}", { status: 200 }),
		spawnImpl: () => {
			spawnCount += 1;
			return new FakeChildProcess();
		},
	});

	assert.equal(spawnCount, 0);
	assert.match(instance.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("ensureExecutorRunning spawns and waits for reachability when offline", async () => {
	const sandbox = await createSandbox();
	let reachable = false;
	let spawnCount = 0;
	let command: string | undefined;
	let args: readonly string[] | undefined;

	const instance = await ensureExecutorRunning(sandbox.workspace, defaultConfig, {
		agentDir: sandbox.agentDir,
		allocatePort: async () => 4501,
		isPortAvailable: async () => true,
		fetchImpl: async () => {
			if (!reachable) {
				throw new Error("offline");
			}
			return new Response("{}", { status: 200 });
		},
		spawnImpl: (spawnCommand, spawnArgs) => {
			spawnCount += 1;
			command = spawnCommand;
			args = spawnArgs;
			const child = new FakeChildProcess();
			process.nextTick(() => {
				reachable = true;
				child.emit("spawn");
			});
			return child;
		},
	});

	assert.equal(spawnCount, 1);
	assert.equal(command, "executor");
	assert.deepEqual(args, ["server", "start", "--port", "4501"]);
	assert.match(instance.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("ensureExecutorRunning reports actionable timeout errors", async () => {
	const sandbox = await createSandbox();
	await assert.rejects(
		() =>
			ensureExecutorRunning(sandbox.workspace, defaultConfig, {
				agentDir: sandbox.agentDir,
				allocatePort: async () => 4601,
				isPortAvailable: async () => true,
				fetchImpl: async () => {
					throw new Error("offline");
				},
				spawnImpl: () => {
					const child = new FakeChildProcess();
					process.nextTick(() => child.emit("spawn"));
					return child;
				},
			}),
		/error.*port .*Check .*server\.log/i,
	);
});

test("ensureExecutorRunning rejects missing executor command", async () => {
	const sandbox = await createSandbox();
	await assert.rejects(
		() =>
			ensureExecutorRunning(sandbox.workspace, defaultConfig, {
				agentDir: sandbox.agentDir,
				allocatePort: async () => 4701,
				isPortAvailable: async () => true,
				fetchImpl: async () => {
					throw new Error("offline");
				},
				spawnImpl: () => {
					const child = new FakeChildProcess();
					process.nextTick(() => child.emit("error", new Error("spawn ENOENT")));
					return child;
				},
			}),
		/not found/,
	);
});

test("ensureExecutorRunning fails fast when configured port is occupied by another process", async () => {
	const sandbox = await createSandbox();
	await assert.rejects(
		() =>
			ensureExecutorRunning(sandbox.workspace, { ...defaultConfig, port: 4801 }, {
				agentDir: sandbox.agentDir,
				isPortAvailable: async () => false,
				fetchImpl: async () => {
					throw new Error("offline");
				},
			}),
		/already in use by another process/,
	);
});
