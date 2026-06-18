import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	invalidateCodexSessionCaches,
	resolveCodexStateDatabasePath,
} from "../src/db/codex";

let tmpDir: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "gctrl-codex-state-test-"));
});

beforeEach(() => {
	for (const entry of readdirSync(tmpDir)) {
		if (entry.startsWith("state_") && entry.endsWith(".sqlite")) {
			unlinkSync(join(tmpDir, entry));
		}
	}
});

afterEach(() => {
	invalidateCodexSessionCaches();
	delete process.env.GCTRL_CODEX_STATE_DB_PATH;
});

describe("resolveCodexStateDatabasePath", () => {
	it("returns the newest state db by mtime", () => {
		const oldPath = join(tmpDir, "state_1.sqlite");
		const newPath = join(tmpDir, "state_2.sqlite");
		writeFileSync(oldPath, "");
		writeFileSync(newPath, "");

		utimesSync(newPath, new Date(), new Date(Date.now() + 10_000));

		const result = resolveCodexStateDatabasePath(tmpDir);
		expect(result).toBe(newPath);
	});

	it("returns same path on second call within TTL (cache hit)", () => {
		const path = join(tmpDir, "state_cache.sqlite");
		writeFileSync(path, "");

		const first = resolveCodexStateDatabasePath(tmpDir);
		const second = resolveCodexStateDatabasePath(tmpDir);
		expect(second).toBe(first);

		const newerPath = join(tmpDir, "state_newer.sqlite");
		writeFileSync(newerPath, "");
		utimesSync(newerPath, new Date(), new Date(Date.now() + 20_000));

		const cached = resolveCodexStateDatabasePath(tmpDir);
		expect(cached).toBe(first);
	});

	it("invalidateCodexSessionCaches resets the cache", () => {
		const oldPath = join(tmpDir, "state_inv_old.sqlite");
		writeFileSync(oldPath, "");

		const first = resolveCodexStateDatabasePath(tmpDir);
		expect(first).toBe(oldPath);

		invalidateCodexSessionCaches();

		const newPath = join(tmpDir, "state_inv_new.sqlite");
		writeFileSync(newPath, "");
		utimesSync(newPath, new Date(), new Date(Date.now() + 10_000));

		const after = resolveCodexStateDatabasePath(tmpDir);
		expect(after).toBe(newPath);
	});

	it("falls back to state_5.sqlite when no candidates exist", () => {
		const result = resolveCodexStateDatabasePath(tmpDir);
		expect(result).toBe(join(tmpDir, "state_5.sqlite"));
	});

	it("GCTRL_CODEX_STATE_DB_PATH override bypasses cache", () => {
		const overridePath = join(tmpDir, "override.sqlite");
		process.env.GCTRL_CODEX_STATE_DB_PATH = overridePath;

		const realPath = join(tmpDir, "state_real.sqlite");
		writeFileSync(realPath, "");

		const result = resolveCodexStateDatabasePath(tmpDir);
		expect(result).toBe(overridePath);
	});

	it("override bypasses cache even after a cache was populated", () => {
		const realPath = join(tmpDir, "state_override_real.sqlite");
		writeFileSync(realPath, "");

		const before = resolveCodexStateDatabasePath(tmpDir);
		expect(before).toBe(realPath);

		const overridePath = join(tmpDir, "override_after_cache.sqlite");
		process.env.GCTRL_CODEX_STATE_DB_PATH = overridePath;

		const after = resolveCodexStateDatabasePath(tmpDir);
		expect(after).toBe(overridePath);
	});
});
