import { afterEach, describe, expect, it } from "vitest";
import { getMissionControlSnapshotFromSqlite } from "../src/db/missionControlSqliteSnapshot";
import { computeMcCanonicalTreeToken } from "../src/db/missionControlSqliteTreeToken";
import type { Session, SubagentSession } from "../src/types";
import {
	cleanupMcSqliteFixtures,
	createMcSqliteFixture,
} from "./mcSqliteFixture";

const findSession = (
	roots: readonly Session[],
	sessionId: string,
): Session | SubagentSession | undefined =>
	roots
		.flatMap((root) => [root, ...(root.subagentSessions ?? [])])
		.find((session) => session.id === sessionId);

describe("Mission Control canonical identity and hierarchy", () => {
	afterEach(cleanupMcSqliteFixtures);

	it("orders sibling ids by UTF-8 bytes before hashing canonical tree rows", () => {
		const parents = new Map<string, string | null>([
			["é", "根"],
			["根", null],
			["z", "根"],
		]);
		expect(
			computeMcCanonicalTreeToken("根", parents, new Set(parents.keys())),
		).toBe("92494fd441c5cd2d4984621c5cb802f4bdee82972cf90821535aa8478f2e8b3a");
	});

	it("matches Task 9 parent precedence/fallback and Task 10 canonical token bytes", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "mc-tree-root",
					parent_session_id: null,
					status: "running",
				},
				{
					session_id: "mc-tree-explicit",
					parent_session_id: "mc-tree-root",
					root_session_id: "ignored-root-metadata",
					status: "running",
				},
				{
					session_id: "mc-tree-fallback",
					parent_session_id: null,
					status: "idle",
				},
			].map((row) => ({ ...row, created_at: "2026-07-11T00:00:00.000Z" })),
			relations: [
				{
					relation_id: "ignored-explicit",
					parent_session_id: "ignored-relation-parent",
					child_session_id: "mc-tree-explicit",
					kind: "subagent",
				},
				{
					relation_id: "fallback",
					parent_session_id: "mc-tree-explicit",
					child_session_id: "mc-tree-fallback",
					kind: "parent_child",
				},
				{
					relation_id: "ignored-kind",
					parent_session_id: "mc-tree-root",
					child_session_id: "mc-tree-fallback",
					kind: "fork",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sessions).toHaveLength(1);
		expect(
			findSession(result.value.sessions, "mc-tree-explicit")?.parent_id,
		).toBe("mc-tree-root");
		expect(
			findSession(result.value.sessions, "mc-tree-fallback")?.parent_id,
		).toBe("mc-tree-explicit");
		expect(
			result.value.sessions[0].sourceMetadata?.missionControl?.treeToken,
		).toBe("e9296e7c5250a2fd542b4ee2799d4bfe00a33d47ea627298e84533b8a7d81232");
		expect(
			findSession(result.value.sessions, "mc-tree-explicit")?.sourceMetadata
				?.missionControl?.treeToken,
		).toBe("4ae560a1aa2098ded2d6ef080528b9c242d3c43e191ba493fdce09018b333e50");
		expect(
			findSession(result.value.sessions, "mc-tree-fallback")?.sourceMetadata
				?.missionControl?.treeToken,
		).toBe("e3b7c040db4d9fbfce7d6dfb0c43484f2189b09f689bf9f8042582d3156c80ca");
	});

	it("never recovers a missing explicit parent through root_session_id", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{ session_id: "real-root", parent_session_id: null, status: "running" },
				{
					session_id: "orphan",
					parent_session_id: "missing-direct-parent",
					root_session_id: "real-root",
					status: "running",
				},
			].map((row) => ({ ...row, created_at: "2026-07-11T00:00:00.000Z" })),
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sessions).toHaveLength(1);
		expect(result.value.sessions[0].subagentSessions).toEqual([]);
		expect(result.value.sessionIssues.orphan).toContain(
			"missing-direct-parent",
		);
	});

	it.each([
		{
			name: "multiple fallback parents",
			sessions: [
				{
					session_id: "mc-tree-root",
					parent_session_id: null,
					status: "running",
				},
				{
					session_id: "mc-tree-other",
					parent_session_id: null,
					status: "running",
				},
				{
					session_id: "mc-tree-child",
					parent_session_id: null,
					status: "running",
				},
			],
			relations: [
				{
					relation_id: "a",
					parent_session_id: "mc-tree-root",
					child_session_id: "mc-tree-child",
					kind: "parent_child",
				},
				{
					relation_id: "b",
					parent_session_id: "mc-tree-other",
					child_session_id: "mc-tree-child",
					kind: "subagent",
				},
			],
			issueId: "mc-tree-child",
		},
		{
			name: "explicit cycle",
			sessions: [
				{
					session_id: "mc-cycle-a",
					parent_session_id: "mc-cycle-b",
					status: "running",
				},
				{
					session_id: "mc-cycle-b",
					parent_session_id: "mc-cycle-a",
					status: "running",
				},
			],
			relations: [],
			issueId: "mc-cycle-a",
		},
		{
			name: "self relation",
			sessions: [
				{
					session_id: "mc-self",
					parent_session_id: null,
					status: "running",
				},
			],
			relations: [
				{
					relation_id: "self",
					parent_session_id: "mc-self",
					child_session_id: "mc-self",
					kind: "subagent",
				},
			],
			issueId: "mc-self",
		},
	])("diagnoses $name and emits no unsafe hierarchy candidate", ({
		sessions,
		relations,
		issueId,
	}) => {
		const fixture = createMcSqliteFixture({
			sessions: sessions.map((row) => ({
				...row,
				created_at: "2026-07-11T00:00:00.000Z",
			})),
			relations,
		});
		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sessionIssues[issueId]).toContain("unstable");
		expect(findSession(result.value.sessions, issueId)).toBeUndefined();
	});
});
