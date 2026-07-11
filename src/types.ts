export enum SessionStatus {
	pending = "pending",
	running = "running",
	waiting = "waiting",
	completed = "completed",
	failed = "failed",
	unknown = "unknown",
}

export type SessionSource =
	| "opencode"
	| "codex"
	| "claude"
	| "pi"
	| "omp"
	| "mission-control";

export interface SessionCapabilities {
	attach: boolean;
	delete: boolean;
	abortChildren: boolean;
	hierarchy: boolean;
}

export type MissionControlLifecycleStatus =
	| "idle"
	| "running"
	| "awaiting"
	| "stopped"
	| "failed";

export type MissionControlRunOutcome =
	| "idle"
	| "running"
	| "interrupted"
	| "completed"
	| "failed"
	| "blocked_on_approval";

export type MissionControlLeaseState =
	| "live"
	| "missing"
	| "expired"
	| "unknown";

export type MissionControlFallbackSafety = "retry" | "eligible" | "no_delete";

export interface MissionControlLatestRunMetadata {
	outcome: MissionControlRunOutcome | null;
	sequence: number;
	timestamp: string;
	eventType: string;
	runId?: string;
	reason?: string;
	errorCode?: string;
}

export interface MissionControlLeaseMetadata {
	state: MissionControlLeaseState;
	fallbackSafety: MissionControlFallbackSafety;
	ownerId?: string;
	epoch?: number;
	expiresWallMs?: number;
}

export interface MissionControlSessionMetadata {
	databaseIdentity: string;
	canonicalDatabasePath: string;
	rawLifecycleStatus: string | null;
	lifecycleStatus?: MissionControlLifecycleStatus;
	lifecycleReason?: string;
	lastEventSequence?: number;
	updatedAt?: string;
	lastActivityAt?: string;
	latestRun?: MissionControlLatestRunMetadata;
	hasActiveWork: boolean | null;
	abortable: boolean;
	lease: MissionControlLeaseMetadata;
	effectiveParentId?: string | null;
	treeToken?: string;
}

export interface SessionSourceMetadata {
	originator?: string;
	cliVersion?: string;
	rawSource?: string;
	sourceCategory?: string;
	agentRole?: string;
	agentNickname?: string;
	agentPath?: string;
	agentStatus?: string;
	agentListObservedAtMs?: number;
	reasoningEffort?: string;
	modelRole?: string;
	activeToolNames?: string[];
	lastEventType?: string;
	lastTurnId?: string;
	abortedReason?: string;
	openChildCount?: number;
	closedChildCount?: number;
	sessionPath?: string;
	parentSessionPath?: string;
	missionControl?: MissionControlSessionMetadata;
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
	modelID?: string;
	variant?: string;
	time: MessageTimeData;
	finish?: "stop" | "tool-calls" | "error" | "other" | "length" | "unknown";
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
	sessionSource: SessionSource;
	capabilities?: SessionCapabilities;
	currentAgent?: string;
	currentModelID?: string;
	currentVariant?: string;
	currentReasoningEffort?: string;
	status?: SessionStatus;
	statusDetail?: string;
	finishReason?: string;
	providerID?: string;
	sourceMetadata?: SessionSourceMetadata;
}

export interface Session extends SessionRecord {
	sessionSource: SessionSource;
	capabilities?: SessionCapabilities;
	currentAgent?: string;
	currentModelID?: string;
	currentVariant?: string;
	currentReasoningEffort?: string;
	status?: SessionStatus;
	statusDetail?: string;
	finishReason?: string;
	providerID?: string;
	sourceMetadata?: SessionSourceMetadata;
	subagentSessions?: SubagentSession[];
}

export type AgentColorMap = Record<string, string>;

export interface SessionMonitorUIState {
	selectedIndex: number;
	isDetailMode: boolean;
	isSideviewMode: boolean;
}

export type HierarchyViewMode = "tree" | "flow";
export type HierarchyInfoMode = "standard" | "detailed";
export type HierarchyFilterMode = "latest" | "active" | "all";

export interface TUIState extends SessionMonitorUIState {}
