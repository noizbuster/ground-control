import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMissionControlDatabasePath } from "../src/db/missionControlSqlite";
import {
	cleanupMcSqliteFixtures,
	createMcSqliteFixture,
	type McSessionAwaitRow,
	type McSessionEventRow,
	type McSessionMessageRow,
	type McSessionRelationRow,
	type McSessionRow,
} from "./mcSqliteFixture";

const ENV_KEYS = [
	"GCTRL_MC_DB_PATH",
	"MCTRL_DATA_DIR",
	"XDG_DATA_HOME",
] as const;

let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

const clearMcEnv = (): void => {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
};

const expectedXdgDefault = (): string =>
	join(homedir(), ".local", "share", "mission-control", "memory.db");

beforeEach(() => {
	envSnapshot = {};
	for (const key of ENV_KEYS) {
		envSnapshot[key] = process.env[key];
	}
	clearMcEnv();
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (envSnapshot[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = envSnapshot[key];
		}
	}
	cleanupMcSqliteFixtures();
});

describe("resolveMissionControlDatabasePath", () => {
	it("honors GCTRL_MC_DB_PATH when absolute", () => {
		process.env.GCTRL_MC_DB_PATH = "/custom/memory.db";
		expect(resolveMissionControlDatabasePath()).toBe("/custom/memory.db");
	});

	it("homedir-expands a relative GCTRL_MC_DB_PATH", () => {
		process.env.GCTRL_MC_DB_PATH = "mc/memory.db";
		expect(resolveMissionControlDatabasePath()).toBe(
			join(homedir(), "mc", "memory.db"),
		);
	});

	it("falls back to MCTRL_DATA_DIR/memory.db when the DB path is unset (absolute)", () => {
		process.env.MCTRL_DATA_DIR = "/data";
		expect(resolveMissionControlDatabasePath()).toBe("/data/memory.db");
	});

	it("homedir-expands a relative MCTRL_DATA_DIR before appending memory.db", () => {
		process.env.MCTRL_DATA_DIR = "data";
		expect(resolveMissionControlDatabasePath()).toBe(
			join(homedir(), "data", "memory.db"),
		);
	});

	it("falls back to XDG_DATA_HOME/mission-control/memory.db when only XDG is set", () => {
		process.env.XDG_DATA_HOME = "/xdg";
		expect(resolveMissionControlDatabasePath()).toBe(
			"/xdg/mission-control/memory.db",
		);
	});

	it("uses the homedir XDG default when nothing is set", () => {
		expect(resolveMissionControlDatabasePath()).toBe(expectedXdgDefault());
	});

	it("falls through an empty GCTRL_MC_DB_PATH to the next precedence level", () => {
		process.env.GCTRL_MC_DB_PATH = "   ";
		process.env.MCTRL_DATA_DIR = "/data";
		expect(resolveMissionControlDatabasePath()).toBe("/data/memory.db");
	});

	it("respects GCTRL_MC_DB_PATH over MCTRL_DATA_DIR and XDG_DATA_HOME (full precedence stack)", () => {
		process.env.GCTRL_MC_DB_PATH = "/override/memory.db";
		process.env.MCTRL_DATA_DIR = "/data";
		process.env.XDG_DATA_HOME = "/xdg";
		expect(resolveMissionControlDatabasePath()).toBe("/override/memory.db");
	});
});

describe("createMcSqliteFixture", () => {
	it("creates all required tables with MC schema column names and seeds the provided rows", () => {
		const session: McSessionRow = {
			session_id: "sess-1",
			root_session_id: "sess-1",
			parent_session_id: null,
			status: "running",
			awaiting_reason: null,
			primary_wait_id: null,
			workspace_path: "/home/user/project",
			provider_id: "anthropic",
			model_id: "claude-sonnet-4",
			title: "Fix the bug",
			total_input_tokens: 100,
			total_output_tokens: 50,
			last_event_seq: 3,
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-01T00:00:05Z",
			last_activity_at: "2025-01-01T00:00:05Z",
			metadata_json: '{"foo":"bar"}',
		};
		const event: McSessionEventRow = {
			session_id: "sess-1",
			seq: 1,
			event_id: "evt-1",
			type: "session.started",
			timestamp: "2025-01-01T00:00:00Z",
			payload_json: '{"type":"session.started"}',
		};
		const message: McSessionMessageRow = {
			message_id: "msg-1",
			session_id: "sess-1",
			seq: 1,
			role: "user",
			created_at: "2025-01-01T00:00:01Z",
		};
		const awaitRow: McSessionAwaitRow = {
			wait_id: "wait-1",
			session_id: "sess-1",
			reason: "approval",
			source_kind: "tool",
			source_id: "approval-1",
			status: "pending",
			created_at: "2025-01-01T00:00:02Z",
		};
		const relation: McSessionRelationRow = {
			relation_id: "rel-1",
			parent_session_id: "sess-1",
			child_session_id: "sess-2",
			kind: "subagent",
			created_at: "2025-01-01T00:00:03Z",
		};

		const fixture = createMcSqliteFixture({
			sessions: [session],
			events: [event],
			messages: [message],
			awaits: [awaitRow],
			relations: [relation],
		});

		const reader = new DatabaseSync(fixture.dbPath, { readOnly: true });

		const sessionRow = reader
			.prepare(
				"SELECT session_id, status, workspace_path, provider_id, model_id, title, total_input_tokens, metadata_json FROM sessions WHERE session_id = ?",
			)
			.get("sess-1") as Record<string, unknown>;
		expect(sessionRow).toMatchObject({
			session_id: "sess-1",
			status: "running",
			workspace_path: "/home/user/project",
			provider_id: "anthropic",
			model_id: "claude-sonnet-4",
			title: "Fix the bug",
			total_input_tokens: 100,
			metadata_json: '{"foo":"bar"}',
		});

		expect(
			(
				reader.prepare("SELECT COUNT(*) AS n FROM session_events").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		expect(
			(
				reader.prepare("SELECT COUNT(*) AS n FROM session_messages").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		expect(
			(
				reader.prepare("SELECT COUNT(*) AS n FROM session_awaits").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		expect(
			(
				reader.prepare("SELECT COUNT(*) AS n FROM session_relations").get() as {
					n: number;
				}
			).n,
		).toBe(1);

		const tableNames = reader
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		expect(tableNames.map((row) => row.name)).toEqual(
			expect.arrayContaining([
				"sessions",
				"session_events",
				"session_messages",
				"session_awaits",
				"session_relations",
			]),
		);

		reader.close();
	});

	it("omits session_relations when includeRelations is false", () => {
		const fixture = createMcSqliteFixture({ includeRelations: false });
		const reader = new DatabaseSync(fixture.dbPath, { readOnly: true });
		const tableNames = reader
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_relations'",
			)
			.all() as Array<{ name: string }>;
		expect(tableNames).toEqual([]);
		reader.close();
	});

	it("honors a custom dbName", () => {
		const fixture = createMcSqliteFixture({ dbName: "custom.db" });
		expect(fixture.dbPath.endsWith("custom.db")).toBe(true);
	});
});
