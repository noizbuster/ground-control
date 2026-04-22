import type { Database } from "bun:sqlite";
import {
	buildSessionSnapshot,
	type SessionSnapshot,
} from "../lib/sessionSnapshot";
import type { SessionRecord } from "../types";
import {
	ACTIVE_SESSION_QUERY,
	createQueryFailedDatabaseError,
	type DatabaseResult,
	getProjectLabel,
	openReadOnlyDatabase,
	readLatestMessagesFromDatabase,
	readMessageCountsFromDatabase,
	readWaitingSignalsFromDatabase,
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
	database: Database,
): SessionRecord[] => {
	const statement = database.query<ActiveSessionRow, []>(ACTIVE_SESSION_QUERY);
	const rows = statement.all() as ActiveSessionRow[];

	return rows.map((session) => ({
		...session,
		project_label: getProjectLabel(session),
	}));
};

export const getOpenCodeSnapshot = (): DatabaseResult<SessionSnapshot> => {
	const opened = openReadOnlyDatabase();
	if (!opened.ok) {
		return opened;
	}

	const database = opened.value;
	try {
		const rawSessions = readActiveSessionsFromDatabase(database);
		const sessionIds = rawSessions.map((session) => session.id);
		const latestMessages = readLatestMessagesFromDatabase(database, sessionIds);
		const messageCounts = readMessageCountsFromDatabase(database, sessionIds);
		const waitingSignalCandidateIds = getWaitingSignalCandidateIds(
			sessionIds,
			latestMessages,
		);
		const waitingSignals = readWaitingSignalsFromDatabase(
			database,
			waitingSignalCandidateIds,
		);

		return {
			ok: true,
			value: buildSessionSnapshot({
				rawSessions,
				latestMessages,
				messageCounts,
				waitingSignals,
			}),
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(error),
		};
	} finally {
		database.close();
	}
};
