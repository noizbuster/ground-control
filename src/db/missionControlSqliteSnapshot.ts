// Mission Control SQLite session snapshot.
//
// Opens memory.db read-only and builds the full SessionSnapshot: reads the
// `sessions` table (LEFT JOIN session_awaits on primary_wait_id for the awaiting
// reason) and aggregates message counts from session_messages; maps session
// status; enriches directory/title/model from session_events payloads when the
// sessions columns are null; and assembles the parent/child hierarchy. A missing
// database file or a database lacking the `sessions` table resolves to a
// missing_database error naming the resolved path.

import { DatabaseSync } from "node:sqlite";
import type { SessionSnapshot } from "../lib/sessionSnapshot";
import {
	getDefaultSessionCapabilities,
	getSessionSourceLabel,
} from "../lib/sessionSource";
import type { Session } from "../types";
import {
	createQueryFailedDatabaseError,
	type DatabaseError,
	type DatabaseResult,
} from "./index";
import {
	getProjectLabel,
	normalizeTimestampMs,
	truncateTitle,
} from "./missionControlHelpers";
import {
	fetchEventMetadataFallbacks,
	type McMetadataFallbacksBySession,
} from "./missionControlSqliteEvents";
import { assembleSqliteHierarchy } from "./missionControlSqliteHierarchy";
import { mapMissionControlSessionStatus } from "./missionControlSqliteStatus";

interface SessionRow {
	session_id: string;
	status: string | null;
	awaiting_reason: string | null;
	workspace_path: string | null;
	provider_id: string | null;
	model_id: string | null;
	title: string | null;
	created_at: string | null;
	updated_at: string | null;
	last_activity_at: string | null;
	parent_session_id: string | null;
	root_session_id: string | null;
	wait_reason: string | null;
}

interface MessageCountRow {
	session_id: string;
	cnt: number;
}

interface RelationRow {
	parent_session_id: string | null;
	child_session_id: string;
	kind: string;
}

const SESSIONS_TABLE_LOOKUP_QUERY =
	"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'";

const SESSIONS_QUERY = `
	SELECT
		s.session_id, s.status, s.awaiting_reason,
		s.workspace_path, s.provider_id, s.model_id, s.title,
		s.created_at, s.updated_at, s.last_activity_at,
		s.parent_session_id, s.root_session_id,
		w.reason AS wait_reason
	FROM sessions s
	LEFT JOIN session_awaits w ON w.wait_id = s.primary_wait_id
`;

const MESSAGE_COUNTS_QUERY = `
	SELECT session_id, COUNT(*) AS cnt
	FROM session_messages
	GROUP BY session_id
`;

const RELATIONS_QUERY = `
	SELECT parent_session_id, child_session_id, kind
	FROM session_relations
	WHERE kind IN ('subagent', 'parent_child')
`;

const safeQueryRelations = (database: DatabaseSync): RelationRow[] => {
	try {
		return database.prepare(RELATIONS_QUERY).all() as unknown as RelationRow[];
	} catch {
		return [];
	}
};

const safeFetchEventFallbacks = (
	database: DatabaseSync,
	sessionIds: readonly string[],
): McMetadataFallbacksBySession => {
	try {
		return fetchEventMetadataFallbacks(database, sessionIds);
	} catch {
		return {
			directory: new Map<string, string>(),
			title: new Map<string, string>(),
			model: new Map(),
		};
	}
};

const isMissingDatabaseError = (error: unknown): boolean => {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	const code = "code" in error ? (error as { code?: string }).code : undefined;
	return (
		code === "ENOENT" ||
		message.includes("unable to open database file") ||
		message.includes("no such file or directory")
	);
};

export const getMissionControlSnapshotFromSqlite = (params: {
	databasePath: string;
}): DatabaseResult<SessionSnapshot> => {
	const { databasePath } = params;
	let database: DatabaseSync | null = null;
	try {
		database = new DatabaseSync(databasePath, { readOnly: true });

		// A DB that opens but lacks the `sessions` table is treated as a missing
		// Mission Control source, mirroring the missing-file case below.
		const tableRow = database.prepare(SESSIONS_TABLE_LOOKUP_QUERY).get() as
			| { name: string }
			| undefined;
		if (!tableRow) {
			return {
				ok: false,
				error: {
					code: "missing_database",
					message: `${getSessionSourceLabel("mission-control")} database not found at ${databasePath}.`,
				} as DatabaseError,
			};
		}

		const sessionRows = database
			.prepare(SESSIONS_QUERY)
			.all() as unknown as SessionRow[];
		const countRows = database
			.prepare(MESSAGE_COUNTS_QUERY)
			.all() as unknown as MessageCountRow[];

		const messageCounts = new Map<string, number>();
		for (const row of countRows) {
			messageCounts.set(row.session_id, row.cnt);
		}

		const fallbackSessionIds: string[] = [];
		for (const row of sessionRows) {
			if (
				!row.workspace_path ||
				!row.title ||
				!row.model_id ||
				!row.provider_id
			) {
				fallbackSessionIds.push(row.session_id);
			}
		}
		const fallbacks = safeFetchEventFallbacks(database, fallbackSessionIds);

		const flatSessions: Session[] = [];
		const rootSessionIdBySessionId = new Map<string, string | null>();
		const statusBySessionId: SessionSnapshot["statusBySessionId"] = {};
		const messageCountBySessionId: SessionSnapshot["messageCountBySessionId"] =
			{};

		for (const row of sessionRows) {
			const awaitingReason = row.wait_reason ?? row.awaiting_reason;
			const mapped = mapMissionControlSessionStatus(row.status, awaitingReason);

			const directory =
				row.workspace_path ?? fallbacks.directory.get(row.session_id) ?? "";
			const titleSource = row.title ?? fallbacks.title.get(row.session_id);
			const title = titleSource ? truncateTitle(titleSource) : row.session_id;
			const modelFallback = fallbacks.model.get(row.session_id);
			const timeCreated = normalizeTimestampMs(row.created_at) ?? 0;
			const timeUpdated =
				normalizeTimestampMs(row.last_activity_at) ??
				normalizeTimestampMs(row.updated_at) ??
				timeCreated;

			flatSessions.push({
				id: row.session_id,
				title,
				directory,
				project_id: row.session_id,
				project_label: getProjectLabel(directory),
				parent_id: row.parent_session_id,
				time_created: timeCreated,
				time_updated: timeUpdated,
				sessionSource: "mission-control",
				capabilities: getDefaultSessionCapabilities("mission-control"),
				currentModelID: row.model_id ?? modelFallback?.currentModelID,
				providerID: row.provider_id ?? modelFallback?.providerID,
				status: mapped.status,
				statusDetail: mapped.statusDetail,
				sourceMetadata: {
					sessionPath: databasePath,
					rawSource: databasePath,
				},
				subagentSessions: [],
			});
			rootSessionIdBySessionId.set(row.session_id, row.root_session_id);
			statusBySessionId[row.session_id] = mapped.status;
			messageCountBySessionId[row.session_id] =
				messageCounts.get(row.session_id) ?? 0;
		}

		const relationRows = safeQueryRelations(database);
		const assembled = assembleSqliteHierarchy({
			flatSessions,
			rootSessionIdBySessionId,
			relations: relationRows,
			statusBySessionId,
			sourceLabel: getSessionSourceLabel("mission-control"),
		});

		return {
			ok: true,
			value: {
				sessions: assembled.sessions,
				statusBySessionId: assembled.statusBySessionId,
				messageCountBySessionId,
				sessionIssues: assembled.sessionIssues,
				sourceIssues: [],
			},
		};
	} catch (error) {
		if (isMissingDatabaseError(error)) {
			return {
				ok: false,
				error: {
					code: "missing_database",
					message: `${getSessionSourceLabel("mission-control")} database not found at ${databasePath}.`,
				} as DatabaseError,
			};
		}
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				"Failed to read Mission Control SQLite sessions.",
			),
		};
	} finally {
		if (database) {
			try {
				database.close();
			} catch {
				// Best-effort cleanup; the error has already been mapped above.
			}
		}
	}
};
