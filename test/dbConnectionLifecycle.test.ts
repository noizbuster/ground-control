import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__invalidateCachedDatabaseForTesting,
	closeReadOnlyDatabase,
	openReadOnlyDatabase,
	withDatabaseRetry,
} from "../src/db";

let tempDir: string;

// Real files (not ":memory:") because each ":memory:" handle is isolated and
// cannot be reopened by path — the cache identity tests require a path that
// resolves to the same on-disk database across handles.
const createTempDatabaseFile = (name: string): string => {
	const fullPath = join(tempDir, name);
	const writer = new Database(fullPath);
	writer.close();
	return fullPath;
};

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "gctrl-lifecycle-"));
	__invalidateCachedDatabaseForTesting();
});

afterEach(() => {
	closeReadOnlyDatabase();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("DB connection lifecycle (module-scope cache + retry)", () => {
	it("returns the same cached handle when opening the same path twice", () => {
		const path = createTempDatabaseFile("cached.db");
		const first = openReadOnlyDatabase(path);
		const second = openReadOnlyDatabase(path);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok && second.ok) {
			expect(second.value).toBe(first.value);
		}
	});

	it("discards the previous handle when the cached path changes", () => {
		const pathA = createTempDatabaseFile("a.db");
		const pathB = createTempDatabaseFile("b.db");

		const first = openReadOnlyDatabase(pathA);
		const second = openReadOnlyDatabase(pathB);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok && second.ok) {
			expect(second.value).not.toBe(first.value);
		}

		const reopenedA = openReadOnlyDatabase(pathA);
		expect(reopenedA.ok).toBe(true);
		if (first.ok && reopenedA.ok) {
			expect(reopenedA.value).not.toBe(first.value);
		}
	});

	it("recovers via withDatabaseRetry after the cached handle is invalidated", () => {
		const path = createTempDatabaseFile("recover.db");

		const warm = openReadOnlyDatabase(path);
		expect(warm.ok).toBe(true);

		__invalidateCachedDatabaseForTesting();
		const result = withDatabaseRetry(() => "recovered", path);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBe("recovered");
		}
	});

	it("does not retry when the callback throws a non-retryable error", () => {
		const path = createTempDatabaseFile("noretry.db");
		let attempts = 0;

		const result = withDatabaseRetry(() => {
			attempts++;
			throw new Error("logic bug");
		}, path);

		expect(result.ok).toBe(false);
		expect(attempts).toBe(1);
		if (!result.ok) {
			expect(result.error.code).toBe("query_failed");
		}
	});

	it("maps a missing database file to the missing_database error code", () => {
		const result = openReadOnlyDatabase(join(tempDir, "missing.db"));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("missing_database");
		}
	});

	it("preserves the missing_database mapping across the retry path", () => {
		const missingPath = join(tempDir, "still-missing.db");
		expect(existsSync(missingPath)).toBe(false);

		const result = withDatabaseRetry(() => "unreachable", missingPath);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("missing_database");
		}
	});
});
