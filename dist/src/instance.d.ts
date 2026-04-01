import type { ExecutorInstance, ResolvedPiExecutorConfig } from "./types.js";
export type FetchLike = typeof fetch;
type SpawnedProcess = {
    once(event: "error", listener: (error: Error) => void): SpawnedProcess;
    once(event: "spawn", listener: () => void): SpawnedProcess;
    unref(): void;
};
type SpawnFunction = (command: string, args: readonly string[], options: {
    cwd: string;
    detached: boolean;
    env: NodeJS.ProcessEnv;
    stdio: "ignore";
}) => SpawnedProcess;
type ResolveExecutorInstanceOptions = {
    agentDir?: string;
    allocatePort?: () => Promise<number>;
    isPortAvailable?: (port: number) => Promise<boolean>;
    realpathFn?: (path: string) => Promise<string>;
};
type ReachabilityOptions = {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    intervalMs?: number;
};
type EnsureExecutorRunningOptions = ResolveExecutorInstanceOptions & ReachabilityOptions & {
    spawnImpl?: SpawnFunction;
};
export declare const allocatePort: () => Promise<number>;
export declare const isPortAvailable: (port: number) => Promise<boolean>;
export declare const resolveExecutorInstance: (cwd: string, config: ResolvedPiExecutorConfig, options?: ResolveExecutorInstanceOptions) => Promise<ExecutorInstance>;
export declare const isReachable: (baseUrl: string, options?: ReachabilityOptions) => Promise<boolean>;
export declare const waitForReachability: (baseUrl: string, expected: boolean, timeoutMs: number, options?: ReachabilityOptions) => Promise<void>;
export declare const startExecutorWebDetached: (cwd: string, instance: ExecutorInstance, command?: string, options?: {
    spawnImpl?: SpawnFunction;
}) => Promise<void>;
export declare const ensureExecutorRunning: (cwd: string, config: ResolvedPiExecutorConfig, options?: EnsureExecutorRunningOptions) => Promise<ExecutorInstance>;
export declare const openBrowser: (url: string, options?: {
    spawnImpl?: SpawnFunction;
}) => Promise<void>;
export declare const getInstanceRecordPath: (instanceId: string, agentDir?: string) => string;
export declare const getConfigPaths: (cwd: string, agentDir?: string) => {
    global: string;
    project: string;
};
export {};
