import type { Database } from "bun:sqlite";
import { buildSessionSnapshot } from "../lib/sessionSnapshot";
import type { SessionRecord } from "../types";
import {
	ACTIVE_SESSION_QUERY,
	createQueryFailedDatabaseError,
	getProjectLabel,
	openReadOnlyDatabase,
	readLatestMessagesFromDatabase,
	readMessageCountsFromDatabase,
	readWaitingSignalsFromDatabase,
} from "./index";
import {
	createErrorResponse,
	createSuccessResponse,
	isRefreshRequest,
	type RefreshRequest,
	type RefreshResponse,
} from "./refresh-worker-protocol";
import { getWaitingSignalCandidateIds } from "./waitingSignalCandidates";

interface WorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(response: RefreshResponse): void;
}

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

const workerScope = globalThis as unknown as WorkerScope;
const pendingRequests: RefreshRequest[] = [];
let isProcessing = false;

const openedDatabase = openReadOnlyDatabase();
const persistentDatabase = openedDatabase.ok ? openedDatabase.value : null;
const startupDatabaseError = openedDatabase.ok ? null : openedDatabase.error;

const readActiveSessions = (database: Database): SessionRecord[] => {
	const statement = database.query<ActiveSessionRow, []>(ACTIVE_SESSION_QUERY);
	const rows = statement.all() as ActiveSessionRow[];

	return rows.map((session) => ({
		...session,
		project_label: getProjectLabel(session),
	}));
};

const readSnapshot = (database: Database) => {
	const rawSessions = readActiveSessions(database);
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

	return buildSessionSnapshot({
		rawSessions,
		latestMessages,
		messageCounts,
		waitingSignals,
	});
};

const buildResponse = (request: RefreshRequest): RefreshResponse => {
	if (startupDatabaseError) {
		return createErrorResponse(request.requestId, startupDatabaseError);
	}

	if (!persistentDatabase) {
		return createErrorResponse(
			request.requestId,
			createQueryFailedDatabaseError(
				"Persistent database handle was not initialized.",
				"Failed to open the OpenCode SQLite database.",
			),
		);
	}

	try {
		const snapshot = readSnapshot(persistentDatabase);
		return createSuccessResponse(request.requestId, snapshot);
	} catch (error) {
		return createErrorResponse(
			request.requestId,
			createQueryFailedDatabaseError(error),
		);
	}
};

const processNextRequest = (): void => {
	if (isProcessing) {
		return;
	}

	const request = pendingRequests.shift();
	if (!request) {
		return;
	}

	isProcessing = true;

	try {
		const response = buildResponse(request);
		workerScope.postMessage(response);
	} finally {
		isProcessing = false;
		if (pendingRequests.length > 0) {
			processNextRequest();
		}
	}
};

workerScope.onmessage = (event) => {
	if (!isRefreshRequest(event.data)) {
		return;
	}

	pendingRequests.push(event.data);
	processNextRequest();
};

process.on("exit", () => {
	if (!persistentDatabase) {
		return;
	}

	try {
		persistentDatabase.close();
	} catch {}
});
