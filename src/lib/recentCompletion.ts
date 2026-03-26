import { SessionStatus } from "../types";

export const RECENT_COMPLETION_WINDOW_MS = 5 * 60 * 1000;

export const normalizeTimestamp = (value: number): number | null => {
	if (!Number.isFinite(value) || value <= 0) {
		return null;
	}

	return value < 1_000_000_000_000 ? value * 1000 : value;
};

export const isRecentlyCompleted = (
	status: SessionStatus | undefined,
	timeUpdated: number,
	now: number = Date.now(),
): boolean => {
	if (status !== SessionStatus.completed) {
		return false;
	}

	const updatedAt = normalizeTimestamp(timeUpdated);
	if (updatedAt === null) {
		return false;
	}

	return now - updatedAt <= RECENT_COMPLETION_WINDOW_MS;
};
