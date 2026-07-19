import { describe, expect, it } from "vitest";
import {
	BLOCKED_THRESHOLD_MS,
	formatInactiveDuration,
	getInactiveDurationMs,
	getLatestActivityTimestamp,
	getStallLevel,
	STALL_THRESHOLD_MS,
} from "../src/lib/stallDetection";
import type { Session, SubagentSession } from "../src/types";
import { SessionStatus } from "../src/types";

const NOW = 1_700_000_600_000;

const createSession = (overrides: Partial<Session> = {}): Session => ({
	id: "root-session",
	title: "Root session",
	directory: "/repo/app",
	project_id: "project",
	project_label: "Project",
	parent_id: null,
	time_created: NOW - 60 * 60 * 1000,
	time_updated: NOW - 60 * 1000,
	sessionSource: "opencode",
	status: SessionStatus.running,
	subagentSessions: [],
	...overrides,
});

const createSubagent = (
	overrides: Partial<SubagentSession> = {},
): SubagentSession => ({
	id: "child-session",
	title: "Child session",
	directory: "/repo/app",
	project_id: "project",
	project_label: "Project",
	parent_id: "root-session",
	time_created: NOW - 60 * 60 * 1000,
	time_updated: NOW - 60 * 1000,
	sessionSource: "opencode",
	status: SessionStatus.running,
	...overrides,
});

describe("getLatestActivityTimestamp", () => {
	it("uses the root time_updated when there are no subagents", () => {
		const session = createSession({ time_updated: NOW - 10_000 });

		expect(getLatestActivityTimestamp(session)).toBe(NOW - 10_000);
	});

	it("uses the newest subagent update when it is later than the root", () => {
		const session = createSession({
			time_updated: NOW - 20 * 60 * 1000,
			subagentSessions: [
				createSubagent({ time_updated: NOW - 15 * 60 * 1000 }),
				createSubagent({
					id: "child-2",
					time_updated: NOW - 2 * 60 * 1000,
				}),
			],
		});

		expect(getLatestActivityTimestamp(session)).toBe(NOW - 2 * 60 * 1000);
	});
});

describe("getStallLevel", () => {
	it("returns none for completed sessions", () => {
		const session = createSession({
			status: SessionStatus.completed,
			time_updated: NOW - BLOCKED_THRESHOLD_MS - 1,
		});

		expect(getStallLevel(SessionStatus.completed, session, NOW)).toBe("none");
	});

	it("stalls AWAITING SUBAGENT when display status is running and children are idle", () => {
		// Card label uses completed+running children → displayStatus running.
		// Stall must use that display status, not raw completed.
		const session = createSession({
			status: SessionStatus.completed,
			time_updated: NOW - BLOCKED_THRESHOLD_MS - 1,
			subagentSessions: [
				createSubagent({
					status: SessionStatus.running,
					time_updated: NOW - BLOCKED_THRESHOLD_MS - 1,
				}),
			],
		});

		expect(getStallLevel(SessionStatus.running, session, NOW)).toBe("blocked");
	});

	it("returns none for idle waiting sessions", () => {
		const session = createSession({
			status: SessionStatus.waiting,
			finishReason: "end_turn",
			time_updated: NOW - BLOCKED_THRESHOLD_MS - 1,
		});

		expect(getStallLevel(SessionStatus.waiting, session, NOW)).toBe("none");
	});

	it("returns none when activity is newer than the stall window", () => {
		const session = createSession({
			time_updated: NOW - STALL_THRESHOLD_MS + 1,
		});

		expect(getStallLevel(SessionStatus.running, session, NOW)).toBe("none");
	});

	it("returns stalled after 5 minutes without updates", () => {
		const session = createSession({
			time_updated: NOW - STALL_THRESHOLD_MS,
		});

		expect(getStallLevel(SessionStatus.running, session, NOW)).toBe("stalled");
	});

	it("returns blocked after 10 minutes without updates", () => {
		const session = createSession({
			time_updated: NOW - BLOCKED_THRESHOLD_MS,
		});

		expect(getStallLevel(SessionStatus.running, session, NOW)).toBe("blocked");
	});

	it("stays none when a subagent is still updating", () => {
		const session = createSession({
			time_updated: NOW - BLOCKED_THRESHOLD_MS - 1,
			subagentSessions: [createSubagent({ time_updated: NOW - 30 * 1000 })],
		});

		expect(getStallLevel(SessionStatus.running, session, NOW)).toBe("none");
	});

	it("uses subagent inactivity for stalled when root is older", () => {
		const session = createSession({
			time_updated: NOW - BLOCKED_THRESHOLD_MS - 1,
			subagentSessions: [
				createSubagent({ time_updated: NOW - STALL_THRESHOLD_MS }),
			],
		});

		expect(getStallLevel(SessionStatus.running, session, NOW)).toBe("stalled");
	});

	it("applies to awaiting-user waiting sessions (priority handled by UI)", () => {
		const session = createSession({
			status: SessionStatus.waiting,
			time_updated: NOW - BLOCKED_THRESHOLD_MS,
		});

		expect(getStallLevel(SessionStatus.waiting, session, NOW)).toBe("blocked");
	});

	it("returns none for failed sessions", () => {
		const session = createSession({
			status: SessionStatus.failed,
			time_updated: NOW - BLOCKED_THRESHOLD_MS - 1,
		});

		expect(getStallLevel(SessionStatus.failed, session, NOW)).toBe("none");
	});
});

describe("inactive duration helpers", () => {
	it("reports minutes since the latest root or subagent activity", () => {
		const session = createSession({
			time_updated: NOW - 15 * 60 * 1000,
			subagentSessions: [
				createSubagent({ time_updated: NOW - 12 * 60 * 1000 }),
			],
		});

		expect(getInactiveDurationMs(session, NOW)).toBe(12 * 60 * 1000);
	});

	it("formats short blocked durations as minutes and hours", () => {
		expect(formatInactiveDuration(0)).toBe("0m");
		expect(formatInactiveDuration(12 * 60 * 1000)).toBe("12m");
		expect(formatInactiveDuration(60 * 60 * 1000)).toBe("1h");
		expect(formatInactiveDuration(90 * 60 * 1000)).toBe("1h30m");
	});
});
