import { SessionStatus } from "../types";
import { getStatusLabel } from "./hierarchyHelpers";
import { normalizeTimestamp } from "./recentCompletion";

/** No updates from session + subagents for this long → stalled (orange). */
export const STALL_THRESHOLD_MS = 5 * 60 * 1000;

/** No updates from session + subagents for this long → blocked (red). */
export const BLOCKED_THRESHOLD_MS = 10 * 60 * 1000;

export type StallLevel = "none" | "stalled" | "blocked";

export interface StallActivitySource {
	time_updated: number;
	finishReason?: string;
	subagentSessions?: ReadonlyArray<{ time_updated: number }>;
}

const IDLE_STATUS_LABEL = "Idle";

const isEligibleForStall = (
	status: SessionStatus | undefined,
	finishReason?: string,
): boolean => {
	if (
		status !== SessionStatus.pending &&
		status !== SessionStatus.running &&
		status !== SessionStatus.waiting
	) {
		return false;
	}

	// Idle is a waiting-display variant; do not treat as stalled/blocked.
	return getStatusLabel(status, { finishReason }) !== IDLE_STATUS_LABEL;
};

/** Latest activity across the root session and all direct subagents. */
export const getLatestActivityTimestamp = (
	session: StallActivitySource,
): number => {
	let latest = session.time_updated;

	for (const subagent of session.subagentSessions ?? []) {
		if (subagent.time_updated > latest) {
			latest = subagent.time_updated;
		}
	}

	return latest;
};

export const getInactiveDurationMs = (
	session: StallActivitySource,
	now: number = Date.now(),
): number | null => {
	const latestActivity = normalizeTimestamp(
		getLatestActivityTimestamp(session),
	);
	if (latestActivity === null) {
		return null;
	}

	return Math.max(0, now - latestActivity);
};

export const formatInactiveDuration = (inactiveForMs: number): string => {
	const totalMinutes = Math.max(0, Math.floor(inactiveForMs / 60_000));
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (minutes === 0) {
		return `${hours}h`;
	}

	return `${hours}h${minutes}m`;
};

export const getStallLevel = (
	status: SessionStatus | undefined,
	session: StallActivitySource,
	now: number = Date.now(),
): StallLevel => {
	if (!isEligibleForStall(status, session.finishReason)) {
		return "none";
	}

	const inactiveForMs = getInactiveDurationMs(session, now);
	if (inactiveForMs === null) {
		return "none";
	}

	if (inactiveForMs >= BLOCKED_THRESHOLD_MS) {
		return "blocked";
	}

	if (inactiveForMs >= STALL_THRESHOLD_MS) {
		return "stalled";
	}

	return "none";
};
