import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidatePiSessionCaches, parsePiSessionLogFile } from "../src/db/pi";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-pi-cache-"));
	tempRoots.push(root);
	return root;
};

const VALID_JSONL = [
	'{"type":"session","id":"test-session-1","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
	'{"type":"message","role":"user","content":"hello"}',
	'{"type":"message","role":"assistant","content":"hi"}',
].join("\n");

const EXTENDED_JSONL = [
	'{"type":"session","id":"test-session-1","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
	'{"type":"message","role":"user","content":"hello"}',
	'{"type":"message","role":"assistant","content":"hi"}',
	'{"type":"message","role":"user","content":"another"}',
].join("\n");

const DIFFERENT_JSONL = [
	'{"type":"session","id":"test-session-1","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
	'{"type":"message","role":"user","content":"goodbye"}',
].join("\n");

beforeEach(() => {
	invalidatePiSessionCaches();
});

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	invalidatePiSessionCaches();
});

describe("piLogCache", () => {
	it("cache hit: second parse on unchanged file returns same object reference", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_JSONL);

		const first = parsePiSessionLogFile(path, root, "pi");
		expect(first).toBeDefined();
		if (!first) return;

		const second = parsePiSessionLogFile(path, root, "pi");
		expect(second).toBe(first);
		expect(second?.entries).toHaveLength(2);
	});

	it("mtime change forces re-parse", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_JSONL);

		const first = parsePiSessionLogFile(path, root, "pi");
		expect(first).toBeDefined();
		expect(first?.entries).toHaveLength(2);

		const second = parsePiSessionLogFile(path, root, "pi");
		expect(second).toBe(first);

		// Write extended content and bump mtime.
		writeFileSync(path, EXTENDED_JSONL);
		utimesSync(path, new Date(Date.now() / 1000), new Date(Date.now() / 1000 + 1));

		const third = parsePiSessionLogFile(path, root, "pi");
		expect(third).toBeDefined();
		expect(third).not.toBe(first);
		expect(third?.entries).toHaveLength(3);
	});

	it("size change with same mtime forces re-parse", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_JSONL);

		const first = parsePiSessionLogFile(path, root, "pi");
		expect(first).toBeDefined();
		expect(first?.entries).toHaveLength(2);

		// Write different content (different size) but preserve mtime.
		const beforeStats = statSync(path);
		writeFileSync(path, DIFFERENT_JSONL);
		utimesSync(path, beforeStats.atime, beforeStats.mtime);

		const second = parsePiSessionLogFile(path, root, "pi");
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(second?.entries).toHaveLength(1);
		expect((second?.entries[0] as { role: string }).role).toBe("user");
	});

	it("invalidatePiSessionCaches forces re-read on next call", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_JSONL);

		const first = parsePiSessionLogFile(path, root, "pi");
		expect(first).toBeDefined();
		const second = parsePiSessionLogFile(path, root, "pi");
		expect(second).toBe(first);

		// Invalidate and re-parse: should produce a new object.
		invalidatePiSessionCaches();
		const third = parsePiSessionLogFile(path, root, "pi");
		expect(third).toBeDefined();
		expect(third).not.toBe(first);
		expect(third?.header.id).toBe(first?.header.id);
		expect(third?.entries).toHaveLength(first!.entries.length);
	});

	it("pi and omp paths cache independently", () => {
		const piRoot = createTempRoot();
		const ompRoot = createTempRoot();
		const piPath = join(piRoot, "pi-session.jsonl");
		const ompPath = join(ompRoot, "omp-session.jsonl");

		writeFileSync(piPath, VALID_JSONL);
		writeFileSync(ompPath, VALID_JSONL);

		const piResult = parsePiSessionLogFile(piPath, piRoot, "pi");
		const ompResult = parsePiSessionLogFile(ompPath, ompRoot, "omp");

		expect(piResult).toBeDefined();
		expect(ompResult).toBeDefined();
		expect(piResult?.source).toBe("pi");
		expect(ompResult?.source).toBe("omp");
		expect(piResult?.path).toBe(piPath);
		expect(ompResult?.path).toBe(ompPath);

		// Re-parse: both should be cache hits (same object references).
		const piAgain = parsePiSessionLogFile(piPath, piRoot, "pi");
		const ompAgain = parsePiSessionLogFile(ompPath, ompRoot, "omp");
		expect(piAgain).toBe(piResult);
		expect(ompAgain).toBe(ompResult);

		// Invalidate only clears the pi cache entry when the whole map clears.
		// Both should get new objects after invalidation.
		invalidatePiSessionCaches();
		const piFresh = parsePiSessionLogFile(piPath, piRoot, "pi");
		const ompFresh = parsePiSessionLogFile(ompPath, ompRoot, "omp");
		expect(piFresh).not.toBe(piResult);
		expect(ompFresh).not.toBe(ompResult);
	});
});
