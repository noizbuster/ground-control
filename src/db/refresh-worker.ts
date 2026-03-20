import type { Database } from "bun:sqlite";
import { buildSessionSnapshot } from "../lib/sessionSnapshot";
import type { SessionRecord } from "../types";
import {
	ACTIVE_SESSION_QUERY,
	buildLatestMessagesQuery,
	buildLatestQuestionToolPartsQuery,
	buildLatestUserMessageTimesQuery,
	buildMessageCountsQuery,
	createQueryFailedDatabaseError,
	getProjectLabel,
	type LatestMessageResultsBySessionId,
	type MessageCountsBySessionId,
	openReadOnlyDatabase,
	parseMessageData,
	type WaitingSignalsBySessionId,
} from "./index";
import {
	createErrorResponse,
	createSuccessResponse,
	isRefreshRequest,
	type RefreshRequest,
	type RefreshResponse,
} from "./refresh-worker-protocol";

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

interface LatestMessageRow {
	session_id: string;
	data: string | null;
}

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
}

const workerScope = globalThis as unknown as WorkerScope;
const pendingRequests: RefreshRequest[] = [];
let isProcessing = false;

const openedDatabase = openReadOnlyDatabase();
const persistentDatabase = openedDatabase.ok ? openedDatabase.value : null;
const startupDatabaseError = openedDatabase.ok ? null : openedDatabase.error;

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

const readActiveSessions = (database: Database): SessionRecord[] => {
	const statement = database.query<ActiveSessionRow, []>(ACTIVE_SESSION_QUERY);
	const rows = statement.all() as ActiveSessionRow[];

	return rows.map((session) => ({
		...session,
		project_label: getProjectLabel(session),
	}));
};

const readLatestMessages = (
	database: Database,
	sessionIds: string[],
): LatestMessageResultsBySessionId => {
	if (sessionIds.length === 0) {
		return {};
	}

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
};

const readMessageCounts = (
	database: Database,
	sessionIds: string[],
): MessageCountsBySessionId => {
	if (sessionIds.length === 0) {
		return {};
	}

	const statement = database.query<MessageCountRow, string[]>(
		buildMessageCountsQuery(sessionIds.length),
	);
	const rows = statement.all(...sessionIds) as MessageCountRow[];

	return rows.reduce<MessageCountsBySessionId>((results, row) => {
		results[row.session_id] = row.message_count;
		return results;
	}, {});
};

const readWaitingSignals = (
	database: Database,
	sessionIds: string[],
): WaitingSignalsBySessionId => {
	if (sessionIds.length === 0) {
		return {};
	}

	const waitingSignals: WaitingSignalsBySessionId = {};

	const userTimesStatement = database.query<LatestUserMessageTimeRow, string[]>(
		buildLatestUserMessageTimesQuery(sessionIds.length),
	);
	const userTimeRows = userTimesStatement.all(
		...sessionIds,
	) as LatestUserMessageTimeRow[];
	for (const row of userTimeRows) {
		waitingSignals[row.session_id] = {
			...(waitingSignals[row.session_id] ?? { questionToolRunning: false }),
			latestUserMessageTime: row.latest_user_time,
		};
	}

	const questionPartsStatement = database.query<
		LatestQuestionToolPartRow,
		string[]
	>(buildLatestQuestionToolPartsQuery(sessionIds.length));
	const questionPartRows = questionPartsStatement.all(
		...sessionIds,
	) as LatestQuestionToolPartRow[];
	for (const row of questionPartRows) {
		waitingSignals[row.session_id] = {
			...(waitingSignals[row.session_id] ?? { questionToolRunning: false }),
			latestQuestionToolTime: row.time_created,
			questionToolRunning: isQuestionToolRunning(row.data),
		};
	}

	return waitingSignals;
};

const readSnapshot = (database: Database) => {
	const rawSessions = readActiveSessions(database);
	const sessionIds = rawSessions.map((session) => session.id);
	const latestMessages = readLatestMessages(database, sessionIds);
	const messageCounts = readMessageCounts(database, sessionIds);
	const waitingSignals = readWaitingSignals(database, sessionIds);

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
