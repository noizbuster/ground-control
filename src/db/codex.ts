import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isActiveStatus } from "../lib/hierarchyHelpers";
import type { SessionSnapshot } from "../lib/sessionSnapshot";
import {
	getDefaultSessionCapabilities,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import {
	type Session,
	type SessionRecord,
	type SessionSourceMetadata,
	SessionStatus,
	type SubagentSession,
} from "../types";
import { createQueryFailedDatabaseError, type DatabaseResult } from "./index";

const CODEX_ROOT = `${homedir()}/.codex`;
const DEFAULT_CODEX_SESSIONS_DIR = `${CODEX_ROOT}/sessions`;
const DEFAULT_CODEX_ARCHIVED_SESSIONS_DIR = `${CODEX_ROOT}/archived_sessions`;
const DEFAULT_CODEX_SESSION_INDEX_PATH = `${CODEX_ROOT}/session_index.jsonl`;
const LOG_INDEX_REFRESH_MS = 10_000;
const EXEC_COMMAND_STALE_GRACE_MS = 10_000;

export interface CodexDeleteResult {
	deletedThreadIds: string[];
	deletedRolloutPaths: string[];
	deletedSessionIndexEntries: number;
}

interface CodexDeleteThreadRow {
	id: string;
	rollout_path: string | null;
}

interface DeleteCodexSessionOptions {
	skipArchiveRequest?: boolean;
	codexExecutable?: string;
	databasePath?: string;
	sessionsDirectory?: string;
	archivedSessionsDirectory?: string;
	sessionIndexPath?: string;
}

export interface CodexThreadRow {
	id: string;
	source: string | null;
	model_provider: string | null;
	cwd: string | null;
	title: string | null;
	agent_role: string | null;
	agent_nickname: string | null;
	model: string | null;
	reasoning_effort: string | null;
	archived: number | null;
	created_at_ms: number | null;
	updated_at_ms: number | null;
}

export interface CodexThreadSpawnEdgeRow {
	parent_thread_id: string;
	child_thread_id: string;
	status: string | null;
}

export interface CodexSessionMetaPayload {
	id?: string;
	timestamp?: string;
	cwd?: string;
	originator?: string;
	cli_version?: string;
	source?: unknown;
	model_provider?: string;
	thread_source?: string;
	agent_nickname?: string;
	agent_role?: string;
	agent_path?: string;
}

interface CodexSubagentAssignment {
	readonly recipient?: string;
	readonly content: string;
}

export interface CodexSessionLogSummary {
	sessionMeta?: CodexSessionMetaPayload;
	messageCount: number;
	lastEventType?: string;
	lastTurnId?: string;
	lastAgentMessage?: string;
	subagentAssignment?: CodexSubagentAssignment;
	taskState?: "running" | "completed" | "aborted" | "unknown";
	waitingForApproval?: boolean;
	waitingForUser?: boolean;
	activeToolNames?: string[];
	abortedReason?: string;
	startedAtMs?: number;
	completedAtMs?: number;
}

interface ParsedCodexThreadSource {
	rawSource?: string;
	sourceCategory: string;
	sourceLabel: string;
	parentThreadId?: string;
	agentRole?: string;
	agentNickname?: string;
	agentPath?: string;
}

interface ThreadEdgeStats {
	openChildCount: number;
	closedChildCount: number;
}

interface CodexStatusResolution {
	status: SessionStatus;
	finishReason?: string;
	statusDetail?: string;
}

interface ActiveCodexToolCall {
	name: string;
	expiresAtMs?: number;
	requiresApproval: boolean;
}

const trimToUndefined = (
	value: string | null | undefined,
): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeTimestampMs = (
	value: number | undefined | null,
): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	return value < 1_000_000_000_000 ? value * 1000 : value;
};

const parseIsoTimestampMs = (value: string | undefined): number | undefined => {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null && !Array.isArray(value);
};

const parseJsonRecord = (
	value: string | undefined,
): Record<string, unknown> => {
	if (!value) {
		return {};
	}

	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
};

const getPayloadString = (
	payload: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = payload[key];
	return typeof value === "string" ? trimToUndefined(value) : undefined;
};

const getPayloadBoolean = (
	payload: Record<string, unknown>,
	key: string,
): boolean | undefined => {
	const value = payload[key];
	return typeof value === "boolean" ? value : undefined;
};

const getPayloadNumber = (
	payload: Record<string, unknown>,
	key: string,
): number | undefined => {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
};

const isApprovalRequiredFunctionCall = (
	payload: Record<string, unknown>,
): boolean => {
	const argumentsJson = getPayloadString(payload, "arguments");
	const args = parseJsonRecord(argumentsJson);
	return (
		args.sandbox_permissions === "require_escalated" ||
		typeof args.justification === "string"
	);
};

const getExecCommandExpiresAtMs = (params: {
	toolName: string;
	argumentsJson?: string;
	timestampMs?: number;
}): number | undefined => {
	if (params.toolName !== "exec_command" || !params.timestampMs) {
		return undefined;
	}

	const args = parseJsonRecord(params.argumentsJson);
	const yieldTimeMs =
		typeof args.yield_time_ms === "number" &&
		Number.isFinite(args.yield_time_ms)
			? args.yield_time_ms
			: undefined;

	if (!yieldTimeMs || yieldTimeMs <= 0) {
		return undefined;
	}

	return params.timestampMs + yieldTimeMs + EXEC_COMMAND_STALE_GRACE_MS;
};

const getResponseMessageText = (
	payload: Record<string, unknown>,
): string | undefined => {
	const content = payload.content;
	if (typeof content === "string") {
		return trimToUndefined(content);
	}

	if (!Array.isArray(content)) {
		return undefined;
	}

	const chunks: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			chunks.push(part);
			continue;
		}

		if (!isRecord(part)) {
			continue;
		}

		const text =
			getPayloadString(part, "text") ?? getPayloadString(part, "content");
		if (text) {
			chunks.push(text);
		}
	}

	return trimToUndefined(chunks.join(""));
};

const parseSubagentAssignment = (
	messageText: string | undefined,
): CodexSubagentAssignment | undefined => {
	const parsed = parseJsonRecord(messageText);
	const triggerTurn = getPayloadBoolean(parsed, "trigger_turn");
	const content = getPayloadString(parsed, "content");
	if (triggerTurn !== true || !content) {
		return undefined;
	}

	return {
		recipient: getPayloadString(parsed, "recipient"),
		content,
	};
};

const isAssignmentForCurrentSubagent = (
	summary: CodexSessionLogSummary,
	assignment: CodexSubagentAssignment,
): boolean => {
	const sessionMeta = summary.sessionMeta;
	const agentPath = trimToUndefined(sessionMeta?.agent_path);
	if (!agentPath) {
		return sessionMeta?.thread_source === "subagent";
	}

	return assignment.recipient === agentPath;
};

const toHumanCountLabel = (count: number, label: string): string => {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
};

const normalizeProjectLabel = (
	directory: string | undefined,
): {
	projectId: string;
	projectLabel: string;
} => {
	const normalizedDirectory = trimToUndefined(directory);
	if (!normalizedDirectory) {
		return {
			projectId: "codex:unknown",
			projectLabel: getSessionSourceLabel("codex"),
		};
	}

	const parts = normalizedDirectory.replace(/[\\/]+$/gu, "").split(/[\\/]/u);
	const projectLabel = parts.filter(Boolean).at(-1) ?? normalizedDirectory;

	return {
		projectId: normalizedDirectory,
		projectLabel,
	};
};

const normalizeTitle = (
	title: string | null | undefined,
	fallbackId: string,
): string => {
	const normalized = trimToUndefined(title)?.replace(/\s+/gu, " ");
	if (!normalized) {
		return `Codex thread ${fallbackId.slice(0, 8)}`;
	}

	if (normalized.length <= 160) {
		return normalized;
	}

	return `${normalized.slice(0, 157)}...`;
};

const humanizeIdentifier = (value: string): string | undefined => {
	const normalized = trimToUndefined(value.replace(/[_-]+/gu, " "));
	if (!normalized) {
		return undefined;
	}

	const lower = normalized.toLowerCase();
	return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const getLastPathSegment = (value: string | undefined): string | undefined => {
	const trimmed = trimToUndefined(value);
	if (!trimmed) {
		return undefined;
	}

	const segments = trimmed.split("/").filter(Boolean);
	return trimToUndefined(segments.at(-1));
};

const buildAgentTaskLabel = (
	agentPath: string | undefined,
): string | undefined => {
	const segment = getLastPathSegment(agentPath);
	if (!segment) {
		return undefined;
	}

	return humanizeIdentifier(segment);
};

const resolveSubagentTitleCandidate = (params: {
	thread: CodexThreadRow;
	summary?: CodexSessionLogSummary;
	parsedSource: ParsedCodexThreadSource;
}): string | undefined => {
	const assignment = params.summary?.subagentAssignment;
	if (assignment) {
		return assignment.content;
	}

	const agentPath =
		trimToUndefined(params.summary?.sessionMeta?.agent_path) ??
		trimToUndefined(params.parsedSource.agentPath);
	const taskLabel = buildAgentTaskLabel(agentPath);
	if (taskLabel) {
		return taskLabel;
	}

	const agentNickname = trimToUndefined(params.thread.agent_nickname);
	const agentRole = trimToUndefined(params.thread.agent_role);
	if (agentNickname && agentRole) {
		return `${agentNickname} (${agentRole})`;
	}

	return agentNickname ?? agentRole;
};

const resolveCodexTitle = (params: {
	thread: CodexThreadRow;
	summary?: CodexSessionLogSummary;
	parsedSource: ParsedCodexThreadSource;
	directory: string;
}): string => {
	const explicitTitle = trimToUndefined(params.thread.title);
	if (explicitTitle) {
		return normalizeTitle(explicitTitle, params.thread.id);
	}

	return normalizeTitle(
		resolveSubagentTitleCandidate(params),
		params.thread.id,
	);
};

const parseCodexThreadSource = (
	rawSource: string | null | undefined,
): ParsedCodexThreadSource => {
	const trimmed = trimToUndefined(rawSource);
	if (!trimmed) {
		return {
			sourceCategory: "unknown",
			sourceLabel: "Unknown",
		};
	}

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as {
				subagent?: {
					thread_spawn?: {
						parent_thread_id?: string;
						agent_role?: string;
						agent_nickname?: string;
						agent_path?: string;
					};
				};
			};
			const threadSpawn = parsed.subagent?.thread_spawn;
			return {
				rawSource: trimmed,
				sourceCategory: "subagent",
				sourceLabel: "Subagent",
				parentThreadId: trimToUndefined(threadSpawn?.parent_thread_id),
				agentRole: trimToUndefined(threadSpawn?.agent_role),
				agentNickname: trimToUndefined(threadSpawn?.agent_nickname),
				agentPath: trimToUndefined(threadSpawn?.agent_path),
			};
		} catch {
			return {
				rawSource: trimmed,
				sourceCategory: "json",
				sourceLabel: "JSON source",
			};
		}
	}

	const normalized = trimmed.toLowerCase();
	const labelMap: Record<string, string> = {
		cli: "CLI",
		exec: "Exec",
		vscode: "VS Code",
		app: "App",
		api: "API",
	};

	return {
		rawSource: trimmed,
		sourceCategory: normalized,
		sourceLabel: labelMap[normalized] ?? trimmed,
	};
};

const resolveCodexStateDatabasePath = (): string => {
	const overridePath = trimToUndefined(process.env.GCTRL_CODEX_STATE_DB_PATH);
	if (overridePath) {
		return overridePath;
	}

	const candidates = readdirSync(CODEX_ROOT, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() && /^state(?:_[^/]+)?\.sqlite$/u.test(entry.name),
		)
		.map((entry) => join(CODEX_ROOT, entry.name))
		.sort((left, right) => {
			try {
				return statSync(right).mtimeMs - statSync(left).mtimeMs;
			} catch {
				return 0;
			}
		});

	return candidates[0] ?? `${CODEX_ROOT}/state_5.sqlite`;
};

const resolveCodexSessionsDirectory = (): string => {
	return (
		trimToUndefined(process.env.GCTRL_CODEX_SESSIONS_DIR) ??
		DEFAULT_CODEX_SESSIONS_DIR
	);
};

const resolveCodexArchivedSessionsDirectory = (): string => {
	return (
		trimToUndefined(process.env.GCTRL_CODEX_ARCHIVED_SESSIONS_DIR) ??
		DEFAULT_CODEX_ARCHIVED_SESSIONS_DIR
	);
};

const resolveCodexSessionIndexPath = (): string => {
	return (
		trimToUndefined(process.env.GCTRL_CODEX_SESSION_INDEX_PATH) ??
		DEFAULT_CODEX_SESSION_INDEX_PATH
	);
};

const buildThreadEdgeStats = (
	edges: CodexThreadSpawnEdgeRow[],
): Map<string, ThreadEdgeStats> => {
	const stats = new Map<string, ThreadEdgeStats>();

	for (const edge of edges) {
		const entry = stats.get(edge.parent_thread_id) ?? {
			openChildCount: 0,
			closedChildCount: 0,
		};
		if (trimToUndefined(edge.status)?.toLowerCase() === "open") {
			entry.openChildCount += 1;
		} else {
			entry.closedChildCount += 1;
		}
		stats.set(edge.parent_thread_id, entry);
	}

	return stats;
};

const buildEdgesByParentThreadId = (
	edges: CodexThreadSpawnEdgeRow[],
): Map<string, CodexThreadSpawnEdgeRow[]> => {
	const edgesByParentThreadId = new Map<string, CodexThreadSpawnEdgeRow[]>();

	for (const edge of edges) {
		const current = edgesByParentThreadId.get(edge.parent_thread_id) ?? [];
		current.push(edge);
		edgesByParentThreadId.set(edge.parent_thread_id, current);
	}

	return edgesByParentThreadId;
};

export const summarizeCodexSessionLogContent = (
	content: string,
): CodexSessionLogSummary => {
	const summary: CodexSessionLogSummary = {
		messageCount: 0,
		taskState: "unknown",
	};
	const activeToolCalls = new Map<string, ActiveCodexToolCall>();

	for (const line of content.split(/\r?\n/gu)) {
		if (!line.trim()) {
			continue;
		}

		const entry = JSON.parse(line) as {
			timestamp?: string;
			type?: string;
			payload?: Record<string, unknown>;
		};
		const payload = (entry.payload ?? {}) as Record<string, unknown>;
		const payloadType = getPayloadString(payload, "type");
		const timestampMs = parseIsoTimestampMs(entry.timestamp);

		if (
			entry.type === "response_item" &&
			(payloadType === "function_call" || payloadType === "custom_tool_call")
		) {
			const callId = getPayloadString(payload, "call_id");
			const toolName =
				getPayloadString(payload, "name") ??
				`${payloadType.replace(/_/gu, " ")}`;
			const status = getPayloadString(payload, "status");
			if (callId && status !== "completed") {
				activeToolCalls.set(callId, {
					name: toolName,
					expiresAtMs: getExecCommandExpiresAtMs({
						toolName,
						argumentsJson: getPayloadString(payload, "arguments"),
						timestampMs,
					}),
					requiresApproval:
						payloadType === "function_call" &&
						isApprovalRequiredFunctionCall(payload),
				});
			}
			continue;
		}

		if (
			entry.type === "response_item" &&
			(payloadType === "function_call_output" ||
				payloadType === "custom_tool_call_output")
		) {
			const callId = getPayloadString(payload, "call_id");
			if (callId) {
				activeToolCalls.delete(callId);
			}
			continue;
		}

		if (entry.type === "event_msg" && payloadType === "mcp_tool_call_end") {
			const callId = getPayloadString(payload, "call_id");
			if (callId) {
				activeToolCalls.delete(callId);
			}
			continue;
		}

		if (entry.type === "session_meta") {
			summary.sessionMeta = payload as CodexSessionMetaPayload;
			continue;
		}

		if (entry.type === "response_item" && payload.type === "message") {
			if (!summary.subagentAssignment) {
				const assignment = parseSubagentAssignment(
					getResponseMessageText(payload),
				);
				if (assignment && isAssignmentForCurrentSubagent(summary, assignment)) {
					summary.subagentAssignment = assignment;
				}
			}
			summary.messageCount += 1;
			continue;
		}

		if (entry.type !== "event_msg") {
			continue;
		}

		const eventType = trimToUndefined(payload.type as string | undefined);
		if (!eventType) {
			continue;
		}

		summary.lastEventType = eventType;
		summary.lastTurnId = trimToUndefined(payload.turn_id as string | undefined);

		if (eventType === "user_message" || eventType === "agent_message") {
			summary.messageCount += 1;
		}

		if (eventType === "task_started") {
			summary.taskState = "running";
			summary.waitingForApproval = false;
			summary.waitingForUser = false;
			summary.abortedReason = undefined;
			summary.completedAtMs = undefined;
			summary.startedAtMs =
				normalizeTimestampMs(getPayloadNumber(payload, "started_at")) ??
				parseIsoTimestampMs(entry.timestamp);
			activeToolCalls.clear();
			continue;
		}

		if (eventType === "task_complete") {
			summary.taskState = "completed";
			summary.waitingForApproval = false;
			summary.waitingForUser = false;
			summary.abortedReason = undefined;
			summary.completedAtMs =
				normalizeTimestampMs(getPayloadNumber(payload, "completed_at")) ??
				parseIsoTimestampMs(entry.timestamp);
			summary.lastAgentMessage = trimToUndefined(
				payload.last_agent_message as string | undefined,
			);
			activeToolCalls.clear();
			continue;
		}

		if (eventType === "turn_aborted") {
			summary.taskState = "aborted";
			summary.waitingForApproval = false;
			summary.waitingForUser = false;
			summary.abortedReason = trimToUndefined(
				payload.reason as string | undefined,
			);
			summary.completedAtMs =
				normalizeTimestampMs(getPayloadNumber(payload, "completed_at")) ??
				parseIsoTimestampMs(entry.timestamp);
			activeToolCalls.clear();
		}
	}

	if (summary.taskState === "running") {
		const nowMs = Date.now();
		const activeCalls = [...activeToolCalls.values()];
		const approvalCalls = activeCalls.filter((call) => call.requiresApproval);
		const regularCalls = activeCalls.filter((call) => !call.requiresApproval);
		const unexpiredRegularCalls = regularCalls.filter(
			(call) => !call.expiresAtMs || call.expiresAtMs > nowMs,
		);
		summary.activeToolNames =
			unexpiredRegularCalls.length > 0
				? [...new Set(unexpiredRegularCalls.map((call) => call.name))]
				: undefined;
		summary.waitingForApproval =
			unexpiredRegularCalls.length === 0 && approvalCalls.length > 0;
		summary.waitingForUser =
			!summary.waitingForApproval &&
			regularCalls.length > 0 &&
			unexpiredRegularCalls.length === 0;
	}

	return summary;
};

const logPathCache = new Map<string, string>();
let logIndexRoot: string | null = null;
let logIndexBuiltAt = 0;
const logSummaryCache = new Map<
	string,
	{ mtimeMs: number; summary: CodexSessionLogSummary }
>();

const extractThreadIdFromLogPath = (path: string): string | null => {
	const match = basename(path).match(/([0-9a-f-]{36})\.jsonl$/iu);
	return match?.[1] ?? null;
};

const collectSessionLogPaths = (directory: string, paths: string[]): void => {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectSessionLogPaths(fullPath, paths);
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			paths.push(fullPath);
		}
	}
};

const ensureCodexLogIndex = (sessionsDirectory: string): void => {
	const shouldRebuild =
		logIndexRoot !== sessionsDirectory ||
		Date.now() - logIndexBuiltAt > LOG_INDEX_REFRESH_MS;
	if (!shouldRebuild) {
		return;
	}

	logPathCache.clear();
	if (!existsSync(sessionsDirectory)) {
		logIndexRoot = sessionsDirectory;
		logIndexBuiltAt = Date.now();
		return;
	}

	const paths: string[] = [];
	collectSessionLogPaths(sessionsDirectory, paths);
	for (const path of paths) {
		const threadId = extractThreadIdFromLogPath(path);
		if (threadId) {
			logPathCache.set(threadId, path);
		}
	}

	logIndexRoot = sessionsDirectory;
	logIndexBuiltAt = Date.now();
};

export const invalidateCodexSessionCaches = (): void => {
	logPathCache.clear();
	logSummaryCache.clear();
	logIndexRoot = null;
	logIndexBuiltAt = 0;
};

const readCodexLogSummary = (
	threadId: string,
	sessionsDirectory: string,
): { summary?: CodexSessionLogSummary; issue?: string } => {
	ensureCodexLogIndex(sessionsDirectory);
	const path = logPathCache.get(threadId);
	if (!path) {
		return {};
	}

	try {
		const stats = statSync(path);
		const cached = logSummaryCache.get(path);
		if (cached && cached.mtimeMs === stats.mtimeMs) {
			return { summary: cached.summary };
		}

		const summary = summarizeCodexSessionLogContent(readFileSync(path, "utf8"));
		logSummaryCache.set(path, { mtimeMs: stats.mtimeMs, summary });
		return { summary };
	} catch (error) {
		return {
			issue:
				error instanceof Error
					? error.message
					: `Failed to parse Codex session log for ${threadId}`,
		};
	}
};

export const resolveCodexStatus = (params: {
	summary?: CodexSessionLogSummary;
	edgeStats?: ThreadEdgeStats;
}): CodexStatusResolution => {
	const { summary, edgeStats } = params;
	const openChildCount = edgeStats?.openChildCount ?? 0;
	const lastEventType = trimToUndefined(summary?.lastEventType);

	if (summary?.taskState === "running") {
		if (summary.waitingForApproval) {
			return {
				status: SessionStatus.waiting,
				finishReason: "awaiting_approval",
				statusDetail: "Awaiting approval",
			};
		}

		if (summary.waitingForUser) {
			return {
				status: SessionStatus.waiting,
				finishReason: "awaiting_user",
				statusDetail: "Awaiting user input",
			};
		}

		return {
			status: SessionStatus.running,
			finishReason: "task_started",
			statusDetail:
				openChildCount > 0
					? `Task running with ${toHumanCountLabel(openChildCount, "open child thread")}`
					: "Task running",
		};
	}

	if (openChildCount > 0) {
		return {
			status: SessionStatus.running,
			finishReason:
				summary?.taskState === "completed"
					? "awaiting_child_threads"
					: "open_child_threads",
			statusDetail:
				summary?.taskState === "completed"
					? `Awaiting ${toHumanCountLabel(openChildCount, "child thread")}`
					: `${toHumanCountLabel(openChildCount, "open child thread")} detected`,
		};
	}

	if (summary?.taskState === "completed") {
		return {
			status: SessionStatus.completed,
			finishReason: "task_complete",
			statusDetail: "Task complete",
		};
	}

	if (summary?.taskState === "aborted") {
		const abortedReason = trimToUndefined(summary.abortedReason);
		return {
			status: SessionStatus.unknown,
			finishReason: "turn_aborted",
			statusDetail: abortedReason
				? `Turn aborted (${abortedReason})`
				: "Turn aborted",
		};
	}

	return {
		status: SessionStatus.unknown,
		statusDetail: lastEventType
			? `Last event: ${lastEventType.replace(/_/gu, " ")}`
			: "No Codex task history recorded",
	};
};

const buildSourceMetadata = (params: {
	parsedSource: ParsedCodexThreadSource;
	thread: CodexThreadRow;
	summary?: CodexSessionLogSummary;
	edgeStats?: ThreadEdgeStats;
}): SessionSourceMetadata => {
	const { parsedSource, thread, summary, edgeStats } = params;
	return {
		originator: trimToUndefined(summary?.sessionMeta?.originator),
		cliVersion: trimToUndefined(summary?.sessionMeta?.cli_version),
		rawSource: parsedSource.rawSource,
		sourceCategory: parsedSource.sourceLabel,
		agentRole:
			trimToUndefined(thread.agent_role) ??
			trimToUndefined(parsedSource.agentRole),
		agentNickname:
			trimToUndefined(thread.agent_nickname) ??
			trimToUndefined(parsedSource.agentNickname),
		reasoningEffort: trimToUndefined(thread.reasoning_effort),
		lastEventType: trimToUndefined(summary?.lastEventType),
		lastTurnId: trimToUndefined(summary?.lastTurnId),
		abortedReason: trimToUndefined(summary?.abortedReason),
		openChildCount: edgeStats?.openChildCount,
		closedChildCount: edgeStats?.closedChildCount,
	};
};

const buildCodexSessionRecord = (params: {
	thread: CodexThreadRow;
	parentId: string | null;
	summary?: CodexSessionLogSummary;
	parsedSource: ParsedCodexThreadSource;
	edgeStats?: ThreadEdgeStats;
}): SessionRecord & {
	currentAgent?: string;
	currentModelID?: string;
	currentReasoningEffort?: string;
	providerID?: string;
	status?: SessionStatus;
	statusDetail?: string;
	finishReason?: string;
	sourceMetadata: SessionSourceMetadata;
} => {
	const { thread, parentId, summary, parsedSource, edgeStats } = params;
	const directory =
		trimToUndefined(thread.cwd) ??
		trimToUndefined(summary?.sessionMeta?.cwd) ??
		"";
	const { projectId, projectLabel } = normalizeProjectLabel(directory);
	const statusResolution = resolveCodexStatus({ summary, edgeStats });

	return {
		id: thread.id,
		title: resolveCodexTitle({
			thread,
			summary,
			parsedSource,
			directory,
		}),
		directory,
		project_id: projectId,
		project_label: projectLabel,
		parent_id: parentId,
		time_created:
			normalizeTimestampMs(thread.created_at_ms) ??
			parseIsoTimestampMs(summary?.sessionMeta?.timestamp) ??
			0,
		time_updated:
			normalizeTimestampMs(thread.updated_at_ms) ??
			summary?.completedAtMs ??
			summary?.startedAtMs ??
			Date.now(),
		currentAgent:
			trimToUndefined(thread.agent_nickname) ??
			trimToUndefined(thread.agent_role) ??
			trimToUndefined(summary?.sessionMeta?.originator),
		currentModelID: trimToUndefined(thread.model),
		currentReasoningEffort: trimToUndefined(thread.reasoning_effort),
		providerID:
			trimToUndefined(thread.model_provider) ??
			trimToUndefined(summary?.sessionMeta?.model_provider),
		status: statusResolution.status,
		statusDetail: statusResolution.statusDetail,
		finishReason: statusResolution.finishReason,
		sourceMetadata: buildSourceMetadata({
			parsedSource,
			thread,
			summary,
			edgeStats,
		}),
	};
};

const resolveRootId = (
	threadId: string,
	parentByChildId: Map<string, string>,
): string | null => {
	const visited = new Set<string>();
	let currentId = threadId;

	while (true) {
		if (visited.has(currentId)) {
			return null;
		}
		visited.add(currentId);
		const parentId = parentByChildId.get(currentId);
		if (!parentId || parentId === currentId) {
			return currentId;
		}
		currentId = parentId;
	}
};

export const buildCodexSessionSnapshot = (params: {
	threads: CodexThreadRow[];
	edges: CodexThreadSpawnEdgeRow[];
	logSummaries?: Partial<Record<string, CodexSessionLogSummary>>;
	logIssues?: Partial<Record<string, string>>;
}): SessionSnapshot => {
	const { threads, edges, logSummaries = {}, logIssues = {} } = params;
	const statusBySessionId: Partial<Record<string, SessionStatus>> = {};
	const messageCountBySessionId: Partial<Record<string, number>> = {};
	const sessionIssues: Partial<Record<string, string>> = { ...logIssues };
	const edgeStatsByThreadId = buildThreadEdgeStats(edges);
	const edgesByParentThreadId = buildEdgesByParentThreadId(edges);
	const parsedSourceByThreadId = new Map(
		threads.map((thread) => [thread.id, parseCodexThreadSource(thread.source)]),
	);
	const parentByChildId = new Map<string, string>();

	for (const edge of edges) {
		parentByChildId.set(edge.child_thread_id, edge.parent_thread_id);
	}

	for (const thread of threads) {
		if (parentByChildId.has(thread.id)) {
			continue;
		}

		const parsedSource = parsedSourceByThreadId.get(thread.id);
		if (parsedSource?.parentThreadId) {
			parentByChildId.set(thread.id, parsedSource.parentThreadId);
		}
	}

	const sessionsById = new Map<
		string,
		(Session | SubagentSession) & { sessionSource: "codex" }
	>();
	for (const thread of threads) {
		const session = buildCodexSessionRecord({
			thread,
			parentId: parentByChildId.get(thread.id) ?? null,
			summary: logSummaries[thread.id],
			parsedSource: parsedSourceByThreadId.get(thread.id) ?? {
				sourceCategory: "unknown",
				sourceLabel: "Unknown",
			},
			edgeStats: edgeStatsByThreadId.get(thread.id),
		});
		const enrichedSession = {
			...session,
			sessionSource: "codex" as const,
			capabilities: getDefaultSessionCapabilities("codex"),
			sourceMetadata: {
				...session.sourceMetadata,
				sourceCategory: session.sourceMetadata.sourceCategory,
			},
		};
		sessionsById.set(thread.id, enrichedSession);
		statusBySessionId[thread.id] = enrichedSession.status;
		if (typeof logSummaries[thread.id]?.messageCount === "number") {
			messageCountBySessionId[thread.id] =
				logSummaries[thread.id]?.messageCount;
		}
	}

	const rootSessionsById = new Map<string, Session>();
	for (const thread of threads) {
		const normalizedSession = sessionsById.get(thread.id);
		if (!normalizedSession) {
			continue;
		}

		const rootId = resolveRootId(thread.id, parentByChildId);
		if (!rootId) {
			sessionIssues[thread.id] = "Codex thread hierarchy contains a cycle.";
			rootSessionsById.set(thread.id, {
				...(normalizedSession as Session),
				subagentSessions: [],
			});
			continue;
		}

		if (rootId === thread.id) {
			rootSessionsById.set(thread.id, {
				...(normalizedSession as Session),
				subagentSessions: [],
			});
			continue;
		}

		const rootSession =
			rootSessionsById.get(rootId) ??
			(() => {
				const rootCandidate = sessionsById.get(rootId);
				if (!rootCandidate) {
					sessionIssues[thread.id] = "Codex root thread could not be resolved.";
					return null;
				}

				const createdRoot = {
					...(rootCandidate as Session),
					subagentSessions: [],
				};
				rootSessionsById.set(rootId, createdRoot);
				return createdRoot;
			})();

		if (!rootSession) {
			continue;
		}

		rootSession.subagentSessions = [
			...(rootSession.subagentSessions ?? []),
			normalizedSession as SubagentSession,
		];
	}

	const childSessionsByParentId = new Map<string, SubagentSession[]>();
	for (const session of sessionsById.values()) {
		if (!session.parent_id) {
			continue;
		}

		const siblings = childSessionsByParentId.get(session.parent_id) ?? [];
		siblings.push(session as SubagentSession);
		childSessionsByParentId.set(session.parent_id, siblings);
	}

	const resolvedThreadIds = new Set<string>();
	const reconcileThreadStatus = (threadId: string): void => {
		if (resolvedThreadIds.has(threadId)) {
			return;
		}

		const session = sessionsById.get(threadId);
		if (!session) {
			return;
		}

		const childSessions = childSessionsByParentId.get(threadId) ?? [];
		for (const childSession of childSessions) {
			reconcileThreadStatus(childSession.id);
		}

		const childSessionById = new Map(
			childSessions.map((childSession) => [childSession.id, childSession]),
		);
		const nextEdgeStats: ThreadEdgeStats = {
			openChildCount: 0,
			closedChildCount: 0,
		};

		for (const edge of edgesByParentThreadId.get(threadId) ?? []) {
			const childSession = childSessionById.get(edge.child_thread_id);
			if (childSession) {
				if (isActiveStatus(childSession.status)) {
					nextEdgeStats.openChildCount += 1;
				} else {
					nextEdgeStats.closedChildCount += 1;
				}
				childSessionById.delete(edge.child_thread_id);
				continue;
			}

			if (trimToUndefined(edge.status)?.toLowerCase() === "open") {
				nextEdgeStats.openChildCount += 1;
			} else {
				nextEdgeStats.closedChildCount += 1;
			}
		}

		for (const childSession of childSessionById.values()) {
			if (isActiveStatus(childSession.status)) {
				nextEdgeStats.openChildCount += 1;
			} else {
				nextEdgeStats.closedChildCount += 1;
			}
		}

		const nextStatus = resolveCodexStatus({
			summary: logSummaries[threadId],
			edgeStats: nextEdgeStats,
		});
		session.status = nextStatus.status;
		session.statusDetail = nextStatus.statusDetail;
		session.finishReason = nextStatus.finishReason;
		session.sourceMetadata = {
			...(session.sourceMetadata ?? {}),
			openChildCount: nextEdgeStats.openChildCount,
			closedChildCount: nextEdgeStats.closedChildCount,
		};
		statusBySessionId[threadId] = nextStatus.status;
		const rootSession = rootSessionsById.get(threadId);
		if (rootSession && rootSession !== session) {
			rootSession.status = session.status;
			rootSession.statusDetail = session.statusDetail;
			rootSession.finishReason = session.finishReason;
			rootSession.sourceMetadata = session.sourceMetadata;
		}
		resolvedThreadIds.add(threadId);
	};

	for (const thread of threads) {
		reconcileThreadStatus(thread.id);
	}

	return {
		sessions: [...rootSessionsById.values()].sort(
			(left, right) => right.time_updated - left.time_updated,
		),
		statusBySessionId,
		messageCountBySessionId,
		sessionIssues,
		sourceIssues: [],
	};
};

export const getCodexSnapshot = (): DatabaseResult<SessionSnapshot> => {
	const databasePath = resolveCodexStateDatabasePath();
	const sessionsDirectory = resolveCodexSessionsDirectory();
	if (!existsSync(databasePath)) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				new Error(`Missing Codex state database at ${databasePath}`),
				"Codex state database is not available.",
			),
		};
	}

	let database: Database | null = null;
	try {
		database = new Database(databasePath, { readonly: true });
		const threadRows = database
			.query<CodexThreadRow, []>(`
				SELECT
					id,
					source,
					model_provider,
					cwd,
					title,
					agent_role,
					agent_nickname,
					model,
					reasoning_effort,
					archived,
					created_at_ms,
					updated_at_ms
				FROM threads
				WHERE archived = 0
				ORDER BY updated_at_ms DESC
			`)
			.all() as CodexThreadRow[];
		const edgeRows = database
			.query<CodexThreadSpawnEdgeRow, []>(`
				SELECT parent_thread_id, child_thread_id, status
				FROM thread_spawn_edges
			`)
			.all() as CodexThreadSpawnEdgeRow[];
		const logSummaries: Partial<Record<string, CodexSessionLogSummary>> = {};
		const logIssues: Partial<Record<string, string>> = {};

		for (const thread of threadRows) {
			const logResult = readCodexLogSummary(thread.id, sessionsDirectory);
			if (logResult.summary) {
				logSummaries[thread.id] = logResult.summary;
			}
			if (logResult.issue) {
				logIssues[thread.id] = `Codex log error: ${logResult.issue}`;
			}
		}

		return {
			ok: true,
			value: buildCodexSessionSnapshot({
				threads: threadRows,
				edges: edgeRows,
				logSummaries,
				logIssues,
			}),
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				"Codex query execution failed.",
			),
		};
	} finally {
		try {
			database?.close();
		} catch {}
	}
};

const buildSqlPlaceholders = (values: string[]): string => {
	return values.map(() => "?").join(", ");
};

const getCodexThreadTreeIds = (
	database: Database,
	threadId: string,
): string[] => {
	const rows = database
		.query<{ id: string }, [string]>(
			`
				WITH RECURSIVE thread_tree(id) AS (
					SELECT ?
					UNION
					SELECT edge.child_thread_id
					FROM thread_spawn_edges AS edge
					INNER JOIN thread_tree ON thread_tree.id = edge.parent_thread_id
				)
				SELECT id
				FROM thread_tree
			`,
		)
		.all(threadId) as Array<{ id: string }>;

	const ids = rows
		.map((row) => trimToUndefined(row.id))
		.filter((value): value is string => Boolean(value));

	return ids.length > 0 ? ids : [threadId];
};

const getCodexThreadRolloutRows = (
	database: Database,
	threadIds: string[],
): CodexDeleteThreadRow[] => {
	if (threadIds.length === 0) {
		return [];
	}

	const placeholders = buildSqlPlaceholders(threadIds);
	return database
		.query<CodexDeleteThreadRow, string[]>(
			`
				SELECT id, rollout_path
				FROM threads
				WHERE id IN (${placeholders})
			`,
		)
		.all(...threadIds) as CodexDeleteThreadRow[];
};

const collectCodexRolloutPathsFromDirectory = (
	directory: string,
	threadIds: Set<string>,
	paths: Set<string>,
): void => {
	if (!existsSync(directory)) {
		return;
	}

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectCodexRolloutPathsFromDirectory(fullPath, threadIds, paths);
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		const threadId = extractThreadIdFromLogPath(fullPath);
		if (threadId && threadIds.has(threadId)) {
			paths.add(fullPath);
		}
	}
};

const collectCodexRolloutPaths = (params: {
	threadIds: string[];
	rolloutRows: CodexDeleteThreadRow[];
	sessionsDirectory: string;
	archivedSessionsDirectory: string;
}): string[] => {
	const {
		threadIds,
		rolloutRows,
		sessionsDirectory,
		archivedSessionsDirectory,
	} = params;
	const threadIdSet = new Set(threadIds);
	const pathSet = new Set<string>();

	for (const row of rolloutRows) {
		const rolloutPath = trimToUndefined(row.rollout_path);
		if (rolloutPath) {
			pathSet.add(rolloutPath);
		}
	}

	collectCodexRolloutPathsFromDirectory(
		sessionsDirectory,
		threadIdSet,
		pathSet,
	);
	collectCodexRolloutPathsFromDirectory(
		archivedSessionsDirectory,
		threadIdSet,
		pathSet,
	);

	return [...pathSet];
};

const deleteCodexRolloutFiles = (paths: string[]): string[] => {
	const deletedPaths: string[] = [];

	for (const path of paths) {
		if (!existsSync(path)) {
			continue;
		}

		unlinkSync(path);
		deletedPaths.push(path);
	}

	return deletedPaths;
};

const rewriteCodexSessionIndex = (
	sessionIndexPath: string,
	threadIdSet: Set<string>,
): number => {
	if (!existsSync(sessionIndexPath)) {
		return 0;
	}

	const originalContent = readFileSync(sessionIndexPath, "utf8");
	const keptLines: string[] = [];
	let removedEntries = 0;

	for (const line of originalContent.split(/\r?\n/gu)) {
		if (!line.trim()) {
			continue;
		}

		try {
			const entry = JSON.parse(line) as { id?: string };
			if (entry.id && threadIdSet.has(entry.id)) {
				removedEntries += 1;
				continue;
			}
		} catch {}

		keptLines.push(line);
	}

	const nextContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
	if (nextContent === originalContent) {
		return 0;
	}

	const tempPath = `${sessionIndexPath}.tmp`;
	writeFileSync(tempPath, nextContent);
	renameSync(tempPath, sessionIndexPath);
	return removedEntries;
};

const deleteCodexThreadMetadata = (
	database: Database,
	threadIds: string[],
): void => {
	if (threadIds.length === 0) {
		return;
	}

	const existingTables = new Set(
		(
			database
				.query<{ name: string }, []>(
					`
						SELECT name
						FROM sqlite_master
						WHERE type = 'table'
					`,
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	);
	const placeholders = buildSqlPlaceholders(threadIds);
	const transaction = database.transaction((ids: string[]) => {
		if (existingTables.has("thread_dynamic_tools")) {
			database
				.query(
					`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${placeholders})`,
				)
				.run(...ids);
		}

		if (existingTables.has("stage1_outputs")) {
			database
				.query(
					`DELETE FROM stage1_outputs WHERE thread_id IN (${placeholders})`,
				)
				.run(...ids);
		}

		if (existingTables.has("thread_spawn_edges")) {
			database
				.query(
					`
						DELETE FROM thread_spawn_edges
						WHERE child_thread_id IN (${placeholders})
						   OR parent_thread_id IN (${placeholders})
					`,
				)
				.run(...ids, ...ids);
		}

		database
			.query(`DELETE FROM threads WHERE id IN (${placeholders})`)
			.run(...ids);
	});

	transaction(threadIds);
};

const archiveCodexThreadViaAppServer = async (
	threadId: string,
	codexExecutable: string,
): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			codexExecutable,
			["app-server", "--listen", "stdio://"],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let lineBuffer = "";
		let settled = false;
		const timeout = setTimeout(() => {
			finishWithError("Codex app-server archive request timed out.");
		}, 10_000);

		const cleanup = () => {
			clearTimeout(timeout);
			child.stdout?.removeAllListeners();
			child.stderr?.removeAllListeners();
			child.removeAllListeners();
			if (child.stdin && !child.stdin.destroyed) {
				child.stdin.end();
			}
			if (child.exitCode === null) {
				try {
					child.kill("SIGTERM");
				} catch {}
			}
		};

		const finishWithError = (fallbackMessage: string) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(
				new Error(
					trimToUndefined(stderrBuffer || stdoutBuffer) ?? fallbackMessage,
				),
			);
		};

		const finishSuccessfully = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve();
		};

		const handleStdoutLine = (line: string) => {
			let message: { id?: number; error?: { message?: string } };
			try {
				message = JSON.parse(line) as {
					id?: number;
					error?: { message?: string };
				};
			} catch {
				return;
			}

			if (message.id !== 1) {
				return;
			}

			if (message.error?.message) {
				finishWithError(message.error.message);
				return;
			}

			finishSuccessfully();
		};

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			lineBuffer += chunk;
			const lines = lineBuffer.split(/\r?\n/gu);
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmedLine = line.trim();
				if (trimmedLine) {
					handleStdoutLine(trimmedLine);
				}
			}
		});

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderrBuffer += chunk;
		});

		child.on("error", (error) => {
			finishWithError(error.message);
		});

		child.on("exit", (code) => {
			if (lineBuffer.trim()) {
				handleStdoutLine(lineBuffer.trim());
			}
			if (settled) {
				return;
			}
			if (code === 0) {
				finishWithError(
					"Codex app-server did not return a thread/archive response.",
				);
				return;
			}
			finishWithError(
				`codex app-server exited with code ${code ?? "unknown"}.`,
			);
		});

		child.stdin.write(
			`${JSON.stringify({
				id: 0,
				method: "initialize",
				params: {
					clientInfo: {
						name: "ground-control",
						title: "ground-control",
						version: "0.0.0",
					},
				},
			})}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({
				method: "initialized",
				params: {},
			})}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({
				id: 1,
				method: "thread/archive",
				params: {
					threadId,
				},
			})}\n`,
		);
	});
};

export const deleteCodexSession = async (
	threadId: string,
	options: DeleteCodexSessionOptions = {},
): Promise<DatabaseResult<CodexDeleteResult>> => {
	const databasePath = options.databasePath ?? resolveCodexStateDatabasePath();
	const sessionsDirectory =
		options.sessionsDirectory ?? resolveCodexSessionsDirectory();
	const archivedSessionsDirectory =
		options.archivedSessionsDirectory ??
		resolveCodexArchivedSessionsDirectory();
	const sessionIndexPath =
		options.sessionIndexPath ?? resolveCodexSessionIndexPath();

	if (!existsSync(databasePath)) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				new Error(`Missing Codex state database at ${databasePath}`),
				"Codex state database is not available.",
			),
		};
	}

	let database: Database | null = null;
	try {
		database = new Database(databasePath);
		const threadIds = getCodexThreadTreeIds(database, threadId);

		if (!options.skipArchiveRequest) {
			const codexExecutable =
				options.codexExecutable ?? Bun.which("codex") ?? "codex";
			await archiveCodexThreadViaAppServer(threadId, codexExecutable);
		}

		const rolloutRows = getCodexThreadRolloutRows(database, threadIds);
		const rolloutPaths = collectCodexRolloutPaths({
			threadIds,
			rolloutRows,
			sessionsDirectory,
			archivedSessionsDirectory,
		});
		const deletedRolloutPaths = deleteCodexRolloutFiles(rolloutPaths);
		deleteCodexThreadMetadata(database, threadIds);
		const deletedSessionIndexEntries = rewriteCodexSessionIndex(
			sessionIndexPath,
			new Set(threadIds),
		);
		invalidateCodexSessionCaches();

		return {
			ok: true,
			value: {
				deletedThreadIds: threadIds,
				deletedRolloutPaths,
				deletedSessionIndexEntries,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				"Codex session delete failed.",
			),
		};
	} finally {
		try {
			database?.close();
		} catch {}
	}
};
