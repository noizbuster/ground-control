import type { DatabaseSync } from "node:sqlite";
import type { MissionControlLeaseMetadata } from "../types";
import { sqliteTableExists } from "./missionControlSqliteRows";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export const readMissionControlLeases = (
	database: DatabaseSync,
	dbIdentity: string,
	nowWallMs: number,
): ReadonlyMap<string, MissionControlLeaseMetadata> | null => {
	if (!sqliteTableExists(database, "session_control_leases")) return null;
	const leases = new Map<string, MissionControlLeaseMetadata>();
	try {
		for (const row of database
			.prepare(`
				SELECT session_id, owner_id, epoch, expires_wall_ms
				FROM session_control_leases WHERE db_identity = ?
			`)
			.all(dbIdentity)) {
			if (
				!isRecord(row) ||
				typeof row.session_id !== "string" ||
				typeof row.owner_id !== "string" ||
				typeof row.epoch !== "number" ||
				!Number.isSafeInteger(row.epoch) ||
				row.epoch <= 0 ||
				typeof row.expires_wall_ms !== "number" ||
				!Number.isSafeInteger(row.expires_wall_ms) ||
				row.expires_wall_ms < 0
			)
				return null;
			const live = row.expires_wall_ms > nowWallMs;
			leases.set(row.session_id, {
				state: live ? "live" : "expired",
				fallbackSafety: live ? "retry" : "eligible",
				ownerId: row.owner_id,
				epoch: row.epoch,
				expiresWallMs: row.expires_wall_ms,
			});
		}
	} catch {
		return null;
	}
	return leases;
};
