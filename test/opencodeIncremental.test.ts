import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { computeOpenCodeSnapshot } from "../src/db/opencode";
import type { MessageData } from "../src/types";

let database: DatabaseSync;

const RUNNING_MESSAGE: MessageData = {
	role: "assistant",
	time: { created: 1000 },
};

const json = (value: unknown): string => JSON.stringify(value);

const seedSession = (
	id: string,
	timeUpdated: number,
	timeArchived: number | null = null,
): void => {
	database
		.prepare(
			`INSERT INTO session
			 (id, project_id, title, directory, parent_id, time_created, time_updated, time_archived)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
		)
		.run(id, "proj-1", `Session ${id}`, "/tmp/test", timeUpdated, timeUpdated, timeArchived);
};

const insertMessage = (
	sessionId: string,
	message: MessageData,
	timeCreated: number,
): void => {
	database
		.prepare(
			"INSERT INTO message (session_id, data, time_created) VALUES (?, ?, ?)",
		)
		.run(sessionId, json(message), timeCreated);
};

const insertPart = (
	sessionId: string,
	part: Record<string, unknown>,
	timeCreated: number,
): void => {
	database
		.prepare(
			"INSERT INTO part (session_id, data, time_created) VALUES (?, ?, ?)",
		)
		.run(sessionId, json(part), timeCreated);
};

beforeEach(() => {
	database = new DatabaseSync(":memory:");
	database.exec(`
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
	database.exec(`
		CREATE TABLE project (
			id TEXT PRIMARY KEY,
			name TEXT,
			worktree TEXT
		)
	`);
	database.exec(`
		CREATE TABLE message (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			data TEXT,
			time_created INTEGER NOT NULL
		)
	`);
	database.exec(`
		CREATE TABLE part (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			data TEXT NOT NULL,
			time_created INTEGER NOT NULL
		)
	`);
	database
		.prepare("INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)")
		.run("proj-1", "test-project", "/tmp/test");
});

describe("computeOpenCodeSnapshot — incremental skip", () => {
	it("returns changed:false when nothing moved and no non-terminal sessions to poll", () => {
		seedSession("sess-1", 2000);
		insertMessage("sess-1", RUNNING_MESSAGE, 1000);

		const full = computeOpenCodeSnapshot(database);
		expect(full.changed).toBe(true);
		expect(full.maxUpdatedAt).toBe(2000);

		const result = computeOpenCodeSnapshot(database, {
			since: full.maxUpdatedAt,
		});
		expect(result.changed).toBe(false);
		expect(result.rawSessions).toEqual([]);
		expect(result.waitingSignals).toEqual({});
	});
});

describe("computeOpenCodeSnapshot — non-terminal refresh catches part-only changes", () => {
	it("picks up a question-tool part added without bumping session.time_updated", () => {
		seedSession("sess-1", 2000);
		insertMessage("sess-1", RUNNING_MESSAGE, 1000);

		const full = computeOpenCodeSnapshot(database);
		const since = full.maxUpdatedAt;

		const beforePart = computeOpenCodeSnapshot(database, {
			since,
			nonTerminalSessionIds: ["sess-1"],
		});
		expect(beforePart.changed).toBe(true);
		expect(beforePart.waitingSignals["sess-1"]).toBeUndefined();

		insertPart(
			"sess-1",
			{ type: "tool", tool: "question", state: { status: "running" } },
			1500,
		);

		const afterPart = computeOpenCodeSnapshot(database, {
			since,
			nonTerminalSessionIds: ["sess-1"],
		});
		expect(afterPart.changed).toBe(true);
		expect(afterPart.waitingSignals["sess-1"]).toEqual({
			latestQuestionToolTime: 1500,
			questionToolRunning: true,
		});
	});

	it("reflects question-tool completion on the next poll", () => {
		seedSession("sess-1", 2000);
		insertMessage("sess-1", RUNNING_MESSAGE, 1000);
		insertPart(
			"sess-1",
			{ type: "tool", tool: "question", state: { status: "running" } },
			1500,
		);

		const full = computeOpenCodeSnapshot(database);
		const since = full.maxUpdatedAt;

		const whileRunning = computeOpenCodeSnapshot(database, {
			since,
			nonTerminalSessionIds: ["sess-1"],
		});
		expect(whileRunning.waitingSignals["sess-1"]?.questionToolRunning).toBe(
			true,
		);

		database
			.prepare("UPDATE part SET data = ? WHERE session_id = ?")
			.run(
				json({
					type: "tool",
					tool: "question",
					state: { status: "completed" },
				}),
				"sess-1",
			);

		const afterComplete = computeOpenCodeSnapshot(database, {
			since,
			nonTerminalSessionIds: ["sess-1"],
		});
		expect(
			afterComplete.waitingSignals["sess-1"]?.questionToolRunning,
		).toBe(false);
	});
});

describe("computeOpenCodeSnapshot — union of changed and non-terminal", () => {
	it("includes probe-changed sessions alongside polled non-terminal sessions", () => {
		seedSession("sess-running", 2000);
		insertMessage("sess-running", RUNNING_MESSAGE, 1000);

		seedSession("sess-completed", 1000);
		insertMessage(
			"sess-completed",
			{ role: "assistant", time: { created: 900, completed: 950 }, finish: "stop" },
			900,
		);

		const full = computeOpenCodeSnapshot(database);
		const since = full.maxUpdatedAt;

		insertPart(
			"sess-running",
			{ type: "tool", tool: "question", state: { status: "running" } },
			3000,
		);
		insertMessage(
			"sess-completed",
			{ role: "assistant", time: { created: 4000, completed: 4100 }, finish: "stop" },
			4000,
		);
		database
			.prepare("UPDATE session SET time_updated = ? WHERE id = ?")
			.run(4000, "sess-completed");

		const result = computeOpenCodeSnapshot(database, {
			since,
			nonTerminalSessionIds: ["sess-running"],
		});

		expect(result.changed).toBe(true);
		expect(result.waitingSignals["sess-running"]).toEqual({
			latestQuestionToolTime: 3000,
			questionToolRunning: true,
		});

		const completedMessage = result.latestMessages["sess-completed"]?.message;
		expect(completedMessage?.ok).toBe(true);
		if (completedMessage?.ok) {
			expect(completedMessage.value).toEqual({
				role: "assistant",
				time: { created: 4000, completed: 4100 },
				finish: "stop",
			});
		}
	});
});
