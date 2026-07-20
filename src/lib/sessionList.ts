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

export const isAttachedPinCandidateSession = (session: Session): boolean =>
	isSettledSession(session) || session.status === SessionStatus.idle;

const isActiveWorkSession = (session: Session): boolean =>
	!isAttachedPinCandidateSession(session);

export const selectDirectoryPinnedSessionIds = (params: {
	readonly sessions: readonly Session[];
	readonly directoryProcessCounts: ReadonlyMap<string, number>;
	readonly getDirectoryKey: (session: Session) => string;
}): ReadonlySet<string> => {
	const { sessions, directoryProcessCounts, getDirectoryKey } = params;
	if (directoryProcessCounts.size === 0) {
		return new Set();
	}

	const activeWorkCountByDirectory = new Map<string, number>();
	for (const session of sessions) {
		if (isAttachedPinCandidateSession(session)) {
			continue;
		}

		const directoryKey = getDirectoryKey(session);
		activeWorkCountByDirectory.set(
			directoryKey,
			(activeWorkCountByDirectory.get(directoryKey) ?? 0) + 1,
		);
	}

	const remainingDirectorySlots = new Map<string, number>();
	for (const [directoryKey, totalSlots] of directoryProcessCounts) {
		const remainingSlots =
			totalSlots - (activeWorkCountByDirectory.get(directoryKey) ?? 0);
		if (remainingSlots > 0) {
			remainingDirectorySlots.set(directoryKey, remainingSlots);
		}
	}

	const orderedPinCandidates = [...sessions]
		.filter((session) => isAttachedPinCandidateSession(session))
		.sort((left, right) => right.time_updated - left.time_updated);

	const pinnedSessionIds = new Set<string>();
	for (const session of orderedPinCandidates) {
		const directoryKey = getDirectoryKey(session);
		const remainingSlots = remainingDirectorySlots.get(directoryKey) ?? 0;
		if (remainingSlots <= 0) {
			continue;
		}

		pinnedSessionIds.add(session.id);
		if (remainingSlots === 1) {
			remainingDirectorySlots.delete(directoryKey);
		} else {
			remainingDirectorySlots.set(directoryKey, remainingSlots - 1);
		}
	}

	return pinnedSessionIds;
};

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

	if (session.status === SessionStatus.idle) {
		return 2;
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
