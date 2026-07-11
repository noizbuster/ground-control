import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getMissionControlSnapshotFromSqlite } from "../src/db/missionControlSqliteSnapshot";
import {
	cleanupMcSqliteFixtures,
	createMcSqliteFixture,
} from "./mcSqliteFixture";
import { addMcTask11Tables, type McProjectionRunRow } from "./mcTask11Fixture";

const OUTCOMES = [
	"idle",
	"running",
	"interrupted",
	"completed",
	"failed",
	"blocked_on_approval",
] as const;

describe("Mission Control latest run outcome metadata", () => {
	afterEach(cleanupMcSqliteFixtures);

	it("preserves every raw run outcome and treats only active outcomes as durable work", () => {
		const fixture = createMcSqliteFixture({
			sessions: [...OUTCOMES, "unknown"].map((outcome) => ({
				session_id: `outcome-${outcome}`,
				status: "idle",
				created_at: "2026-07-11T00:00:00.000Z",
			})),
		});
		const projections: McProjectionRunRow[] = [
			...OUTCOMES.map((outcome, index) => ({
				sessionId: `outcome-${outcome}`,
				eventId: `event-${index}`,
				sequence: index + 1,
				timestamp: `2026-07-11T00:00:0${index}.000Z`,
				eventType: `run.${outcome}`,
				state: outcome,
				runId: `run-${index}`,
			})),
			{
				sessionId: "outcome-unknown",
				eventId: "event-unknown",
				sequence: 9,
				timestamp: "2026-07-11T00:00:09.000Z",
				eventType: "run.future",
				state: "future_state",
				runId: "run-unknown",
			},
		];
		addMcTask11Tables(fixture.dbPath, {
			projections,
			includeLeaseTable: false,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const metadata = Object.fromEntries(
			result.value.sessions.map((session) => [
				session.id,
				{
					outcome: session.sourceMetadata?.missionControl?.latestRun?.outcome,
					active: session.sourceMetadata?.missionControl?.hasActiveWork,
					abortable: session.sourceMetadata?.missionControl?.abortable,
				},
			]),
		);
		for (const outcome of OUTCOMES) {
			const active = outcome === "running" || outcome === "blocked_on_approval";
			expect(metadata[`outcome-${outcome}`]).toEqual({
				outcome,
				active,
				abortable: active,
			});
		}
		expect(metadata["outcome-unknown"]).toEqual({
			outcome: null,
			active: false,
			abortable: false,
		});
	});

	it("uses the highest sequence as latest outcome and active-work authority per run", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "settled",
					status: "idle",
					created_at: "2026-07-11T00:00:00.000Z",
				},
			],
		});
		addMcTask11Tables(fixture.dbPath, {
			projections: [
				{
					sessionId: "settled",
					eventId: "event-1",
					sequence: 1,
					timestamp: "2026-07-11T00:00:01.000Z",
					eventType: "run.started",
					state: "running",
					runId: "run-settled",
				},
				{
					sessionId: "settled",
					eventId: "event-2",
					sequence: 2,
					timestamp: "2026-07-11T00:00:02.000Z",
					eventType: "run.completed",
					state: "completed",
					runId: "run-settled",
				},
			],
			includeLeaseTable: false,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.value.sessions[0].sourceMetadata?.missionControl,
		).toMatchObject({
			latestRun: {
				outcome: "completed",
				sequence: 2,
				timestamp: "2026-07-11T00:00:02.000Z",
			},
			hasActiveWork: false,
			abortable: false,
		});
	});

	it("matches MC max-sequence work authority when tied outcomes disagree", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "tied",
					status: "idle",
					created_at: "2026-07-11T00:00:00.000Z",
				},
			],
		});
		addMcTask11Tables(fixture.dbPath, {
			projections: [
				{
					sessionId: "tied",
					eventId: "a-running",
					sequence: 5,
					timestamp: "2026-07-11T00:00:05.000Z",
					eventType: "run.started",
					state: "running",
					runId: "run-tied",
				},
				{
					sessionId: "tied",
					eventId: "z-completed",
					sequence: 5,
					timestamp: "2026-07-11T00:00:05.000Z",
					eventType: "run.completed",
					state: "completed",
					runId: "run-tied",
				},
			],
			includeLeaseTable: false,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.value.sessions[0].sourceMetadata?.missionControl,
		).toMatchObject({
			latestRun: { outcome: "completed", sequence: 5 },
			hasActiveWork: true,
			abortable: true,
		});
	});

	it("marks active work unknown when present authority tables are unreadable", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "unknown-work",
					status: "idle",
					created_at: "2026-07-11T00:00:00.000Z",
				},
			],
		});
		const writer = new DatabaseSync(fixture.dbPath);
		writer.exec("CREATE TABLE session_projection_runs (session_id TEXT)");
		writer.exec("CREATE TABLE mission_runs (run_id TEXT)");
		writer.close();

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.value.sessions[0].sourceMetadata?.missionControl,
		).toMatchObject({
			hasActiveWork: null,
			abortable: false,
		});
	});
});
