import { DatabaseSync } from "node:sqlite";
import { getMissionControlSnapshotFromSqlite } from "../src/db/missionControlSqliteSnapshot";
import type { SessionSnapshot } from "../src/lib/sessionSnapshot";
import type { Session } from "../src/types";

const SQLITE_BUSY_TIMEOUT_MS = 2_000;

export function sessionRows(
	databasePath: string,
): readonly Record<string, unknown>[] {
	return rows(
		databasePath,
		"SELECT session_id,status,parent_session_id,metadata_json FROM sessions ORDER BY session_id",
	);
}

export function tableRows(
	databasePath: string,
	sql: string,
): readonly Record<string, unknown>[] {
	return rows(databasePath, sql);
}

export function expireLeases(databasePath: string): void {
	write(databasePath, (database) => {
		database
			.prepare("UPDATE session_control_leases SET expires_wall_ms = 0")
			.run();
	});
}

export function installNewRunProjection(
	databasePath: string,
	sessionId: string,
): void {
	write(databasePath, (database) => {
		const sequence = Number(
			database
				.prepare(
					"SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM session_projection_runs WHERE session_id = ?",
				)
				.get(sessionId)?.sequence,
		);
		database
			.prepare(
				"INSERT INTO session_projection_runs (session_id,event_id,sequence,timestamp,event_type,state,run_id) VALUES (?,?,?,?,?,?,?)",
			)
			.run(
				sessionId,
				"event-new-run",
				sequence,
				new Date().toISOString(),
				"run.started",
				"running",
				"run-new",
			);
		database
			.prepare(
				"UPDATE sessions SET status = 'running', metadata_json = '{}' WHERE session_id = ?",
			)
			.run(sessionId);
	});
}

export function snapshot(databasePath: string): SessionSnapshot {
	const result = getMissionControlSnapshotFromSqlite({ databasePath });
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

export function selectedRoot(value: SessionSnapshot): Session {
	const root = value.sessions.find((session) => session.id === "mc-stop-root");
	if (root === undefined) throw new Error("missing mc-stop-root");
	return root;
}

export function metadata(session: Session) {
	const value = session.sourceMetadata?.missionControl;
	if (value === undefined)
		throw new Error(`missing MC metadata for ${session.id}`);
	return value;
}

export function sessionState(
	databasePath: string,
	sessionId: string,
): { status: string; lifecycleReason?: string } {
	const row = sessionRows(databasePath).find(
		(candidate) => candidate.session_id === sessionId,
	);
	if (row === undefined || typeof row.status !== "string")
		throw new Error(`missing session row ${sessionId}`);
	const parsed: unknown =
		typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : {};
	const reason =
		typeof parsed === "object" &&
		parsed !== null &&
		typeof Reflect.get(parsed, "lifecycleReason") === "string"
			? String(Reflect.get(parsed, "lifecycleReason"))
			: undefined;
	return {
		status: row.status,
		...(reason !== undefined ? { lifecycleReason: reason } : {}),
	};
}

export function stateById(databasePath: string): Record<string, string> {
	return Object.fromEntries(
		sessionRows(databasePath).map((row) => {
			const state = sessionState(databasePath, String(row.session_id));
			return [
				row.session_id,
				`${state.status}${state.lifecycleReason === undefined ? "" : `:${state.lifecycleReason}`}`,
			];
		}),
	);
}

export function deletedIds(stdout: string): string[] {
	return [...stdout.matchAll(/^Deleted session (\S+) \(\d+ events\)$/gmu)].map(
		(match) => match[1] ?? "",
	);
}

export function dataDir(databasePath: string): string {
	return databasePath.slice(0, databasePath.lastIndexOf("/"));
}

function rows(
	databasePath: string,
	sql: string,
): readonly Record<string, unknown>[] {
	const database = new DatabaseSync(databasePath, {
		readOnly: true,
		timeout: SQLITE_BUSY_TIMEOUT_MS,
	});
	try {
		return database.prepare(sql).all();
	} finally {
		database.close();
	}
}

function write(
	databasePath: string,
	operation: (database: DatabaseSync) => void,
): void {
	const database = new DatabaseSync(databasePath, {
		timeout: SQLITE_BUSY_TIMEOUT_MS,
	});
	try {
		operation(database);
	} finally {
		database.close();
	}
}
