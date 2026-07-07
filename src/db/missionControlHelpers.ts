// Shared Mission Control metadata helpers: title truncation, project label,
// and timestamp normalization. Used by the SQLite snapshot, hierarchy, and
// event-fallback modules.

import { getSessionSourceLabel } from "../lib/sessionSource";

export const truncateTitle = (value: string): string =>
	value.length <= 160 ? value : `${value.slice(0, 157)}...`;

export const getProjectLabel = (directory: string): string => {
	const trimmed = directory.trim().replace(/[\\/]+$/u, "");
	if (!trimmed) {
		return getSessionSourceLabel("mission-control");
	}

	return trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
};

export const normalizeTimestampMs = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}

	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
};
