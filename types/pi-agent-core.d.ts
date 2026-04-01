declare module "@mariozechner/pi-agent-core" {
	export interface AgentMessage {
		role: string;
	}

	export interface AgentToolResult<TDetails = object> {
		content: Array<{ type: string }>;
		details: TDetails;
	}

	export type AgentToolUpdateCallback<TDetails = object> = (result: AgentToolResult<TDetails>) => void;
	export type ThinkingLevel = "off" | "low" | "medium" | "high";
}
