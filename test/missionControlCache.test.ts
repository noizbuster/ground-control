import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateMissionControlCaches, parseMissionControlLogFile } from "../src/db/missionControl";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-mc-cache-"));
	tempRoots.push(root);
	return root;
};

const VALID_MC_JSONL = [
	'{"kind":"mission-control.session-log","version":1,"sessionId":"mc-test-1","createdAt":"2025-01-01T00:00:00Z"}',
	'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:01Z","event":{"type":"session.started"}}',
	'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:02Z","event":{"type":"run.command.received","message":"hello"}}',
].join("\n");

const EXTENDED_MC_JSONL = [
	'{"kind":"mission-control.session-log","version":1,"sessionId":"mc-test-1","createdAt":"2025-01-01T00:00:00Z"}',
	'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:01Z","event":{"type":"session.started"}}',
	'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:02Z","event":{"type":"run.command.received","message":"hello"}}',
	'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:03Z","event":{"type":"model.call.completed"}}',
].join("\n");

const DIFFERENT_MC_JSONL = [
	'{"kind":"mission-control.session-log","version":1,"sessionId":"mc-test-1","createdAt":"2025-01-01T00:00:00Z"}',
	'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:01Z","event":{"type":"session.stopped"}}',
].join("\n");

beforeEach(() => {
	invalidateMissionControlCaches();
});

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	invalidateMissionControlCaches();
});

describe("mcLogCache", () => {
	it("cache hit: second parse on unchanged file returns same object reference", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_MC_JSONL);

		const first = parseMissionControlLogFile(path, root);
		expect(first).toBeDefined();
		if (!first) return;

		const second = parseMissionControlLogFile(path, root);
		expect(second).toBe(first);
		expect(second?.envelopes).toHaveLength(2);
	});

	it("mtime change forces re-parse", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_MC_JSONL);

		const first = parseMissionControlLogFile(path, root);
		expect(first).toBeDefined();
		expect(first?.envelopes).toHaveLength(2);

		const second = parseMissionControlLogFile(path, root);
		expect(second).toBe(first);

		// Write extended content and bump mtime.
		writeFileSync(path, EXTENDED_MC_JSONL);
		utimesSync(path, new Date(Date.now() / 1000), new Date(Date.now() / 1000 + 1));

		const third = parseMissionControlLogFile(path, root);
		expect(third).toBeDefined();
		expect(third).not.toBe(first);
		expect(third?.envelopes).toHaveLength(3);
	});

	it("size change with same mtime forces re-parse", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_MC_JSONL);

		const first = parseMissionControlLogFile(path, root);
		expect(first).toBeDefined();
		expect(first?.envelopes).toHaveLength(2);

		// Write different content (different size) but preserve mtime.
		const beforeStats = statSync(path);
		writeFileSync(path, DIFFERENT_MC_JSONL);
		utimesSync(path, beforeStats.atime, beforeStats.mtime);

		const second = parseMissionControlLogFile(path, root);
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(second?.envelopes).toHaveLength(1);
		expect((second?.envelopes[0] as { type: string }).type).toBe("session.stopped");
	});

	it("invalidateMissionControlCaches forces re-read on next call", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_MC_JSONL);

		const first = parseMissionControlLogFile(path, root);
		expect(first).toBeDefined();
		const second = parseMissionControlLogFile(path, root);
		expect(second).toBe(first);

		// Invalidate and re-parse: should produce a new object.
		invalidateMissionControlCaches();
		const third = parseMissionControlLogFile(path, root);
		expect(third).toBeDefined();
		expect(third).not.toBe(first);
		expect(third?.sessionId).toBe(first?.sessionId);
		expect(third?.envelopes).toHaveLength(first!.envelopes.length);
	});

	it("header with wrong kind returns undefined", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		const WRONG_KIND_JSONL = [
			'{"kind":"something-else","version":1,"sessionId":"mc-wrong","createdAt":"2025-01-01T00:00:00Z"}',
		].join("\n");
		writeFileSync(path, WRONG_KIND_JSONL);

		const result = parseMissionControlLogFile(path, root);
		expect(result).toBeUndefined();
	});

	it("valid header and event envelopes populate record fields", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		writeFileSync(path, VALID_MC_JSONL);

		const record = parseMissionControlLogFile(path, root);
		expect(record).toBeDefined();
		if (!record) return;

		expect(record.sessionId).toBe("mc-test-1");
		expect(record.createdAt).toBe("2025-01-01T00:00:00Z");
		// envelopes[0] is the .event field of the first event line.
		expect(record.envelopes[0]).toEqual({ type: "session.started" });
		expect((record.envelopes[0] as { type: string }).type).toBe("session.started");
	});

	it("corrupt JSON line is skipped without crashing", () => {
		const root = createTempRoot();
		const path = join(root, "session.jsonl");
		const CORRUPT_MC_JSONL = [
			'{"kind":"mission-control.session-log","version":1,"sessionId":"mc-corrupt","createdAt":"2025-01-01T00:00:00Z"}',
			'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:01Z","event":{"type":"session.started"}}',
			"this is not valid json {{{",
			'{"kind":"mission-control.session-event","createdAt":"2025-01-01T00:00:02Z","event":{"type":"run.command.received"}}',
		].join("\n");
		writeFileSync(path, CORRUPT_MC_JSONL);

		const record = parseMissionControlLogFile(path, root);
		expect(record).toBeDefined();
		expect(record?.sessionId).toBe("mc-corrupt");
		expect(record?.envelopes).toHaveLength(2);
		expect((record?.envelopes[0] as { type: string }).type).toBe("session.started");
		expect((record?.envelopes[1] as { type: string }).type).toBe("run.command.received");
	});
});
