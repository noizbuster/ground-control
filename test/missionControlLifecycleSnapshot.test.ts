import { afterEach, describe, expect, it } from "vitest";
import { getMissionControlSnapshotFromSqlite } from "../src/db/missionControlSqliteSnapshot";
import type { Session, SubagentSession } from "../src/types";
import {
	cleanupMcSqliteFixtures,
	createMcSqliteFixture,
	type McSessionRow,
} from "./mcSqliteFixture";
import { addMcTask11Tables } from "./mcTask11Fixture";

const NOW_WALL_MS = 2_000;

const allSessions = (
	roots: readonly Session[],
): Array<Session | SubagentSession> =>
	roots.flatMap((root) => [root, ...(root.subagentSessions ?? [])]);

describe("Mission Control raw lifecycle and lease snapshot metadata", () => {
	afterEach(cleanupMcSqliteFixtures);

	it("keeps idle visually waiting while an aborted idle session is non-abortable", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "idle-aborted",
					status: "idle",
					last_event_seq: 8,
					updated_at: "2026-07-11T12:00:00.000Z",
					created_at: "2026-07-11T11:00:00.000Z",
					metadata_json: JSON.stringify({ lifecycleReason: "aborted" }),
				},
			],
		});
		addMcTask11Tables(fixture.dbPath, {
			projections: [
				{
					sessionId: "idle-aborted",
					eventId: "evt-8",
					sequence: 8,
					timestamp: "2026-07-11T12:00:00.000Z",
					eventType: "run.interrupted",
					state: "interrupted",
					runId: "run-1",
					reason: "operator_aborted",
				},
			],
			includeLeaseTable: false,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
			nowWallMs: NOW_WALL_MS,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const session = result.value.sessions[0];
		expect(session.status).toBe("waiting");
		expect(session.statusDetail).toBe("Idle (aborted)");
		expect(session.sourceMetadata?.missionControl).toMatchObject({
			rawLifecycleStatus: "idle",
			lifecycleReason: "aborted",
			lastEventSequence: 8,
			latestRun: {
				outcome: "interrupted",
				sequence: 8,
				timestamp: "2026-07-11T12:00:00.000Z",
				eventType: "run.interrupted",
				reason: "operator_aborted",
			},
			hasActiveWork: false,
			abortable: false,
			lease: { state: "unknown", fallbackSafety: "no_delete" },
		});
	});

	it("uses raw running/awaiting or durable active work, never display status, for abortability", () => {
		const sessions: McSessionRow[] = [
			{ session_id: "raw-running", status: "running" },
			{ session_id: "raw-awaiting", status: "awaiting" },
			{ session_id: "idle-active-run", status: "idle" },
			{ session_id: "idle-active-mission", status: "idle" },
			{ session_id: "idle-terminal", status: "idle" },
			{ session_id: "stopped-active", status: "stopped" },
			{ session_id: "failed-active", status: "failed" },
		].map((row) => ({ ...row, created_at: "2026-07-11T00:00:00.000Z" }));
		const fixture = createMcSqliteFixture({ sessions });
		addMcTask11Tables(fixture.dbPath, {
			projections: ["idle-active-run", "stopped-active", "failed-active"].map(
				(sessionId, index) => ({
					sessionId,
					eventId: `active-${index}`,
					sequence: 2,
					timestamp: "2026-07-11T01:00:00.000Z",
					eventType: "run.started",
					state: "running",
					runId: `run-${index}`,
				}),
			),
			missionRuns: [
				{
					runId: "mission-active",
					sessionId: "idle-active-mission",
					status: "blocked",
					updatedAt: "2026-07-11T01:00:00.000Z",
				},
			],
			includeLeaseTable: false,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
			nowWallMs: NOW_WALL_MS,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const abortability = Object.fromEntries(
			allSessions(result.value.sessions).map((session) => [
				session.id,
				session.sourceMetadata?.missionControl?.abortable,
			]),
		);
		expect(abortability).toEqual({
			"raw-running": true,
			"raw-awaiting": true,
			"idle-active-run": true,
			"idle-active-mission": true,
			"idle-terminal": false,
			"stopped-active": false,
			"failed-active": false,
		});
	});
});
