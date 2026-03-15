export enum SessionStatus {
	pending = "pending",
	running = "running",
	waiting = "waiting",
	completed = "completed",
	failed = "failed",
	unknown = "unknown",
}

export interface MessageTimeData {
	created: number;
	completed?: number;
}

export interface MessageTokens {
	input: number;
	output: number;
}

export interface MessageTools {
	question?: boolean;
	task?: boolean;
	call_omo_agent?: boolean;
	[key: string]: boolean | undefined;
}

export interface MessageData {
	role: "user" | "assistant";
	agent?: string;
	mode?: string;
	time: MessageTimeData;
	finish?: "stop" | "tool-calls" | "error";
	tokens?: MessageTokens;
	tools?: MessageTools;
}

export interface SessionRecord {
	id: string;
	title: string;
	directory: string;
	project_id: string;
	project_name?: string | null;
	project_worktree?: string | null;
	project_label: string;
	parent_id: string | null;
	time_created: number;
	time_updated: number;
}

export interface SubagentSession extends SessionRecord {
	currentAgent?: string;
	status?: SessionStatus;
}

export interface Session extends SessionRecord {
	currentAgent?: string;
	status?: SessionStatus;
	subagentSessions?: SubagentSession[];
}

export type AgentColorMap = Record<string, string>;

export interface SessionMonitorUIState {
	selectedIndex: number;
	isDetailMode: boolean;
	isSideviewMode: boolean;
}

export interface TUIState extends SessionMonitorUIState {}
