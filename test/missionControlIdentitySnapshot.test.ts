import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	missionControlIdentityFromCanonicalDatabasePath,
	resolveMissionControlDatabaseIdentity,
} from "../src/db/missionControlSqlite";
import { getMissionControlSnapshotFromSqlite } from "../src/db/missionControlSqliteSnapshot";
import {
	cleanupMcSqliteFixtures,
	createMcSqliteFixture,
} from "./mcSqliteFixture";

const TASK_3_IDENTITY_VECTORS = [
	{
		platform: "linux" as const,
		input: "/home/alice/.local/share/mission-control/memory.db",
		databasePath: "/home/alice/.local/share/mission-control/memory.db",
		fileUrl: "file:///home/alice/.local/share/mission-control/memory.db",
		dbIdentity:
			"8df978b1b91de5716a7aa2b1421579d3ad84cb4b8fef3002a21c340e44094f3b",
	},
	{
		platform: "win32" as const,
		input: "c:\\Users\\Alice\\AppData\\Roaming\\mission-control\\memory.db",
		databasePath:
			"C:\\Users\\Alice\\AppData\\Roaming\\mission-control\\memory.db",
		fileUrl: "file:///C:/Users/Alice/AppData/Roaming/mission-control/memory.db",
		dbIdentity:
			"488afdd858d13406509f2689433ec2304dd6d8b25cda0a0c05a6364eec481bee",
	},
	{
		platform: "win32" as const,
		input: "\\\\SERVER\\Team Share\\mission-control\\memory.db",
		databasePath: "\\\\SERVER\\Team Share\\mission-control\\memory.db",
		fileUrl: "file://server/Team%20Share/mission-control/memory.db",
		dbIdentity:
			"5d85abad1b8a4618d5e8ec55d636f9106cba3e8e4ddef0b89c41d22822b5fca0",
	},
] as const;

describe("Mission Control canonical database identity", () => {
	afterEach(cleanupMcSqliteFixtures);

	it("matches all Task 3 golden vectors", () => {
		for (const vector of TASK_3_IDENTITY_VECTORS) {
			expect(
				missionControlIdentityFromCanonicalDatabasePath(
					vector.input,
					vector.platform,
				),
			).toEqual({
				databasePath: vector.databasePath,
				databaseFileUrl: vector.fileUrl,
				dbIdentity: vector.dbIdentity,
			});
		}
	});

	it("loads a sessions-only older database and fails lease safety closed", () => {
		const fixture = createMcSqliteFixture();
		const minimalPath = join(fixture.dir, "minimal.db");
		const database = new DatabaseSync(minimalPath);
		database.exec(`
			CREATE TABLE sessions (
				session_id TEXT PRIMARY KEY,
				status TEXT,
				parent_session_id TEXT,
				created_at TEXT
			)
		`);
		database
			.prepare(
				"INSERT INTO sessions (session_id, status, parent_session_id, created_at) VALUES (?, ?, ?, ?)",
			)
			.run("minimal", "idle", null, "2026-07-11T00:00:00.000Z");
		database.close();

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: minimalPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sessions[0].id).toBe("minimal");
		expect(
			result.value.sessions[0].sourceMetadata?.missionControl,
		).toMatchObject({
			rawLifecycleStatus: "idle",
			abortable: false,
			lease: { state: "unknown", fallbackSafety: "no_delete" },
		});
		expect(
			resolveMissionControlDatabaseIdentity(minimalPath).databasePath,
		).toBe(minimalPath);
	});

	it("loads without throwing when an older relations table lacks current columns", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "older-relations",
					status: "idle",
					created_at: "2026-07-11T00:00:00.000Z",
				},
			],
		});
		const writer = new DatabaseSync(fixture.dbPath);
		writer.exec("DROP TABLE session_relations");
		writer.exec(
			"CREATE TABLE session_relations (relation_id TEXT PRIMARY KEY)",
		);
		writer.close();

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sessions.map((session) => session.id)).toEqual([
			"older-relations",
		]);
	});
});
