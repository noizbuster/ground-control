import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteCodexSession } from "../src/db/codex";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-codex-delete-"));
	tempRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const createStateDatabase = (path: string): DatabaseSync => {
	const database = new DatabaseSync(path);
	database.exec(`
		CREATE TABLE threads (
			id TEXT PRIMARY KEY,
			rollout_path TEXT NOT NULL,
			archived INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE thread_dynamic_tools (
			thread_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			input_schema TEXT NOT NULL,
			defer_loading INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(thread_id, position)
		);
		CREATE TABLE stage1_outputs (
			thread_id TEXT PRIMARY KEY,
			source_updated_at INTEGER NOT NULL,
			raw_memory TEXT NOT NULL,
			rollout_summary TEXT NOT NULL,
			generated_at INTEGER NOT NULL
		);
		CREATE TABLE thread_spawn_edges (
			parent_thread_id TEXT NOT NULL,
			child_thread_id TEXT NOT NULL PRIMARY KEY,
			status TEXT NOT NULL
		);
	`);
	return database;
};

describe("deleteCodexSession", () => {
	it("removes codex thread trees, rollout files, and session index entries", async () => {
		const root = createTempRoot();
		const sessionsDirectory = join(root, "sessions", "2026", "04", "22");
		const archivedSessionsDirectory = join(root, "archived_sessions");
		mkdirSync(sessionsDirectory, { recursive: true });
		mkdirSync(archivedSessionsDirectory, { recursive: true });

		const rootThreadId = "019db480-ba94-76f3-b70f-cc439246bf99";
		const childThreadId = "019db480-ba94-76f3-b70f-cc439246bf98";
		const otherThreadId = "019db480-ba94-76f3-b70f-cc439246bf97";
		const rootRolloutPath = join(
			sessionsDirectory,
			`rollout-2026-04-22T09-00-00-${rootThreadId}.jsonl`,
		);
		const childRolloutPath = join(
			archivedSessionsDirectory,
			`rollout-2026-04-22T09-01-00-${childThreadId}.jsonl`,
		);
		const otherRolloutPath = join(
			sessionsDirectory,
			`rollout-2026-04-22T09-02-00-${otherThreadId}.jsonl`,
		);
		writeFileSync(rootRolloutPath, "{\"type\":\"session_meta\"}\n");
		writeFileSync(childRolloutPath, "{\"type\":\"session_meta\"}\n");
		writeFileSync(otherRolloutPath, "{\"type\":\"session_meta\"}\n");

		const sessionIndexPath = join(root, "session_index.jsonl");
		writeFileSync(
			sessionIndexPath,
			[
				JSON.stringify({ id: rootThreadId, thread_name: "Root" }),
				JSON.stringify({ id: childThreadId, thread_name: "Child" }),
				JSON.stringify({ id: otherThreadId, thread_name: "Other" }),
			].join("\n") + "\n",
		);

		const databasePath = join(root, "state_5.sqlite");
		const database = createStateDatabase(databasePath);
		database
			.prepare(
				"INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)",
			)
			.run(rootThreadId, rootRolloutPath, 0);
		database
			.prepare(
				"INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)",
			)
			.run(childThreadId, childRolloutPath, 1);
		database
			.prepare(
				"INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)",
			)
			.run(otherThreadId, otherRolloutPath, 0);
		database
			.prepare(
				"INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
			)
			.run(rootThreadId, childThreadId, "closed");
		database
			.prepare(
				"INSERT INTO thread_dynamic_tools (thread_id, position, name, description, input_schema) VALUES (?, ?, ?, ?, ?)",
			)
			.run(rootThreadId, 0, "tool", "desc", "{}");
		database
			.prepare(
				"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(childThreadId, 1, "memory", "summary", 1);
		database.close();

		const result = await deleteCodexSession(rootThreadId, {
			databasePath,
			sessionsDirectory: join(root, "sessions"),
			archivedSessionsDirectory,
			sessionIndexPath,
			skipArchiveRequest: true,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.deletedThreadIds.sort()).toEqual(
			[rootThreadId, childThreadId].sort(),
		);
		expect(result.value.deletedRolloutPaths.sort()).toEqual(
			[rootRolloutPath, childRolloutPath].sort(),
		);
		expect(result.value.deletedSessionIndexEntries).toBe(2);
		expect(existsSync(rootRolloutPath)).toBe(false);
		expect(existsSync(childRolloutPath)).toBe(false);
		expect(existsSync(otherRolloutPath)).toBe(true);

		const verificationDatabase = new DatabaseSync(databasePath, {
			readOnly: true,
		});
		expect(
			verificationDatabase
				.prepare("SELECT id FROM threads ORDER BY id")
				.all() as Array<{ id: string }>,
		).toEqual([{ id: otherThreadId }]);
		expect(
			verificationDatabase
				.prepare("SELECT COUNT(*) AS count FROM thread_spawn_edges")
				.get() as { count: number } | undefined,
		).toEqual({ count: 0 });
		verificationDatabase.close();

		const sessionIndexContent = readFileSync(sessionIndexPath, "utf8");
		expect(sessionIndexContent).not.toContain(rootThreadId);
		expect(sessionIndexContent).not.toContain(childThreadId);
		expect(sessionIndexContent).toContain(otherThreadId);
	});
});
