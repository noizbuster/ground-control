import {
	detectSessionStatus,
	type LatestMessageResultsBySessionId,
	type MessageCountsBySessionId,
	type WaitingSignalsBySessionId,
} from "../db";
import { type Session, type SessionRecord, SessionStatus } from "../types";

export type SessionStatusById = Partial<Record<string, SessionStatus>>;

export interface SessionSnapshot {
	sessions: Session[];
	statusBySessionId: SessionStatusById;
	messageCountBySessionId: Partial<Record<string, number>>;
	sessionIssues: Partial<Record<string, string>>;
}

interface BuildSessionSnapshotParams {
	rawSessions: SessionRecord[];
	latestMessages: LatestMessageResultsBySessionId;
	messageCounts: MessageCountsBySessionId;
	waitingSignals: WaitingSignalsBySessionId;
}

const resolveRootSession = (
	session: Session,
	sessionsById: Map<string, Session>,
): Session | null => {
	const visited = new Set<string>();
	let current: Session | undefined = session;

	while (current?.parent_id) {
		if (visited.has(current.id)) {
			return null;
		}

		visited.add(current.id);
		current = sessionsById.get(current.parent_id);
		if (!current) {
			return null;
		}
	}

	return current ?? null;
};

export const buildSessionSnapshot = (
	params: BuildSessionSnapshotParams,
): SessionSnapshot => {
	const nextSessionsById = new Map<string, Session>();
	const nextStatusBySessionId: SessionStatusById = {};
	const nextMessageCountBySessionId: Partial<Record<string, number>> = {};
	const nextSessionIssues: Partial<Record<string, string>> = {};
	const orderedSessions: Session[] = [];

	for (const rawSession of params.rawSessions) {
		const session: Session = {
			...rawSession,
			subagentSessions: [],
		};

		const latestMessageResult = params.latestMessages[session.id];
		const messageCount = params.messageCounts[session.id];

		if (typeof messageCount === "number") {
			nextMessageCountBySessionId[session.id] = messageCount;
		}

		if (latestMessageResult) {
			const parseResult = latestMessageResult.message;
			const waitingSignal = params.waitingSignals[session.id];
			const latestUserMessageTime = waitingSignal?.latestUserMessageTime ?? 0;
			const latestQuestionToolTime = waitingSignal?.latestQuestionToolTime ?? 0;
			const isAwaitingUser =
				waitingSignal?.questionToolRunning === true &&
				latestQuestionToolTime > latestUserMessageTime;
			const detectedStatus = detectSessionStatus(parseResult);
			const status =
				isAwaitingUser &&
				detectedStatus !== SessionStatus.failed &&
				detectedStatus !== SessionStatus.completed
					? SessionStatus.waiting
					: detectedStatus;
			session.status = status;
			nextStatusBySessionId[session.id] = status;

			if (parseResult.ok && parseResult.value.agent) {
				session.currentAgent = parseResult.value.agent;
			}

			if (!parseResult.ok) {
				nextSessionIssues[session.id] =
					`Data error: ${parseResult.error.message}`;
			}
		} else {
			session.status = SessionStatus.unknown;
			nextStatusBySessionId[session.id] = SessionStatus.unknown;
		}

		nextSessionsById.set(session.id, session);
		orderedSessions.push(session);
	}

	const rootSessions = orderedSessions.filter((session) => !session.parent_id);

	for (const session of orderedSessions) {
		if (!session.parent_id) {
			continue;
		}

		const rootSession = resolveRootSession(session, nextSessionsById);
		if (!rootSession || rootSession.id === session.id) {
			nextSessionIssues[session.id] = "Parent session not found for subagent.";
			continue;
		}

		rootSession.subagentSessions = [
			...(rootSession.subagentSessions ?? []),
			session,
		];
	}

	return {
		sessions: rootSessions,
		statusBySessionId: nextStatusBySessionId,
		messageCountBySessionId: nextMessageCountBySessionId,
		sessionIssues: nextSessionIssues,
	};
};
