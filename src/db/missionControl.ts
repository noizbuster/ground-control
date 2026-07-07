import type { SessionSnapshot } from "../lib/sessionSnapshot";
import type { DatabaseResult } from "./index";
import { resolveMissionControlDatabasePath } from "./missionControlSqlite";
import { getMissionControlSnapshotFromSqlite } from "./missionControlSqliteSnapshot";

// SQLite is the sole Mission Control session source. The snapshot owns all
// error classification: a missing database file, a database without the
// `sessions` table, or a query failure each surfaces as a typed DatabaseResult.
export const getMissionControlSnapshot = (): DatabaseResult<SessionSnapshot> =>
	getMissionControlSnapshotFromSqlite({
		databasePath: resolveMissionControlDatabasePath(),
	});

export {
	type DeleteMissionControlSessionOptions,
	deleteMissionControlSession,
	type MissionControlDeleteResult,
} from "./missionControlDelete";
export { resolveMissionControlDatabasePath } from "./missionControlSqlite";
export { getMissionControlSnapshotFromSqlite } from "./missionControlSqliteSnapshot";
