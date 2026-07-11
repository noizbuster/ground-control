import { DatabaseSync } from "node:sqlite";

export interface McProjectionRunRow {
	readonly sessionId: string;
	readonly eventId: string;
	readonly sequence: number;
	readonly timestamp: string;
	readonly eventType: string;
	readonly state: string | null;
	readonly runId: string | null;
	readonly reason?: string | null;
	readonly errorCode?: string | null;
}

export interface McMissionRunWorkRow {
	readonly runId: string;
	readonly sessionId: string;
	readonly status: string;
	readonly updatedAt: string;
}

export interface McLeaseRow {
	readonly dbIdentity: string;
	readonly sessionId: string;
	readonly ownerId: string;
	readonly epoch: number;
	readonly expiresWallMs: number;
}

export interface McTask11Tables {
	readonly projections?: readonly McProjectionRunRow[];
	readonly missionRuns?: readonly McMissionRunWorkRow[];
	readonly leases?: readonly McLeaseRow[];
	readonly includeProjectionTable?: boolean;
	readonly includeMissionRunsTable?: boolean;
	readonly includeLeaseTable?: boolean;
}

export const addMcTask11Tables = (
	databasePath: string,
	options: McTask11Tables,
): void => {
	const database = new DatabaseSync(databasePath);
	if (options.includeProjectionTable ?? true) {
		database.exec(`
			CREATE TABLE session_projection_runs (
				session_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				timestamp TEXT NOT NULL,
				event_type TEXT NOT NULL,
				command TEXT,
				state TEXT,
				run_id TEXT,
				input_id TEXT,
				provider_turn_id TEXT,
				reason TEXT,
				error_code TEXT,
				PRIMARY KEY (session_id, event_id)
			)
		`);
		const insertProjection = database.prepare(`
			INSERT INTO session_projection_runs
				(session_id, event_id, sequence, timestamp, event_type, state, run_id, reason, error_code)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const row of options.projections ?? []) {
			insertProjection.run(
				row.sessionId,
				row.eventId,
				row.sequence,
				row.timestamp,
				row.eventType,
				row.state,
				row.runId,
				row.reason ?? null,
				row.errorCode ?? null,
			);
		}
	}
	if (options.includeMissionRunsTable ?? true) {
		database.exec(`
			CREATE TABLE mission_runs (
				run_id TEXT PRIMARY KEY,
				session_id TEXT,
				status TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		const insertMissionRun = database.prepare(
			"INSERT INTO mission_runs (run_id, session_id, status, updated_at) VALUES (?, ?, ?, ?)",
		);
		for (const row of options.missionRuns ?? []) {
			insertMissionRun.run(row.runId, row.sessionId, row.status, row.updatedAt);
		}
	}
	if (options.includeLeaseTable ?? true) {
		database.exec(`
			CREATE TABLE session_control_leases (
				db_identity TEXT NOT NULL,
				session_id TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				epoch INTEGER NOT NULL,
				expires_wall_ms INTEGER NOT NULL,
				PRIMARY KEY (db_identity, session_id)
			)
		`);
		const insertLease = database.prepare(`
			INSERT INTO session_control_leases
				(db_identity, session_id, owner_id, epoch, expires_wall_ms)
			VALUES (?, ?, ?, ?, ?)
		`);
		for (const row of options.leases ?? []) {
			insertLease.run(
				row.dbIdentity,
				row.sessionId,
				row.ownerId,
				row.epoch,
				row.expiresWallMs,
			);
		}
	}
	database.close();
};
