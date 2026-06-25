import type { DatabaseSync } from "node:sqlite";
import type { SessionRecord } from "../types";
import {
	ACTIVE_SESSION_QUERY,
	type DatabaseResult,
	getProjectLabel,
	type LatestMessageResultsBySessionId,
	type MessageCountsBySessionId,
	prepareCachedStatement,
	readLatestMessagesAndCountsFromDatabase,
	readWaitingSignalsFromDatabase,
	type WaitingSignalsBySessionId,
	withDatabaseRetry,
} from "./index";
import { getWaitingSignalCandidateIds } from "./waitingSignalCandidates";

interface ActiveSessionRow {
	id: string;
	project_id: string;
	title: string;
	directory: string;
	project_name: string | null;
	project_worktree: string | null;
	parent_id: string | null;
	time_created: number;
	time_updated: number;
}

// Cheap change-detection probe: a single-row aggregate over the whole session
// table. Unconditional (no time_archived filter) so it also detects archival,
// which OpenCode records by bumping time_updated. Used to skip the refresh
// entirely when nothing moved since the last refresh.
const MAX_TIME_UPDATED_QUERY =
	"SELECT MAX(time_updated) AS max_ts FROM session";

// Incremental active-session read: only rows touched since the last refresh.
// Column list mirrors ACTIVE_SESSION_QUERY so the row shape is identical.
const CHANGED_ACTIVE_SESSION_QUERY = `
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
WHERE session.time_updated > ? AND session.time_archived IS NULL
ORDER BY session.time_updated DESC
`;

// Sessions archived since the last refresh. The worker drops these from its
// cache so archived sessions stop appearing in the snapshot.
const NEWLY_ARCHIVED_SESSION_IDS_QUERY =
	"SELECT id FROM session WHERE time_archived IS NOT NULL AND time_updated > ?";

export interface OpenCodeReadResult {
	readonly rawSessions: SessionRecord[];
	readonly latestMessages: LatestMessageResultsBySessionId;
	readonly messageCounts: MessageCountsBySessionId;
	readonly waitingSignals: WaitingSignalsBySessionId;
	readonly maxUpdatedAt: number;
	readonly removedSessionIds: string[];
	readonly changed: boolean;
}

const mapActiveSessionRows = (rows: ActiveSessionRow[]): SessionRecord[] =>
	rows.map((session) => ({
		...session,
		project_label: getProjectLabel(session),
	}));

export const getOpenCodeMaxUpdatedAt = (database: DatabaseSync): number => {
	const row = prepareCachedStatement(database, MAX_TIME_UPDATED_QUERY).get() as
		| { max_ts: number | null }
		| undefined;
	return row?.max_ts ?? 0;
};

const readActiveSessions = (
	database: DatabaseSync,
	since: number | undefined,
): SessionRecord[] => {
	if (since === undefined) {
		const rows = prepareCachedStatement(
			database,
			ACTIVE_SESSION_QUERY,
		).all() as unknown as ActiveSessionRow[];
		return mapActiveSessionRows(rows);
	}

	const rows = prepareCachedStatement(
		database,
		CHANGED_ACTIVE_SESSION_QUERY,
	).all(since) as unknown as ActiveSessionRow[];
	return mapActiveSessionRows(rows);
};

const readNewlyArchivedSessionIds = (
	database: DatabaseSync,
	since: number,
): string[] => {
	const rows = prepareCachedStatement(
		database,
		NEWLY_ARCHIVED_SESSION_IDS_QUERY,
	).all(since) as unknown as { id: string }[];
	return rows.map((row) => row.id);
};

// Reads OpenCode session data. With `since` undefined this is a full read of
// every active session; with `since` set it returns only sessions whose
// time_updated advanced past `since` plus the ids of sessions archived since
// then.
//
// `nonTerminalSessionIds` are session IDs the caller knows are non-terminal
// (running / waiting / unknown). These are polled every call regardless of the
// session-table probe because part-table changes — question-tool state
// transitions, tool completions — do NOT bump session.time_updated (no DB
// triggers; verified on 7GB prod DB). Without this, an "awaiting user"
// transition whose part row lands after the message row is invisible until
// restart.
export interface OpenCodeSnapshotOptions {
	since?: number;
	nonTerminalSessionIds?: string[];
}

// Extracted so tests can pass a DatabaseSync directly, bypassing the
// module-scope DB_PATH const that is locked at first import.
export const computeOpenCodeSnapshot = (
	database: DatabaseSync,
	options: OpenCodeSnapshotOptions = {},
): OpenCodeReadResult => {
	const since = options.since;
	const nonTerminalSessionIds = options.nonTerminalSessionIds ?? [];

	const maxUpdatedAt = getOpenCodeMaxUpdatedAt(database);
	const sessionTableChanged = since === undefined || maxUpdatedAt !== since;

	if (
		since !== undefined &&
		!sessionTableChanged &&
		nonTerminalSessionIds.length === 0
	) {
		return {
			rawSessions: [],
			latestMessages: {},
			messageCounts: {},
			waitingSignals: {},
			maxUpdatedAt,
			removedSessionIds: [],
			changed: false,
		};
	}

	const rawSessions = sessionTableChanged
		? readActiveSessions(database, since)
		: [];
	const removedSessionIds =
		sessionTableChanged && since !== undefined
			? readNewlyArchivedSessionIds(database, since)
			: [];

	const changedSessionIds = rawSessions.map((session) => session.id);
	const refreshIds = Array.from(
		new Set([...changedSessionIds, ...nonTerminalSessionIds]),
	);

	const { latestMessages, messageCounts } =
		refreshIds.length > 0
			? readLatestMessagesAndCountsFromDatabase(database, refreshIds)
			: { latestMessages: {}, messageCounts: {} };

	const waitingSignalCandidateIds = getWaitingSignalCandidateIds(
		refreshIds,
		latestMessages,
	);
	const waitingSignals =
		waitingSignalCandidateIds.length > 0
			? readWaitingSignalsFromDatabase(database, waitingSignalCandidateIds)
			: {};

	return {
		rawSessions,
		latestMessages,
		messageCounts,
		waitingSignals,
		maxUpdatedAt,
		removedSessionIds,
		changed: sessionTableChanged || refreshIds.length > 0,
	};
};

export const getOpenCodeSnapshot = (
	options?: OpenCodeSnapshotOptions,
): DatabaseResult<OpenCodeReadResult> => {
	return withDatabaseRetry((database) =>
		computeOpenCodeSnapshot(database, options),
	);
};
