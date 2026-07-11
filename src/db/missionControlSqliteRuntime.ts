import type { DatabaseSync } from "node:sqlite";
import type {
	MissionControlLatestRunMetadata,
	MissionControlLeaseMetadata,
	MissionControlLifecycleStatus,
	MissionControlRunOutcome,
	MissionControlSessionMetadata,
} from "../types";
import { readMissionControlLeases } from "./missionControlSqliteLease";
import type { McSqliteSessionRow } from "./missionControlSqliteRows";
import { sqliteTableExists } from "./missionControlSqliteRows";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const lifecycleStatus = (
	value: string | null,
): MissionControlLifecycleStatus | undefined => {
	switch (value) {
		case "idle":
		case "running":
		case "awaiting":
		case "stopped":
		case "failed":
			return value;
		default:
			return undefined;
	}
};

const runOutcome = (value: unknown): MissionControlRunOutcome | null => {
	switch (value) {
		case "idle":
		case "running":
		case "interrupted":
		case "completed":
		case "failed":
		case "blocked_on_approval":
			return value;
		default:
			return null;
	}
};

const lifecycleReason = (metadataJson: string | null): string | undefined => {
	if (metadataJson === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		return isRecord(parsed) && typeof parsed.lifecycleReason === "string"
			? parsed.lifecycleReason
			: undefined;
	} catch {
		return undefined;
	}
};

const readLatestRuns = (
	database: DatabaseSync,
): ReadonlyMap<string, MissionControlLatestRunMetadata> => {
	const latest = new Map<string, MissionControlLatestRunMetadata>();
	if (!sqliteTableExists(database, "session_projection_runs")) return latest;
	try {
		const rows = database
			.prepare(`
			SELECT session_id, event_id, sequence, timestamp, event_type, state,
				run_id, reason, error_code
			FROM (
				SELECT *, ROW_NUMBER() OVER (
					PARTITION BY session_id ORDER BY sequence DESC, event_id DESC
				) AS rank
				FROM session_projection_runs
			)
			WHERE rank = 1
		`)
			.all();
		for (const row of rows) {
			if (
				!isRecord(row) ||
				typeof row.session_id !== "string" ||
				typeof row.sequence !== "number" ||
				typeof row.timestamp !== "string" ||
				typeof row.event_type !== "string"
			)
				continue;
			latest.set(row.session_id, {
				outcome: runOutcome(row.state),
				sequence: row.sequence,
				timestamp: row.timestamp,
				eventType: row.event_type,
				...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
				...(typeof row.reason === "string" ? { reason: row.reason } : {}),
				...(typeof row.error_code === "string"
					? { errorCode: row.error_code }
					: {}),
			});
		}
	} catch {
		return new Map();
	}
	return latest;
};

interface ActiveWorkRead {
	readonly sessionIds: ReadonlySet<string>;
	readonly known: boolean;
}

const readActiveWork = (database: DatabaseSync): ActiveWorkRead => {
	const active = new Set<string>();
	let known = true;
	if (sqliteTableExists(database, "session_projection_runs")) {
		try {
			for (const row of database
				.prepare(`
					SELECT DISTINCT current.session_id
					FROM session_projection_runs current
					WHERE current.run_id IS NOT NULL
						AND current.state IN ('running', 'blocked_on_approval')
						AND current.sequence = (
							SELECT MAX(latest.sequence)
							FROM session_projection_runs latest
							WHERE latest.session_id = current.session_id
								AND latest.run_id = current.run_id
						)
				`)
				.all()) {
				if (isRecord(row) && typeof row.session_id === "string")
					active.add(row.session_id);
			}
		} catch {
			known = false;
		}
	}
	if (sqliteTableExists(database, "mission_runs")) {
		try {
			for (const row of database
				.prepare(
					"SELECT DISTINCT session_id FROM mission_runs WHERE session_id IS NOT NULL AND status IN ('pending', 'running', 'blocked')",
				)
				.all()) {
				if (isRecord(row) && typeof row.session_id === "string")
					active.add(row.session_id);
			}
		} catch {
			known = false;
		}
	}
	return { sessionIds: active, known };
};

const unknownLease = (): MissionControlLeaseMetadata => ({
	state: "unknown",
	fallbackSafety: "no_delete",
});

const isAbortable = (
	status: MissionControlLifecycleStatus | undefined,
	hasActiveWork: boolean | null,
): boolean => {
	switch (status) {
		case "running":
		case "awaiting":
			return true;
		case "idle":
			return hasActiveWork === true;
		case "stopped":
		case "failed":
		case undefined:
			return false;
	}
};

export const readMissionControlRuntimeMetadata = (params: {
	readonly database: DatabaseSync;
	readonly sessions: readonly McSqliteSessionRow[];
	readonly dbIdentity: string;
	readonly canonicalDatabasePath: string;
	readonly nowWallMs: number;
}): ReadonlyMap<string, MissionControlSessionMetadata> => {
	const latestRuns = readLatestRuns(params.database);
	const activeWork = readActiveWork(params.database);
	const leases = readMissionControlLeases(
		params.database,
		params.dbIdentity,
		params.nowWallMs,
	);
	return new Map(
		params.sessions.map((session) => {
			const status = lifecycleStatus(session.status);
			const reason = lifecycleReason(session.metadataJson);
			const hasActiveWork = activeWork.sessionIds.has(session.sessionId)
				? true
				: activeWork.known
					? false
					: null;
			const matchingLease = leases?.get(session.sessionId);
			const lease =
				leases === null
					? unknownLease()
					: (matchingLease ?? {
							state: "missing",
							fallbackSafety: "eligible",
						});
			const latestRun = latestRuns.get(session.sessionId);
			return [
				session.sessionId,
				{
					databaseIdentity: params.dbIdentity,
					canonicalDatabasePath: params.canonicalDatabasePath,
					rawLifecycleStatus: session.status,
					...(status !== undefined ? { lifecycleStatus: status } : {}),
					...(reason !== undefined ? { lifecycleReason: reason } : {}),
					...(session.lastEventSequence !== null
						? { lastEventSequence: session.lastEventSequence }
						: {}),
					...(session.updatedAt !== null
						? { updatedAt: session.updatedAt }
						: {}),
					...(session.lastActivityAt !== null
						? { lastActivityAt: session.lastActivityAt }
						: {}),
					...(latestRun !== undefined ? { latestRun } : {}),
					hasActiveWork,
					abortable: isAbortable(status, hasActiveWork),
					lease,
				},
			] as const;
		}),
	);
};
