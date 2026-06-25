import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionSnapshot, type SessionSnapshot } from "../src/lib/sessionSnapshot";
import {
	ACTIVE_SESSION_QUERY,
	closeReadOnlyDatabase,
	getProjectLabel,
	__invalidateCachedDatabaseForTesting,
	openReadOnlyDatabase,
	readLatestMessagesAndCountsFromDatabase,
	readWaitingSignalsFromDatabase,
	withDatabaseRetry,
} from "../src/db";
import { getWaitingSignalCandidateIds } from "../src/db/waitingSignalCandidates";
import type { SessionRecord } from "../src/types";

// `getOpenCodeSnapshot()` reads through `DB_PATH`, a module-load-time const
// resolved once from GCTRL_DB_PATH. In the full `bun test` run another file
// imports src/db first and locks DB_PATH to the default, so the production
// entry point cannot be redirected from here. Instead we exercise the exact
// same composition (withDatabaseRetry -> ACTIVE_SESSION_QUERY -> combined
// latest+count query -> waiting signals -> buildSessionSnapshot) through an
// explicit temp path on the real cached handle. This is the integration T1 +
// T2 wired together; handle identity is also covered by
// dbConnectionLifecycle.test.ts.
let tempDir: string;
let tempDbPath: string;

interface ActiveSessionRow {
	id: string;
	project_id: string;
	title: string;
	directory: string;
	project_name: string | null;
	project_worktree: string | null;
	parent_id: string | null;
	time_created: number;
	time_updated: number;
}

const seedFixture = (path: string): void => {
	const writer = new DatabaseSync(path);
	writer.exec(`
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			project_id TEXT,
			title TEXT,
			directory TEXT,
			parent_id TEXT,
			time_created INTEGER,
			time_updated INTEGER,
			time_archived INTEGER
		)
	`);
	writer.exec(`
		CREATE TABLE project (
			id TEXT PRIMARY KEY,
			name TEXT,
			worktree TEXT
		)
	`);
	writer.exec(`
		CREATE TABLE message (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			data TEXT,
			time_created INTEGER NOT NULL
		)
	`);
	writer.exec(`
		CREATE TABLE part (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			data TEXT NOT NULL,
			time_created INTEGER NOT NULL
		)
	`);
	writer.prepare(
		"INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)",
	).run("proj-1", "ground-control", "/home/noiz/projects/ground-control");
	writer.prepare(
		`INSERT INTO session
			(id, project_id, title, directory, parent_id, time_created, time_updated, time_archived)
		 VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`,
	).run(
		"sess-1",
		"proj-1",
		"Test session",
		"/home/noiz/projects/ground-control",
		1000,
		2000,
	);
	writer.prepare(
		"INSERT INTO message (session_id, data, time_created) VALUES (?, ?, ?)",
	).run(
		"sess-1",
		JSON.stringify({ role: "assistant", time: { created: 1000 } }),
		1000,
	);
	writer.prepare(
		"INSERT INTO message (session_id, data, time_created) VALUES (?, ?, ?)",
	).run(
		"sess-1",
		JSON.stringify({
			role: "assistant",
			time: { created: 2000 },
			finish: "stop",
		}),
		2000,
	);
	writer.close();
};

// Mirror of the private readActiveSessionsFromDatabase in opencode.ts, rebuilt
// from exported primitives so the test exercises the real query + label logic.
const readActiveSessions = (database: DatabaseSync): SessionRecord[] => {
	const rows = database
		.prepare(ACTIVE_SESSION_QUERY)
		.all() as unknown as ActiveSessionRow[];
	return rows.map((session) => ({
		...session,
		project_label: getProjectLabel(session),
	}));
};

// Reproduces getOpenCodeSnapshot's body against an explicit cached path so the
// fixture DB is reachable regardless of when src/db was first imported.
const buildSnapshotViaCachedHandle = (
	path: string,
): { ok: true; value: SessionSnapshot } | { ok: false; error: unknown } =>
	withDatabaseRetry((database) => {
		const rawSessions = readActiveSessions(database);
		const sessionIds = rawSessions.map((session) => session.id);
		const { latestMessages, messageCounts } =
			readLatestMessagesAndCountsFromDatabase(database, sessionIds);
		const waitingSignalCandidateIds = getWaitingSignalCandidateIds(
			sessionIds,
			latestMessages,
		);
		const waitingSignals = readWaitingSignalsFromDatabase(
			database,
			waitingSignalCandidateIds,
		);
		return buildSessionSnapshot({
			rawSessions,
			latestMessages,
			messageCounts,
			waitingSignals,
		});
	}, path);

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "gctrl-snapshot-"));
	tempDbPath = join(tempDir, "snapshot.db");
	seedFixture(tempDbPath);
	__invalidateCachedDatabaseForTesting();
});

afterEach(() => {
	closeReadOnlyDatabase();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("getOpenCodeSnapshot composition (cached handle + T1 combined query)", () => {
	it("returns ok:true with a populated snapshot structure", () => {
		const result = buildSnapshotViaCachedHandle(tempDbPath);

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		const snapshot = result.value;
		expect(Array.isArray(snapshot.sessions)).toBe(true);
		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]?.id).toBe("sess-1");
		expect(snapshot.sessions[0]?.sessionSource).toBe("opencode");
		expect(snapshot.sessions[0]?.subagentSessions).toEqual([]);
		expect(snapshot.sessions[0]?.parent_id).toBeNull();

		expect(snapshot.statusBySessionId["sess-1"]).toBeDefined();
		expect(snapshot.messageCountBySessionId["sess-1"]).toBe(2);
		expect(snapshot.sessionIssues).toEqual({});
		expect(snapshot.sourceIssues).toEqual([]);
	});

	it("reuses the same cached DB handle across consecutive snapshot builds", () => {
		const firstHandle = openReadOnlyDatabase(tempDbPath);
		expect(firstHandle.ok).toBe(true);

		const firstSnapshot = buildSnapshotViaCachedHandle(tempDbPath);
		const secondSnapshot = buildSnapshotViaCachedHandle(tempDbPath);

		const secondHandle = openReadOnlyDatabase(tempDbPath);

		expect(firstSnapshot.ok).toBe(true);
		expect(secondSnapshot.ok).toBe(true);
		expect(secondHandle.ok).toBe(true);

		if (firstHandle.ok && secondHandle.ok) {
			// withDatabaseRetry routes through openReadOnlyDatabase ->
			// getCachedReadOnlyDatabase, so both snapshot builds must observe
			// the same cached handle as the surrounding direct calls.
			expect(secondHandle.value).toBe(firstHandle.value);
		}

		if (firstSnapshot.ok && secondSnapshot.ok) {
			// Stable results across consecutive refreshes.
			expect(secondSnapshot.value.sessions).toEqual(
				firstSnapshot.value.sessions,
			);
			expect(secondSnapshot.value.statusBySessionId).toEqual(
				firstSnapshot.value.statusBySessionId,
			);
			expect(secondSnapshot.value.messageCountBySessionId).toEqual(
				firstSnapshot.value.messageCountBySessionId,
			);
		}
	});
});
