import { SessionStatus } from "../types";

export const RECENT_COMPLETION_WINDOW_MS = 10 * 60 * 1000;

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
	finishReason?: string,
): boolean => {
	const isSettledStatus =
		status === SessionStatus.completed ||
		status === SessionStatus.idle ||
		finishReason === "interrupted" ||
		finishReason === "turn_aborted";
	if (!isSettledStatus) {
		return false;
	}

	const updatedAt = normalizeTimestamp(timeUpdated);
	if (updatedAt === null) {
		return false;
	}

	return now - updatedAt <= RECENT_COMPLETION_WINDOW_MS;
};
