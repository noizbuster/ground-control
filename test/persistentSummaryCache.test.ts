import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getCodexSnapshot,
	invalidateCodexSessionCaches,
} from "../src/db/codex";
import { getPiOmpSnapshots, invalidatePiSessionCaches } from "../src/db/pi";
import {
	closeSessionSummaryCache,
	resetSessionSummaryCacheForTesting,
	SessionSummaryCache,
} from "../src/db/sessionSummaryCache";

const tempRoots: string[] = [];
const originalEnvironment = {
	cachePath: process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH,
	codexStatePath: process.env.GCTRL_CODEX_STATE_DB_PATH,
	codexSessionsDirectory: process.env.GCTRL_CODEX_SESSIONS_DIR,
};

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-persistent-cache-"));
	tempRoots.push(root);
	return root;
};

const restoreEnvironmentValue = (
	key:
		| "GCTRL_SESSION_SUMMARY_CACHE_PATH"
		| "GCTRL_CODEX_STATE_DB_PATH"
		| "GCTRL_CODEX_SESSIONS_DIR",
	value: string | undefined,
): void => {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
};

beforeEach(() => {
	invalidatePiSessionCaches();
	invalidateCodexSessionCaches();
	resetSessionSummaryCacheForTesting();
});

afterEach(() => {
	closeSessionSummaryCache();
	invalidatePiSessionCaches();
	invalidateCodexSessionCaches();
	restoreEnvironmentValue(
		"GCTRL_SESSION_SUMMARY_CACHE_PATH",
		originalEnvironment.cachePath,
	);
	restoreEnvironmentValue(
		"GCTRL_CODEX_STATE_DB_PATH",
		originalEnvironment.codexStatePath,
	);
	restoreEnvironmentValue(
		"GCTRL_CODEX_SESSIONS_DIR",
		originalEnvironment.codexSessionsDirectory,
	);
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("persistent source summaries", () => {
	it("reuses Pi and omp summaries after every in-memory cache is reset", () => {
		const root = createTempRoot();
		const sessionsDirectory = join(root, "sessions");
		mkdirSync(sessionsDirectory);
		process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH = join(root, "cache.sqlite");
		writeFileSync(
			join(sessionsDirectory, "session.jsonl"),
			[
				'{"type":"session","id":"pi-session","timestamp":"2026-08-15T00:00:00Z","cwd":"/repo"}',
				'{"type":"message","id":"1","role":"user","content":"one"}',
				'{"type":"message","id":"2","parentId":"1","role":"assistant","content":"two"}',
				'{"type":"message","id":"3","parentId":"2","role":"user","content":"three"}',
				'{"type":"message","id":"4","parentId":"3","role":"assistant","content":"four"}',
			].join("\n"),
		);

		const first = getPiOmpSnapshots({
			nowMs: 0,
			pi: { sessionRoots: [sessionsDirectory] },
			omp: { sessionRoots: [sessionsDirectory] },
		});
		closeSessionSummaryCache();
		invalidatePiSessionCaches();
		resetSessionSummaryCacheForTesting();

		const parseSpy = vi.spyOn(JSON, "parse");
		const second = getPiOmpSnapshots({
			nowMs: 0,
			pi: { sessionRoots: [sessionsDirectory] },
			omp: { sessionRoots: [sessionsDirectory] },
		});
		const parseCalls = parseSpy.mock.calls.length;
		parseSpy.mockRestore();

		expect(second).toEqual(first);
		expect(parseCalls).toBeLessThanOrEqual(2);
	});

	it("rejects Pi cache hits when the source disappears during refresh", () => {
		const root = createTempRoot();
		const sessionsDirectory = join(root, "sessions");
		const sessionPath = join(sessionsDirectory, "session.jsonl");
		mkdirSync(sessionsDirectory);
		process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH = join(root, "cache.sqlite");
		writeFileSync(
			sessionPath,
			[
				'{"type":"session","id":"pi-race","timestamp":"2026-08-15T00:00:00Z","cwd":"/repo"}',
				'{"type":"message","role":"user","content":"one"}',
			].join("\n"),
		);
		getPiOmpSnapshots({
			nowMs: 0,
			pi: { sessionRoots: [sessionsDirectory] },
			omp: { sessionRoots: [sessionsDirectory] },
		});
		closeSessionSummaryCache();
		invalidatePiSessionCaches();
		resetSessionSummaryCacheForTesting();

		const originalRead = SessionSummaryCache.prototype.read;
		const readSpy = vi
			.spyOn(SessionSummaryCache.prototype, "read")
			.mockImplementationOnce(function (...args) {
				const result = originalRead.call(this, ...args);
				unlinkSync(sessionPath);
				return result;
			});
		const refreshed = getPiOmpSnapshots({
			nowMs: 0,
			pi: { sessionRoots: [sessionsDirectory] },
			omp: { sessionRoots: [sessionsDirectory] },
		});
		readSpy.mockRestore();

		expect(refreshed.pi.ok && refreshed.pi.value.sessions).toHaveLength(0);
		expect(refreshed.omp.ok && refreshed.omp.value.sessions).toHaveLength(0);
	});

	it("reuses Codex summaries after its process-local caches are reset", () => {
		const root = createTempRoot();
		const sessionsDirectory = join(root, "sessions", "2026", "08", "15");
		mkdirSync(sessionsDirectory, { recursive: true });
		const statePath = join(root, "state.sqlite");
		const cachePath = join(root, "cache.sqlite");
		const threadId = "019db480-ba94-76f3-b70f-cc439246bf99";
		process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH = cachePath;
		process.env.GCTRL_CODEX_STATE_DB_PATH = statePath;
		process.env.GCTRL_CODEX_SESSIONS_DIR = join(root, "sessions");

		const database = new DatabaseSync(statePath);
		database.exec(`
			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				source TEXT,
				model_provider TEXT,
				cwd TEXT,
				title TEXT,
				agent_role TEXT,
				agent_nickname TEXT,
				model TEXT,
				reasoning_effort TEXT,
				archived INTEGER,
				created_at_ms INTEGER,
				updated_at_ms INTEGER
			);
			CREATE TABLE thread_spawn_edges (
				parent_thread_id TEXT,
				child_thread_id TEXT,
				status TEXT
			);
		`);
		database
			.prepare(`
				INSERT INTO threads (
					id, source, model_provider, cwd, title, agent_role,
					agent_nickname, model, reasoning_effort, archived,
					created_at_ms, updated_at_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				threadId,
				"cli",
				"openai",
				"/repo",
				"Cached thread",
				null,
				null,
				"gpt-5.6",
				"high",
				0,
				1_700_000_000_000,
				1_700_000_010_000,
			);
		database.close();

		const logLines = [
			JSON.stringify({
				timestamp: "2026-08-15T00:00:00.000Z",
				type: "session_meta",
				payload: { id: threadId, cwd: "/repo", source: "cli" },
			}),
			JSON.stringify({
				timestamp: "2026-08-15T00:00:00.500Z",
				type: "event_msg",
				payload: { type: "task_started", turn_id: "turn-1" },
			}),
			...Array.from({ length: 12 }, (_, index) =>
				JSON.stringify({
					timestamp: `2026-08-15T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
					type: "event_msg",
					payload: { type: "user_message", message: `message-${index}` },
				}),
			),
			JSON.stringify({
				timestamp: "2026-08-15T00:00:13.000Z",
				type: "event_msg",
				payload: {
					type: "turn_aborted",
					turn_id: "turn-1",
					reason: "user_interrupt",
				},
			}),
		];
		writeFileSync(
			join(sessionsDirectory, `rollout-${threadId}.jsonl`),
			logLines.join("\n"),
		);

		const first = getCodexSnapshot();
		closeSessionSummaryCache();
		invalidateCodexSessionCaches();
		resetSessionSummaryCacheForTesting();

		const parseSpy = vi.spyOn(JSON, "parse");
		const second = getCodexSnapshot();
		const parseCalls = parseSpy.mock.calls.length;
		parseSpy.mockRestore();

		expect(second).toEqual(first);
		expect(parseCalls).toBeLessThanOrEqual(3);

		closeSessionSummaryCache();
		writeFileSync(
			join(sessionsDirectory, `rollout-${threadId}.jsonl`),
			logLines.slice(0, 2).join("\n"),
		);
		invalidateCodexSessionCaches();
		resetSessionSummaryCacheForTesting();
		const running = getCodexSnapshot();
		expect(running.ok).toBe(true);
		closeSessionSummaryCache();
		const runningCacheDatabase = new DatabaseSync(cachePath, {
			readOnly: true,
		});
		const runningCachedRows = runningCacheDatabase
			.prepare(
				"SELECT COUNT(*) AS count FROM session_summary_cache WHERE source = 'codex'",
			)
			.get() as { count: number };
		runningCacheDatabase.close();
		expect(runningCachedRows.count).toBe(0);

		const logPath = join(sessionsDirectory, `rollout-${threadId}.jsonl`);
		chmodSync(logPath, 0);
		invalidateCodexSessionCaches();
		resetSessionSummaryCacheForTesting();
		const invalid = getCodexSnapshot();
		expect(invalid.ok).toBe(true);
		chmodSync(logPath, 0o600);
		closeSessionSummaryCache();
		const invalidCacheDatabase = new DatabaseSync(cachePath, {
			readOnly: true,
		});
		const invalidCachedRows = invalidCacheDatabase
			.prepare(
				"SELECT COUNT(*) AS count FROM session_summary_cache WHERE source = 'codex'",
			)
			.get() as { count: number };
		invalidCacheDatabase.close();
		expect(invalidCachedRows.count).toBe(0);
		closeSessionSummaryCache();
		const archivedState = new DatabaseSync(statePath);
		archivedState
			.prepare("UPDATE threads SET archived = 1 WHERE id = ?")
			.run(threadId);
		archivedState.close();
		invalidateCodexSessionCaches();
		resetSessionSummaryCacheForTesting();
		const archived = getCodexSnapshot();
		expect(archived.ok && archived.value.sessions).toHaveLength(0);
		closeSessionSummaryCache();

		const cacheDatabase = new DatabaseSync(cachePath, { readOnly: true });
		const cachedRows = cacheDatabase
			.prepare(
				"SELECT COUNT(*) AS count FROM session_summary_cache WHERE source = 'codex'",
			)
			.get() as { count: number };
		cacheDatabase.close();
		expect(cachedRows.count).toBe(0);
	});
});
