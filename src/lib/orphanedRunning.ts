import { normalizeTimestamp } from "./recentCompletion";

export const ORPHANED_RUNNING_MS = 5 * 60 * 1000;

export const isOrphanedRunningActivity = (
	lastActivityMs: number | undefined | null,
	nowMs: number = Date.now(),
): boolean => {
	const normalized =
		lastActivityMs == null ? null : normalizeTimestamp(lastActivityMs);
	if (normalized === null) {
		return false;
	}

	return nowMs - normalized >= ORPHANED_RUNNING_MS;
};
