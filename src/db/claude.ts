import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
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

const CLAUDE_ROOT = `${homedir()}/.claude`;
const DEFAULT_CLAUDE_PROJECTS_DIR = `${CLAUDE_ROOT}/projects`;
const DEFAULT_CLAUDE_ACTIVE_SESSIONS_DIR = `${CLAUDE_ROOT}/sessions`;

type ClaudeTaskState = "running" | "waiting" | "completed" | "unknown";

const CLAUDE_ENTRYPOINT_LABELS: Record<string, string> = {
	cli: "CLI",
	"claude-vscode": "VS Code",
	chrome: "Chrome",
};

export interface ClaudeActiveSessionRecord {
	pid: number;
	sessionId: string;
	cwd?: string;
	startedAt?: number;
	procStart?: string;
	version?: string;
	kind?: string;
	entrypoint?: string;
}

export interface ClaudeSessionLogSummary {
	explicitSessionName?: string;
	aiTitle?: string;
	cwd?: string;
	entrypoint?: string;
	cliVersion?: string;
	gitBranch?: string;
	permissionMode?: string;
	agentId?: string;
	agentNickname?: string;
	messageCount: number;
	currentModelID?: string;
	lastAssistantText?: string;
	firstUserPrompt?: string;
	lastUserPrompt?: string;
	lastAssistantStopReason?: string;
	lastConversationRole?: "user" | "assistant";
	lastUserWasToolResultOnly?: boolean;
	lastEventType?: string;
	taskState: ClaudeTaskState;
	startedAtMs?: number;
	completedAtMs?: number;
	lastTimestampMs?: number;
}

interface ClaudeStatusResolution {
	status: SessionStatus;
	finishReason?: string;
	statusDetail?: string;
}

export interface ClaudeSessionLogRecord {
	id: string;
	parentId: string | null;
	summary?: ClaudeSessionLogSummary;
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

const parseIsoTimestampMs = (value: string | undefined): number | undefined => {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
};

const normalizeTimestampMs = (
	value: number | undefined | null,
): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	return value < 1_000_000_000_000 ? value * 1000 : value;
};

const toHumanCountLabel = (count: number, label: string): string => {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
};

const getClaudeEntryPointLabel = (
	value: string | undefined,
): string | undefined => {
	const trimmed = trimToUndefined(value);
	if (!trimmed) {
		return undefined;
	}

	return CLAUDE_ENTRYPOINT_LABELS[trimmed] ?? trimmed;
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
			projectId: "claude:unknown",
			projectLabel: getSessionSourceLabel("claude"),
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
	title: string | undefined,
	fallbackPrefix: string,
	fallbackId: string,
): string => {
	const normalized = trimToUndefined(title)?.replace(/\s+/gu, " ");
	if (!normalized) {
		return `${fallbackPrefix} ${fallbackId.slice(0, 8)}`;
	}

	if (normalized.length <= 160) {
		return normalized;
	}

	return `${normalized.slice(0, 157)}...`;
};

const extractTextValues = (content: unknown): string[] => {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const values: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			const trimmed = item.trim();
			if (trimmed.length > 0) {
				values.push(trimmed);
			}
			continue;
		}

		if (typeof item !== "object" || item === null) {
			continue;
		}

		const typedItem = item as { type?: string; text?: string };
		if (typedItem.type !== "text") {
			continue;
		}

		const trimmed = trimToUndefined(typedItem.text);
		if (trimmed) {
			values.push(trimmed);
		}
	}

	return values;
};

const extractLastTextValue = (content: unknown): string | undefined => {
	return extractTextValues(content).at(-1);
};

const parseClaudeLocalCommand = (
	content: string | undefined,
): {
	commandName?: string;
	commandArgs?: string;
} => {
	const trimmed = trimToUndefined(content);
	if (!trimmed) {
		return {};
	}

	const readTagValue = (tagName: string): string | undefined => {
		const match = trimmed.match(
			new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "u"),
		);
		return trimToUndefined(match?.[1]);
	};

	return {
		commandName: readTagValue("command-name"),
		commandArgs: readTagValue("command-args"),
	};
};

const isToolResultOnlyUserContent = (content: unknown): boolean => {
	if (!Array.isArray(content) || content.length === 0) {
		return false;
	}

	return content.every((item) => {
		if (typeof item !== "object" || item === null) {
			return false;
		}

		return (item as { type?: string }).type === "tool_result";
	});
};

const updateSummaryTimestamp = (
	summary: ClaudeSessionLogSummary,
	timestampMs: number | undefined,
): void => {
	if (!timestampMs) {
		return;
	}

	summary.startedAtMs = Math.min(
		summary.startedAtMs ?? timestampMs,
		timestampMs,
	);
	summary.lastTimestampMs = Math.max(
		summary.lastTimestampMs ?? timestampMs,
		timestampMs,
	);
};

export const summarizeClaudeSessionLogContent = (
	content: string,
): ClaudeSessionLogSummary => {
	const summary: ClaudeSessionLogSummary = {
		messageCount: 0,
		taskState: "unknown",
	};
	const countedAssistantIds = new Set<string>();
	const countedUserIds = new Set<string>();

	for (const line of content.split(/\r?\n/gu)) {
		if (!line.trim()) {
			continue;
		}

		const entry = JSON.parse(line) as {
			type?: string;
			subtype?: string;
			timestamp?: string;
			uuid?: string;
			promptId?: string;
			content?: string;
			aiTitle?: string;
			permissionMode?: string;
			cwd?: string;
			version?: string;
			entrypoint?: string;
			gitBranch?: string;
			agentId?: string;
			slug?: string;
			message?: {
				id?: string;
				role?: string;
				content?: unknown;
				model?: string;
				stop_reason?: string | null;
			};
		};

		const timestampMs = parseIsoTimestampMs(trimToUndefined(entry.timestamp));
		updateSummaryTimestamp(summary, timestampMs);
		summary.cwd = trimToUndefined(entry.cwd) ?? summary.cwd;
		summary.cliVersion = trimToUndefined(entry.version) ?? summary.cliVersion;
		summary.entrypoint =
			trimToUndefined(entry.entrypoint) ?? summary.entrypoint;
		summary.gitBranch = trimToUndefined(entry.gitBranch) ?? summary.gitBranch;
		summary.agentId = trimToUndefined(entry.agentId) ?? summary.agentId;
		summary.agentNickname =
			trimToUndefined(entry.slug) ?? summary.agentNickname;

		const entryType = trimToUndefined(entry.type);
		if (entryType) {
			summary.lastEventType = entry.subtype
				? `${entryType}:${entry.subtype}`
				: entryType;
		}

		if (entryType === "ai-title") {
			summary.aiTitle = trimToUndefined(entry.aiTitle) ?? summary.aiTitle;
			continue;
		}

		if (entryType === "permission-mode") {
			summary.permissionMode =
				trimToUndefined(entry.permissionMode) ?? summary.permissionMode;
			continue;
		}

		if (entryType === "system" && entry.subtype === "local_command") {
			const localCommand = parseClaudeLocalCommand(entry.content);
			if (localCommand.commandName === "/rename" && localCommand.commandArgs) {
				summary.explicitSessionName =
					localCommand.commandArgs ?? summary.explicitSessionName;
			}
		}

		const message = entry.message;
		if (!message) {
			continue;
		}

		if (message.role === "user") {
			const promptText = extractLastTextValue(message.content);
			const isToolResultOnly = isToolResultOnlyUserContent(message.content);
			const userMessageId =
				trimToUndefined(entry.promptId) ??
				trimToUndefined(entry.uuid) ??
				`user-${countedUserIds.size}`;

			if (!isToolResultOnly && !countedUserIds.has(userMessageId)) {
				countedUserIds.add(userMessageId);
				summary.messageCount += 1;
			}

			if (promptText) {
				summary.firstUserPrompt = summary.firstUserPrompt ?? promptText;
				summary.lastUserPrompt = promptText;
			}
			summary.lastConversationRole = "user";
			summary.lastUserWasToolResultOnly = isToolResultOnly;
			summary.taskState = "running";
			continue;
		}

		if (message.role !== "assistant") {
			continue;
		}

		const assistantMessageId =
			trimToUndefined(message.id) ??
			trimToUndefined(entry.uuid) ??
			`assistant-${countedAssistantIds.size}`;
		if (!countedAssistantIds.has(assistantMessageId)) {
			countedAssistantIds.add(assistantMessageId);
			summary.messageCount += 1;
		}

		const assistantText = extractLastTextValue(message.content);
		if (assistantText) {
			summary.lastAssistantText = assistantText;
		}

		summary.currentModelID =
			trimToUndefined(message.model) ?? summary.currentModelID;
		summary.lastAssistantStopReason =
			trimToUndefined(message.stop_reason) ?? summary.lastAssistantStopReason;
		summary.lastConversationRole = "assistant";
		summary.lastUserWasToolResultOnly = false;

		if (summary.lastAssistantStopReason === "end_turn") {
			summary.taskState = "completed";
			summary.completedAtMs = timestampMs ?? summary.completedAtMs;
			continue;
		}

		if (summary.lastAssistantStopReason === "tool_use") {
			summary.taskState = "running";
			summary.completedAtMs = undefined;
		}
	}

	return summary;
};

const getActiveClaudeProjectsDirectory = (): string => {
	return (
		trimToUndefined(process.env.GCTRL_CLAUDE_PROJECTS_DIR) ??
		DEFAULT_CLAUDE_PROJECTS_DIR
	);
};

const getActiveClaudeSessionsDirectory = (): string => {
	return (
		trimToUndefined(process.env.GCTRL_CLAUDE_SESSIONS_DIR) ??
		DEFAULT_CLAUDE_ACTIVE_SESSIONS_DIR
	);
};

const normalizeClaudeDirectory = (
	directory: string | undefined,
): string | undefined => {
	const trimmed = trimToUndefined(directory);
	if (!trimmed) {
		return undefined;
	}

	return trimmed.replace(/[\\/]+$/u, "");
};

const normalizeClaudeRootSessionId = (sessionId: string): string => {
	const trimmed = trimToUndefined(sessionId) ?? sessionId;
	const separatorIndex = trimmed.indexOf(":");
	return separatorIndex > 0 ? trimmed.slice(0, separatorIndex) : trimmed;
};

const readProcessStartTime = (pid: number): string | null => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closingParenIndex = stat.lastIndexOf(")");
		if (closingParenIndex < 0) {
			return null;
		}

		const fields = stat
			.slice(closingParenIndex + 2)
			.trim()
			.split(/\s+/u);
		return fields[19] ?? null;
	} catch {
		return null;
	}
};

const isLiveActiveClaudeSession = (
	record: ClaudeActiveSessionRecord,
): boolean => {
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		return false;
	}

	const currentStartTime = readProcessStartTime(record.pid);
	if (!currentStartTime) {
		return false;
	}

	const expectedStartTime = trimToUndefined(record.procStart);
	return expectedStartTime ? currentStartTime === expectedStartTime : true;
};

const readActiveClaudeSessions = (
	sessionsDirectory: string,
): Map<string, ClaudeActiveSessionRecord> => {
	const sessionsById = new Map<string, ClaudeActiveSessionRecord>();
	if (!existsSync(sessionsDirectory)) {
		return sessionsById;
	}

	for (const entry of readdirSync(sessionsDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) {
			continue;
		}

		try {
			const parsed = JSON.parse(
				readFileSync(join(sessionsDirectory, entry.name), "utf8"),
			) as ClaudeActiveSessionRecord;
			const sessionId = trimToUndefined(parsed.sessionId);
			if (!sessionId) {
				continue;
			}

			const normalizedRecord: ClaudeActiveSessionRecord = {
				pid: parsed.pid,
				sessionId,
				cwd: trimToUndefined(parsed.cwd),
				startedAt: normalizeTimestampMs(parsed.startedAt),
				procStart: trimToUndefined(parsed.procStart),
				version: trimToUndefined(parsed.version),
				kind: trimToUndefined(parsed.kind),
				entrypoint: trimToUndefined(parsed.entrypoint),
			};

			if (!isLiveActiveClaudeSession(normalizedRecord)) {
				continue;
			}

			sessionsById.set(sessionId, normalizedRecord);
		} catch {}
	}

	return sessionsById;
};

const collectClaudeLogPaths = (directory: string, paths: string[]): void => {
	if (!existsSync(directory)) {
		return;
	}

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectClaudeLogPaths(fullPath, paths);
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			paths.push(fullPath);
		}
	}
};

const collectClaudeProjectArtifactPaths = (
	directory: string,
	sessionId: string,
	paths: Set<string>,
): void => {
	if (!existsSync(directory)) {
		return;
	}

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === sessionId) {
				paths.add(fullPath);
				continue;
			}

			collectClaudeProjectArtifactPaths(fullPath, sessionId, paths);
			continue;
		}

		if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
			paths.add(fullPath);
		}
	}
};

const collectClaudeActiveSessionEntryPaths = (
	sessionsDirectory: string,
	sessionId: string,
): string[] => {
	if (!existsSync(sessionsDirectory)) {
		return [];
	}

	const paths: string[] = [];
	for (const entry of readdirSync(sessionsDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) {
			continue;
		}

		const fullPath = join(sessionsDirectory, entry.name);
		try {
			const parsed = JSON.parse(
				readFileSync(fullPath, "utf8"),
			) as ClaudeActiveSessionRecord;
			if (trimToUndefined(parsed.sessionId) === sessionId) {
				paths.push(fullPath);
			}
		} catch {}
	}

	return paths;
};

const resolveClaudeRootDirectories = (params: {
	projectsDirectory: string;
	sessionsDirectory: string;
	rootDirectories?: string[];
}): string[] => {
	const roots = new Set<string>();

	for (const candidate of [
		...(params.rootDirectories ?? []),
		dirname(params.projectsDirectory),
		dirname(params.sessionsDirectory),
	]) {
		const normalized = normalizeClaudeDirectory(candidate);
		if (normalized) {
			roots.add(normalized);
		}
	}

	return [...roots];
};

export interface ClaudeDeleteResult {
	deletedPaths: string[];
}

export interface DeleteClaudeSessionOptions {
	projectsDirectory?: string;
	sessionsDirectory?: string;
	rootDirectories?: string[];
}

const isClaudeSubagentLogPath = (path: string): boolean => {
	return path.includes(`${sep}subagents${sep}`);
};

const getClaudeRootSessionIdFromSubagentPath = (
	path: string,
): string | undefined => {
	return trimToUndefined(basename(dirname(dirname(path))));
};

const getClaudeSubagentIdFromPath = (path: string): string => {
	const filename = basename(path, ".jsonl");
	return filename.replace(/^agent-/u, "");
};

const readClaudeSessionLogSummary = (
	path: string,
): { summary?: ClaudeSessionLogSummary; issue?: string } => {
	try {
		return {
			summary: summarizeClaudeSessionLogContent(readFileSync(path, "utf8")),
		};
	} catch (error) {
		return {
			issue:
				error instanceof Error
					? error.message
					: `Failed to parse Claude session log at ${path}`,
		};
	}
};

export const resolveClaudeStatus = (params: {
	summary?: ClaudeSessionLogSummary;
	activeSession?: ClaudeActiveSessionRecord;
	openChildCount?: number;
}): ClaudeStatusResolution => {
	const { summary, activeSession } = params;
	const openChildCount = params.openChildCount ?? 0;
	const hasActiveProcess = Boolean(activeSession);

	if (hasActiveProcess) {
		if (summary?.lastConversationRole === "assistant") {
			if (summary.lastAssistantStopReason === "tool_use") {
				return {
					status: SessionStatus.running,
					finishReason: "tool_use",
					statusDetail:
						openChildCount > 0
							? `Running with ${toHumanCountLabel(openChildCount, "active child session")}`
							: "Awaiting tool result",
				};
			}

			if (summary.lastAssistantStopReason === "end_turn") {
				return {
					status:
						openChildCount > 0 ? SessionStatus.running : SessionStatus.waiting,
					finishReason:
						openChildCount > 0 ? "awaiting_child_sessions" : "end_turn",
					statusDetail:
						openChildCount > 0
							? `Awaiting ${toHumanCountLabel(openChildCount, "child session")}`
							: "Idle between prompts",
				};
			}
		}

		if (summary?.lastConversationRole === "user") {
			return {
				status: SessionStatus.running,
				finishReason: summary.lastUserWasToolResultOnly
					? "tool_result"
					: "user_prompt",
				statusDetail: summary.lastUserWasToolResultOnly
					? "Processing tool result"
					: "Awaiting Claude response",
			};
		}

		return {
			status:
				openChildCount > 0 ? SessionStatus.running : SessionStatus.waiting,
			finishReason:
				openChildCount > 0 ? "awaiting_child_sessions" : "active_session",
			statusDetail:
				openChildCount > 0
					? `Awaiting ${toHumanCountLabel(openChildCount, "child session")}`
					: "Session idle",
		};
	}

	if (openChildCount > 0) {
		return {
			status: SessionStatus.running,
			finishReason: "awaiting_child_sessions",
			statusDetail: `Awaiting ${toHumanCountLabel(openChildCount, "child session")}`,
		};
	}

	if (summary?.taskState === "running") {
		if (summary.lastConversationRole === "assistant") {
			return {
				status: SessionStatus.running,
				finishReason: summary.lastAssistantStopReason ?? "assistant_running",
				statusDetail:
					summary.lastAssistantStopReason === "tool_use"
						? "Awaiting tool result"
						: "Claude Code still processing",
			};
		}

		if (summary.lastConversationRole === "user") {
			return {
				status: SessionStatus.running,
				finishReason: summary.lastUserWasToolResultOnly
					? "tool_result"
					: "user_prompt",
				statusDetail: summary.lastUserWasToolResultOnly
					? "Processing tool result"
					: "Awaiting Claude response",
			};
		}

		return {
			status: SessionStatus.running,
			finishReason: "running",
			statusDetail: "Claude Code still processing",
		};
	}

	if (summary?.lastConversationRole === "assistant") {
		if (summary.lastAssistantStopReason === "end_turn") {
			return {
				status: SessionStatus.completed,
				finishReason: "end_turn",
				statusDetail: "Last turn complete",
			};
		}

		if (summary.lastAssistantStopReason === "tool_use") {
			return {
				status: SessionStatus.unknown,
				finishReason: "tool_use",
				statusDetail: "Session log ended during tool use",
			};
		}
	}

	if (summary?.lastConversationRole === "user") {
		return {
			status: SessionStatus.unknown,
			finishReason: summary.lastUserWasToolResultOnly
				? "tool_result"
				: "user_prompt",
			statusDetail: summary.lastUserWasToolResultOnly
				? "Session log ended after a tool result"
				: "Session log ended before Claude replied",
		};
	}

	return {
		status: SessionStatus.unknown,
		statusDetail: summary?.lastEventType
			? `Last event: ${summary.lastEventType.replace(/[:_]/gu, " ")}`
			: "No Claude session history recorded",
	};
};

const buildSourceMetadata = (params: {
	summary?: ClaudeSessionLogSummary;
	activeSession?: ClaudeActiveSessionRecord;
	isSubagent: boolean;
	openChildCount?: number;
	closedChildCount?: number;
}): SessionSourceMetadata => {
	const {
		summary,
		activeSession,
		isSubagent,
		openChildCount,
		closedChildCount,
	} = params;

	return {
		originator: "claude_code",
		cliVersion:
			trimToUndefined(activeSession?.version) ??
			trimToUndefined(summary?.cliVersion),
		rawSource:
			trimToUndefined(activeSession?.entrypoint) ??
			trimToUndefined(summary?.entrypoint),
		sourceCategory: getClaudeEntryPointLabel(
			trimToUndefined(activeSession?.entrypoint) ??
				trimToUndefined(summary?.entrypoint),
		),
		agentRole: isSubagent ? "subagent" : undefined,
		agentNickname:
			trimToUndefined(summary?.agentNickname) ??
			trimToUndefined(summary?.agentId),
		lastEventType: trimToUndefined(summary?.lastEventType),
		openChildCount,
		closedChildCount,
	};
};

const buildClaudeSessionRecord = (params: {
	id: string;
	parentId: string | null;
	summary?: ClaudeSessionLogSummary;
	activeSession?: ClaudeActiveSessionRecord;
}): SessionRecord & {
	currentAgent?: string;
	currentModelID?: string;
	status?: SessionStatus;
	statusDetail?: string;
	finishReason?: string;
	sourceMetadata: SessionSourceMetadata;
} => {
	const { id, parentId, summary, activeSession } = params;
	const isSubagent = parentId !== null;
	const directory =
		trimToUndefined(activeSession?.cwd) ?? trimToUndefined(summary?.cwd) ?? "";
	const { projectId, projectLabel } = normalizeProjectLabel(directory);
	const statusResolution = resolveClaudeStatus({ summary, activeSession });
	const sourceMetadata = buildSourceMetadata({
		summary,
		activeSession,
		isSubagent,
	});

	const inferredTitle = isSubagent
		? (trimToUndefined(summary?.agentNickname) ??
			(summary?.agentId ? `Claude subagent ${summary.agentId}` : undefined))
		: (trimToUndefined(summary?.explicitSessionName) ??
			trimToUndefined(summary?.aiTitle) ??
			trimToUndefined(summary?.firstUserPrompt));

	return {
		id,
		title: normalizeTitle(
			inferredTitle,
			isSubagent ? "Claude subagent" : "Claude session",
			id,
		),
		directory,
		project_id: projectId,
		project_label: projectLabel,
		parent_id: parentId,
		time_created:
			activeSession?.startedAt ??
			summary?.startedAtMs ??
			summary?.lastTimestampMs ??
			0,
		time_updated:
			summary?.lastTimestampMs ?? activeSession?.startedAt ?? Date.now(),
		currentAgent: isSubagent
			? (trimToUndefined(summary?.agentNickname) ??
				trimToUndefined(summary?.agentId) ??
				"subagent")
			: undefined,
		currentModelID: trimToUndefined(summary?.currentModelID),
		status: statusResolution.status,
		statusDetail: statusResolution.statusDetail,
		finishReason: statusResolution.finishReason,
		sourceMetadata,
	};
};

const createSyntheticClaudeRootSession = (params: {
	id: string;
	childSession?: SubagentSession;
	activeSession?: ClaudeActiveSessionRecord;
}): Session & { sessionSource: "claude" } => {
	const { id, childSession, activeSession } = params;
	const directory =
		trimToUndefined(activeSession?.cwd) ??
		trimToUndefined(childSession?.directory) ??
		"";
	const { projectId, projectLabel } = normalizeProjectLabel(directory);
	return {
		id,
		title: normalizeTitle(undefined, "Claude session", id),
		directory,
		project_id: projectId,
		project_label: projectLabel,
		parent_id: null,
		time_created:
			activeSession?.startedAt ?? childSession?.time_created ?? Date.now(),
		time_updated:
			childSession?.time_updated ?? activeSession?.startedAt ?? Date.now(),
		sessionSource: "claude",
		capabilities: getDefaultSessionCapabilities("claude"),
		status: activeSession ? SessionStatus.waiting : SessionStatus.unknown,
		finishReason: activeSession ? "active_session" : undefined,
		statusDetail: activeSession ? "Session idle" : "Root session log not found",
		sourceMetadata: buildSourceMetadata({
			activeSession,
			isSubagent: false,
		}),
		subagentSessions: [],
	};
};

export const buildClaudeSessionSnapshot = (params: {
	logs: ClaudeSessionLogRecord[];
	activeSessions?: Map<string, ClaudeActiveSessionRecord>;
	logIssues?: Partial<Record<string, string>>;
}): SessionSnapshot => {
	const { logs, logIssues = {} } = params;
	const activeSessions = params.activeSessions ?? new Map();
	const statusBySessionId: Partial<Record<string, SessionStatus>> = {};
	const messageCountBySessionId: Partial<Record<string, number>> = {};
	const sessionIssues: Partial<Record<string, string>> = { ...logIssues };
	const summariesById = new Map(
		logs
			.filter((log) => log.summary)
			.map((log) => [log.id, log.summary as ClaudeSessionLogSummary]),
	);
	const sessionsById = new Map<
		string,
		(Session | SubagentSession) & { sessionSource: "claude" }
	>();

	for (const log of logs) {
		const session = buildClaudeSessionRecord({
			id: log.id,
			parentId: log.parentId,
			summary: log.summary,
			activeSession: log.parentId ? undefined : activeSessions.get(log.id),
		});
		const enrichedSession = {
			...session,
			sessionSource: "claude" as const,
			capabilities: getDefaultSessionCapabilities("claude"),
		};
		sessionsById.set(log.id, enrichedSession);
		statusBySessionId[log.id] = enrichedSession.status;
		if (typeof log.summary?.messageCount === "number") {
			messageCountBySessionId[log.id] = log.summary.messageCount;
		}
	}

	for (const [sessionId, activeSession] of activeSessions) {
		if (sessionsById.has(sessionId)) {
			continue;
		}

		const syntheticSession = buildClaudeSessionRecord({
			id: sessionId,
			parentId: null,
			activeSession,
		});
		const enrichedSyntheticSession = {
			...syntheticSession,
			sessionSource: "claude" as const,
			capabilities: getDefaultSessionCapabilities("claude"),
		};
		sessionsById.set(sessionId, enrichedSyntheticSession);
		statusBySessionId[sessionId] = enrichedSyntheticSession.status;
	}

	const rootSessionsById = new Map<
		string,
		Session & { sessionSource: "claude" }
	>();
	for (const session of sessionsById.values()) {
		if (session.parent_id) {
			continue;
		}

		rootSessionsById.set(session.id, {
			...session,
			subagentSessions: [],
		} as Session & { sessionSource: "claude" });
	}

	for (const session of sessionsById.values()) {
		if (!session.parent_id) {
			continue;
		}

		const rootSession =
			rootSessionsById.get(session.parent_id) ??
			(() => {
				const createdRoot = createSyntheticClaudeRootSession({
					id: session.parent_id ?? session.id,
					childSession: session as SubagentSession,
					activeSession: activeSessions.get(session.parent_id ?? ""),
				});
				rootSessionsById.set(createdRoot.id, createdRoot);
				sessionIssues[session.id] =
					"Claude root session log not found; created a synthetic root record.";
				return createdRoot;
			})();

		rootSession.subagentSessions = [
			...(rootSession.subagentSessions ?? []),
			session as SubagentSession,
		];
	}

	for (const rootSession of rootSessionsById.values()) {
		const childSessions = rootSession.subagentSessions ?? [];
		const openChildCount = childSessions.filter((session) =>
			isActiveStatus(session.status),
		).length;
		const closedChildCount = childSessions.length - openChildCount;
		const nextStatus = resolveClaudeStatus({
			summary: summariesById.get(rootSession.id),
			activeSession: activeSessions.get(rootSession.id),
			openChildCount,
		});

		rootSession.status = nextStatus.status;
		rootSession.statusDetail = nextStatus.statusDetail;
		rootSession.finishReason = nextStatus.finishReason;
		rootSession.sourceMetadata = buildSourceMetadata({
			summary: summariesById.get(rootSession.id),
			activeSession: activeSessions.get(rootSession.id),
			isSubagent: false,
			openChildCount,
			closedChildCount,
		});
		statusBySessionId[rootSession.id] = nextStatus.status;
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

export const deleteClaudeSession = async (
	sessionId: string,
	options: DeleteClaudeSessionOptions = {},
): Promise<DatabaseResult<ClaudeDeleteResult>> => {
	const rootSessionId = normalizeClaudeRootSessionId(sessionId);
	const projectsDirectory =
		options.projectsDirectory ?? getActiveClaudeProjectsDirectory();
	const sessionsDirectory =
		options.sessionsDirectory ?? getActiveClaudeSessionsDirectory();

	try {
		if (readActiveClaudeSessions(sessionsDirectory).has(rootSessionId)) {
			const activeSessionMessage = `Claude session ${rootSessionId} is still active and cannot be deleted yet.`;
			return {
				ok: false,
				error: createQueryFailedDatabaseError(
					new Error(activeSessionMessage),
					activeSessionMessage,
				),
			};
		}

		const pathsToDelete = new Set<string>();
		collectClaudeProjectArtifactPaths(
			projectsDirectory,
			rootSessionId,
			pathsToDelete,
		);
		for (const path of collectClaudeActiveSessionEntryPaths(
			sessionsDirectory,
			rootSessionId,
		)) {
			pathsToDelete.add(path);
		}

		for (const rootDirectory of resolveClaudeRootDirectories({
			projectsDirectory,
			sessionsDirectory,
			rootDirectories: options.rootDirectories,
		})) {
			for (const relativePath of [
				["file-history", rootSessionId],
				["session-env", rootSessionId],
				["tasks", rootSessionId],
			]) {
				const fullPath = join(rootDirectory, ...relativePath);
				if (existsSync(fullPath)) {
					pathsToDelete.add(fullPath);
				}
			}
		}

		if (pathsToDelete.size === 0) {
			const notFoundMessage = `No Claude session artifacts were found for ${rootSessionId}.`;
			return {
				ok: false,
				error: createQueryFailedDatabaseError(
					new Error(notFoundMessage),
					notFoundMessage,
				),
			};
		}

		const deletedPaths: string[] = [];
		for (const path of [...pathsToDelete].sort(
			(left, right) => right.length - left.length,
		)) {
			rmSync(path, { recursive: true, force: true });
			if (!existsSync(path)) {
				deletedPaths.push(path);
			}
		}

		return {
			ok: true,
			value: {
				deletedPaths,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				"Claude Code session delete failed.",
			),
		};
	}
};

export const getClaudeSnapshot = (): DatabaseResult<SessionSnapshot> => {
	const projectsDirectory = getActiveClaudeProjectsDirectory();
	const sessionsDirectory = getActiveClaudeSessionsDirectory();
	if (!existsSync(projectsDirectory) && !existsSync(sessionsDirectory)) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				new Error(
					`Missing Claude Code session storage at ${projectsDirectory} and ${sessionsDirectory}`,
				),
				"Claude Code session storage is not available.",
			),
		};
	}

	try {
		const activeSessions = readActiveClaudeSessions(sessionsDirectory);
		const logPaths: string[] = [];
		collectClaudeLogPaths(projectsDirectory, logPaths);

		const logs: ClaudeSessionLogRecord[] = [];
		const logIssues: Partial<Record<string, string>> = {};
		for (const path of logPaths) {
			const isSubagent = isClaudeSubagentLogPath(path);
			const parentId = isSubagent
				? (getClaudeRootSessionIdFromSubagentPath(path) ?? null)
				: null;
			const logId = isSubagent
				? `${parentId ?? "unknown"}:${getClaudeSubagentIdFromPath(path)}`
				: basename(path, ".jsonl");
			const logResult = readClaudeSessionLogSummary(path);

			logs.push({
				id: logId,
				parentId,
				summary: logResult.summary,
			});

			if (logResult.issue) {
				logIssues[logId] = `Claude log error: ${logResult.issue}`;
			}
		}

		return {
			ok: true,
			value: buildClaudeSessionSnapshot({
				logs,
				activeSessions,
				logIssues,
			}),
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				"Claude Code query execution failed.",
			),
		};
	}
};
