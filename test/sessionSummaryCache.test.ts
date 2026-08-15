import {
	existsSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeSessionSummaryCache,
	getSessionSummaryCache,
	resetSessionSummaryCacheForTesting,
	SessionSummaryCache,
	type SessionSummaryFileIdentity,
} from "../src/db/sessionSummaryCache";

const tempRoots: string[] = [];
const originalCachePath = process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH;

const createCachePath = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-summary-cache-"));
	tempRoots.push(root);
	return join(root, "cache", "session-summaries.sqlite");
};

const identity = (suffix: number): SessionSummaryFileIdentity => ({
	canonicalPath: `/sessions/${suffix}.jsonl`,
	dev: 1,
	ino: suffix,
	mtimeMs: 1_700_000_000_000 + suffix,
	size: 100 + suffix,
});

afterEach(() => {
	closeSessionSummaryCache();
	if (originalCachePath === undefined) {
		delete process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH;
	} else {
		process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH = originalCachePath;
	}
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("SessionSummaryCache", () => {
	it("round-trips compact values and invalidates changed file identities", () => {
		const cache = new SessionSummaryCache(createCachePath());
		const version = identity(1);

		expect(
			cache.writeValue("pi", "session-1", version, 1, {
				messageCount: 3,
			}),
		).toBe(true);
		expect(
			cache.read<{ messageCount: number }>("pi", "session-1", version, 1),
		).toEqual({ kind: "value", value: { messageCount: 3 } });
		expect(
			cache.read("pi", "session-1", { ...version, size: 999 }, 1),
		).toBeNull();
		expect(cache.read("pi", "session-1", version, 1)).toBeNull();
		expect(cache.writeValue("pi", "session-2", version, 1, { id: "old" })).toBe(
			true,
		);
		expect(cache.read("pi", "session-2", version, 2)).toBeNull();
		expect(cache.read("pi", "session-2", version, 1)).toBeNull();
		cache.close();
	});

	it("persists parse issues without reparsing unchanged files", () => {
		const cache = new SessionSummaryCache(createCachePath());
		const version = identity(2);

		expect(
			cache.writeIssue("omp", "session-2", version, 1, "invalid JSONL"),
		).toBe(true);
		expect(cache.read("omp", "session-2", version, 1)).toEqual({
			kind: "issue",
			issue: "invalid JSONL",
		});
		cache.close();
	});

	it("prunes stale rows by source without loading the table into memory", () => {
		const cache = new SessionSummaryCache(createCachePath());
		cache.writeValue("pi", "live", identity(3), 1, { id: "live" });
		cache.writeValue("pi", "stale", identity(4), 1, { id: "stale" });
		cache.writeValue("codex", "other", identity(5), 1, { id: "other" });

		expect(cache.pruneSource("pi", ["live"])).toBe(true);
		expect(cache.read("pi", "live", identity(3), 1)).not.toBeNull();
		expect(cache.read("pi", "stale", identity(4), 1)).toBeNull();
		expect(cache.read("codex", "other", identity(5), 1)).not.toBeNull();
		cache.close();
	});

	it("evicts old rows and compacts storage to its configured limit", () => {
		const path = createCachePath();
		const cache = new SessionSummaryCache(path);
		for (let index = 0; index < 96; index += 1) {
			cache.writeValue("codex", `thread-${index}`, identity(index + 10), 1, {
				index,
				payload: "x".repeat(16 * 1024),
			});
		}

		const maxBytes = 128 * 1024;
		expect(cache.getStorageBytes()).toBeGreaterThan(maxBytes);
		cache.close();

		const reopened = new SessionSummaryCache(path);
		reopened.maintainSize(maxBytes);
		expect(reopened.getStorageBytes()).toBeLessThanOrEqual(maxBytes);
		reopened.close();
	});

	it("compacts an oversized empty cache after reopening", () => {
		const path = createCachePath();
		const cache = new SessionSummaryCache(path);
		for (let index = 0; index < 96; index += 1) {
			cache.writeValue("pi", `session-${index}`, identity(index + 200), 1, {
				payload: "x".repeat(16 * 1024),
			});
		}
		cache.close();

		const interrupted = new DatabaseSync(path);
		interrupted.exec("DELETE FROM session_summary_cache");
		interrupted.close();
		const maxBytes = 128 * 1024;
		expect(statSync(path).size).toBeGreaterThan(maxBytes);

		const reopened = new SessionSummaryCache(path);
		reopened.maintainSize(maxBytes);
		expect(reopened.getStorageBytes()).toBeLessThanOrEqual(maxBytes);
		reopened.close();
	});

	it("replaces incompatible schemas and removes obsolete rows", () => {
		const path = createCachePath();
		const directory = join(path, "..");
		const bootstrap = new SessionSummaryCache(path);
		bootstrap.close();
		const incompatible = new DatabaseSync(path);
		incompatible.exec(`
			CREATE TABLE obsolete_cache(value TEXT);
			INSERT INTO obsolete_cache(value) VALUES ('stale');
			PRAGMA user_version = 99;
		`);
		incompatible.close();

		const cache = new SessionSummaryCache(path);
		cache.close();
		const inspected = new DatabaseSync(path, { readOnly: true });
		const tables = inspected
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>;
		inspected.close();
		expect(tables.map((row) => row.name)).toContain("session_summary_cache");
		expect(tables.map((row) => row.name)).not.toContain("obsolete_cache");
		expect(existsSync(directory)).toBe(true);
	});

	it("recovers a corrupt cache and keeps cache files private", () => {
		const path = createCachePath();
		const initialized = new SessionSummaryCache(path);
		initialized.close();
		writeFileSync(path, "not a sqlite database");
		process.env.GCTRL_SESSION_SUMMARY_CACHE_PATH = path;
		resetSessionSummaryCacheForTesting();

		const cache = getSessionSummaryCache();
		expect(cache).not.toBeNull();
		expect(
			cache?.writeValue("pi", "session", identity(100), 1, { ok: true }),
		).toBe(true);
		closeSessionSummaryCache();
		if (process.platform !== "win32") {
			expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		for (const suffix of ["-journal", "-shm", "-wal"]) {
			expect(existsSync(`${path}${suffix}`)).toBe(false);
		}
	});
});
