import { homedir } from "node:os";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { getSessionStatus } from "../lib/status";
import type { MessageData, SessionRecord, SessionStatus } from "../types";

const DEFAULT_DB_PATH = `${homedir()}/.local/share/opencode/opencode.db`;

const resolveDatabasePath = (): string => {
	const overridePath = process.env.GCTRL_DB_PATH?.trim();

	if (overridePath && overridePath.length > 0) {
		return overridePath;
	}

	return DEFAULT_DB_PATH;
};

export const DB_PATH = resolveDatabasePath();

export const ACTIVE_SESSION_QUERY = `
SELECT
  session.id,
  session.project_id,
  session.title,
  session.directory,
  project.name AS project_name,
  project.worktree AS project_worktree,
  session.parent_id,
  session.time_created,
  session.time_updated
FROM session
LEFT JOIN project ON project.id = session.project_id
WHERE session.time_archived IS NULL
ORDER BY session.time_updated DESC
`;

export const LATEST_MESSAGE_QUERY = `
SELECT session_id, data
FROM message
WHERE session_id = ?
ORDER BY time_created DESC LIMIT 1
`;

export const buildLatestUserMessageTimesQuery = (
	sessionCount: number,
): string => {
	const placeholders = Array.from({ length: sessionCount }, () => "?").join(
		", ",
	);

	return `
SELECT session_id, MAX(time_created) AS latest_user_time
FROM message
WHERE session_id IN (${placeholders})
  AND data LIKE '%"role":"user"%'
GROUP BY session_id
`;
};

export const buildLatestQuestionToolPartsQuery = (
	sessionCount: number,
): string => {
	const placeholders = Array.from({ length: sessionCount }, () => "?").join(
		", ",
	);

	// MAX+join replaces correlated subquery. Eliminates the per-row inner
	// scan over the non-covering part_session_idx. Ties on MAX(time_created)
	// are resolved in TS by keeping the highest rowid (caller dedups).
	return `
WITH latest_question AS (
  SELECT session_id, MAX(time_created) AS mt
  FROM part
  WHERE session_id IN (${placeholders})
    AND data LIKE '%"type":"tool"%'
    AND data LIKE '%"tool":"question"%'
  GROUP BY session_id
)
SELECT p.session_id, p.time_created, p.data, p.rowid AS rid
FROM part p
INNER JOIN latest_question lq
  ON lq.session_id = p.session_id
  AND p.time_created = lq.mt
  AND p.data LIKE '%"type":"tool"%'
  AND p.data LIKE '%"tool":"question"%'
`;
};

export const buildLatestMessagesQuery = (sessionCount: number): string => {
	const placeholders = Array.from({ length: sessionCount }, () => "?").join(
		", ",
	);

	return `
SELECT message.session_id, message.data
FROM message
WHERE message.session_id IN (${placeholders})
  AND message.rowid = (
    SELECT latest.rowid
    FROM message AS latest
    WHERE latest.session_id = message.session_id
    ORDER BY latest.time_created DESC, latest.rowid DESC
    LIMIT 1
  )
`;
};

export const buildMessageCountsQuery = (sessionCount: number): string => {
	const placeholders = Array.from({ length: sessionCount }, () => "?").join(
		", ",
	);

	return `
SELECT session_id, COUNT(*) AS message_count
FROM message
WHERE session_id IN (${placeholders})
GROUP BY session_id
`;
};

export type DatabaseErrorCode =
	| "missing_database"
	| "database_access_denied"
	| "query_failed";

export interface DatabaseError {
	code: DatabaseErrorCode;
	message: string;
	cause?: string;
}

export type DatabaseResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: DatabaseError };

export type MessageParseErrorCode = "invalid_json";

export interface MessageParseError {
	code: MessageParseErrorCode;
	message: string;
}

export type MessageParseResult =
	| { ok: true; value: MessageData }
	| { ok: false; error: MessageParseError };

export interface LatestMessageRow {
	session_id: string;
	data: string | null;
}

interface ActiveSessionRow extends SessionRecord {
	project_name: string | null;
	project_worktree: string | null;
}

export interface LatestMessageResult {
	sessionId: string;
	message: MessageParseResult;
	rawData: string | null;
}

export type LatestMessageResultsBySessionId = Partial<
	Record<string, LatestMessageResult>
>;
export type MessageCountsBySessionId = Partial<Record<string, number>>;

interface MessageCountRow {
	session_id: string;
	message_count: number;
}

interface LatestUserMessageTimeRow {
	session_id: string;
	latest_user_time: number;
}

interface LatestQuestionToolPartRow {
	session_id: string;
	time_created: number;
	data: string;
	rid: number;
}

export interface WaitingSignal {
	latestUserMessageTime?: number;
	latestQuestionToolTime?: number;
	questionToolRunning: boolean;
}

export type WaitingSignalsBySessionId = Partial<Record<string, WaitingSignal>>;

const normalizeDatabaseError = (
	cause: unknown,
	dbPath: string,
): DatabaseError => {
	if (cause instanceof Error) {
		const message = cause.message.toLowerCase();
		const code =
			"code" in cause ? (cause as { code?: string }).code : undefined;

		if (
			code === "ENOENT" ||
			message.includes("unable to open database file") ||
			message.includes("no such file or directory")
		) {
			return {
				code: "missing_database",
				message: `OpenCode database not found at ${dbPath}.`,
			};
		}

		if (code === "EACCES" || message.includes("permission denied")) {
			return {
				code: "database_access_denied",
				message: `Cannot read OpenCode database at ${dbPath}. Check file permissions.`,
			};
		}

		return {
			code: "query_failed",
			message: "Failed to open the OpenCode SQLite database.",
			cause: cause.message,
		};
	}

	return {
		code: "query_failed",
		message: "Unknown database failure while opening OpenCode database.",
		cause: typeof cause === "string" ? cause : "Unknown error object",
	};
};

export const createQueryFailedDatabaseError = (
	error: unknown,
	message = "Query execution failed.",
): DatabaseError => {
	return {
		code: "query_failed",
		message,
		cause: error instanceof Error ? error.message : String(error),
	};
};

const getLastPathSegment = (value?: string | null): string | null => {
	if (!value) {
		return null;
	}

	const trimmed = value.trim().replace(/[\\/]+$/gu, "");
	if (!trimmed) {
		return null;
	}

	const parts = trimmed.split(/[\\/]/u).filter(Boolean);
	return parts.at(-1) ?? null;
};

export const getProjectLabel = (session: {
	project_id: string;
	project_name?: string | null;
	project_worktree?: string | null;
}): string => {
	const projectName = session.project_name?.trim();
	if (projectName) {
		return projectName;
	}

	const worktreeName = getLastPathSegment(session.project_worktree);
	if (worktreeName) {
		return worktreeName;
	}

	return session.project_id;
};

// Module-scope readonly handle cache. A long-lived reader is safe under WAL
// mode (see .omo/evidence/prereq-wal-mode.txt); reopening on every 2s refresh
// was the dominant per-refresh cost, so one handle is reused for the process.
let cachedDatabase: { path: string; handle: DatabaseSync } | null = null;

// Per-DatabaseSync statement cache. node:sqlite's prepare() has no built-in
// cache (unlike bun:sqlite's query(), which returned the same Statement for
// identical SQL), so this restores the per-refresh reuse the hot path depends
// on. Keying by DatabaseSync instance — via WeakMap — means each connection
// (the long-lived production reader and every test's fresh :memory: DB) keeps
// its own statements, so a StatementSync can never leak across connections or
// outlive its DatabaseSync. Entries are reclaimed automatically once a
// DatabaseSync is closed and no longer referenced.
const statementCacheByDatabase = new WeakMap<
	DatabaseSync,
	Map<string, StatementSync>
>();

export const prepareCachedStatement = (
	database: DatabaseSync,
	sql: string,
): StatementSync => {
	let perDatabase = statementCacheByDatabase.get(database);
	if (!perDatabase) {
		perDatabase = new Map<string, StatementSync>();
		statementCacheByDatabase.set(database, perDatabase);
	}
	const cached = perDatabase.get(sql);
	if (cached) {
		return cached;
	}
	const statement = database.prepare(sql);
	perDatabase.set(sql, statement);
	return statement;
};

// Internal: returns the cached handle for `path`, opening one on cache miss or
// path change. THROWS on missing/corrupt DB (same as `new DatabaseSync()`).
// Every caller must wrap in try/catch + normalizeDatabaseError. Not exported —
// `openReadOnlyDatabase` is the public, error-mapped API.
const getCachedReadOnlyDatabase = (path: string = DB_PATH): DatabaseSync => {
	if (cachedDatabase && cachedDatabase.path === path) {
		return cachedDatabase.handle;
	}
	// Path differs from the cached handle (test-only: production DB_PATH is a
	// constant read once at module load, so this branch never runs there).
	// Dereference the previous handle WITHOUT closing it: node:sqlite throws
	// ERR_INVALID_STATE when any getter runs on a closed DatabaseSync, which
	// breaks introspection (e.g. a test assertion holding the old reference).
	// The orphaned handle is reclaimed by GC + process exit; explicit shutdown
	// of the live handle runs in closeReadOnlyDatabase.
	cachedDatabase = null;
	const handle = new DatabaseSync(path, { readOnly: true });
	cachedDatabase = { path, handle };
	return handle;
};

// Shutdown/test-only. NEVER call from the refresh hot path — closing the
// shared handle while the cache is in use would force a reopen next refresh
// and corrupt any in-flight query on that handle.
export const closeReadOnlyDatabase = (): void => {
	if (cachedDatabase) {
		try {
			cachedDatabase.handle.close();
		} catch {}
		cachedDatabase = null;
	}
};

// Test seam: deterministically simulate a stale handle so lifecycle tests do
// not depend on file deletion or OS-level FD invalidation. No production
// callers; side effect is limited to clearing the module-scope cache.
export const __invalidateCachedDatabaseForTesting = (): void => {
	closeReadOnlyDatabase();
};

export const openReadOnlyDatabase = (
	path: string = DB_PATH,
): DatabaseResult<DatabaseSync> => {
	try {
		return { ok: true, value: getCachedReadOnlyDatabase(path) };
	} catch (error) {
		return { ok: false, error: normalizeDatabaseError(error, path) };
	}
};

const withDatabase = <T>(
	callback: (database: DatabaseSync) => T,
): DatabaseResult<T> => {
	const opened = openReadOnlyDatabase();
	if (!opened.ok) {
		return opened;
	}

	try {
		return { ok: true, value: callback(opened.value) };
	} catch (error) {
		return { ok: false, error: createQueryFailedDatabaseError(error) };
	}
	// NOTE: intentionally no `finally { db.close() }`. The handle is cached at
	// module scope; closing it here would destroy the cache and force a reopen
	// on every refresh — the exact cost this change eliminates.
};

// Stale-handle signatures that a close+reopen can recover from. SQLITE_BUSY is
// excluded: under WAL mode (prereq-wal-mode.txt) readonly readers never block.
const RETRYABLE_DB_ERROR =
	/unable to open database file|no such file|database disk image is malformed/i;

// Like withDatabase, but on a retryable stale-handle error it closes the cached
// handle, reopens once, and retries the callback. Every open routes through
// openReadOnlyDatabase so missing_database / database_access_denied mapping is
// preserved on both the first attempt and the retry (P0 regression guard).
// `path` is optional so tests can target a missing path; production callers
// omit it to use the default DB_PATH.
export const withDatabaseRetry = <T>(
	callback: (database: DatabaseSync) => T,
	path: string = DB_PATH,
): DatabaseResult<T> => {
	const execute = (db: DatabaseSync): DatabaseResult<T> => {
		try {
			return { ok: true, value: callback(db) };
		} catch (error) {
			return { ok: false, error: createQueryFailedDatabaseError(error) };
		}
	};

	const reopenAndExecute = (): DatabaseResult<T> => {
		closeReadOnlyDatabase();
		const retryOpened = openReadOnlyDatabase(path);
		if (!retryOpened.ok) {
			return retryOpened;
		}
		return execute(retryOpened.value);
	};

	const firstOpened = openReadOnlyDatabase(path);
	if (!firstOpened.ok) {
		if (
			firstOpened.error.code === "query_failed" ||
			firstOpened.error.code === "missing_database"
		) {
			return reopenAndExecute();
		}
		return firstOpened;
	}

	try {
		return { ok: true, value: callback(firstOpened.value) };
	} catch (error) {
		if (!(error instanceof Error) || !RETRYABLE_DB_ERROR.test(error.message)) {
			return { ok: false, error: createQueryFailedDatabaseError(error) };
		}
		return reopenAndExecute();
	}
};

export const parseMessageData = (raw: string | null): MessageParseResult => {
	if (!raw) {
		return {
			ok: false,
			error: {
				code: "invalid_json",
				message: "Message data is empty or missing",
			},
		};
	}

	try {
		const parsed = JSON.parse(raw) as MessageData;
		return { ok: true, value: parsed };
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "invalid_json",
				message:
					error instanceof Error
						? error.message
						: "Failed to parse message JSON",
			},
		};
	}
};

export const detectSessionStatus = (
	messageInput: LatestMessageResult["message"] | MessageData | null | undefined,
): SessionStatus => {
	return getSessionStatus(messageInput);
};

export const getActiveSessions = (): DatabaseResult<SessionRecord[]> =>
	withDatabase((database) => {
		const statement = prepareCachedStatement(database, ACTIVE_SESSION_QUERY);
		return (statement.all() as unknown as ActiveSessionRow[]).map(
			(session) => ({
				...session,
				project_label: getProjectLabel(session),
			}),
		);
	});

export const getLatestMessages = (
	sessionIds: string[],
): DatabaseResult<LatestMessageResultsBySessionId> => {
	return withDatabase((database) =>
		readLatestMessagesFromDatabase(database, sessionIds),
	);
};

export const getMessageCounts = (
	sessionIds: string[],
): DatabaseResult<MessageCountsBySessionId> => {
	return withDatabase((database) =>
		readMessageCountsFromDatabase(database, sessionIds),
	);
};

export const readLatestMessagesFromDatabase = (
	database: DatabaseSync,
	sessionIds: string[],
): LatestMessageResultsBySessionId => {
	if (sessionIds.length === 0) {
		return {};
	}

	const statement = prepareCachedStatement(
		database,
		buildLatestMessagesQuery(sessionIds.length),
	);
	const rows = statement.all(...sessionIds) as unknown as LatestMessageRow[];

	return rows.reduce<LatestMessageResultsBySessionId>((results, row) => {
		results[row.session_id] = {
			sessionId: row.session_id,
			rawData: row.data,
			message: parseMessageData(row.data),
		};

		return results;
	}, {});
};

const isQuestionToolRunning = (raw: string): boolean => {
	try {
		const parsed = JSON.parse(raw) as {
			type?: string;
			tool?: string;
			state?: { status?: string };
		};

		return (
			parsed.type === "tool" &&
			parsed.tool === "question" &&
			parsed.state?.status === "running"
		);
	} catch {
		return false;
	}
};

export const readMessageCountsFromDatabase = (
	database: DatabaseSync,
	sessionIds: string[],
): MessageCountsBySessionId => {
	if (sessionIds.length === 0) {
		return {};
	}

	const statement = prepareCachedStatement(
		database,
		buildMessageCountsQuery(sessionIds.length),
	);
	const rows = statement.all(...sessionIds) as unknown as MessageCountRow[];

	return rows.reduce<MessageCountsBySessionId>((results, row) => {
		results[row.session_id] = row.message_count;
		return results;
	}, {});
};

export interface LatestMessageAndCountRow {
	session_id: string;
	data: string | null;
	rid: number;
	cnt: number;
}

export interface LatestMessagesAndCountsResult {
	latestMessages: LatestMessageResultsBySessionId;
	messageCounts: MessageCountsBySessionId;
}

// MAX+join+COUNT in one query. May return multiple rows per session on
// time_created ties; caller keeps highest rowid to preserve
// `ORDER BY time_created DESC, rowid DESC LIMIT 1` semantics.
const buildLatestMessagesAndCountsQuery = (sessionCount: number): string => {
	const placeholders = Array.from({ length: sessionCount }, () => "?").join(
		", ",
	);

	return `
WITH latest AS (
  SELECT session_id, MAX(time_created) AS max_time, COUNT(*) AS cnt
  FROM message
  WHERE session_id IN (${placeholders})
  GROUP BY session_id
)
SELECT m.session_id, m.data, m.rowid AS rid, latest.cnt
FROM message m
INNER JOIN latest ON latest.session_id = m.session_id AND m.time_created = latest.max_time
`;
};

// Combined reader: latestMessages + messageCounts from one MAX+join+COUNT query.
// Tie-break on identical time_created is resolved in TS by keeping the highest
// rowid, preserving the original `ORDER BY time_created DESC, rowid DESC LIMIT 1`.
export const readLatestMessagesAndCountsFromDatabase = (
	database: DatabaseSync,
	sessionIds: string[],
): LatestMessagesAndCountsResult => {
	const latestMessages: LatestMessageResultsBySessionId = {};
	const messageCounts: MessageCountsBySessionId = {};
	if (sessionIds.length === 0) {
		return { latestMessages, messageCounts };
	}

	const rows = prepareCachedStatement(
		database,
		buildLatestMessagesAndCountsQuery(sessionIds.length),
	).all(...sessionIds) as unknown as LatestMessageAndCountRow[];

	// rowid tracked separately; never mutate the result object (no `as any`).
	const rowidBySession = new Map<string, number>();
	for (const row of rows) {
		const seenRowid = rowidBySession.get(row.session_id);
		if (seenRowid === undefined || row.rid > seenRowid) {
			rowidBySession.set(row.session_id, row.rid);
			latestMessages[row.session_id] = {
				sessionId: row.session_id,
				rawData: row.data,
				message: parseMessageData(row.data),
			};
		}
		messageCounts[row.session_id] = row.cnt;
	}
	return { latestMessages, messageCounts };
};

export const getWaitingSignals = (
	sessionIds: string[],
): DatabaseResult<WaitingSignalsBySessionId> => {
	return withDatabase((database) =>
		readWaitingSignalsFromDatabase(database, sessionIds),
	);
};

export const readWaitingSignalsFromDatabase = (
	database: DatabaseSync,
	sessionIds: string[],
): WaitingSignalsBySessionId => {
	if (sessionIds.length === 0) {
		return {};
	}

	const waitingSignals: WaitingSignalsBySessionId = {};

	const userTimesStatement = prepareCachedStatement(
		database,
		buildLatestUserMessageTimesQuery(sessionIds.length),
	);
	const userTimeRows = userTimesStatement.all(
		...sessionIds,
	) as unknown as LatestUserMessageTimeRow[];
	for (const row of userTimeRows) {
		waitingSignals[row.session_id] = {
			...(waitingSignals[row.session_id] ?? { questionToolRunning: false }),
			latestUserMessageTime: row.latest_user_time,
		};
	}

	const questionPartsStatement = prepareCachedStatement(
		database,
		buildLatestQuestionToolPartsQuery(sessionIds.length),
	);
	const questionPartRows = questionPartsStatement.all(
		...sessionIds,
	) as unknown as LatestQuestionToolPartRow[];

	// TS dedup: MAX+join may return multiple rows per session on time_created
	// ties. Keep highest rowid to preserve ORDER BY time_created DESC, rowid DESC.
	const questionRidBySession = new Map<string, number>();
	for (const row of questionPartRows) {
		const seenRid = questionRidBySession.get(row.session_id);
		if (seenRid === undefined || row.rid > seenRid) {
			questionRidBySession.set(row.session_id, row.rid);
			waitingSignals[row.session_id] = {
				...(waitingSignals[row.session_id] ?? {
					questionToolRunning: false,
				}),
				latestQuestionToolTime: row.time_created,
				questionToolRunning: isQuestionToolRunning(row.data),
			};
		}
	}

	return waitingSignals;
};

export const getLatestMessage = (
	sessionId: string,
): DatabaseResult<LatestMessageResult | null> =>
	withDatabase((database) => {
		const statement = prepareCachedStatement(database, LATEST_MESSAGE_QUERY);
		const row = statement.get(sessionId) as LatestMessageRow | undefined;

		if (!row) {
			return null;
		}

		return {
			sessionId: row.session_id,
			rawData: row.data,
			message: parseMessageData(row.data),
		};
	});

// Release the cached readonly handle on graceful shutdown (per-process).
process.on("beforeExit", closeReadOnlyDatabase);
