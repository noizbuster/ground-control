import { type Session, SessionStatus } from "../types";

export type SessionFilterMode = "active" | "recent" | "busy" | "all";
export type SessionSortMode = "status" | "update" | "create";

export interface SessionFilterResult {
	sessions: Session[];
	hiddenCompletedCount: number;
}

const shouldNormalizeDirectoryCase = process.platform === "win32";

export const normalizeDirectoryPath = (directory: string): string => {
	const normalized = directory.trim().replace(/[\\/]+$/gu, "");
	return shouldNormalizeDirectoryCase ? normalized.toLowerCase() : normalized;
};

export const isInterruptedSession = (session: Session): boolean =>
	session.finishReason === "interrupted" ||
	session.finishReason === "turn_aborted";

export const isSettledSession = (session: Session): boolean =>
	session.status === SessionStatus.completed || isInterruptedSession(session);

const isActiveWorkSession = (session: Session): boolean =>
	!isSettledSession(session);

const getSessionStatusSortRank = (session: Session): number => {
	if (isInterruptedSession(session)) {
		return 3;
	}

	if (session.status === SessionStatus.waiting) {
		return 0;
	}

	if (session.status === SessionStatus.running) {
		return 1;
	}

	if (session.status === SessionStatus.completed) {
		return 3;
	}

	return 2;
};

export const applySessionFilter = (
	sessions: Session[],
	filterMode: SessionFilterMode,
	pinnedSessionIds: ReadonlySet<string> = new Set(),
	latestCompletedSessionId: string | null = null,
): SessionFilterResult => {
	switch (filterMode) {
		case "all":
			return { sessions, hiddenCompletedCount: 0 };

		case "busy":
			return {
				sessions: sessions.filter((session) => isActiveWorkSession(session)),
				hiddenCompletedCount: 0,
			};

		case "recent": {
			const orderedSessions = [...sessions].sort(
				(left, right) => right.time_updated - left.time_updated,
			);
			const latestSessionIdsByProject = new Set<string>();
			const seenProjectDirectories = new Set<string>();
			for (const session of orderedSessions) {
				const projectDirectoryKey = normalizeDirectoryPath(session.directory);
				if (seenProjectDirectories.has(projectDirectoryKey)) {
					continue;
				}

				seenProjectDirectories.add(projectDirectoryKey);
				latestSessionIdsByProject.add(session.id);
			}
			let hiddenCompletedCount = 0;

			const filteredSessions = orderedSessions.filter((session) => {
				if (isActiveWorkSession(session)) {
					return true;
				}

				if (pinnedSessionIds.has(session.id)) {
					return true;
				}

				if (latestSessionIdsByProject.has(session.id)) {
					return true;
				}

				if (
					latestCompletedSessionId !== null &&
					session.id === latestCompletedSessionId
				) {
					return true;
				}

				if (isSettledSession(session)) {
					hiddenCompletedCount += 1;
				}

				return false;
			});

			return {
				sessions: filteredSessions,
				hiddenCompletedCount,
			};
		}

		case "active": {
			const orderedSessions = [...sessions].sort(
				(left, right) => right.time_updated - left.time_updated,
			);
			let hiddenCompletedCount = 0;

			const filteredSessions = orderedSessions.filter((session) => {
				if (isActiveWorkSession(session)) {
					return true;
				}

				if (pinnedSessionIds.has(session.id)) {
					return true;
				}

				hiddenCompletedCount += 1;
				return false;
			});

			return {
				sessions: filteredSessions,
				hiddenCompletedCount,
			};
		}
	}
};

export const applySessionSort = (
	sessions: Session[],
	sortMode: SessionSortMode,
): Session[] => {
	const orderedSessions = [...sessions];

	orderedSessions.sort((left, right) => {
		switch (sortMode) {
			case "create": {
				if (left.time_created !== right.time_created) {
					return right.time_created - left.time_created;
				}
				break;
			}

			case "update": {
				if (left.time_updated !== right.time_updated) {
					return right.time_updated - left.time_updated;
				}
				break;
			}

			case "status": {
				const leftRank = getSessionStatusSortRank(left);
				const rightRank = getSessionStatusSortRank(right);

				if (leftRank !== rightRank) {
					return leftRank - rightRank;
				}

				if (left.time_updated !== right.time_updated) {
					return right.time_updated - left.time_updated;
				}
				break;
			}
		}

		if (left.time_updated !== right.time_updated) {
			return right.time_updated - left.time_updated;
		}

		if (left.time_created !== right.time_created) {
			return right.time_created - left.time_created;
		}

		return left.id.localeCompare(right.id);
	});

	return orderedSessions;
};
