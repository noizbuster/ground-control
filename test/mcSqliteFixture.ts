// On-disk Mission Control SQLite fixture helper.
//
// Builds a real `mission-control.db` (not `:memory:`) under a temp dir using
// `node:sqlite` DatabaseSync, with table/column names that match the Mission
// Control data-dir schema exactly. NOT NULL and foreign-key constraints from
// the production schema are relaxed here so tests can seed partial rows; only
// primary keys are preserved. This is the fixture foundation that the SQLite
// path/probe tests (this todo) and the snapshot/hierarchy tests (todos 4/5)
// reuse.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface McSessionRow {
	session_id: string;
	root_session_id?: string | null;
	parent_session_id?: string | null;
	status?: string;
	awaiting_reason?: string | null;
	primary_wait_id?: string | null;
	workspace_path?: string | null;
	provider_id?: string | null;
	model_id?: string | null;
	title?: string | null;
	total_input_tokens?: number | null;
	total_output_tokens?: number | null;
	total_cost_usd?: string | null;
	last_event_seq?: number | null;
	created_at?: string | null;
	updated_at?: string | null;
	last_activity_at?: string | null;
	stopped_at?: string | null;
	failed_at?: string | null;
	legacy_jsonl_path?: string | null;
	imported_at?: string | null;
	exported_at?: string | null;
	metadata_json?: string | null;
}

export interface McSessionEventRow {
	session_id: string;
	seq: number;
	event_id?: string | null;
	type?: string | null;
	timestamp?: string | null;
	run_id?: string | null;
	turn_id?: string | null;
	causation_id?: string | null;
	correlation_id?: string | null;
	payload_json?: string | null;
}

export interface McSessionMessageRow {
	message_id: string;
	session_id?: string | null;
	seq?: number | null;
	role?: string | null;
	provider_message_id?: string | null;
	created_at?: string | null;
	metadata_json?: string | null;
}

export interface McSessionAwaitRow {
	wait_id: string;
	session_id?: string | null;
	reason?: string | null;
	source_kind?: string | null;
	source_id?: string | null;
	run_id?: string | null;
	tool_call_id?: string | null;
	approval_id?: string | null;
	job_id?: string | null;
	child_session_id?: string | null;
	status?: string | null;
	created_at?: string | null;
	resolved_at?: string | null;
	cancelled_at?: string | null;
	metadata_json?: string | null;
}

export interface McSessionRelationRow {
	relation_id: string;
	parent_session_id?: string | null;
	child_session_id?: string | null;
	kind?: string | null;
	created_at?: string | null;
	metadata_json?: string | null;
}

export interface McSqliteFixtureOptions {
	readonly sessions?: readonly McSessionRow[];
	readonly events?: readonly McSessionEventRow[];
	readonly messages?: readonly McSessionMessageRow[];
	readonly awaits?: readonly McSessionAwaitRow[];
	readonly relations?: readonly McSessionRelationRow[];
	readonly includeRelations?: boolean;
	readonly dbName?: string;
}

export interface McSqliteFixture {
	readonly dbPath: string;
	readonly dir: string;
}

// Column names mirror mission-control/packages/core/src/db (session-core-schema,
// session-record-schema, session-await-schema, local-libsql-schema-*). NOT NULL
// and FK constraints are dropped for seeding flexibility; PKs are kept so the
// composite (session_id, seq) on session_events and unique event semantics hold.
const SCHEMA_SESSIONS = `
CREATE TABLE sessions (
	session_id TEXT PRIMARY KEY,
	root_session_id TEXT,
	parent_session_id TEXT,
	status TEXT,
	awaiting_reason TEXT,
	primary_wait_id TEXT,
	workspace_path TEXT,
	provider_id TEXT,
	model_id TEXT,
	title TEXT,
	total_input_tokens INTEGER DEFAULT 0,
	total_output_tokens INTEGER DEFAULT 0,
	total_cost_usd TEXT,
	last_event_seq INTEGER DEFAULT 0,
	created_at TEXT,
	updated_at TEXT,
	last_activity_at TEXT,
	stopped_at TEXT,
	failed_at TEXT,
	legacy_jsonl_path TEXT,
	imported_at TEXT,
	exported_at TEXT,
	metadata_json TEXT
)`;

const SCHEMA_SESSION_EVENTS = `
CREATE TABLE session_events (
	session_id TEXT,
	seq INTEGER,
	event_id TEXT,
	type TEXT,
	timestamp TEXT,
	run_id TEXT,
	turn_id TEXT,
	causation_id TEXT,
	correlation_id TEXT,
	payload_json TEXT,
	PRIMARY KEY (session_id, seq)
)`;

const SCHEMA_SESSION_MESSAGES = `
CREATE TABLE session_messages (
	message_id TEXT PRIMARY KEY,
	session_id TEXT,
	seq INTEGER,
	role TEXT,
	provider_message_id TEXT,
	created_at TEXT,
	metadata_json TEXT
)`;

const SCHEMA_SESSION_AWAITS = `
CREATE TABLE session_awaits (
	wait_id TEXT PRIMARY KEY,
	session_id TEXT,
	reason TEXT,
	source_kind TEXT,
	source_id TEXT,
	run_id TEXT,
	tool_call_id TEXT,
	approval_id TEXT,
	job_id TEXT,
	child_session_id TEXT,
	status TEXT,
	created_at TEXT,
	resolved_at TEXT,
	cancelled_at TEXT,
	metadata_json TEXT
)`;

const SCHEMA_SESSION_RELATIONS = `
CREATE TABLE session_relations (
	relation_id TEXT PRIMARY KEY,
	parent_session_id TEXT,
	child_session_id TEXT,
	kind TEXT,
	created_at TEXT,
	metadata_json TEXT
)`;

const createMcSchema = (
	database: DatabaseSync,
	includeRelations: boolean,
): void => {
	database.exec(SCHEMA_SESSIONS);
	database.exec(SCHEMA_SESSION_EVENTS);
	database.exec(SCHEMA_SESSION_MESSAGES);
	database.exec(SCHEMA_SESSION_AWAITS);
	if (includeRelations) {
		database.exec(SCHEMA_SESSION_RELATIONS);
	}
};

// Inserts only the columns present on `row` (undefined values skipped), so
// partial seeds work without hitting NOT NULL. Booleans are coerced to 0/1.
const insertRow = <T extends object>(
	database: DatabaseSync,
	table: string,
	row: T,
): void => {
	const entries: ReadonlyArray<[string, unknown]> = Object.entries(row).filter(
		(entry) => entry[1] !== undefined,
	);
	if (entries.length === 0) {
		return;
	}
	const columns = entries.map(([key]) => key);
	const placeholders = columns.map(() => "?").join(", ");
	const values: SQLInputValue[] = entries.map(([, value]) => {
		if (typeof value === "boolean") {
			return value ? 1 : 0;
		}
		return value as SQLInputValue;
	});
	database
		.prepare(
			`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
		)
		.run(...values);
};

const insertRows = <T extends object>(
	database: DatabaseSync,
	table: string,
	rows: readonly T[] | undefined,
): void => {
	if (!rows) {
		return;
	}
	for (const row of rows) {
		insertRow(database, table, row);
	}
};

const createdDirs: string[] = [];

export const createMcSqliteFixture = (
	options: McSqliteFixtureOptions = {},
): McSqliteFixture => {
	const dir = mkdtempSync(join(tmpdir(), "gctrl-mc-sqlite-"));
	createdDirs.push(dir);
	const dbPath = join(dir, options.dbName ?? "mission-control.db");
	const database = new DatabaseSync(dbPath);
	const includeRelations = options.includeRelations ?? true;
	createMcSchema(database, includeRelations);
	insertRows(database, "sessions", options.sessions);
	insertRows(database, "session_events", options.events);
	insertRows(database, "session_messages", options.messages);
	insertRows(database, "session_awaits", options.awaits);
	if (includeRelations) {
		insertRows(database, "session_relations", options.relations);
	}
	database.close();
	return { dbPath, dir };
};

// Rm every temp dir created by createMcSqliteFixture. Call from afterEach.
export const cleanupMcSqliteFixtures = (): void => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
};
