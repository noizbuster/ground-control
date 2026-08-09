import { randomUUID } from "node:crypto";
import {
	type Dirent,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
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
	relative,
	resolve,
	sep,
} from "node:path";
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

const MAX_PI_SESSION_ID_LENGTH = 256;
const MAX_PI_COMPACT_TIMESTAMP_LENGTH = 64;
const MAX_PI_COMPACT_CWD_LENGTH = 4_096;
const MAX_PI_COMPACT_PARENT_SESSION_LENGTH = 4_096;
const MAX_PI_COMPACT_TITLE_LENGTH = 1_024;
const MAX_PI_COMPACT_TITLE_SOURCE_LENGTH = 256;

export interface PiSessionLogRecord {
	source: PiDialect;
	path: string;
	root: string;
	header: PiSessionHeader;
	entries?: JsonObject[];
	mtimeMs: number;
	size?: number;
	summary?: PiSessionSummary;
}

interface PiLoadedSessionLogRecord extends PiSessionLogRecord {
	readonly fileVersion: PiFileVersion;
}

interface PiSessionRawLogRecord extends PiLoadedSessionLogRecord {
	entries: JsonObject[];
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

interface PiFileVersion {
	readonly canonicalPath: string;
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
	readonly size: number;
}

interface PiParsedSessionContent {
	readonly header: PiSessionHeader;
	readonly entries: JsonObject[];
}

interface PiRawParseCacheEntry {
	readonly parsed: PiParsedSessionContent | null;
	readonly sourceBytes: number;
}

interface PiRefreshOccurrence {
	readonly key: string;
	readonly source: PiDialect;
	readonly root: string;
	readonly path: string;
	version?: PiFileVersion;
	record?: PiSessionLogRecord;
	issue?: string;
	issueVersion?: PiFileVersion;
}

interface PiSourceRefreshState {
	rootSignature: string | null;
	lastReconciledAt: number | null;
	occurrences: Map<string, PiRefreshOccurrence>;
}

interface PiSnapshotCycleOptions {
	readonly nowMs?: number;
	readonly pi?: PiSnapshotOptions;
	readonly omp?: PiSnapshotOptions;
}

const PI_RECONCILE_INTERVAL_MS = 10_000;
const PI_RAW_PARSE_CACHE_LIMIT = 256;
const PI_RAW_PARSE_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
const piRawParseCache = new Map<string, PiRawParseCacheEntry>();
let piRawParseCacheSourceBytes = 0;

const piSourceRefreshStates: Record<PiDialect, PiSourceRefreshState> = {
	pi: {
		rootSignature: null,
		lastReconciledAt: null,
		occurrences: new Map(),
	},
	omp: {
		rootSignature: null,
		lastReconciledAt: null,
		occurrences: new Map(),
	},
};

const createPiOccurrenceKey = (
	source: PiDialect,
	root: string,
	path: string,
): string => `${source}\0${root}\0${path}`;

const getPiFileVersion = (path: string): PiFileVersion | undefined => {
	try {
		const stats = statSync(path);
		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(path);
		} catch {
			canonicalPath = resolve(path);
		}
		return {
			canonicalPath,
			dev: stats.dev,
			ino: stats.ino,
			mtimeMs: stats.mtimeMs,
			size: stats.size,
		};
	} catch {
		return undefined;
	}
};

const arePiFileVersionsEqual = (
	left: PiFileVersion | undefined,
	right: PiFileVersion | undefined,
): boolean =>
	left !== undefined &&
	right !== undefined &&
	left.canonicalPath === right.canonicalPath &&
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.mtimeMs === right.mtimeMs &&
	left.size === right.size;

const createPiFileVersionKeyPrefix = (version: PiFileVersion): string =>
	`${version.canonicalPath}\0`;

const createPiFileVersionKey = (version: PiFileVersion): string =>
	`${createPiFileVersionKeyPrefix(version)}${version.dev}\0${version.ino}\0${version.mtimeMs}\0${version.size}`;

const removeCachedPiRawParse = (key: string): void => {
	const cached = piRawParseCache.get(key);
	if (!cached) {
		return;
	}

	piRawParseCache.delete(key);
	piRawParseCacheSourceBytes -= cached.sourceBytes;
};

const getCachedPiRawParse = (
	version: PiFileVersion,
): PiParsedSessionContent | null | undefined => {
	const key = createPiFileVersionKey(version);
	const cached = piRawParseCache.get(key);
	if (!cached) {
		return undefined;
	}

	piRawParseCache.delete(key);
	piRawParseCache.set(key, cached);
	return cached.parsed;
};

const cachePiRawParse = (
	version: PiFileVersion,
	parsed: PiParsedSessionContent | null,
): void => {
	const key = createPiFileVersionKey(version);
	const keyPrefix = createPiFileVersionKeyPrefix(version);
	for (const cachedKey of piRawParseCache.keys()) {
		if (cachedKey.startsWith(keyPrefix)) {
			removeCachedPiRawParse(cachedKey);
		}
	}

	if (version.size > PI_RAW_PARSE_CACHE_BYTE_LIMIT) {
		return;
	}

	piRawParseCache.set(key, { parsed, sourceBytes: version.size });
	piRawParseCacheSourceBytes += version.size;

	while (
		piRawParseCache.size > PI_RAW_PARSE_CACHE_LIMIT ||
		piRawParseCacheSourceBytes > PI_RAW_PARSE_CACHE_BYTE_LIMIT
	) {
		const oldestKey = piRawParseCache.keys().next().value;
		if (oldestKey === undefined) {
			return;
		}
		removeCachedPiRawParse(oldestKey);
	}
};

const parsePiSessionContent = (
	content: string,
): PiParsedSessionContent | undefined => {
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

		if (
			!header &&
			parsed.type === "session" &&
			typeof parsed.id === "string" &&
			parsed.id.length <= MAX_PI_SESSION_ID_LENGTH
		) {
			header = parsed as PiSessionHeader;
			continue;
		}

		entries.push(parsed);
	}

	if (!header) {
		return undefined;
	}

	return { header, entries };
};

const getBoundedCompactHeaderString = (
	value: unknown,
	maxLength: number,
): string | undefined =>
	typeof value === "string" && value.length <= maxLength ? value : undefined;

const createCompactPiSessionHeader = (
	header: PiSessionHeader,
): PiSessionHeader => {
	const timestamp =
		typeof header.timestamp === "number" && Number.isFinite(header.timestamp)
			? header.timestamp
			: getBoundedCompactHeaderString(
					header.timestamp,
					MAX_PI_COMPACT_TIMESTAMP_LENGTH,
				);
	const cwd = getBoundedCompactHeaderString(
		header.cwd,
		MAX_PI_COMPACT_CWD_LENGTH,
	);
	const parentSession = getBoundedCompactHeaderString(
		header.parentSession,
		MAX_PI_COMPACT_PARENT_SESSION_LENGTH,
	);
	const title = getBoundedCompactHeaderString(
		header.title,
		MAX_PI_COMPACT_TITLE_LENGTH,
	);
	const titleSource = getBoundedCompactHeaderString(
		header.titleSource,
		MAX_PI_COMPACT_TITLE_SOURCE_LENGTH,
	);

	return {
		type: "session",
		id: header.id,
		...(timestamp === undefined ? {} : { timestamp }),
		...(cwd === undefined ? {} : { cwd }),
		...(parentSession === undefined ? {} : { parentSession }),
		...(title === undefined ? {} : { title }),
		...(titleSource === undefined ? {} : { titleSource }),
	};
};

const createPiSessionRawLogRecord = (
	parsed: PiParsedSessionContent,
	path: string,
	root: string,
	source: PiDialect,
	version: PiFileVersion,
): PiSessionRawLogRecord => ({
	source,
	path,
	root,
	header: parsed.header,
	entries: parsed.entries,
	mtimeMs: version.mtimeMs,
	size: version.size,
	fileVersion: version,
});

const createPiCompactSessionLogRecord = (
	parsed: PiParsedSessionContent,
	occurrence: PiRefreshOccurrence,
	version: PiFileVersion,
): PiSessionLogRecord => {
	const rawLog = createPiSessionRawLogRecord(
		parsed,
		occurrence.path,
		occurrence.root,
		occurrence.source,
		version,
	);
	const header = createCompactPiSessionHeader(rawLog.header);
	return {
		source: rawLog.source,
		path: rawLog.path,
		root: rawLog.root,
		header,
		mtimeMs: rawLog.mtimeMs,
		size: rawLog.size,
		summary: summarizePiSession({ ...rawLog, header }),
	};
};

export const invalidatePiSessionCaches = (): void => {
	piRawParseCache.clear();
	piRawParseCacheSourceBytes = 0;
	for (const state of Object.values(piSourceRefreshStates)) {
		state.rootSignature = null;
		state.lastReconciledAt = null;
		state.occurrences.clear();
	}
};

export const getPiRawParseCacheKeysForTesting = (): readonly string[] =>
	Array.from(piRawParseCache.keys());

export const getPiRawParseCacheStateForTesting = (): Readonly<{
	readonly byteLimit: number;
	readonly sourceBytes: number;
}> => ({
	byteLimit: PI_RAW_PARSE_CACHE_BYTE_LIMIT,
	sourceBytes: piRawParseCacheSourceBytes,
});

export const parsePiSessionLogFile = (
	path: string,
	root: string,
	source: PiDialect,
): PiSessionRawLogRecord | undefined => {
	const version = getPiFileVersion(path);
	if (!version) {
		return undefined;
	}

	const cached = getCachedPiRawParse(version);
	if (cached !== undefined) {
		return cached
			? createPiSessionRawLogRecord(cached, path, root, source, version)
			: undefined;
	}

	let content: string | undefined;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const after = getPiFileVersion(path);
	if (
		content === undefined ||
		!after ||
		!arePiFileVersionsEqual(version, after)
	) {
		return undefined;
	}

	const parsed = parsePiSessionContent(content);
	cachePiRawParse(after, parsed ?? null);
	return parsed
		? createPiSessionRawLogRecord(parsed, path, root, source, after)
		: undefined;
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
const AWAITING_USER_RESPONSE_TOOL_NAME = "ask";
const OMP_SILENT_ABORT_ERROR = "__omp.silent_abort__";
const PLAN_READY_FOR_REVIEW_TEXT = "Plan ready for review.";

const isToolUseFinishReason = (finishReason: string | undefined): boolean =>
	finishReason === "toolUse" || finishReason === "tool_use";

type OmpSessionExitKind = "normal" | "process_exit" | "signal" | "fatal";

const getOmpSessionExitKind = (
	entry: JsonObject,
): OmpSessionExitKind | undefined => {
	if (
		entry.type !== "custom" ||
		entry.customType !== "session_exit" ||
		!isJsonObject(entry.data)
	) {
		return undefined;
	}

	const kind = trimToUndefined(entry.data.kind);
	return kind === "normal" ||
		kind === "process_exit" ||
		kind === "signal" ||
		kind === "fatal"
		? kind
		: undefined;
};

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

const isSuccessfulProposeToolResult = (
	entry: JsonObject | undefined,
	message: JsonObject | undefined,
): boolean => {
	if (!entry && !message) {
		return false;
	}
	if (
		readMetadataBoolean(message?.isError) === true ||
		readMetadataBoolean(entry?.isError) === true
	) {
		return false;
	}

	const details = isJsonObject(message?.details)
		? message.details
		: isJsonObject(entry?.details)
			? entry.details
			: undefined;
	const xdev = isJsonObject(details?.xdev) ? details.xdev : undefined;
	if (trimToUndefined(xdev?.tool)?.toLowerCase() === "propose") {
		return true;
	}

	const text = normalizeComparableText(
		extractTextFromContent(message?.content) ??
			extractTextFromContent(entry?.content),
	);
	return text === PLAN_READY_FOR_REVIEW_TEXT;
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

const summarizePiSession = (log: PiSessionRawLogRecord): PiSessionSummary => {
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
	let sessionExitKind: OmpSessionExitKind | undefined;
	let latestMode: string | undefined;

	for (const entry of getActiveBranchEntries(log.entries)) {
		lastEntryType = trimToUndefined(entry.type) ?? lastEntryType;
		lastTimestampMs = normalizeTimestampMs(entry.timestamp) ?? lastTimestampMs;

		if (log.source === "omp") {
			const exitKind = getOmpSessionExitKind(entry);
			if (exitKind) {
				sessionExitKind = exitKind;
				continue;
			}

			// OMP can append a resumed turn to the same JSONL file. Activity
			// after an exit record belongs to that newer session lifecycle.
			sessionExitKind = undefined;
		}

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

		if (entry.type === "mode_change") {
			latestMode = trimToUndefined(entry.mode) ?? latestMode;
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
	// OMP plan mode exits the agent turn with a silent abort after a successful
	// xd://propose handoff. A later mode_change to "none" means the operator
	// approved or otherwise closed that review; until then the session is waiting.
	const hasPlanReviewHandoff =
		lastRole === "assistant" &&
		lastAssistantFinish === "aborted" &&
		lastAssistantError === OMP_SILENT_ABORT_ERROR &&
		isSuccessfulProposeToolResult(
			latestToolResultEntry,
			latestToolResultMessage,
		);
	const hasResolvedPlanReview = hasPlanReviewHandoff && latestMode === "none";
	const isAwaitingPlanReview = hasPlanReviewHandoff && !hasResolvedPlanReview;
	const isAwaitingUserResponse =
		(isToolUseFinish &&
			lastAssistantToolCallNames.includes(AWAITING_USER_RESPONSE_TOOL_NAME)) ||
		isAwaitingPlanReview;
	const hasSuccessfulYieldTail = isSuccessfulYieldToolResultTail({
		lastRole,
		lastAssistantFinish,
		lastAssistantToolCallNames,
		latestToolResultEntry,
		latestToolResultMessage,
	});
	const isTerminalAssistantFinish =
		lastRole === "assistant" && !isToolUseFinish && !isAwaitingPlanReview;
	const hasRunningActiveTools =
		activeToolNames.length > 0 &&
		!isIdleEndTurn &&
		!isIdleToolUseHandoff &&
		!isAwaitingUserResponse &&
		!hasSuccessfulYieldTail &&
		!isTerminalAssistantFinish;

	const status = (() => {
		if (sessionExitKind === "fatal") {
			return SessionStatus.failed;
		}
		if (sessionExitKind) {
			return SessionStatus.completed;
		}
		if (hasRunningActiveTools) {
			return SessionStatus.running;
		}
		if (messageCount === 0) {
			return SessionStatus.unknown;
		}
		if (lastAssistantError && lastAssistantError !== OMP_SILENT_ABORT_ERROR) {
			return SessionStatus.failed;
		}
		if (lastAssistantFinish === "error") {
			return SessionStatus.failed;
		}
		if (hasResolvedPlanReview) {
			return SessionStatus.completed;
		}
		if (hasSuccessfulYieldTail) {
			return SessionStatus.completed;
		}
		if (isAwaitingUserResponse) {
			return SessionStatus.waiting;
		}
		if (lastAssistantFinish === "aborted") {
			return SessionStatus.unknown;
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
		if (sessionExitKind === "signal") {
			return "Stopped";
		}
		if (sessionExitKind === "fatal") {
			return "Session failed";
		}
		if (hasRunningActiveTools) {
			return `Running ${activeToolNames.length === 1 ? activeToolNames[0] : `${activeToolNames.length} tools`}`;
		}
		if (lastAssistantError && lastAssistantError !== OMP_SILENT_ABORT_ERROR) {
			return lastAssistantError;
		}
		if (hasResolvedPlanReview) {
			return undefined;
		}
		if (isAwaitingUserResponse) {
			return "Awaiting user input";
		}
		if (lastAssistantError === OMP_SILENT_ABORT_ERROR) {
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
		finishReason:
			sessionExitKind === "signal"
				? "interrupted"
				: sessionExitKind === "fatal"
					? "error"
					: hasResolvedPlanReview || hasSuccessfulYieldTail
						? undefined
						: isAwaitingUserResponse
							? "awaiting_user"
							: lastAssistantFinish,
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
				fallbackDisplayStatus === SessionStatus.idle ||
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

		const summary =
			log.summary ??
			(log.entries
				? summarizePiSession(log as PiSessionRawLogRecord)
				: undefined);
		if (!summary) {
			sessionIssues[log.header.id] =
				`${sourceLabel} session summary is unavailable.`;
			continue;
		}

		logsById.set(log.header.id, log);
		addPathAliases(pathAliases, log);
		summariesById.set(log.header.id, summary);
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
	logs: PiLoadedSessionLogRecord[];
	logIssues: Partial<Record<string, string>>;
} => {
	const logs: PiLoadedSessionLogRecord[] = [];
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

export const getPiOmpSnapshots = (
	options: PiSnapshotCycleOptions = {},
): {
	pi: DatabaseResult<SessionSnapshot>;
	omp: DatabaseResult<SessionSnapshot>;
} => {
	const nowMs = options.nowMs ?? Date.now();
	const results: Partial<Record<PiDialect, DatabaseResult<SessionSnapshot>>> =
		{};
	const availableSources: Array<{
		source: PiDialect;
		roots: string[];
		state: PiSourceRefreshState;
	}> = [];

	try {
		for (const source of ["pi", "omp"] as const) {
			const sourceOptions = options[source];
			const configuredRoots =
				sourceOptions?.sessionRoots ?? resolvePiSessionRoots(source);
			const roots = getReadableExistingRoots(configuredRoots);
			if (roots.length === 0) {
				const state = piSourceRefreshStates[source];
				state.rootSignature = null;
				state.lastReconciledAt = null;
				state.occurrences.clear();
				results[source] = {
					ok: false,
					error: {
						code: "missing_database",
						message: `${getSessionSourceLabel(source)} sessions not found at ${configuredRoots.join(", ")}.`,
					},
				};
				continue;
			}

			const state = piSourceRefreshStates[source];
			const rootSignature = roots.join("\0");
			const shouldReconcile =
				state.rootSignature !== rootSignature ||
				state.lastReconciledAt === null ||
				nowMs - state.lastReconciledAt >= PI_RECONCILE_INTERVAL_MS;
			if (shouldReconcile) {
				const nextOccurrences = new Map<string, PiRefreshOccurrence>();
				for (const root of roots) {
					for (const path of collectJsonlFiles(root)) {
						const key = createPiOccurrenceKey(source, root, path);
						const previous = state.occurrences.get(key);
						nextOccurrences.set(
							key,
							previous ?? {
								key,
								source,
								root,
								path,
							},
						);
					}
				}
				state.occurrences = nextOccurrences;
				state.rootSignature = rootSignature;
				state.lastReconciledAt = nowMs;
			}

			availableSources.push({ source, roots, state });
		}

		const changedGroups = new Map<string, PiRefreshOccurrence[]>();
		for (const { state } of availableSources) {
			for (const occurrence of state.occurrences.values()) {
				const version = getPiFileVersion(occurrence.path);
				if (!version) {
					if (!occurrence.record) {
						occurrence.issue = "Unable to read JSONL session.";
						occurrence.issueVersion = undefined;
						occurrence.version = undefined;
					}
					continue;
				}

				const hasStableCachedValue =
					occurrence.record !== undefined ||
					(occurrence.issueVersion !== undefined &&
						arePiFileVersionsEqual(occurrence.issueVersion, version));
				if (
					arePiFileVersionsEqual(occurrence.version, version) &&
					hasStableCachedValue
				) {
					continue;
				}

				const physicalKey = createPiFileVersionKey(version);
				const group = changedGroups.get(physicalKey);
				if (group) {
					group.push(occurrence);
				} else {
					changedGroups.set(physicalKey, [occurrence]);
				}
			}
		}

		for (const occurrences of changedGroups.values()) {
			const representative = occurrences[0];
			const before = getPiFileVersion(representative.path);
			const cached = before ? getCachedPiRawParse(before) : undefined;
			let content = "";
			let readSucceeded = false;
			if (cached === undefined && before) {
				try {
					content = readFileSync(representative.path, "utf8");
					readSucceeded = true;
				} catch {}
			}
			const after = getPiFileVersion(representative.path);
			if (
				!before ||
				!after ||
				!arePiFileVersionsEqual(before, after) ||
				(cached === undefined && !readSucceeded)
			) {
				for (const occurrence of occurrences) {
					if (!occurrence.record) {
						occurrence.issue = "JSONL session changed while being read.";
					}
				}
				continue;
			}

			let parsed: PiParsedSessionContent | null;
			if (cached === undefined) {
				parsed = parsePiSessionContent(content) ?? null;
				cachePiRawParse(after, parsed);
			} else {
				parsed = cached;
			}
			for (const occurrence of occurrences) {
				if (!parsed) {
					occurrence.record = undefined;
					occurrence.issue = `Unable to parse ${getSessionSourceLabel(occurrence.source)} JSONL session.`;
					occurrence.issueVersion = after;
					occurrence.version = after;
					continue;
				}

				occurrence.record = createPiCompactSessionLogRecord(
					parsed,
					occurrence,
					after,
				);
				occurrence.issue = undefined;
				occurrence.issueVersion = undefined;
				occurrence.version = after;
			}
		}

		for (const { source, state } of availableSources) {
			const logs: PiSessionLogRecord[] = [];
			const logIssues: Partial<Record<string, string>> = {};
			for (const occurrence of state.occurrences.values()) {
				if (occurrence.record) {
					logs.push(occurrence.record);
				} else if (occurrence.issue) {
					logIssues[occurrence.path] = occurrence.issue;
				}
			}

			results[source] =
				logs.length === 0 && Object.keys(logIssues).length === 0
					? { ok: true, value: { ...EMPTY_SNAPSHOT } }
					: {
							ok: true,
							value: buildPiSessionSnapshot({ source, logs, logIssues }),
						};
		}
	} catch (error) {
		for (const source of ["pi", "omp"] as const) {
			results[source] = {
				ok: false,
				error: createQueryFailedDatabaseError(
					error,
					`Failed to read ${getSessionSourceLabel(source)} sessions.`,
				),
			};
		}
	}

	return {
		pi: results.pi ?? {
			ok: false,
			error: createQueryFailedDatabaseError(
				new Error("Pi snapshot was not produced."),
				"Failed to read Pi sessions.",
			),
		},
		omp: results.omp ?? {
			ok: false,
			error: createQueryFailedDatabaseError(
				new Error("omp snapshot was not produced."),
				"Failed to read omp sessions.",
			),
		},
	};
};

export const getPiSnapshot = (
	options: PiSnapshotOptions = {},
): DatabaseResult<SessionSnapshot> => getPiOmpSnapshots({ pi: options }).pi;

export const getOmpSnapshot = (
	options: PiSnapshotOptions = {},
): DatabaseResult<SessionSnapshot> => getPiOmpSnapshots({ omp: options }).omp;

const collectDescendantLogs = <T extends PiSessionLogRecord>(
	source: PiDialect,
	targetLog: T,
	logs: T[],
): T[] => {
	const logsByPath = new Map<string, T>();
	for (const log of logs) {
		const path = normalizePath(log.path);
		if (!logsByPath.has(path)) {
			logsByPath.set(path, log);
		}
	}
	logsByPath.set(normalizePath(targetLog.path), targetLog);

	const uniqueLogs = [...logsByPath.values()];
	const logsById = new Map<string, T[]>();
	const aliases = new Map<string, T[]>();
	const addToIndex = (index: Map<string, T[]>, key: string, log: T): void => {
		const values = index.get(key) ?? [];
		if (
			!values.some(
				(value) => normalizePath(value.path) === normalizePath(log.path),
			)
		) {
			values.push(log);
			index.set(key, values);
		}
	};

	for (const log of uniqueLogs) {
		addToIndex(logsById, log.header.id, log);
		addToIndex(aliases, basename(log.path), log);
		addToIndex(aliases, basename(log.path, ".jsonl"), log);
	}

	const resolveDeletionParent = (log: T): T | undefined => {
		const parent = trimToUndefined(log.header.parentSession);
		if (!parent) {
			return undefined;
		}

		const parentByIdCandidates = logsById.get(parent);
		const parentById =
			parentByIdCandidates?.length === 1 ? parentByIdCandidates[0] : undefined;
		if (parentById) {
			return parentById;
		}

		const parentPath = resolveParentPath(log.path, parent);
		if (parentPath) {
			return logsByPath.get(normalizePath(parentPath));
		}

		const parentAliasCandidates = aliases.get(parent);
		const parentAlias =
			parentAliasCandidates?.length === 1
				? parentAliasCandidates[0]
				: undefined;
		if (parentAlias) {
			return parentAlias;
		}

		const parentJsonlAliasCandidates = aliases.get(`${parent}.jsonl`);
		return parentJsonlAliasCandidates?.length === 1
			? parentJsonlAliasCandidates[0]
			: undefined;
	};

	const childrenByParentPath = new Map<string, T[]>();
	for (const log of uniqueLogs) {
		const parent = resolveDeletionParent(log);
		if (!parent) {
			continue;
		}
		const parentPath = normalizePath(parent.path);
		const children = childrenByParentPath.get(parentPath);
		if (children) {
			children.push(log);
		} else {
			childrenByParentPath.set(parentPath, [log]);
		}
	}

	const paths = new Set<string>([normalizePath(targetLog.path)]);
	const stack = [normalizePath(targetLog.path)];
	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) {
			continue;
		}
		for (const child of childrenByParentPath.get(currentPath) ?? []) {
			const childPath = normalizePath(child.path);
			if (paths.has(childPath)) {
				continue;
			}
			paths.add(childPath);
			stack.push(childPath);
		}

		if (source !== "omp") {
			continue;
		}
		const artifactPath = getOmpArtifactPath(currentPath);
		for (const log of uniqueLogs) {
			const childPath = normalizePath(log.path);
			const relativeChildPath = relative(artifactPath, childPath);
			if (
				relativeChildPath.length === 0 ||
				relativeChildPath === ".." ||
				relativeChildPath.startsWith(`..${sep}`) ||
				isAbsolute(relativeChildPath) ||
				paths.has(childPath)
			) {
				continue;
			}
			paths.add(childPath);
			stack.push(childPath);
		}
	}
	return uniqueLogs.filter((log) => paths.has(normalizePath(log.path)));
};

const findTargetLog = <T extends PiSessionLogRecord>(
	sessionId: string,
	logs: T[],
	sessionPath?: string,
): T | undefined => {
	const normalizedSessionPath = sessionPath
		? normalizePath(sessionPath)
		: undefined;
	const exactIdLogs = logs.filter((log) => log.header.id === sessionId);
	if (normalizedSessionPath) {
		return exactIdLogs.find(
			(log) => normalizePath(log.path) === normalizedSessionPath,
		);
	}

	const targetLog = exactIdLogs[0];
	if (
		!targetLog ||
		exactIdLogs.some(
			(log) => normalizePath(log.path) !== normalizePath(targetLog.path),
		)
	) {
		return undefined;
	}
	return targetLog;
};

const pathExistsWithoutFollowing = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

const removeQuarantinedOmpArtifact = (path: string): void => {
	const identity = getOmpArtifactIdentity(path);
	if (!identity) {
		throw new Error(`OMP artifact quarantine entry ${path} was not found.`);
	}

	if (identity.kind === "directory") {
		rmSync(path, { recursive: true, force: false });
	} else {
		unlinkSync(path);
	}

	if (pathExistsWithoutFollowing(path)) {
		throw new Error(`OMP artifact quarantine entry ${path} still exists.`);
	}
};

let piSessionDeletionBeforeQuarantineForTesting:
	| ((path: string) => void)
	| undefined;

let piSessionDeletionBeforeUnlinkForTesting:
	| ((path: string) => void)
	| undefined;

let ompArtifactDeletionAfterQuarantineForTesting:
	| ((sessionPath: string, artifactPath: string) => void)
	| undefined;

let ompArtifactDeletionBeforeCleanupForTesting:
	| ((artifactPath: string, quarantinePath: string) => void)
	| undefined;

export const setPiSessionDeletionBeforeQuarantineForTesting = (
	hook: ((path: string) => void) | undefined,
): void => {
	piSessionDeletionBeforeQuarantineForTesting = hook;
};

export const setPiSessionDeletionBeforeUnlinkForTesting = (
	hook: ((path: string) => void) | undefined,
): void => {
	piSessionDeletionBeforeUnlinkForTesting = hook;
};

export const setOmpArtifactDeletionAfterQuarantineForTesting = (
	hook: ((sessionPath: string, artifactPath: string) => void) | undefined,
): void => {
	ompArtifactDeletionAfterQuarantineForTesting = hook;
};

export const setOmpArtifactDeletionBeforeCleanupForTesting = (
	hook: ((artifactPath: string, quarantinePath: string) => void) | undefined,
): void => {
	ompArtifactDeletionBeforeCleanupForTesting = hook;
};

const arePiFileIdentitiesEqual = (
	left: PiFileVersion | undefined,
	right: PiFileVersion | undefined,
): boolean =>
	left !== undefined &&
	right !== undefined &&
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.mtimeMs === right.mtimeMs &&
	left.size === right.size;

type OmpArtifactKind = "directory" | "file" | "symlink" | "other";

interface OmpArtifactIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
	readonly size: number;
	readonly kind: OmpArtifactKind;
}

interface OmpArtifactDeletionCandidate {
	readonly artifactPath: string;
	readonly identity?: OmpArtifactIdentity;
}

const getOmpArtifactIdentity = (
	path: string,
): OmpArtifactIdentity | undefined => {
	try {
		const stats = lstatSync(path);
		const kind: OmpArtifactKind = stats.isDirectory()
			? "directory"
			: stats.isFile()
				? "file"
				: stats.isSymbolicLink()
					? "symlink"
					: "other";
		return {
			dev: stats.dev,
			ino: stats.ino,
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			kind,
		};
	} catch {
		return undefined;
	}
};

const areOmpArtifactIdentitiesEqual = (
	left: OmpArtifactIdentity | undefined,
	right: OmpArtifactIdentity | undefined,
): boolean => {
	if (
		left === undefined ||
		right === undefined ||
		left.dev !== right.dev ||
		left.ino !== right.ino ||
		left.kind !== right.kind
	) {
		return false;
	}

	return (
		left.kind === "directory" ||
		(left.mtimeMs === right.mtimeMs && left.size === right.size)
	);
};

const getOmpArtifactPath = (sessionPath: string): string =>
	sessionPath.endsWith(".jsonl")
		? sessionPath.slice(0, -".jsonl".length)
		: sessionPath;

const getPiDeletionQuarantineDirectory = (
	path: string,
	artifactPaths: readonly string[],
): string => {
	let enclosingArtifactPath: string | undefined;
	for (const artifactPath of artifactPaths) {
		const relativePath = relative(artifactPath, path);
		if (
			relativePath.length === 0 ||
			relativePath === ".." ||
			relativePath.startsWith(`..${sep}`) ||
			isAbsolute(relativePath)
		) {
			continue;
		}
		if (
			!enclosingArtifactPath ||
			artifactPath.length < enclosingArtifactPath.length
		) {
			enclosingArtifactPath = artifactPath;
		}
	}
	return enclosingArtifactPath ? dirname(enclosingArtifactPath) : dirname(path);
};

const snapshotOmpArtifactForDeletion = (
	sessionPath: string,
): OmpArtifactDeletionCandidate => {
	const artifactPath = getOmpArtifactPath(sessionPath);
	return { artifactPath, identity: getOmpArtifactIdentity(artifactPath) };
};

const doesOmpArtifactMatchDeletionCandidate = (
	candidate: OmpArtifactDeletionCandidate,
	path = candidate.artifactPath,
): boolean =>
	candidate.identity
		? areOmpArtifactIdentitiesEqual(
				candidate.identity,
				getOmpArtifactIdentity(path),
			)
		: getOmpArtifactIdentity(path) === undefined;

const movePathToPiDeletionQuarantine = (
	path: string,
	quarantineDirectory = dirname(path),
): string => {
	const quarantinePath = join(
		quarantineDirectory,
		`.${basename(path)}.deleting-${randomUUID()}`,
	);
	renameSync(path, quarantinePath);
	return quarantinePath;
};

interface PiQuarantineRecovery {
	readonly path: string;
	readonly restoredToCanonicalPath: boolean;
}

const moveQuarantinedPathToPiRecovery = (
	quarantinePath: string,
	canonicalPath: string,
): string => {
	while (true) {
		const recoveryDirectory = join(
			dirname(canonicalPath),
			`${basename(canonicalPath)}.recovery-${randomUUID()}`,
		);
		try {
			mkdirSync(recoveryDirectory);
			const recoveryPath = join(recoveryDirectory, basename(canonicalPath));
			renameSync(quarantinePath, recoveryPath);
			return recoveryPath;
		} catch (error) {
			const errorCode =
				error instanceof Error &&
				"code" in error &&
				typeof error.code === "string"
					? error.code
					: undefined;
			if (errorCode === "EEXIST") {
				continue;
			}
			throw error;
		}
	}
};

const restoreQuarantinedPiSession = (
	quarantinePath: string,
	sessionPath: string,
): PiQuarantineRecovery => {
	try {
		linkSync(quarantinePath, sessionPath);
		unlinkSync(quarantinePath);
		return { path: sessionPath, restoredToCanonicalPath: true };
	} catch {
		return {
			path: moveQuarantinedPathToPiRecovery(quarantinePath, sessionPath),
			restoredToCanonicalPath: false,
		};
	}
};

const restoreQuarantinedOmpArtifact = (
	quarantinePath: string,
	artifactPath: string,
): PiQuarantineRecovery => {
	if (getOmpArtifactIdentity(quarantinePath)?.kind === "directory") {
		return {
			path: moveQuarantinedPathToPiRecovery(quarantinePath, artifactPath),
			restoredToCanonicalPath: false,
		};
	}

	try {
		linkSync(quarantinePath, artifactPath);
		unlinkSync(quarantinePath);
		return { path: artifactPath, restoredToCanonicalPath: true };
	} catch {
		return {
			path: moveQuarantinedPathToPiRecovery(quarantinePath, artifactPath),
			restoredToCanonicalPath: false,
		};
	}
};

interface QuarantinedOmpArtifact {
	readonly artifactPath: string;
	readonly quarantinePath: string;
}

interface RecoveredOmpArtifact {
	readonly artifactPath: string;
	readonly recovery: PiQuarantineRecovery;
}

const moveOmpArtifactToDeletionQuarantine = (
	sessionPath: string,
	candidate: OmpArtifactDeletionCandidate,
	quarantineDirectory: string,
): QuarantinedOmpArtifact | RecoveredOmpArtifact | undefined => {
	if (
		!candidate.identity ||
		pathExistsWithoutFollowing(sessionPath) ||
		!doesOmpArtifactMatchDeletionCandidate(candidate)
	) {
		return undefined;
	}

	try {
		const quarantinePath = movePathToPiDeletionQuarantine(
			candidate.artifactPath,
			quarantineDirectory,
		);
		if (
			pathExistsWithoutFollowing(sessionPath) ||
			!areOmpArtifactIdentitiesEqual(
				candidate.identity,
				getOmpArtifactIdentity(quarantinePath),
			)
		) {
			return {
				artifactPath: candidate.artifactPath,
				recovery: restoreQuarantinedOmpArtifact(
					quarantinePath,
					candidate.artifactPath,
				),
			};
		}
		return { artifactPath: candidate.artifactPath, quarantinePath };
	} catch (error) {
		const errorCode =
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: undefined;
		if (errorCode === "ENOENT") {
			return undefined;
		}
		throw error;
	}
};

const isLoadedPiSessionLogCurrentAtPath = (
	log: PiLoadedSessionLogRecord,
	path: string,
): boolean => {
	const before = getPiFileVersion(path);
	if (!arePiFileIdentitiesEqual(log.fileVersion, before)) {
		return false;
	}

	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return false;
	}

	const parsed = parsePiSessionContent(content);
	if (parsed?.header.id !== log.header.id) {
		return false;
	}

	const after = getPiFileVersion(path);
	return arePiFileIdentitiesEqual(log.fileVersion, after);
};

interface StagedPiDeletion {
	readonly log: PiLoadedSessionLogRecord;
	readonly sessionQuarantinePath: string;
	readonly artifactCandidate?: OmpArtifactDeletionCandidate;
	artifact?: QuarantinedOmpArtifact;
}

const assertStagedOmpDeletionManifestCurrent = (
	staged: readonly StagedPiDeletion[],
): void => {
	for (const entry of staged) {
		const candidate = entry.artifactCandidate;
		if (!candidate) {
			continue;
		}
		if (pathExistsWithoutFollowing(entry.log.path)) {
			throw new Error(
				`OMP session ${entry.log.path} reappeared while deleting its artifact.`,
			);
		}
		if (entry.artifact) {
			if (pathExistsWithoutFollowing(candidate.artifactPath)) {
				throw new Error(
					`OMP artifact ${candidate.artifactPath} reappeared while deleting its session.`,
				);
			}
			if (
				!candidate.identity ||
				!areOmpArtifactIdentitiesEqual(
					candidate.identity,
					getOmpArtifactIdentity(entry.artifact.quarantinePath),
				)
			) {
				throw new Error(
					`OMP artifact ${candidate.artifactPath} changed while quarantined.`,
				);
			}
			continue;
		}
		if (!doesOmpArtifactMatchDeletionCandidate(candidate)) {
			throw new Error(
				candidate.identity
					? `OMP artifact ${candidate.artifactPath} changed before deletion.`
					: `OMP artifact ${candidate.artifactPath} appeared before deletion.`,
			);
		}
	}
};

const describeRecovery = (
	kind: "session" | "artifact",
	canonicalPath: string,
	recovery: PiQuarantineRecovery,
): string =>
	`${kind} ${canonicalPath} ${recovery.restoredToCanonicalPath ? `was restored to ${recovery.path}` : `was preserved at ${recovery.path}`}`;

const recoverStagedPiDeletions = (
	staged: readonly StagedPiDeletion[],
): string[] => {
	const recoveries: string[] = [];

	for (const entry of [...staged].reverse()) {
		if (
			entry.artifact &&
			pathExistsWithoutFollowing(entry.artifact.quarantinePath)
		) {
			try {
				const recovery = restoreQuarantinedOmpArtifact(
					entry.artifact.quarantinePath,
					entry.artifact.artifactPath,
				);
				recoveries.push(
					describeRecovery("artifact", entry.artifact.artifactPath, recovery),
				);
			} catch (error) {
				recoveries.push(
					`artifact ${entry.artifact.artifactPath} could not be recovered from ${entry.artifact.quarantinePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (!pathExistsWithoutFollowing(entry.sessionQuarantinePath)) {
			continue;
		}

		try {
			const recovery = restoreQuarantinedPiSession(
				entry.sessionQuarantinePath,
				entry.log.path,
			);
			recoveries.push(describeRecovery("session", entry.log.path, recovery));
		} catch (error) {
			recoveries.push(
				`session ${entry.log.path} could not be recovered from ${entry.sessionQuarantinePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return recoveries;
};

const createPiDeleteFailure = (
	source: PiDialect,
	sessionId: string,
	error: unknown,
	recoveries: readonly string[],
	deletedSessionPaths: readonly string[],
	deletedArtifactPaths: readonly string[],
): DatabaseResult<PiDeleteResult> => {
	const details = [
		error instanceof Error ? error.message : String(error),
		...recoveries,
		deletedSessionPaths.length > 0
			? `Permanently deleted session paths: ${deletedSessionPaths.join(", ")}.`
			: undefined,
		deletedArtifactPaths.length > 0
			? `Permanently deleted artifact paths: ${deletedArtifactPaths.join(", ")}.`
			: undefined,
	]
		.filter((detail): detail is string => detail !== undefined)
		.join(" ");

	return {
		ok: false,
		error: createQueryFailedDatabaseError(
			new Error(details),
			`Failed to delete ${getSessionSourceLabel(source)} session ${sessionId}.`,
		),
	};
};

const deletePiFamilySession = async (
	source: PiDialect,
	sessionId: string,
	options: DeletePiSessionOptions = {},
): Promise<DatabaseResult<PiDeleteResult>> => {
	const staged: StagedPiDeletion[] = [];
	const deletedSessionPaths: string[] = [];
	const deletedArtifactPaths: string[] = [];

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

		const logsToDelete = collectDescendantLogs(source, targetLog, logs);
		const artifactPaths =
			source === "omp"
				? logsToDelete.map((log) => getOmpArtifactPath(log.path))
				: [];
		for (const log of logsToDelete) {
			piSessionDeletionBeforeQuarantineForTesting?.(log.path);
			const artifactCandidate =
				source === "omp" ? snapshotOmpArtifactForDeletion(log.path) : undefined;
			const sessionQuarantinePath = movePathToPiDeletionQuarantine(
				log.path,
				getPiDeletionQuarantineDirectory(log.path, artifactPaths),
			);
			const entry: StagedPiDeletion = artifactCandidate
				? { log, sessionQuarantinePath, artifactCandidate }
				: { log, sessionQuarantinePath };
			staged.push(entry);

			if (!isLoadedPiSessionLogCurrentAtPath(log, sessionQuarantinePath)) {
				throw new Error(
					`${getSessionSourceLabel(source)} session file ${log.path} changed before deletion.`,
				);
			}

			piSessionDeletionBeforeUnlinkForTesting?.(log.path);
		}

		if (source === "omp") {
			assertStagedOmpDeletionManifestCurrent(staged);
			const artifactEntries = staged
				.filter((entry) => entry.artifactCandidate?.identity)
				.sort(
					(left, right) =>
						(right.artifactCandidate?.artifactPath.length ?? 0) -
						(left.artifactCandidate?.artifactPath.length ?? 0),
				);
			for (const entry of artifactEntries) {
				const candidate = entry.artifactCandidate;
				if (!candidate?.identity) {
					continue;
				}
				const artifact = moveOmpArtifactToDeletionQuarantine(
					entry.log.path,
					candidate,
					getPiDeletionQuarantineDirectory(
						candidate.artifactPath,
						artifactPaths,
					),
				);
				if (!artifact) {
					throw new Error(
						`OMP artifact ${candidate.artifactPath} changed before deletion.`,
					);
				}
				if (!("quarantinePath" in artifact)) {
					throw new Error(
						`OMP artifact ${artifact.artifactPath} changed before deletion. ${describeRecovery("artifact", artifact.artifactPath, artifact.recovery)}.`,
					);
				}

				entry.artifact = artifact;
				ompArtifactDeletionAfterQuarantineForTesting?.(
					entry.log.path,
					artifact.artifactPath,
				);
			}

			assertStagedOmpDeletionManifestCurrent(staged);
			for (const entry of staged) {
				if (!entry.artifact) {
					continue;
				}
				ompArtifactDeletionBeforeCleanupForTesting?.(
					entry.artifact.artifactPath,
					entry.artifact.quarantinePath,
				);
			}
			assertStagedOmpDeletionManifestCurrent(staged);
		}

		for (const entry of staged) {
			unlinkSync(entry.sessionQuarantinePath);
			deletedSessionPaths.push(entry.log.path);
		}

		for (const entry of staged) {
			if (!entry.artifact) {
				continue;
			}
			removeQuarantinedOmpArtifact(entry.artifact.quarantinePath);
			deletedArtifactPaths.push(entry.artifact.artifactPath);
			entry.artifact = undefined;
		}

		invalidatePiSessionCaches();
		return {
			ok: true,
			value: { deletedSessionPaths, deletedArtifactPaths },
		};
	} catch (error) {
		const recoveries = recoverStagedPiDeletions(staged);
		invalidatePiSessionCaches();
		return createPiDeleteFailure(
			source,
			sessionId,
			error,
			recoveries,
			deletedSessionPaths,
			deletedArtifactPaths,
		);
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
