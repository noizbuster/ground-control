import type { DatabaseSync } from "node:sqlite";
import {
	buildSessionSnapshot,
	type SessionSnapshot,
} from "../lib/sessionSnapshot";
import type { SessionRecord } from "../types";
import {
	ACTIVE_SESSION_QUERY,
	type DatabaseResult,
	getProjectLabel,
	prepareCachedStatement,
	readLatestMessagesAndCountsFromDatabase,
	readWaitingSignalsFromDatabase,
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

const readActiveSessionsFromDatabase = (
	database: DatabaseSync,
): SessionRecord[] => {
	const statement = prepareCachedStatement(database, ACTIVE_SESSION_QUERY);
	const rows = statement.all() as unknown as ActiveSessionRow[];

	return rows.map((session) => ({
		...session,
		project_label: getProjectLabel(session),
	}));
};

export const getOpenCodeSnapshot = (): DatabaseResult<SessionSnapshot> => {
	return withDatabaseRetry((database) => {
		const rawSessions = readActiveSessionsFromDatabase(database);
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
		return buildSessionSnapshot({
			rawSessions,
			latestMessages,
			messageCounts,
			waitingSignals,
		});
	});
};
