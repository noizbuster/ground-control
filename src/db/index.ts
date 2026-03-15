import { Database } from "bun:sqlite";
import { getSessionStatus } from "../lib/status";
import type { MessageData, SessionRecord, SessionStatus } from "../types";

const DB_PATH = "/home/noiz/.local/share/opencode/opencode.db";

export const ACTIVE_SESSION_QUERY = `
SELECT id, project_id, title, directory, parent_id, time_created, time_updated
FROM session
WHERE time_archived IS NULL
ORDER BY time_updated DESC
`;

export const LATEST_MESSAGE_QUERY = `
SELECT session_id, data
FROM message
WHERE session_id = ?
ORDER BY time_created DESC LIMIT 1
`;

const buildLatestMessagesQuery = (sessionCount: number): string => {
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

const buildMessageCountsQuery = (sessionCount: number): string => {
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

const openReadOnlyDatabase = (path = DB_PATH): DatabaseResult<Database> => {
	try {
		const db = new Database(path, { readonly: true });
		return { ok: true, value: db };
	} catch (error) {
		return { ok: false, error: normalizeDatabaseError(error, path) };
	}
};

const withDatabase = <T>(
	callback: (database: Database) => T,
): DatabaseResult<T> => {
	const opened = openReadOnlyDatabase();
	if (!opened.ok) {
		return opened;
	}

	const { value: db } = opened;
	try {
		return { ok: true, value: callback(db) };
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "query_failed",
				message: "Query execution failed.",
				cause: error instanceof Error ? error.message : String(error),
			},
		};
	} finally {
		db.close();
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
		const statement = database.query<SessionRecord, []>(ACTIVE_SESSION_QUERY);
		return statement.all() as SessionRecord[];
	});

export const getLatestMessages = (
	sessionIds: string[],
): DatabaseResult<LatestMessageResultsBySessionId> => {
	if (sessionIds.length === 0) {
		return { ok: true, value: {} };
	}

	return withDatabase((database) => {
		const statement = database.query<LatestMessageRow, string[]>(
			buildLatestMessagesQuery(sessionIds.length),
		);
		const rows = statement.all(...sessionIds) as LatestMessageRow[];

		return rows.reduce<LatestMessageResultsBySessionId>((results, row) => {
			results[row.session_id] = {
				sessionId: row.session_id,
				rawData: row.data,
				message: parseMessageData(row.data),
			};

			return results;
		}, {});
	});
};

export const getMessageCounts = (
	sessionIds: string[],
): DatabaseResult<MessageCountsBySessionId> => {
	if (sessionIds.length === 0) {
		return { ok: true, value: {} };
	}

	return withDatabase((database) => {
		const statement = database.query<MessageCountRow, string[]>(
			buildMessageCountsQuery(sessionIds.length),
		);
		const rows = statement.all(...sessionIds) as MessageCountRow[];

		return rows.reduce<MessageCountsBySessionId>((results, row) => {
			results[row.session_id] = row.message_count;
			return results;
		}, {});
	});
};

export const getLatestMessage = (
	sessionId: string,
): DatabaseResult<LatestMessageResult | null> =>
	withDatabase((database) => {
		const statement = database.query<LatestMessageRow, [string]>(
			LATEST_MESSAGE_QUERY,
		);
		const row = statement.get(sessionId);

		if (!row) {
			return null;
		}

		return {
			sessionId: row.session_id,
			rawData: row.data,
			message: parseMessageData(row.data),
		};
	});
