import type { ResolvedPiExecutorConfig } from "./types.js";
type ConfigLoadOptions = {
    agentDir?: string;
};
export declare const getAgentDir: (agentDir?: string) => string;
export declare const getGlobalConfigPath: (options?: ConfigLoadOptions) => string;
export declare const getProjectConfigPath: (cwd: string) => string;
export declare const loadConfig: (cwd: string, options?: ConfigLoadOptions) => Promise<ResolvedPiExecutorConfig>;
export {};
