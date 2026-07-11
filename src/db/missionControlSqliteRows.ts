import type { DatabaseSync } from "node:sqlite";

export interface McSqliteSessionRow {
	readonly sessionId: string;
	readonly status: string | null;
	readonly awaitingReason: string | null;
	readonly workspacePath: string | null;
	readonly providerId: string | null;
	readonly modelId: string | null;
	readonly title: string | null;
	readonly createdAt: string | null;
	readonly updatedAt: string | null;
	readonly lastActivityAt: string | null;
	readonly parentSessionId: string | null;
	readonly waitReason: string | null;
	readonly lastEventSequence: number | null;
	readonly metadataJson: string | null;
}

export interface McSqliteRelationRow {
	readonly parent_session_id: string | null;
	readonly child_session_id: string;
	readonly kind: string;
}

const SESSION_COLUMNS = [
	"session_id",
	"status",
	"awaiting_reason",
	"workspace_path",
	"provider_id",
	"model_id",
	"title",
	"created_at",
	"updated_at",
	"last_activity_at",
	"parent_session_id",
	"last_event_seq",
	"metadata_json",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const stringOrNull = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

const numberOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const tableColumns = (database: DatabaseSync, table: string): Set<string> => {
	const columns = new Set<string>();
	for (const row of database.prepare(`PRAGMA table_info('${table}')`).all()) {
		if (!isRecord(row) || typeof row.name !== "string") {
			continue;
		}
		columns.add(row.name);
	}
	return columns;
};

export const sqliteTableExists = (
	database: DatabaseSync,
	table: string,
): boolean => {
	const row = database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
	return isRecord(row) && row.name === table;
};

const selectedColumn = (
	columns: ReadonlySet<string>,
	column: string,
): string =>
	columns.has(column) ? `s.${column} AS ${column}` : `NULL AS ${column}`;

export const readMcSqliteSessionRows = (
	database: DatabaseSync,
): McSqliteSessionRow[] => {
	const columns = tableColumns(database, "sessions");
	if (!columns.has("session_id")) {
		throw new Error("Mission Control sessions table lacks session_id");
	}
	const awaitColumns = sqliteTableExists(database, "session_awaits")
		? tableColumns(database, "session_awaits")
		: new Set<string>();
	const canJoinWait =
		columns.has("primary_wait_id") &&
		awaitColumns.has("wait_id") &&
		awaitColumns.has("reason");
	const waitSelection = canJoinWait
		? "w.reason AS wait_reason"
		: "NULL AS wait_reason";
	const waitJoin = canJoinWait
		? "LEFT JOIN session_awaits w ON w.wait_id = s.primary_wait_id"
		: "";
	const query = `SELECT ${SESSION_COLUMNS.map((column) =>
		selectedColumn(columns, column),
	).join(", ")}, ${waitSelection} FROM sessions s ${waitJoin}`;
	const decoded: McSqliteSessionRow[] = [];
	for (const row of database.prepare(query).all()) {
		if (!isRecord(row) || typeof row.session_id !== "string") {
			continue;
		}
		decoded.push({
			sessionId: row.session_id,
			status: stringOrNull(row.status),
			awaitingReason: stringOrNull(row.awaiting_reason),
			workspacePath: stringOrNull(row.workspace_path),
			providerId: stringOrNull(row.provider_id),
			modelId: stringOrNull(row.model_id),
			title: stringOrNull(row.title),
			createdAt: stringOrNull(row.created_at),
			updatedAt: stringOrNull(row.updated_at),
			lastActivityAt: stringOrNull(row.last_activity_at),
			parentSessionId: stringOrNull(row.parent_session_id),
			waitReason: stringOrNull(row.wait_reason),
			lastEventSequence: numberOrNull(row.last_event_seq),
			metadataJson: stringOrNull(row.metadata_json),
		});
	}
	return decoded;
};

export const readMcMessageCounts = (
	database: DatabaseSync,
): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>();
	if (!sqliteTableExists(database, "session_messages")) {
		return counts;
	}
	const columns = tableColumns(database, "session_messages");
	if (!columns.has("session_id")) {
		return counts;
	}
	for (const row of database
		.prepare(
			"SELECT session_id, COUNT(*) AS count FROM session_messages GROUP BY session_id",
		)
		.all()) {
		if (
			isRecord(row) &&
			typeof row.session_id === "string" &&
			typeof row.count === "number"
		) {
			counts.set(row.session_id, row.count);
		}
	}
	return counts;
};

export const readMcRelations = (
	database: DatabaseSync,
): McSqliteRelationRow[] => {
	if (!sqliteTableExists(database, "session_relations")) {
		return [];
	}
	const columns = tableColumns(database, "session_relations");
	if (
		!columns.has("parent_session_id") ||
		!columns.has("child_session_id") ||
		!columns.has("kind")
	) {
		return [];
	}
	const rows: McSqliteRelationRow[] = [];
	const order = columns.has("relation_id")
		? "ORDER BY child_session_id, relation_id"
		: "ORDER BY child_session_id";
	try {
		for (const row of database
			.prepare(
				`SELECT parent_session_id, child_session_id, kind FROM session_relations WHERE kind IN ('subagent', 'parent_child') ${order}`,
			)
			.all()) {
			if (
				!isRecord(row) ||
				typeof row.child_session_id !== "string" ||
				typeof row.kind !== "string"
			) {
				continue;
			}
			rows.push({
				parent_session_id: stringOrNull(row.parent_session_id),
				child_session_id: row.child_session_id,
				kind: row.kind,
			});
		}
	} catch {
		return [];
	}
	return rows;
};
