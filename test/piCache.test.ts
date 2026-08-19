import {
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseResult } from "../src/db";
import {
	getPiFamilySnapshots,
	getPiRawParseCacheKeysForTesting,
	getPiRawParseCacheStateForTesting,
	invalidatePiSessionCaches,
	parsePiSessionLogFile,
} from "../src/db/pi";
import type { SessionSnapshot } from "../src/lib/sessionSnapshot";

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
	VALID_JSONL,
	'{"type":"message","role":"user","content":"another"}',
].join("\n");

const GJC_V4_JSONL = [
	'{"type":"session","version":4,"id":"gjc-v4","timestamp":"2026-08-19T09:00:00Z","cwd":"/repo/old","title":"Initial title"}',
	'{"type":"header_patch","patch":{"cwd":"/repo/current","title":"Patched title"}}',
	'{"type":"message","id":"assistant","parentId":null,"timestamp":"2026-08-19T09:00:01Z","message":{"role":"assistant","content":"ready","stopReason":"end_turn"}}',
].join("\n");

const readSnapshots = (root: string, nowMs: number) =>
	getPiFamilySnapshots({
		nowMs,
		pi: { sessionRoots: [root] },
		omp: { sessionRoots: [root] },
		gjc: { sessionRoots: [root] },
	});

const getMessageCount = (
	result: DatabaseResult<SessionSnapshot>,
	sessionId: string,
): number => {
	if (!result.ok) {
		throw new Error(result.error.message);
	}
	return result.value.messageCountBySessionId[sessionId] ?? 0;
};

beforeEach(() => {
	invalidatePiSessionCaches();
});

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	invalidatePiSessionCaches();
});

describe("Pi/omp/GJC compact refresh state", () => {
	it("preserves separate source snapshots for one shared physical log", () => {
		const root = createTempRoot();
		writeFileSync(join(root, "session.jsonl"), VALID_JSONL);

		const snapshots = readSnapshots(root, 0);
		expect(snapshots.pi.ok).toBe(true);
		expect(snapshots.omp.ok).toBe(true);
		expect(snapshots.gjc.ok).toBe(true);
		if (!snapshots.pi.ok || !snapshots.omp.ok || !snapshots.gjc.ok) return;

		expect(snapshots.pi.value.sessions[0]?.sourceMetadata?.sourceCategory).toBe(
			"Pi",
		);
		expect(
			snapshots.omp.value.sessions[0]?.sourceMetadata?.sourceCategory,
		).toBe("omp");
		expect(
			snapshots.gjc.value.sessions[0]?.sourceMetadata?.sourceCategory,
		).toBe("gjc");
		expect(snapshots.pi.value.sessions[0]?.id).toBe("test-session-1");
		expect(snapshots.omp.value.sessions[0]?.id).toBe("test-session-1");
		expect(snapshots.gjc.value.sessions[0]?.id).toBe("test-session-1");
	});

	it("applies GJC v4 header patches in compact and persistent summaries", () => {
		const root = createTempRoot();
		writeFileSync(join(root, "session.jsonl"), GJC_V4_JSONL);

		const first = readSnapshots(root, 0).gjc;
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.sessions[0]?.title).toBe("Patched title");
		expect(first.value.sessions[0]?.directory).toBe("/repo/current");

		invalidatePiSessionCaches();
		const cached = readSnapshots(root, 2_000).gjc;
		expect(cached.ok).toBe(true);
		if (!cached.ok) return;
		expect(cached.value.sessions[0]?.title).toBe("Patched title");
		expect(cached.value.sessions[0]?.directory).toBe("/repo/current");
	});

	it("reparses a changed known file on the two-second cadence", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_JSONL);

		expect(getMessageCount(readSnapshots(root, 0).pi, "test-session-1")).toBe(
			2,
		);

		writeFileSync(path, EXTENDED_JSONL);
		expect(
			getMessageCount(readSnapshots(root, 2_000).pi, "test-session-1"),
		).toBe(3);
	});

	it("defers new-path discovery until the ten-second reconciliation", () => {
		const root = createTempRoot();
		writeFileSync(join(root, "first.jsonl"), VALID_JSONL);
		readSnapshots(root, 0);

		writeFileSync(
			join(root, "second.jsonl"),
			VALID_JSONL.replaceAll("test-session-1", "test-session-2"),
		);
		expect(readSnapshots(root, 2_000).pi.ok).toBe(true);
		const beforeReconciliation = readSnapshots(root, 2_000).pi;
		if (!beforeReconciliation.ok) return;
		expect(beforeReconciliation.value.sessions).toHaveLength(1);

		const reconciled = readSnapshots(root, 10_000).pi;
		if (!reconciled.ok) return;
		expect(reconciled.value.sessions).toHaveLength(2);
	});

	it("prunes a removed path during the ten-second reconciliation", () => {
		const root = createTempRoot();
		const firstPath = join(root, "first.jsonl");
		writeFileSync(firstPath, VALID_JSONL);
		writeFileSync(
			join(root, "second.jsonl"),
			VALID_JSONL.replaceAll("test-session-1", "test-session-2"),
		);
		readSnapshots(root, 0);

		unlinkSync(firstPath);
		const beforeReconciliation = readSnapshots(root, 2_000).pi;
		if (!beforeReconciliation.ok) return;
		expect(beforeReconciliation.value.sessions).toHaveLength(2);

		const reconciled = readSnapshots(root, 10_000).pi;
		if (!reconciled.ok) return;
		expect(reconciled.value.sessions).toHaveLength(1);
		expect(reconciled.value.sessions[0]?.id).toBe("test-session-2");
	});

	it("reuses a canonical raw parse across source-state reconciliation", () => {
		const root = createTempRoot();
		const alternateRoot = join(root, ".");
		writeFileSync(join(root, "session.jsonl"), VALID_JSONL);

		readSnapshots(root, 0);
		const parseSpy = vi.spyOn(JSON, "parse");
		try {
			const snapshots = readSnapshots(alternateRoot, 2_000);

			expect(parseSpy).not.toHaveBeenCalled();
			expect(snapshots.pi.ok).toBe(true);
			expect(snapshots.omp.ok).toBe(true);
			if (!snapshots.pi.ok || !snapshots.omp.ok) return;

			expect(
				snapshots.pi.value.sessions[0]?.sourceMetadata?.sourceCategory,
			).toBe("Pi");
			expect(
				snapshots.omp.value.sessions[0]?.sourceMetadata?.sourceCategory,
			).toBe("omp");
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("evicts historical raw versions for one canonical log while reusing its live version", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_JSONL);
		expect(parsePiSessionLogFile(path, root, "pi")).toBeDefined();

		writeFileSync(path, EXTENDED_JSONL);
		expect(parsePiSessionLogFile(path, root, "pi")).toBeDefined();
		expect(getPiRawParseCacheStateForTesting().sourceBytes).toBe(
			statSync(path).size,
		);

		const canonicalPrefix = `${realpathSync(path)}\0`;
		expect(
			getPiRawParseCacheKeysForTesting().filter((key) =>
				key.startsWith(canonicalPrefix),
			),
		).toHaveLength(1);

		const parseSpy = vi.spyOn(JSON, "parse");
		try {
			expect(parsePiSessionLogFile(path, root, "omp")).toBeDefined();
			expect(parseSpy).not.toHaveBeenCalled();
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("evicts raw parses by source-byte budget while reusing the live canonical version", () => {
		const root = createTempRoot();
		const firstPath = join(root, "first-large.jsonl");
		const secondPath = join(root, "second-large.jsonl");
		const { byteLimit } = getPiRawParseCacheStateForTesting();
		const padding = "x".repeat(Math.floor(byteLimit / 2));
		writeFileSync(
			firstPath,
			`{"type":"session","id":"first-large","padding":"${padding}"}\n`,
		);
		writeFileSync(
			secondPath,
			`{"type":"session","id":"second-large","padding":"${padding}"}\n`,
		);

		expect(parsePiSessionLogFile(firstPath, root, "pi")).toBeDefined();
		expect(parsePiSessionLogFile(secondPath, root, "pi")).toBeDefined();

		const cacheKeys = getPiRawParseCacheKeysForTesting();
		const cacheState = getPiRawParseCacheStateForTesting();
		expect(cacheState.sourceBytes).toBeGreaterThan(byteLimit / 2);
		expect(cacheState.sourceBytes).toBeLessThanOrEqual(byteLimit);
		expect(
			cacheKeys.some((key) => key.startsWith(`${realpathSync(firstPath)}\0`)),
		).toBe(false);
		expect(
			cacheKeys.some((key) => key.startsWith(`${realpathSync(secondPath)}\0`)),
		).toBe(true);

		const parseSpy = vi.spyOn(JSON, "parse");
		try {
			expect(parsePiSessionLogFile(secondPath, root, "omp")).toBeDefined();
			expect(parseSpy).not.toHaveBeenCalled();
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("does not retain a raw parse larger than the source-byte budget", () => {
		const root = createTempRoot();
		const path = join(root, "oversized.jsonl");
		const { byteLimit } = getPiRawParseCacheStateForTesting();
		writeFileSync(path, '{"type":"session","id":"oversized"}\n');
		truncateSync(path, byteLimit + 1);

		expect(parsePiSessionLogFile(path, root, "pi")).toBeDefined();
		expect(
			getPiRawParseCacheKeysForTesting().some((key) =>
				key.startsWith(`${realpathSync(path)}\0`),
			),
		).toBe(false);
		expect(getPiRawParseCacheStateForTesting().sourceBytes).toBe(0);
	});

	it("clears raw parse source-byte accounting when invalidated", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_JSONL);
		expect(parsePiSessionLogFile(path, root, "pi")).toBeDefined();
		expect(getPiRawParseCacheStateForTesting().sourceBytes).toBeGreaterThan(0);

		invalidatePiSessionCaches();

		expect(getPiRawParseCacheKeysForTesting()).toHaveLength(0);
		expect(getPiRawParseCacheStateForTesting().sourceBytes).toBe(0);
	});

	it("keeps malformed files stable after their raw cache entry is evicted", () => {
		const root = createTempRoot();
		const malformedPath = join(root, "malformed.jsonl");
		writeFileSync(
			malformedPath,
			'{"type":"message","role":"user","content":"missing header"}\n',
		);

		const initial = readSnapshots(root, 0);
		expect(initial.pi.ok).toBe(true);
		if (!initial.pi.ok) return;
		expect(initial.pi.value.sessionIssues[malformedPath]).toBe(
			"Unable to parse Pi JSONL session.",
		);

		for (let index = 0; index < 256; index += 1) {
			const path = join(root, `cache-entry-${index}.jsonl`);
			writeFileSync(
				path,
				VALID_JSONL.replace("test-session-1", `cache-entry-${index}`),
			);
			expect(parsePiSessionLogFile(path, root, "pi")).toBeDefined();
		}

		const parseSpy = vi.spyOn(JSON, "parse");
		try {
			const refreshed = readSnapshots(root, 2_000);

			expect(parseSpy).not.toHaveBeenCalled();
			expect(refreshed.pi.ok).toBe(true);
			if (!refreshed.pi.ok) return;
			expect(refreshed.pi.value.sessionIssues[malformedPath]).toBe(
				"Unable to parse Pi JSONL session.",
			);
		} finally {
			parseSpy.mockRestore();
		}
	});
});
