import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMissionControlDatabaseIdentity } from "../src/db/missionControlSqlite";
import { getMissionControlSnapshotFromSqlite } from "../src/db/missionControlSqliteSnapshot";
import {
	cleanupMcSqliteFixtures,
	createMcSqliteFixture,
} from "./mcSqliteFixture";
import { addMcTask11Tables } from "./mcTask11Fixture";

const NOW_WALL_MS = 2_000;

describe("Mission Control lease snapshot metadata", () => {
	afterEach(cleanupMcSqliteFixtures);

	it("classifies only the canonical matching lease as live, expired, or missing", () => {
		const fixture = createMcSqliteFixture({
			sessions: ["live", "expired", "wrong-identity"].map((session_id) => ({
				session_id,
				status: "running",
				created_at: "2026-07-11T00:00:00.000Z",
			})),
		});
		const identity = resolveMissionControlDatabaseIdentity(fixture.dbPath);
		addMcTask11Tables(fixture.dbPath, {
			leases: [
				{
					dbIdentity: identity.dbIdentity,
					sessionId: "live",
					ownerId: "owner-live",
					epoch: 4,
					expiresWallMs: NOW_WALL_MS + 1,
				},
				{
					dbIdentity: identity.dbIdentity,
					sessionId: "expired",
					ownerId: "owner-expired",
					epoch: 5,
					expiresWallMs: NOW_WALL_MS,
				},
				{
					dbIdentity: "0".repeat(64),
					sessionId: "wrong-identity",
					ownerId: "wrong-owner",
					epoch: 9,
					expiresWallMs: NOW_WALL_MS + 10_000,
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
			nowWallMs: NOW_WALL_MS,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const leases = Object.fromEntries(
			result.value.sessions.map((session) => [
				session.id,
				session.sourceMetadata?.missionControl?.lease,
			]),
		);
		expect(leases).toEqual({
			live: {
				state: "live",
				fallbackSafety: "retry",
				ownerId: "owner-live",
				epoch: 4,
				expiresWallMs: NOW_WALL_MS + 1,
			},
			expired: {
				state: "expired",
				fallbackSafety: "eligible",
				ownerId: "owner-expired",
				epoch: 5,
				expiresWallMs: NOW_WALL_MS,
			},
			"wrong-identity": { state: "missing", fallbackSafety: "eligible" },
		});
		expect(
			result.value.sessions[0].sourceMetadata?.missionControl?.databaseIdentity,
		).toBe(identity.dbIdentity);
	});

	it("fails every lease classification closed when a matching row is corrupt", () => {
		const fixture = createMcSqliteFixture({
			sessions: ["bad-expiry", "bad-epoch", "unleased"].map((session_id) => ({
				session_id,
				status: "running",
				created_at: "2026-07-11T00:00:00.000Z",
			})),
		});
		const identity = resolveMissionControlDatabaseIdentity(fixture.dbPath);
		addMcTask11Tables(fixture.dbPath, {
			leases: [
				{
					dbIdentity: identity.dbIdentity,
					sessionId: "bad-expiry",
					ownerId: "owner-expiry",
					epoch: 1,
					expiresWallMs: 1,
				},
				{
					dbIdentity: identity.dbIdentity,
					sessionId: "bad-epoch",
					ownerId: "owner-epoch",
					epoch: 1,
					expiresWallMs: 3_000,
				},
			],
		});
		const writer = new DatabaseSync(fixture.dbPath);
		writer.exec(
			"UPDATE session_control_leases SET expires_wall_ms = 9e999 WHERE session_id = 'bad-expiry'",
		);
		writer.exec(
			"UPDATE session_control_leases SET epoch = 0 WHERE session_id = 'bad-epoch'",
		);
		writer.close();

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
			nowWallMs: NOW_WALL_MS,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const session of result.value.sessions) {
			expect(session.sourceMetadata?.missionControl?.lease).toEqual({
				state: "unknown",
				fallbackSafety: "no_delete",
			});
		}
	});
});
