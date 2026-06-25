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
// then. When the probe shows nothing moved, `changed` is false and the delta
// fields are empty — callers reuse their cached snapshot verbatim.
export const getOpenCodeSnapshot = (options?: {
	since?: number;
}): DatabaseResult<OpenCodeReadResult> => {
	const since = options?.since;
	return withDatabaseRetry((database) => {
		const maxUpdatedAt = getOpenCodeMaxUpdatedAt(database);

		if (since !== undefined && maxUpdatedAt === since) {
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

		const rawSessions = readActiveSessions(database, since);
		const sessionIds = rawSessions.map((session) => session.id);
		const { latestMessages, messageCounts } =
			readLatestMessagesAndCountsFromDatabase(database, sessionIds);
		const waitingSignalCandidateIds = getWaitingSignalCandidateIds(
			sessionIds,
			latestMessages,
		);
		const waitingSignals = readWaitingSignalsFromDatabase(
			database,
			waitingSignalCandidateIds,
		);
		const removedSessionIds =
			since === undefined ? [] : readNewlyArchivedSessionIds(database, since);

		return {
			rawSessions,
			latestMessages,
			messageCounts,
			waitingSignals,
			maxUpdatedAt,
			removedSessionIds,
			changed: true,
		};
	});
};
