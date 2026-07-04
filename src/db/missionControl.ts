import {
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import {
	evictOldestCacheEntries,
	refreshCacheEntryLru,
} from "../lib/boundedCache";
import type { SessionSnapshot } from "../lib/sessionSnapshot";
import {
	getDefaultSessionCapabilities,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import { type Session, SessionStatus, type SubagentSession } from "../types";
import { createQueryFailedDatabaseError, type DatabaseResult } from "./index";

type JsonObject = Record<string, unknown>;

interface MissionControlSessionHeader extends JsonObject {
	kind: "mission-control.session-log";
	version: number;
	sessionId: string;
	createdAt: string;
}

export interface MissionControlSessionLogRecord {
	path: string;
	root: string;
	sessionId: string;
	createdAt: string;
	envelopes: ReadonlyArray<Record<string, unknown>>;
	mtimeMs: number;
}

const trimToUndefined = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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

export const resolveMissionControlSessionRoots = (): string[] => {
	const override = getStringArrayEnv(process.env.GCTRL_MC_SESSIONS_DIR);
	if (override.length > 0) {
		return unique(override);
	}

	const dataDir = trimToUndefined(process.env.MCTRL_DATA_DIR);
	if (dataDir) {
		return unique([join(resolveHomeRelativeDirectory(dataDir), "sessions")]);
	}

	const xdgDataHome =
		trimToUndefined(process.env.XDG_DATA_HOME) ??
		join(homedir(), ".local", "share");
	return unique([join(xdgDataHome, "mission-control", "sessions")]);
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
const MC_LOG_CACHE_MAX_ENTRIES = 256;
const mcLogCache = new Map<
	string,
	{ mtimeMs: number; size: number; record: MissionControlSessionLogRecord }
>();

export const invalidateMissionControlCaches = (): void => {
	mcLogCache.clear();
};

export const parseMissionControlLogFile = (
	path: string,
	root: string,
): MissionControlSessionLogRecord | undefined => {
	let stats: { mtimeMs: number; size: number };
	try {
		stats = statSync(path);
	} catch {
		return undefined;
	}

	const cached = mcLogCache.get(path);
	if (
		cached &&
		cached.mtimeMs === stats.mtimeMs &&
		cached.size === stats.size
	) {
		// Re-insert moves live entries newest; stale ones drift oldest.
		refreshCacheEntryLru(mcLogCache, path, cached);
		return cached.record;
	}

	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}

	const mtimeMs = stats.mtimeMs;
	const envelopes: Record<string, unknown>[] = [];
	let header: MissionControlSessionHeader | undefined;
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
			parsed.kind === "mission-control.session-log" &&
			parsed.version === 1 &&
			typeof parsed.sessionId === "string" &&
			typeof parsed.createdAt === "string"
		) {
			header = parsed as MissionControlSessionHeader;
			continue;
		}

		if (parsed.kind === "mission-control.session-event") {
			const event = parsed.event;
			if (isJsonObject(event)) {
				envelopes.push(event);
			}
		}
	}

	if (!header) {
		return undefined;
	}

	const record: MissionControlSessionLogRecord = {
		path,
		root,
		sessionId: header.sessionId,
		createdAt: header.createdAt,
		envelopes,
		mtimeMs,
	};
	evictOldestCacheEntries(mcLogCache, MC_LOG_CACHE_MAX_ENTRIES);
	mcLogCache.set(path, { mtimeMs, size: stats.size, record });
	return record;
};

const EMPTY_SNAPSHOT: SessionSnapshot = {
	sessions: [],
	statusBySessionId: {},
	messageCountBySessionId: {},
	sessionIssues: {},
	sourceIssues: [],
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

const truncateTitle = (value: string): string =>
	value.length <= 160 ? value : `${value.slice(0, 157)}...`;

const getProjectLabel = (directory: string): string => {
	const trimmed = directory.trim().replace(/[\\/]+$/u, "");
	if (!trimmed) {
		return getSessionSourceLabel("mission-control");
	}

	return trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
};

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

export const buildMissionControlSnapshot = (params: {
	logs: MissionControlSessionLogRecord[];
	logIssues?: Partial<Record<string, string>>;
}): SessionSnapshot => {
	const { logs, logIssues = {} } = params;
	const sourceLabel = getSessionSourceLabel("mission-control");
	const statusBySessionId: Partial<Record<string, SessionStatus>> = {};
	const messageCountBySessionId: Partial<Record<string, number>> = {};
	const sessionIssues: Partial<Record<string, string>> = { ...logIssues };
	const sessionsById = new Map<string, Session>();

	for (const log of logs) {
		if (sessionsById.has(log.sessionId)) {
			sessionIssues[log.sessionId] =
				`${sourceLabel} session id appears in multiple JSONL files.`;
			continue;
		}

		let directory = "";
		let title: string | undefined;
		let parentId: string | null = null;
		let currentModelID: string | undefined;
		let providerID: string | undefined;
		let hasStopped = false;
		let hasFailed = false;
		let hasStarted = false;
		let messageCount = 0;
		let lastEnvelopeCreatedAt: number | undefined;

		for (const envelope of log.envelopes) {
			const type = typeof envelope.type === "string" ? envelope.type : "";

			if (type === "session.metadata.updated") {
				const tree = envelope.sessionTree;
				if (isJsonObject(tree)) {
					if (directory === "" && typeof tree.cwd === "string") {
						directory = tree.cwd;
					}
					if (parentId === null && typeof tree.parentSessionId === "string") {
						parentId = tree.parentSessionId;
					}
				}
			}

			if (type === "run.command.received") {
				messageCount++;
				if (title === undefined && typeof envelope.message === "string") {
					title = truncateTitle(envelope.message);
				}
			}

			if (type === "model.call.completed") {
				messageCount++;
			}

			if (type === "session.stopped") {
				hasStopped = true;
			}
			if (type === "task.failed") {
				hasFailed = true;
			}
			if (type === "session.started") {
				hasStarted = true;
			}

			const selection = envelope.modelProviderSelection;
			if (isJsonObject(selection)) {
				if (typeof selection.modelID === "string") {
					currentModelID = selection.modelID;
				}
				if (typeof selection.providerID === "string") {
					providerID = selection.providerID;
				}
			}

			const createdMs = normalizeTimestampMs(envelope.createdAt);
			if (createdMs !== undefined) {
				lastEnvelopeCreatedAt = createdMs;
			}
		}

		const status = hasStopped
			? SessionStatus.completed
			: hasFailed
				? SessionStatus.failed
				: hasStarted
					? SessionStatus.running
					: SessionStatus.unknown;

		const time_created = normalizeTimestampMs(log.createdAt) ?? 0;
		const time_updated = lastEnvelopeCreatedAt ?? time_created;

		const session: Session = {
			id: log.sessionId,
			title: title ?? `session_${log.sessionId}`,
			directory,
			project_id: log.sessionId,
			project_label: getProjectLabel(directory),
			parent_id: parentId,
			time_created,
			time_updated,
			sessionSource: "mission-control",
			capabilities: getDefaultSessionCapabilities("mission-control"),
			currentModelID,
			providerID,
			status,
			sourceMetadata: {
				sessionPath: log.path,
				rawSource: log.path,
			},
		};

		sessionsById.set(log.sessionId, session);
		statusBySessionId[log.sessionId] = status;
		messageCountBySessionId[log.sessionId] = messageCount;
	}

	const rootSessionsById = new Map<string, Session>();
	for (const session of sessionsById.values()) {
		if (session.parent_id) {
			continue;
		}

		rootSessionsById.set(session.id, {
			...session,
			subagentSessions: [],
		});
	}

	for (const session of sessionsById.values()) {
		if (!session.parent_id) {
			continue;
		}

		const rootSession = rootSessionsById.get(session.parent_id);
		if (!rootSession) {
			sessionIssues[session.id] = `${sourceLabel} root session not found.`;
			continue;
		}

		rootSession.subagentSessions = [
			...(rootSession.subagentSessions ?? []),
			session as SubagentSession,
		];
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

export const getMissionControlSnapshot = (
	options: { sessionRoots?: string[] } = {},
): DatabaseResult<SessionSnapshot> => {
	try {
		const configuredRoots =
			options.sessionRoots ?? resolveMissionControlSessionRoots();
		const roots = getReadableExistingRoots(configuredRoots);
		if (roots.length === 0) {
			return {
				ok: false,
				error: {
					code: "missing_database",
					message: `${getSessionSourceLabel("mission-control")} sessions not found at ${configuredRoots.join(", ")}.`,
				},
			};
		}

		const logs: MissionControlSessionLogRecord[] = [];
		const logIssues: Record<string, string> = {};
		for (const root of roots) {
			for (const path of collectJsonlFiles(root)) {
				const parsed = parseMissionControlLogFile(path, root);
				if (parsed) {
					logs.push(parsed);
				} else {
					logIssues[path] =
						`Unable to parse ${getSessionSourceLabel("mission-control")} JSONL session.`;
				}
			}
		}

		if (logs.length === 0 && Object.keys(logIssues).length === 0) {
			return { ok: true, value: { ...EMPTY_SNAPSHOT } };
		}

		return {
			ok: true,
			value: buildMissionControlSnapshot({ logs, logIssues }),
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				`Failed to read ${getSessionSourceLabel("mission-control")} sessions.`,
			),
		};
	}
};
