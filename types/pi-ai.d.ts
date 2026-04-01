declare module "@mariozechner/pi-ai" {
	export interface Api {}
	export interface AssistantMessageEvent {}
	export interface AssistantMessageEventStream {}
	export interface Context {}
	export interface ImageContent {
		type: "image";
	}
	export interface Model<TConfig = object> {
		id?: string;
		config?: TConfig;
	}
	export interface OAuthCredentials {}
	export interface OAuthLoginCallbacks {}
	export interface SimpleStreamOptions {}
	export interface TextContent {
		type: "text";
		text: string;
	}
	export interface ToolResultMessage {}
	export interface Message {
		role: string;
	}
}
