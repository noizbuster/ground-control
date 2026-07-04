import {
	type Dirent,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	delimiter,
	dirname,
	extname,
	isAbsolute,
	join,
	resolve,
} from "node:path";
import {
	evictOldestCacheEntries,
	refreshCacheEntryLru,
} from "../lib/boundedCache";
import { getDisplayStatus, isActiveStatus } from "../lib/hierarchyHelpers";
import type { SessionSnapshot } from "../lib/sessionSnapshot";
import {
	getDefaultSessionCapabilities,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import {
	type Session,
	type SessionRecord,
	type SessionSource,
	SessionStatus,
	type SubagentSession,
} from "../types";
import { createQueryFailedDatabaseError, type DatabaseResult } from "./index";

type PiDialect = Extract<SessionSource, "pi" | "omp">;

type JsonObject = Record<string, unknown>;

interface PiSessionHeader extends JsonObject {
	type: "session";
	id: string;
	timestamp?: string | number;
	cwd?: string;
	parentSession?: string;
	title?: string;
	titleSource?: string;
}

export interface PiSessionLogRecord {
	source: PiDialect;
	path: string;
	root: string;
	header: PiSessionHeader;
	entries: JsonObject[];
	mtimeMs: number;
}

interface PiTaskChildReference {
	sessionPath?: string;
	sessionId?: string;
	agent?: string;
	status?: string;
	description?: string;
}

interface PiSessionSummary {
	id: string;
	directory: string;
	parentSession?: string;
	parentPath?: string;
	title: string;
	childReferences: PiTaskChildReference[];
	messageCount: number;
	firstUserText?: string;
	lastEntryType?: string;
	lastRole?: string;
	lastAssistantFinish?: string;
	lastAssistantToolCallNames?: string[];
	lastAssistantError?: string;
	currentModelID?: string;
	currentVariant?: string;
	providerID?: string;
	currentReasoningEffort?: string;
	currentAgent?: string;
	modelRole?: string;
	activeToolNames?: string[];
	startedAtMs: number;
	lastTimestampMs: number;
	status: SessionStatus;
	finishReason?: string;
	statusDetail?: string;
}

export interface PiDeleteResult {
	deletedSessionPaths: string[];
	deletedArtifactPaths: string[];
}

interface PiSnapshotOptions {
	sessionRoots?: string[];
}

interface DeletePiSessionOptions extends PiSnapshotOptions {
	sessionPath?: string;
}

const EMPTY_SNAPSHOT: SessionSnapshot = {
	sessions: [],
	statusBySessionId: {},
	messageCountBySessionId: {},
	sessionIssues: {},
	sourceIssues: [],
};

const trimToUndefined = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeTimestampMs = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}

	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
};

const truncateTitle = (value: string): string =>
	value.length <= 160 ? value : `${value.slice(0, 157)}...`;

const normalizeText = (value: string | undefined): string | undefined => {
	const normalized = value?.replace(/\s+/gu, " ").trim();
	return normalized && normalized.length > 0
		? truncateTitle(normalized)
		: undefined;
};

const getProjectLabel = (directory: string, source: PiDialect): string => {
	const trimmed = directory.trim().replace(/[\\/]+$/gu, "");
	if (!trimmed) {
		return getSessionSourceLabel(source);
	}

	return trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
};

const getStringArrayEnv = (value: string | undefined): string[] => {
	const trimmed = trimToUndefined(value);
	if (!trimmed) {
		return [];
	}

	return trimmed
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
};

const unique = (values: string[]): string[] => {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const resolved = resolve(value);
		if (seen.has(resolved)) {
			continue;
		}
		seen.add(resolved);
		result.push(resolved);
	}
	return result;
};

const resolveHomeRelativeDirectory = (directory: string): string =>
	isAbsolute(directory) ? directory : join(homedir(), directory);

export const resolvePiSessionRoots = (source: PiDialect): string[] => {
	if (source === "pi") {
		const override = getStringArrayEnv(process.env.GCTRL_PI_SESSIONS_DIR);
		if (override.length > 0) {
			return unique(override);
		}

		const sessionOverride = getStringArrayEnv(
			process.env.PI_CODING_AGENT_SESSION_DIR,
		);
		if (sessionOverride.length > 0) {
			return unique(sessionOverride);
		}

		return unique([
			join(
				process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
				"sessions",
			),
		]);
	}

	const override = getStringArrayEnv(process.env.GCTRL_OMP_SESSIONS_DIR);
	if (override.length > 0) {
		return unique(override);
	}

	const candidates: string[] = [];
	const codingAgentDir = trimToUndefined(process.env.PI_CODING_AGENT_DIR);
	if (codingAgentDir) {
		candidates.push(join(codingAgentDir, "sessions"));
	} else {
		candidates.push(join(homedir(), ".omp", "agent", "sessions"));
	}

	const piConfigDir = trimToUndefined(process.env.PI_CONFIG_DIR);
	if (piConfigDir) {
		const resolvedConfigDir = resolveHomeRelativeDirectory(piConfigDir);
		candidates.push(join(resolvedConfigDir, "agent", "sessions"));
		candidates.push(join(resolvedConfigDir, "sessions"));
	}

	const xdgDataHome =
		trimToUndefined(process.env.XDG_DATA_HOME) ??
		join(homedir(), ".local", "share");
	const xdgConfigHome =
		trimToUndefined(process.env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
	candidates.push(join(xdgDataHome, "omp", "sessions"));
	candidates.push(join(xdgDataHome, "omp", "agent", "sessions"));
	candidates.push(join(xdgConfigHome, "omp", "sessions"));
	candidates.push(join(xdgConfigHome, "omp", "agent", "sessions"));

	return unique(candidates);
};

const getReadableExistingRoots = (roots: string[]): string[] =>
	roots.filter((root) => {
		try {
			return existsSync(root) && statSync(root).isDirectory();
		} catch {
			return false;
		}
	});

const collectJsonlFiles = (root: string): string[] => {
	const collected: string[] = [];
	const stack = [root];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(path);
				continue;
			}

			if (entry.isFile() && extname(entry.name) === ".jsonl") {
				collected.push(path);
			}
		}
	}

	return collected.sort();
};

const parseJsonLine = (line: string): JsonObject | undefined => {
	try {
		const parsed = JSON.parse(line) as unknown;
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
};

// Bounds memory: without eviction this cache grew once per log file ever read.
const PI_LOG_CACHE_MAX_ENTRIES = 256;
const piLogCache = new Map<
	string,
	{ mtimeMs: number; size: number; record: PiSessionLogRecord }
>();

export const invalidatePiSessionCaches = (): void => {
	piLogCache.clear();
};

export const parsePiSessionLogFile = (
	path: string,
	root: string,
	source: PiDialect,
): PiSessionLogRecord | undefined => {
	let stats: { mtimeMs: number; size: number };
	try {
		stats = statSync(path);
	} catch {
		return undefined;
	}

	const cached = piLogCache.get(path);
	if (
		cached &&
		cached.mtimeMs === stats.mtimeMs &&
		cached.size === stats.size
	) {
		// Re-insert moves live entries newest; stale ones drift oldest.
		refreshCacheEntryLru(piLogCache, path, cached);
		return cached.record;
	}

	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}

	const mtimeMs = stats.mtimeMs;
	const entries: JsonObject[] = [];
	let header: PiSessionHeader | undefined;
	for (const line of content.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		const parsed = parseJsonLine(trimmed);
		if (!parsed) {
			continue;
		}

		if (!header && parsed.type === "session" && typeof parsed.id === "string") {
			header = parsed as PiSessionHeader;
			continue;
		}

		entries.push(parsed);
	}

	if (!header) {
		return undefined;
	}

	const record: PiSessionLogRecord = {
		source,
		path,
		root,
		header,
		entries,
		mtimeMs,
	};
	evictOldestCacheEntries(piLogCache, PI_LOG_CACHE_MAX_ENTRIES);
	piLogCache.set(path, { mtimeMs, size: stats.size, record });
	return record;
};

const extractMessage = (entry: JsonObject): JsonObject | undefined => {
	const message = entry.message;
	if (isJsonObject(message)) {
		return message;
	}
	return entry;
};

const extractRole = (entry: JsonObject): string | undefined => {
	const message = extractMessage(entry);
	return trimToUndefined(message?.role) ?? trimToUndefined(entry.role);
};

const extractTextFromContent = (content: unknown): string | undefined => {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (!isJsonObject(part)) {
				continue;
			}
			const text = trimToUndefined(part.text) ?? trimToUndefined(part.content);
			if (text) {
				parts.push(text);
			}
		}
		return parts.join(" ");
	}

	return undefined;
};

const extractMessageText = (entry: JsonObject): string | undefined => {
	const message = extractMessage(entry);
	return (
		extractTextFromContent(message?.content) ??
		extractTextFromContent(entry.content)
	);
};

const TOOL_CALL_CONTENT_TYPES = new Set([
	"toolCall",
	"tool_call",
	"toolUse",
	"tool_use",
]);
const IDLE_TOOL_CALL_NAMES = new Set(["yield"]);

const isToolUseFinishReason = (finishReason: string | undefined): boolean =>
	finishReason === "toolUse" || finishReason === "tool_use";

const normalizeComparableText = (
	value: string | undefined,
): string | undefined => {
	const normalized = value?.replace(/\s+/gu, " ").trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
};

const SUCCESS_STATUS_VALUES = new Set([
	"success",
	"completed",
	"complete",
	"done",
]);
const FAILED_STATUS_VALUES = new Set(["failed", "failure", "error"]);
const ABORTED_STATUS_VALUES = new Set(["aborted", "cancelled", "canceled"]);

const normalizeMetadataStatus = (value: unknown): string | undefined =>
	trimToUndefined(value)?.toLowerCase();

const isSuccessStatusValue = (value: unknown): boolean => {
	const normalized = normalizeMetadataStatus(value);
	return !!normalized && SUCCESS_STATUS_VALUES.has(normalized);
};

const normalizeTaskStatusValue = (value: unknown): string | undefined => {
	const normalized = normalizeMetadataStatus(value);
	if (!normalized) {
		return undefined;
	}
	if (SUCCESS_STATUS_VALUES.has(normalized)) {
		return "completed";
	}
	if (FAILED_STATUS_VALUES.has(normalized)) {
		return "failed";
	}
	if (ABORTED_STATUS_VALUES.has(normalized)) {
		return "aborted";
	}
	if (normalized === "running" || normalized === "active") {
		return "running";
	}
	if (normalized === "pending" || normalized === "in_progress") {
		return "pending";
	}
	return normalized;
};

const readMetadataBoolean = (value: unknown): boolean | undefined => {
	if (typeof value === "boolean") {
		return value;
	}

	const normalized = trimToUndefined(value)?.toLowerCase();
	if (normalized === "true") {
		return true;
	}
	if (normalized === "false") {
		return false;
	}
	return undefined;
};

const readMetadataNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === "string") {
		const trimmed = trimToUndefined(value);
		if (!trimmed) {
			return undefined;
		}
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
};

const extractToolCallNamesFromContent = (content: unknown): string[] => {
	const parts = Array.isArray(content) ? content : [content];
	const toolCallNames: string[] = [];

	for (const part of parts) {
		if (!isJsonObject(part)) {
			continue;
		}

		const type = trimToUndefined(part.type);
		if (!type || !TOOL_CALL_CONTENT_TYPES.has(type)) {
			continue;
		}

		const nestedToolCall = isJsonObject(part.toolCall)
			? part.toolCall
			: isJsonObject(part.tool_call)
				? part.tool_call
				: undefined;
		const toolName =
			trimToUndefined(part.name) ??
			trimToUndefined(part.toolName) ??
			trimToUndefined(part.tool_name) ??
			trimToUndefined(part.tool) ??
			trimToUndefined(nestedToolCall?.name) ??
			trimToUndefined(nestedToolCall?.toolName) ??
			trimToUndefined(nestedToolCall?.tool_name) ??
			trimToUndefined(nestedToolCall?.tool);
		if (toolName) {
			toolCallNames.push(toolName);
		}
	}

	return toolCallNames;
};

const extractToolName = (
	record: JsonObject | undefined,
): string | undefined => {
	if (!record) {
		return undefined;
	}

	return (
		trimToUndefined(record.toolName) ??
		trimToUndefined(record.tool_name) ??
		trimToUndefined(record.name) ??
		trimToUndefined(record.tool)
	);
};

const extractDetailsStatus = (
	record: JsonObject | undefined,
): string | undefined => {
	const details =
		record && isJsonObject(record.details) ? record.details : undefined;
	return trimToUndefined(details?.status);
};

const hasResultSubmittedText = (
	entry: JsonObject | undefined,
	message: JsonObject | undefined,
): boolean => {
	const text = normalizeComparableText(
		extractTextFromContent(message?.content) ??
			extractTextFromContent(entry?.content),
	);
	return text === "Result submitted.";
};

const isSuccessfulYieldToolResultTail = (params: {
	lastRole?: string;
	lastAssistantFinish?: string;
	lastAssistantToolCallNames: string[];
	latestToolResultEntry?: JsonObject;
	latestToolResultMessage?: JsonObject;
}): boolean => {
	if (
		params.lastRole !== "toolResult" ||
		!isToolUseFinishReason(params.lastAssistantFinish) ||
		params.lastAssistantToolCallNames.length === 0 ||
		params.lastAssistantToolCallNames.some(
			(toolName) => !IDLE_TOOL_CALL_NAMES.has(toolName),
		)
	) {
		return false;
	}

	const toolName =
		extractToolName(params.latestToolResultMessage) ??
		extractToolName(params.latestToolResultEntry);
	if (toolName !== "yield") {
		return false;
	}
	if (
		readMetadataBoolean(params.latestToolResultMessage?.isError) === true ||
		readMetadataBoolean(params.latestToolResultEntry?.isError) === true
	) {
		return false;
	}

	return (
		isSuccessStatusValue(
			extractDetailsStatus(params.latestToolResultMessage),
		) ||
		isSuccessStatusValue(extractDetailsStatus(params.latestToolResultEntry)) ||
		hasResultSubmittedText(
			params.latestToolResultEntry,
			params.latestToolResultMessage,
		)
	);
};

const splitProviderModel = (
	value: string | undefined,
): { providerID?: string; currentModelID?: string } => {
	const model = trimToUndefined(value);
	if (!model) {
		return {};
	}

	const slashIndex = model.indexOf("/");
	if (slashIndex <= 0 || slashIndex === model.length - 1) {
		return { currentModelID: model };
	}

	return {
		providerID: model.slice(0, slashIndex),
		currentModelID: model.slice(slashIndex + 1),
	};
};

const getTaskReferenceString = (
	item: JsonObject,
	keys: string[],
): string | undefined => {
	for (const key of keys) {
		const value = trimToUndefined(item[key]);
		if (value) {
			return value;
		}
	}
	return undefined;
};

const hasSuccessfulYieldTaskResult = (item: JsonObject): boolean => {
	const extractedToolData = isJsonObject(item.extractedToolData)
		? item.extractedToolData
		: undefined;
	const yieldResults = extractedToolData?.yield;
	const candidates = Array.isArray(yieldResults)
		? yieldResults
		: yieldResults
			? [yieldResults]
			: [];

	return (
		candidates.length > 0 &&
		candidates.every(
			(candidate) =>
				isJsonObject(candidate) && isSuccessStatusValue(candidate.status),
		)
	);
};

const inferTaskResultMetadataStatus = (
	item: JsonObject,
): string | undefined => {
	const exitCode = readMetadataNumber(item.exitCode ?? item.exit_code);
	const aborted = readMetadataBoolean(item.aborted);

	if (aborted === true) {
		return "aborted";
	}
	if (exitCode !== undefined && exitCode !== 0) {
		return "failed";
	}
	if (hasSuccessfulYieldTaskResult(item)) {
		return "completed";
	}
	if (exitCode === 0 && aborted === false) {
		return "completed";
	}

	return undefined;
};

const collectTaskChildReferences = (
	record: JsonObject,
): PiTaskChildReference[] => {
	const details = record.details;
	if (!isJsonObject(details)) {
		return [];
	}

	const collect = (
		items: unknown,
		inferMissingStatus: boolean,
	): PiTaskChildReference[] => {
		if (!Array.isArray(items)) {
			return [];
		}

		const references: PiTaskChildReference[] = [];
		for (const item of items) {
			if (!isJsonObject(item)) {
				continue;
			}

			const taskId = trimToUndefined(item.id);
			const session = isJsonObject(item.session) ? item.session : undefined;
			const outputPath = getTaskReferenceString(item, [
				"outputPath",
				"output_path",
				"output",
			]);
			const sessionPath =
				getTaskReferenceString(item, [
					"sessionFile",
					"session_file",
					"sessionPath",
					"session_path",
					"path",
				]) ??
				(session
					? getTaskReferenceString(session, [
							"file",
							"sessionFile",
							"session_file",
							"sessionPath",
							"session_path",
							"path",
						])
					: undefined) ??
				(outputPath?.endsWith(".md")
					? `${outputPath.slice(0, -".md".length)}.jsonl`
					: outputPath?.endsWith(".jsonl")
						? outputPath
						: outputPath && taskId
							? join(dirname(outputPath), `${taskId}.jsonl`)
							: undefined);
			const sessionId =
				getTaskReferenceString(item, [
					"sessionId",
					"session_id",
					"sessionID",
				]) ??
				(session
					? getTaskReferenceString(session, ["id", "sessionId", "session_id"])
					: undefined) ??
				taskId;
			if (!sessionPath && !sessionId) {
				continue;
			}

			const explicitStatus = normalizeTaskStatusValue(item.status);
			const status =
				explicitStatus ??
				(inferMissingStatus ? inferTaskResultMetadataStatus(item) : undefined);

			references.push({
				sessionPath,
				sessionId,
				agent: trimToUndefined(item.agent),
				status,
				description: trimToUndefined(item.description),
			});
		}
		return references;
	};

	return [
		...collect(details.results, true),
		...collect(details.progress, false),
	];
};

const getActiveBranchEntries = (entries: JsonObject[]): JsonObject[] => {
	const entriesById = new Map<string, JsonObject>();
	let leafId: string | undefined;
	let lastBranchLeafId: string | undefined;
	let hasTreeLinks = false;

	for (const entry of entries) {
		const id = trimToUndefined(entry.id);
		if (!id) {
			continue;
		}

		entriesById.set(id, entry);
		if (entry.type === "leaf") {
			const targetId = trimToUndefined(entry.targetId);
			const targetEntry = targetId ? entriesById.get(targetId) : undefined;
			leafId =
				targetEntry?.type === "active_tools_change"
					? (trimToUndefined(targetEntry.parentId) ??
						lastBranchLeafId ??
						targetId)
					: targetId;
		} else if (entry.type !== "active_tools_change") {
			leafId = id;
			lastBranchLeafId = id;
		}
		if ("parentId" in entry) {
			hasTreeLinks = true;
		}
	}

	if (!leafId || !hasTreeLinks) {
		return entries;
	}

	const activeIds = new Set<string>();
	let currentId: string | undefined = leafId;
	while (currentId) {
		if (activeIds.has(currentId)) {
			break;
		}
		activeIds.add(currentId);
		const currentEntry = entriesById.get(currentId);
		const parentId = trimToUndefined(currentEntry?.parentId);
		currentId = parentId;
	}

	if (activeIds.size === 0) {
		return entries;
	}

	return entries.filter((entry) => {
		const id = trimToUndefined(entry.id);
		if (!id || activeIds.has(id)) {
			return true;
		}

		if (entry.type !== "active_tools_change") {
			return false;
		}

		const parentId = trimToUndefined(entry.parentId);
		return parentId !== undefined && activeIds.has(parentId);
	});
};

const summarizePiSession = (log: PiSessionLogRecord): PiSessionSummary => {
	const sourceLabel = getSessionSourceLabel(log.source);
	const id = log.header.id;
	const directory = trimToUndefined(log.header.cwd) ?? dirname(log.path);
	const startedAtMs = normalizeTimestampMs(log.header.timestamp) ?? log.mtimeMs;
	let lastTimestampMs = startedAtMs;
	let messageCount = 0;
	let firstUserText: string | undefined;
	let latestSessionName: string | undefined;
	let latestCompactionSummary: string | undefined;
	let lastEntryType: string | undefined;
	let lastRole: string | undefined;
	let lastAssistantFinish: string | undefined;
	let lastAssistantToolCallNames: string[] = [];
	let lastAssistantError: string | undefined;
	let currentModelID: string | undefined;
	let currentVariant: string | undefined;
	let providerID: string | undefined;
	let currentReasoningEffort: string | undefined;
	let currentAgent: string | undefined;
	let modelRole: string | undefined;
	let hasExplicitOmpDefaultModel = false;
	let activeToolNames: string[] = [];
	let childReferences: PiTaskChildReference[] = [];
	let latestToolResultEntry: JsonObject | undefined;
	let latestToolResultMessage: JsonObject | undefined;

	for (const entry of getActiveBranchEntries(log.entries)) {
		lastEntryType = trimToUndefined(entry.type) ?? lastEntryType;
		lastTimestampMs = normalizeTimestampMs(entry.timestamp) ?? lastTimestampMs;

		if (entry.type === "model_change") {
			if (log.source === "omp") {
				const role = trimToUndefined(entry.role) ?? "default";
				const split = splitProviderModel(trimToUndefined(entry.model));
				if (role === "default" || !currentModelID) {
					currentModelID = split.currentModelID ?? currentModelID;
					providerID = split.providerID ?? providerID;
					currentVariant = role === "default" ? undefined : role;
				}
				modelRole = role === "default" ? modelRole : role;
				if (role === "default") {
					hasExplicitOmpDefaultModel = true;
				}
			} else {
				currentModelID = trimToUndefined(entry.modelId) ?? currentModelID;
				providerID = trimToUndefined(entry.provider) ?? providerID;
			}
			continue;
		}

		if (entry.type === "thinking_level_change") {
			currentReasoningEffort =
				trimToUndefined(entry.thinkingLevel) ?? currentReasoningEffort;
			continue;
		}

		if (entry.type === "active_tools_change") {
			activeToolNames = Array.isArray(entry.activeToolNames)
				? entry.activeToolNames
						.map((toolName) => trimToUndefined(toolName))
						.filter((toolName): toolName is string => !!toolName)
				: [];
			continue;
		}

		if (entry.type === "session_init") {
			currentAgent = "subagent";
			continue;
		}

		if (entry.type === "session_info") {
			latestSessionName =
				normalizeText(trimToUndefined(entry.name)) ?? latestSessionName;
			continue;
		}

		if (entry.type === "compaction") {
			latestCompactionSummary =
				normalizeText(
					trimToUndefined(entry.shortSummary) ?? trimToUndefined(entry.summary),
				) ?? latestCompactionSummary;
			continue;
		}

		if (entry.type !== "message") {
			if (
				entry.type === "custom_message" ||
				entry.type === "branch_summary" ||
				entry.type === "compaction"
			) {
				lastRole = "user";
			}
			continue;
		}

		const role = extractRole(entry);
		const isConversationRole =
			role === "user" ||
			role === "assistant" ||
			role === "toolResult" ||
			role === "bashExecution" ||
			role === "pythonExecution" ||
			role === "custom" ||
			role === "hookMessage" ||
			role === "fileMention" ||
			role === "developer" ||
			role === "branchSummary" ||
			role === "compactionSummary";
		if (isConversationRole) {
			messageCount += 1;
		}
		if (role) {
			lastRole = role;
		}
		const message = extractMessage(entry);
		if (role === "toolResult") {
			latestToolResultEntry = entry;
			latestToolResultMessage = message;
		}
		if (role === "user" && !firstUserText) {
			firstUserText = normalizeText(extractMessageText(entry));
		}

		if (message) {
			childReferences = [
				...childReferences,
				...collectTaskChildReferences(message),
				...(message === entry ? [] : collectTaskChildReferences(entry)),
			];
		}
		const messageModel =
			trimToUndefined(message?.model) ?? trimToUndefined(entry.model);
		if (messageModel && (log.source !== "omp" || !hasExplicitOmpDefaultModel)) {
			const split = splitProviderModel(messageModel);
			currentModelID = split.currentModelID ?? messageModel;
			providerID = split.providerID ?? providerID;
			currentVariant = undefined;
		}

		if (role === "assistant") {
			if (log.source !== "omp" || !hasExplicitOmpDefaultModel) {
				providerID =
					trimToUndefined(message?.provider) ??
					trimToUndefined(entry.provider) ??
					providerID;
			}
			lastAssistantToolCallNames = extractToolCallNamesFromContent(
				message?.content ?? entry.content,
			);
			lastAssistantFinish =
				trimToUndefined(message?.stopReason) ??
				trimToUndefined(message?.stop_reason) ??
				trimToUndefined(message?.finishReason) ??
				trimToUndefined(message?.finish_reason) ??
				trimToUndefined(entry.stopReason) ??
				trimToUndefined(entry.stop_reason) ??
				trimToUndefined(entry.finishReason) ??
				trimToUndefined(entry.finish_reason) ??
				lastAssistantFinish;
			lastAssistantError =
				trimToUndefined(message?.errorMessage) ??
				trimToUndefined(message?.error) ??
				trimToUndefined(entry.errorMessage) ??
				trimToUndefined(entry.error);
		}
	}

	const isIdleEndTurn =
		lastRole === "assistant" && lastAssistantFinish === "end_turn";
	const isToolUseFinish =
		lastRole === "assistant" && isToolUseFinishReason(lastAssistantFinish);
	const hasPendingAssistantToolCall = lastAssistantToolCallNames.some(
		(toolName) => !IDLE_TOOL_CALL_NAMES.has(toolName),
	);
	const isIdleToolUseHandoff =
		isToolUseFinish &&
		lastAssistantToolCallNames.length > 0 &&
		!hasPendingAssistantToolCall;
	const hasSuccessfulYieldTail = isSuccessfulYieldToolResultTail({
		lastRole,
		lastAssistantFinish,
		lastAssistantToolCallNames,
		latestToolResultEntry,
		latestToolResultMessage,
	});
	const isTerminalAssistantFinish =
		lastRole === "assistant" && !isToolUseFinish;
	const hasRunningActiveTools =
		activeToolNames.length > 0 &&
		!isIdleEndTurn &&
		!isIdleToolUseHandoff &&
		!hasSuccessfulYieldTail &&
		!isTerminalAssistantFinish;

	const status = (() => {
		if (hasRunningActiveTools) {
			return SessionStatus.running;
		}
		if (messageCount === 0) {
			return SessionStatus.unknown;
		}
		if (lastAssistantError && lastAssistantError !== "__omp.silent_abort__") {
			return SessionStatus.failed;
		}
		if (lastAssistantFinish === "error") {
			return SessionStatus.failed;
		}
		if (lastAssistantFinish === "aborted") {
			return SessionStatus.unknown;
		}
		if (hasSuccessfulYieldTail) {
			return SessionStatus.completed;
		}
		if (isIdleEndTurn) {
			return SessionStatus.waiting;
		}
		if (lastRole === "assistant") {
			if (isToolUseFinish) {
				return isIdleToolUseHandoff
					? SessionStatus.waiting
					: SessionStatus.running;
			}
			return SessionStatus.completed;
		}
		if (
			lastRole === "user" ||
			lastRole === "toolResult" ||
			lastRole === "bashExecution" ||
			lastRole === "pythonExecution" ||
			lastRole === "custom" ||
			lastRole === "hookMessage" ||
			lastRole === "fileMention" ||
			lastRole === "developer" ||
			lastRole === "branchSummary" ||
			lastRole === "compactionSummary"
		) {
			return SessionStatus.running;
		}
		return SessionStatus.unknown;
	})();

	const statusDetail = (() => {
		if (hasRunningActiveTools) {
			return `Running ${activeToolNames.length === 1 ? activeToolNames[0] : `${activeToolNames.length} tools`}`;
		}
		if (lastAssistantError && lastAssistantError !== "__omp.silent_abort__") {
			return lastAssistantError;
		}
		if (lastAssistantError === "__omp.silent_abort__") {
			return "Silent internal abort";
		}
		if (status === SessionStatus.failed) {
			return "Assistant turn failed";
		}
		if (lastAssistantFinish === "aborted") {
			return "Assistant turn aborted";
		}
		if (hasSuccessfulYieldTail) {
			return undefined;
		}
		if (isIdleEndTurn) {
			return "Idle between prompts";
		}
		if (isIdleToolUseHandoff) {
			return "Idle between prompts";
		}
		if (isToolUseFinish) {
			return "Awaiting tool result";
		}
		if (lastRole === "user") {
			return "Awaiting assistant response";
		}
		if (lastRole === "toolResult") {
			return "Processing tool result";
		}
		if (lastRole === "bashExecution") {
			return "Processing command output";
		}
		if (lastRole === "pythonExecution") {
			return "Processing Python output";
		}
		if (lastRole === "fileMention") {
			return "Processing file context";
		}
		return undefined;
	})();

	const title =
		normalizeText(trimToUndefined(log.header.title)) ??
		latestSessionName ??
		latestCompactionSummary ??
		firstUserText ??
		`${sourceLabel} session ${id.slice(0, 8)}`;

	return {
		id,
		directory,
		parentSession: trimToUndefined(log.header.parentSession),
		parentPath: resolveParentPath(
			log.path,
			trimToUndefined(log.header.parentSession),
		),
		title,
		childReferences,
		messageCount,
		firstUserText,
		lastEntryType,
		lastRole,
		lastAssistantFinish,
		lastAssistantToolCallNames,
		lastAssistantError,
		currentModelID,
		currentVariant,
		providerID,
		currentReasoningEffort,
		currentAgent,
		modelRole,
		activeToolNames,
		startedAtMs,
		lastTimestampMs: Math.max(lastTimestampMs, log.mtimeMs),
		status,
		finishReason: hasSuccessfulYieldTail ? undefined : lastAssistantFinish,
		statusDetail,
	};
};

const resolveParentPath = (
	childPath: string,
	parentSession: string | undefined,
): string | undefined => {
	if (!parentSession) {
		return undefined;
	}

	if (
		parentSession.endsWith(".jsonl") ||
		parentSession.includes("/") ||
		parentSession.includes("\\")
	) {
		return resolve(
			isAbsolute(parentSession)
				? parentSession
				: join(dirname(childPath), parentSession),
		);
	}

	return undefined;
};

const buildSessionRecord = (
	log: PiSessionLogRecord,
	summary: PiSessionSummary,
	parentId: string | null,
): SessionRecord => ({
	id: summary.id,
	title: summary.title,
	directory: summary.directory,
	project_id: summary.directory || `${log.source}:unknown`,
	project_name: null,
	project_worktree: null,
	project_label: getProjectLabel(summary.directory, log.source),
	parent_id: parentId,
	time_created: summary.startedAtMs,
	time_updated: summary.lastTimestampMs,
});

const normalizePath = (path: string): string => resolve(path);

const addPathAliases = (
	aliases: Map<string, string>,
	log: PiSessionLogRecord,
): void => {
	const normalized = normalizePath(log.path);
	aliases.set(normalized, log.header.id);
	aliases.set(basename(log.path), log.header.id);
	aliases.set(basename(log.path, ".jsonl"), log.header.id);
};

const resolveArtifactLayoutParentId = (
	log: PiSessionLogRecord,
	aliases: Map<string, string>,
): string | undefined => {
	const childDir = dirname(normalizePath(log.path));
	const taskName = basename(childDir);
	if (!taskName || taskName === "." || taskName === "..") {
		return undefined;
	}

	const parentPath = normalizePath(
		join(dirname(childDir), `${taskName}.jsonl`),
	);
	if (parentPath === normalizePath(log.path)) {
		return undefined;
	}

	return aliases.get(parentPath);
};

const resolveParentId = (
	log: PiSessionLogRecord,
	aliases: Map<string, string>,
	logsById: Map<string, PiSessionLogRecord>,
): string | undefined => {
	const parent = trimToUndefined(log.header.parentSession);
	if (!parent) {
		return undefined;
	}

	if (logsById.has(parent)) {
		return parent;
	}

	const parentPath = resolveParentPath(log.path, parent);
	if (parentPath) {
		return (
			aliases.get(normalizePath(parentPath)) ??
			aliases.get(basename(parentPath))
		);
	}

	return aliases.get(parent) ?? aliases.get(`${parent}.jsonl`);
};

interface PiChildParentHint {
	parentId: string;
	reference: PiTaskChildReference;
}

const getTaskReferenceStatusRank = (status: string | undefined): number => {
	switch (status) {
		case "failed":
		case "aborted":
		case "cancelled":
			return 4;
		case "completed":
			return 3;
		case "running":
		case "pending":
			return 2;
		default:
			return 1;
	}
};

const shouldReplaceChildParentHint = (
	existing: PiChildParentHint | undefined,
	reference: PiTaskChildReference,
): boolean => {
	if (!existing) {
		return true;
	}

	return (
		getTaskReferenceStatusRank(reference.status) >
		getTaskReferenceStatusRank(existing.reference.status)
	);
};

const addChildParentHint = (
	hintsByPath: Map<string, PiChildParentHint>,
	hintsById: Map<string, PiChildParentHint>,
	parentId: string,
	reference: PiTaskChildReference,
): void => {
	const hint = { parentId, reference };
	if (reference.sessionPath) {
		const key = normalizePath(reference.sessionPath);
		if (shouldReplaceChildParentHint(hintsByPath.get(key), reference)) {
			hintsByPath.set(key, hint);
		}
	}
	if (
		reference.sessionId &&
		shouldReplaceChildParentHint(hintsById.get(reference.sessionId), reference)
	) {
		hintsById.set(reference.sessionId, hint);
	}
};

const resolveTaskResultStatus = (
	status: string | undefined,
	fallbackStatus: SessionStatus,
	fallbackFinishReason?: string,
): { status: SessionStatus; statusDetail?: string } => {
	switch (status) {
		case "running":
		case "pending": {
			const fallbackDisplayStatus = getDisplayStatus(fallbackStatus, {
				finishReason: fallbackFinishReason,
			});
			if (
				fallbackDisplayStatus === SessionStatus.completed ||
				fallbackStatus === SessionStatus.failed
			) {
				return { status: fallbackStatus };
			}
			return { status: SessionStatus.running, statusDetail: "Task running" };
		}
		case "failed":
			return { status: SessionStatus.failed, statusDetail: "Task failed" };
		case "aborted":
		case "cancelled":
			return { status: SessionStatus.unknown, statusDetail: "Task aborted" };
		case "completed":
			return { status: SessionStatus.completed, statusDetail: "Task complete" };
		default:
			return { status: fallbackStatus };
	}
};

const isOpenChildSession = (session: SubagentSession): boolean =>
	isActiveStatus(
		getDisplayStatus(session.status, { finishReason: session.finishReason }),
	);

const resolveRootSessionId = (
	session: Session | SubagentSession,
	sessionsById: Map<string, Session | SubagentSession>,
): string | undefined => {
	const seen = new Set<string>([session.id]);
	let parentId = session.parent_id;
	while (parentId) {
		if (seen.has(parentId)) {
			return undefined;
		}
		seen.add(parentId);

		const parent = sessionsById.get(parentId);
		if (!parent) {
			return undefined;
		}
		if (!parent.parent_id) {
			return parent.id;
		}
		parentId = parent.parent_id;
	}
	return session.id;
};

export const buildPiSessionSnapshot = (params: {
	source: PiDialect;
	logs: PiSessionLogRecord[];
	logIssues?: Partial<Record<string, string>>;
}): SessionSnapshot => {
	const { source, logs, logIssues = {} } = params;
	const sourceLabel = getSessionSourceLabel(source);
	const statusBySessionId: Partial<Record<string, SessionStatus>> = {};
	const messageCountBySessionId: Partial<Record<string, number>> = {};
	const sessionIssues: Partial<Record<string, string>> = { ...logIssues };
	const logsById = new Map<string, PiSessionLogRecord>();
	const pathAliases = new Map<string, string>();
	const summariesById = new Map<string, PiSessionSummary>();

	for (const log of logs) {
		if (logsById.has(log.header.id)) {
			sessionIssues[log.header.id] =
				`${sourceLabel} session id appears in multiple JSONL files.`;
			continue;
		}
		logsById.set(log.header.id, log);
		addPathAliases(pathAliases, log);
		summariesById.set(log.header.id, summarizePiSession(log));
	}
	const childHintsByPath = new Map<string, PiChildParentHint>();
	const childHintsById = new Map<string, PiChildParentHint>();
	for (const summary of summariesById.values()) {
		for (const reference of summary.childReferences) {
			addChildParentHint(
				childHintsByPath,
				childHintsById,
				summary.id,
				reference,
			);
		}
	}

	const sessionsById = new Map<string, Session | SubagentSession>();
	for (const log of logsById.values()) {
		const summary = summariesById.get(log.header.id);
		if (!summary) {
			continue;
		}

		const childHint =
			childHintsByPath.get(normalizePath(log.path)) ??
			childHintsById.get(log.header.id);
		const parentId =
			resolveParentId(log, pathAliases, logsById) ??
			childHint?.parentId ??
			resolveArtifactLayoutParentId(log, pathAliases) ??
			null;
		if (summary.parentSession && !parentId) {
			sessionIssues[summary.id] = `${sourceLabel} parent session not found.`;
		}
		const resolvedStatus = resolveTaskResultStatus(
			childHint?.reference.status,
			summary.status,
			summary.finishReason,
		);
		const currentAgent = childHint?.reference.agent ?? summary.currentAgent;
		const finishReason =
			resolvedStatus.status === SessionStatus.completed &&
			(childHint?.reference.status === "completed" ||
				isToolUseFinishReason(summary.finishReason))
				? undefined
				: summary.finishReason;

		const session = {
			...buildSessionRecord(log, summary, parentId),
			sessionSource: source,
			capabilities: getDefaultSessionCapabilities(source),
			currentAgent,
			currentModelID: summary.currentModelID,
			currentVariant: summary.currentVariant,
			currentReasoningEffort: summary.currentReasoningEffort,
			status: resolvedStatus.status,
			statusDetail: resolvedStatus.statusDetail ?? summary.statusDetail,
			finishReason,
			providerID: summary.providerID,
			sourceMetadata: {
				sourceCategory: sourceLabel,
				rawSource: log.path,
				sessionPath: log.path,
				parentSessionPath: summary.parentPath,
				lastEventType: summary.lastEntryType,
				agentRole: currentAgent,
				modelRole: summary.modelRole,
				activeToolNames:
					summary.activeToolNames && summary.activeToolNames.length > 0
						? summary.activeToolNames
						: undefined,
				reasoningEffort: summary.currentReasoningEffort,
			},
		};

		sessionsById.set(log.header.id, session);
		statusBySessionId[log.header.id] = resolvedStatus.status;
		messageCountBySessionId[log.header.id] = summary.messageCount;
	}

	const rootSessionsById = new Map<string, Session>();
	for (const session of sessionsById.values()) {
		if (session.parent_id) {
			continue;
		}

		rootSessionsById.set(session.id, {
			...session,
			subagentSessions: [],
		} as Session);
	}

	for (const session of sessionsById.values()) {
		if (!session.parent_id) {
			continue;
		}

		const rootId = resolveRootSessionId(session, sessionsById);
		const rootSession = rootId ? rootSessionsById.get(rootId) : undefined;
		if (!rootSession) {
			sessionIssues[session.id] = `${sourceLabel} root session not found.`;
			continue;
		}

		rootSession.subagentSessions = [
			...(rootSession.subagentSessions ?? []),
			session as SubagentSession,
		];
	}

	for (const rootSession of rootSessionsById.values()) {
		const childSessions = rootSession.subagentSessions ?? [];
		const openChildCount = childSessions.filter(isOpenChildSession).length;
		const closedChildCount = childSessions.length - openChildCount;
		rootSession.sourceMetadata = {
			...rootSession.sourceMetadata,
			openChildCount,
			closedChildCount,
		};
		if (openChildCount > 0) {
			rootSession.status = SessionStatus.running;
			rootSession.statusDetail = `Awaiting ${openChildCount} child session${openChildCount === 1 ? "" : "s"}`;
			statusBySessionId[rootSession.id] = SessionStatus.running;
		}
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

const loadPiLogs = (
	source: PiDialect,
	roots: string[],
): {
	logs: PiSessionLogRecord[];
	logIssues: Partial<Record<string, string>>;
} => {
	const logs: PiSessionLogRecord[] = [];
	const logIssues: Partial<Record<string, string>> = {};
	for (const root of roots) {
		for (const path of collectJsonlFiles(root)) {
			const parsed = parsePiSessionLogFile(path, root, source);
			if (parsed) {
				logs.push(parsed);
			} else {
				logIssues[path] =
					`Unable to parse ${getSessionSourceLabel(source)} JSONL session.`;
			}
		}
	}
	return { logs, logIssues };
};

const getPiFamilySnapshot = (
	source: PiDialect,
	options: PiSnapshotOptions = {},
): DatabaseResult<SessionSnapshot> => {
	try {
		const configuredRoots =
			options.sessionRoots ?? resolvePiSessionRoots(source);
		const roots = getReadableExistingRoots(configuredRoots);
		if (roots.length === 0) {
			return {
				ok: false,
				error: {
					code: "missing_database",
					message: `${getSessionSourceLabel(source)} sessions not found at ${configuredRoots.join(", ")}.`,
				},
			};
		}

		const { logs, logIssues } = loadPiLogs(source, roots);
		if (logs.length === 0 && Object.keys(logIssues).length === 0) {
			return { ok: true, value: { ...EMPTY_SNAPSHOT } };
		}

		return {
			ok: true,
			value: buildPiSessionSnapshot({ source, logs, logIssues }),
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				`Failed to read ${getSessionSourceLabel(source)} sessions.`,
			),
		};
	}
};

export const getPiSnapshot = (
	options: PiSnapshotOptions = {},
): DatabaseResult<SessionSnapshot> => getPiFamilySnapshot("pi", options);

export const getOmpSnapshot = (
	options: PiSnapshotOptions = {},
): DatabaseResult<SessionSnapshot> => getPiFamilySnapshot("omp", options);

const collectDescendantIds = (
	targetId: string,
	logs: PiSessionLogRecord[],
): Set<string> => {
	const logsById = new Map(logs.map((log) => [log.header.id, log]));
	const pathAliases = new Map<string, string>();
	for (const log of logs) {
		addPathAliases(pathAliases, log);
	}

	const childrenByParentId = new Map<string, string[]>();
	for (const log of logs) {
		const parentId = resolveParentId(log, pathAliases, logsById);
		if (!parentId) {
			continue;
		}
		childrenByParentId.set(parentId, [
			...(childrenByParentId.get(parentId) ?? []),
			log.header.id,
		]);
	}

	const ids = new Set<string>([targetId]);
	const stack = [targetId];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		for (const childId of childrenByParentId.get(current) ?? []) {
			if (ids.has(childId)) {
				continue;
			}
			ids.add(childId);
			stack.push(childId);
		}
	}
	return ids;
};

const findTargetLog = (
	sessionId: string,
	logs: PiSessionLogRecord[],
	sessionPath?: string,
): PiSessionLogRecord | undefined => {
	const normalizedSessionPath = sessionPath
		? normalizePath(sessionPath)
		: undefined;
	return logs.find((log) => {
		if (
			normalizedSessionPath &&
			normalizePath(log.path) === normalizedSessionPath
		) {
			return true;
		}
		return log.header.id === sessionId || log.header.id.startsWith(sessionId);
	});
};

const removeIfExists = (path: string): boolean => {
	try {
		if (!existsSync(path)) {
			return false;
		}
		if (lstatSync(path).isDirectory()) {
			rmSync(path, { recursive: true, force: true });
		} else {
			unlinkSync(path);
		}
		return true;
	} catch {
		return false;
	}
};

const deletePiFamilySession = async (
	source: PiDialect,
	sessionId: string,
	options: DeletePiSessionOptions = {},
): Promise<DatabaseResult<PiDeleteResult>> => {
	try {
		const configuredRoots =
			options.sessionRoots ?? resolvePiSessionRoots(source);
		const roots = getReadableExistingRoots(configuredRoots);
		const { logs } = loadPiLogs(source, roots);
		const targetLog = findTargetLog(sessionId, logs, options.sessionPath);
		if (!targetLog) {
			return {
				ok: false,
				error: {
					code: "query_failed",
					message: `${getSessionSourceLabel(source)} session ${sessionId} was not found.`,
				},
			};
		}

		const idsToDelete = collectDescendantIds(targetLog.header.id, logs);
		const pathsToDelete = logs
			.filter((log) => idsToDelete.has(log.header.id))
			.map((log) => log.path);
		const deletedSessionPaths: string[] = [];
		const deletedArtifactPaths: string[] = [];

		for (const path of pathsToDelete) {
			if (removeIfExists(path)) {
				deletedSessionPaths.push(path);
			}

			if (source === "omp") {
				const artifactPath = path.endsWith(".jsonl")
					? path.slice(0, -".jsonl".length)
					: path;
				if (removeIfExists(artifactPath)) {
					deletedArtifactPaths.push(artifactPath);
				}
			}
		}

		return {
			ok: true,
			value: { deletedSessionPaths, deletedArtifactPaths },
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				`Failed to delete ${getSessionSourceLabel(source)} session ${sessionId}.`,
			),
		};
	}
};

export const deletePiSession = (
	sessionId: string,
	options: DeletePiSessionOptions = {},
): Promise<DatabaseResult<PiDeleteResult>> =>
	deletePiFamilySession("pi", sessionId, options);

export const deleteOmpSession = (
	sessionId: string,
	options: DeletePiSessionOptions = {},
): Promise<DatabaseResult<PiDeleteResult>> =>
	deletePiFamilySession("omp", sessionId, options);
