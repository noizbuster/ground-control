import { describe, expect, it } from "vitest";
import { getStatusLabel } from "../src/lib/hierarchyHelpers";
import {
	isOrphanedRunningActivity,
	ORPHANED_RUNNING_MS,
} from "../src/lib/orphanedRunning";
import { buildSessionSnapshot } from "../src/lib/sessionSnapshot";
import { SessionStatus } from "../src/types";

describe("isOrphanedRunningActivity", () => {
	it("returns false for recent activity", () => {
		const nowMs = 1_700_000_600_000;
		expect(
			isOrphanedRunningActivity(nowMs - ORPHANED_RUNNING_MS + 1, nowMs),
		).toBe(false);
	});

	it("returns true when activity is older than the orphan window", () => {
		const nowMs = 1_700_000_600_000;
		expect(isOrphanedRunningActivity(nowMs - ORPHANED_RUNNING_MS, nowMs)).toBe(
			true,
		);
	});
});

describe("interrupted status labels", () => {
	it("labels interrupted and turn_aborted finish reasons as Interrupted", () => {
		expect(
			getStatusLabel(SessionStatus.unknown, { finishReason: "interrupted" }),
		).toBe("Interrupted");
		expect(
			getStatusLabel(SessionStatus.unknown, { finishReason: "turn_aborted" }),
		).toBe("Interrupted");
	});
});

describe("OpenCode status stays message-driven", () => {
	it("does not demote running sessions when only session.time_updated is stale", () => {
		const nowMs = Date.now();
		const snapshot = buildSessionSnapshot({
			rawSessions: [
				{
					id: "sess-live-tool",
					title: "Live tool session",
					directory: "/repo/app",
					project_id: "proj",
					project_label: "App",
					parent_id: null,
					time_created: nowMs - 60 * 60 * 1000,
					time_updated: nowMs - ORPHANED_RUNNING_MS - 1,
				},
			],
			latestMessages: {
				"sess-live-tool": {
					sessionId: "sess-live-tool",
					rawData: null,
					message: {
						ok: true,
						value: {
							role: "assistant",
							time: { created: nowMs - ORPHANED_RUNNING_MS - 1 },
							finish: "tool-calls",
						},
					},
				},
			},
			messageCounts: { "sess-live-tool": 2 },
			waitingSignals: {},
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.running);
		expect(snapshot.sessions[0]?.finishReason).toBe("tool-calls");
		expect(snapshot.sessions[0]?.finishReason).not.toBe("interrupted");
	});
});
