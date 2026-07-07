import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMissionControlSnapshot } from "../src/db/missionControl";
import { getMissionControlSnapshotFromSqlite } from "../src/db/missionControlSqliteSnapshot";
import { SessionStatus, type SubagentSession } from "../src/types";
import {
	cleanupMcSqliteFixtures,
	createMcSqliteFixture,
	type McSessionEventRow,
	type McSessionMessageRow,
	type McSessionRelationRow,
	type McSessionRow,
} from "./mcSqliteFixture";

describe("getMissionControlSnapshotFromSqlite", () => {
	afterEach(() => {
		cleanupMcSqliteFixtures();
	});

	it("maps a running session to SessionStatus.running with no statusDetail", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_running",
					status: "running",
					workspace_path: "/home/user/project",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions).toHaveLength(1);
		expect(result.value.sessions[0].status).toBe(SessionStatus.running);
		expect(result.value.sessions[0].statusDetail).toBeUndefined();
		expect(result.value.statusBySessionId["sess_running"]).toBe(
			SessionStatus.running,
		);
	});

	it("maps awaiting + joined session_awaits.reason 'approval' to waiting / 'Awaiting approval'", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_await_approval",
					status: "awaiting",
					awaiting_reason: null,
					primary_wait_id: "wait-1",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
			awaits: [
				{
					wait_id: "wait-1",
					session_id: "sess_await_approval",
					reason: "approval",
					created_at: "2025-01-01T00:00:01Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.waiting);
		expect(result.value.sessions[0].statusDetail).toBe("Awaiting approval");
	});

	it("prefers joined session_awaits.reason over sessions.awaiting_reason", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_pref",
					status: "awaiting",
					awaiting_reason: "user_input",
					primary_wait_id: "wait-2",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
			awaits: [
				{
					wait_id: "wait-2",
					session_id: "sess_pref",
					reason: "subagent",
					created_at: "2025-01-01T00:00:01Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].statusDetail).toBe("Awaiting subagent");
	});

	it("maps awaiting + sessions.awaiting_reason 'user_input' to waiting / 'Awaiting user input'", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_await_input",
					status: "awaiting",
					awaiting_reason: "user_input",
					primary_wait_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.waiting);
		expect(result.value.sessions[0].statusDetail).toBe("Awaiting user input");
	});

	it("maps awaiting + reason 'subagent' to waiting / 'Awaiting subagent'", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_await_sub",
					status: "awaiting",
					awaiting_reason: "subagent",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.waiting);
		expect(result.value.sessions[0].statusDetail).toBe("Awaiting subagent");
	});

	it("maps awaiting with no parseable reason to waiting / 'Awaiting Mission Control'", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_await_unknown",
					status: "awaiting",
					awaiting_reason: null,
					primary_wait_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.waiting);
		expect(result.value.sessions[0].statusDetail).toBe(
			"Awaiting Mission Control",
		);
	});

	it("maps idle to waiting / 'Idle between prompts'", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_idle",
					status: "idle",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.waiting);
		expect(result.value.sessions[0].statusDetail).toBe("Idle between prompts");
	});

	it("maps stopped to completed with no statusDetail", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_stopped",
					status: "stopped",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.completed);
		expect(result.value.sessions[0].statusDetail).toBeUndefined();
	});

	it("maps failed to failed / 'Session failed'", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_failed",
					status: "failed",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.failed);
		expect(result.value.sessions[0].statusDetail).toBe("Session failed");
	});

	it("maps an unrecognized status string to unknown with a descriptive statusDetail", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_corrupt",
					status: "frozen",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.unknown);
		expect(result.value.sessions[0].statusDetail).toBe(
			"Unrecognized Mission Control status: frozen",
		);
	});

	it("maps a null status to unknown with a descriptive statusDetail", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_null_status",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].status).toBe(SessionStatus.unknown);
		expect(result.value.sessions[0].statusDetail).toBe(
			"Unrecognized Mission Control status: null",
		);
	});

	it("aggregates message counts per session and defaults to 0 for sessions without messages", () => {
		const sessionWithMessages: McSessionRow = {
			session_id: "sess_with_msgs",
			status: "running",
			created_at: "2025-01-01T00:00:00Z",
		};
		const sessionWithoutMessages: McSessionRow = {
			session_id: "sess_no_msgs",
			status: "running",
			created_at: "2025-01-01T00:00:00Z",
		};
		const messages: McSessionMessageRow[] = [
			{
				message_id: "msg-1",
				session_id: "sess_with_msgs",
				seq: 1,
				role: "user",
				created_at: "2025-01-01T00:00:01Z",
			},
			{
				message_id: "msg-2",
				session_id: "sess_with_msgs",
				seq: 2,
				role: "assistant",
				created_at: "2025-01-01T00:00:02Z",
			},
			{
				message_id: "msg-3",
				session_id: "sess_with_msgs",
				seq: 3,
				role: "user",
				created_at: "2025-01-01T00:00:03Z",
			},
		];

		const fixture = createMcSqliteFixture({
			sessions: [sessionWithMessages, sessionWithoutMessages],
			messages,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.messageCountBySessionId["sess_with_msgs"]).toBe(3);
		expect(result.value.messageCountBySessionId["sess_no_msgs"]).toBe(0);
	});

	it("populates basic metadata (title, directory, provider, model, timestamps, sourceMetadata)", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_meta",
					status: "running",
					workspace_path: "/home/user/project",
					provider_id: "anthropic",
					model_id: "claude-sonnet-4",
					title: "Fix the bug",
					created_at: "2025-01-01T00:00:00Z",
					updated_at: "2025-01-01T00:00:05Z",
					last_activity_at: "2025-01-01T00:00:10Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const session = result.value.sessions[0];
		expect(session.id).toBe("sess_meta");
		expect(session.title).toBe("Fix the bug");
		expect(session.directory).toBe("/home/user/project");
		expect(session.project_label).toBe("project");
		expect(session.providerID).toBe("anthropic");
		expect(session.currentModelID).toBe("claude-sonnet-4");
		expect(session.parent_id).toBeNull();
		expect(session.project_id).toBe("sess_meta");
		expect(session.sessionSource).toBe("mission-control");
		expect(session.time_created).toBe(Date.parse("2025-01-01T00:00:00Z"));
		expect(session.time_updated).toBe(Date.parse("2025-01-01T00:00:10Z"));
		expect(session.subagentSessions).toEqual([]);
		expect(session.sourceMetadata?.sessionPath).toBe(fixture.dbPath);
		expect(session.sourceMetadata?.rawSource).toBe(fixture.dbPath);
	});

	it("defaults title to session_<id> when sessions.title is null", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "abc123",
					status: "running",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].title).toBe("session_abc123");
	});

	it("falls back time_updated to updated_at when last_activity_at is null", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_time",
					status: "running",
					created_at: "2025-01-01T00:00:00Z",
					updated_at: "2025-01-01T00:00:05Z",
					last_activity_at: null,
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].time_updated).toBe(
			Date.parse("2025-01-01T00:00:05Z"),
		);
	});

	it("assembles a child under its parent via parent_session_id (no longer a flat list)", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "parent_sess",
					status: "running",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
				{
					session_id: "child_sess",
					status: "running",
					parent_session_id: "parent_sess",
					created_at: "2025-01-01T00:00:01Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions).toHaveLength(1);
		expect(result.value.sessions[0].id).toBe("parent_sess");
		expect(result.value.sessions[0].subagentSessions).toHaveLength(1);
		expect(result.value.sessions[0].subagentSessions?.[0]?.id).toBe(
			"child_sess",
		);
		expect(result.value.sessions[0].subagentSessions?.[0]?.parent_id).toBe(
			"parent_sess",
		);
	});

	it("returns query_failed for a corrupt SQLite file", () => {
		const fixture = createMcSqliteFixture();
		const corruptPath = join(fixture.dir, "corrupt.db");
		writeFileSync(corruptPath, "this is definitely not a sqlite database");

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: corruptPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.code).toBe("query_failed");
	});

	it("returns missing_database when the DB exists but lacks the sessions table", () => {
		const fixture = createMcSqliteFixture();
		const noSessionsDbPath = join(fixture.dir, "no-sessions.db");
		const writer = new DatabaseSync(noSessionsDbPath);
		writer.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
		writer.close();

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: noSessionsDbPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.code).toBe("missing_database");
	});
});

// session_events.payload_json holds a serialized AgentEventEnvelope; the event
// body is nested under `event`.
const mcEventPayload = (
	seq: number,
	type: string,
	eventBody: Record<string, unknown>,
	sessionId = "sess_events",
): string =>
	JSON.stringify({
		eventId: `evt-${seq}`,
		sequence: seq,
		createdAt: "2025-01-01T00:00:00Z",
		sessionId,
		durability: "persisted",
		event: { type, timestamp: "2025-01-01T00:00:00Z", ...eventBody },
	});

describe("getMissionControlSnapshotFromSqlite — hierarchy + metadata enrichment", () => {
	afterEach(() => {
		cleanupMcSqliteFixtures();
	});

	it("assembles a child under its parent's subagentSessions and lists only the parent as a root", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "root_parent",
					status: "running",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
				{
					session_id: "sub_child",
					status: "running",
					parent_session_id: "root_parent",
					created_at: "2025-01-01T00:00:01Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions).toHaveLength(1);
		expect(result.value.sessions[0].id).toBe("root_parent");
		expect(result.value.sessions[0].subagentSessions).toHaveLength(1);
		expect(result.value.sessions[0].subagentSessions?.[0]?.id).toBe(
			"sub_child",
		);
	});

	it("surfaces a session issue for an orphan child whose parent_session_id points to a missing row", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "orphan_child",
					status: "running",
					parent_session_id: "ghost_parent",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions).toHaveLength(0);
		expect(result.value.sessionIssues["orphan_child"]).toBe(
			"Mission Control root session not found.",
		);
	});

	it("recovers an orphan under root_session_id when the direct parent row is missing", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "real_root",
					status: "running",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
				{
					session_id: "recovered_child",
					status: "running",
					parent_session_id: "missing_direct_parent",
					root_session_id: "real_root",
					created_at: "2025-01-01T00:00:01Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions).toHaveLength(1);
		expect(result.value.sessions[0].id).toBe("real_root");
		expect(result.value.sessions[0].subagentSessions).toHaveLength(1);
		expect(result.value.sessions[0].subagentSessions?.[0]?.id).toBe(
			"recovered_child",
		);
		expect(result.value.sessionIssues["recovered_child"]).toBeUndefined();
	});

	it("fills a missing parent link via session_relations for a child with null parent_session_id, without overriding an explicit parent_session_id", () => {
		const explicitChild: McSessionRow = {
			session_id: "explicit_child",
			status: "running",
			parent_session_id: "root_a",
			created_at: "2025-01-01T00:00:02Z",
		};
		const relationOnlyChild: McSessionRow = {
			session_id: "relation_child",
			status: "running",
			parent_session_id: null,
			root_session_id: "root_a",
			created_at: "2025-01-01T00:00:03Z",
		};
		const relations: McSessionRelationRow[] = [
			{
				relation_id: "rel-1",
				parent_session_id: "root_a",
				child_session_id: "relation_child",
				kind: "subagent",
				created_at: "2025-01-01T00:00:03Z",
			},
			{
				relation_id: "rel-2",
				parent_session_id: "root_b",
				child_session_id: "explicit_child",
				kind: "subagent",
				created_at: "2025-01-01T00:00:02Z",
			},
		];
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "root_a",
					status: "running",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
				explicitChild,
				relationOnlyChild,
			],
			relations,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions).toHaveLength(1);
		const root = result.value.sessions[0];
		expect(root.id).toBe("root_a");
		const childIds =
			root.subagentSessions?.map((child: SubagentSession) => child.id) ?? [];
		expect(childIds).toContain("relation_child");
		expect(childIds).toContain("explicit_child");
		const explicit = root.subagentSessions?.find(
			(child: SubagentSession) => child.id === "explicit_child",
		);
		expect(explicit?.parent_id).toBe("root_a");
	});

	it("falls back directory and title from session_events payloads when sessions columns are null", () => {
		const events: McSessionEventRow[] = [
			{
				session_id: "sess_events",
				seq: 1,
				event_id: "evt-1",
				type: "session.metadata.updated",
				payload_json: mcEventPayload(1, "session.metadata.updated", {
					sessionTree: { cwd: "/old/dir" },
				}),
			},
			{
				session_id: "sess_events",
				seq: 2,
				event_id: "evt-2",
				type: "run.command.received",
				payload_json: mcEventPayload(2, "run.command.received", {
					message: "Refactor the parser",
				}),
			},
			{
				session_id: "sess_events",
				seq: 3,
				event_id: "evt-3",
				type: "session.metadata.updated",
				payload_json: mcEventPayload(3, "session.metadata.updated", {
					sessionTree: { cwd: "/latest/dir" },
				}),
			},
		];
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_events",
					status: "running",
					workspace_path: null,
					title: null,
					created_at: "2025-01-01T00:00:00Z",
				},
			],
			events,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const session = result.value.sessions[0];
		expect(session.directory).toBe("/latest/dir");
		expect(session.title).toBe("Refactor the parser");
		expect(session.project_label).toBe("dir");
	});

	it("falls back provider_id and model_id from session_events modelProviderSelection when sessions columns are null", () => {
		const events: McSessionEventRow[] = [
			{
				session_id: "sess_model",
				seq: 1,
				event_id: "evt-m1",
				type: "model.call.completed",
				payload_json: mcEventPayload(
					1,
					"model.call.completed",
					{
						modelProviderSelection: {
							providerID: "anthropic",
							modelID: "claude-sonnet-4",
						},
					},
					"sess_model",
				),
			},
		];
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_model",
					status: "running",
					provider_id: null,
					model_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
			],
			events,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const session = result.value.sessions[0];
		expect(session.providerID).toBe("anthropic");
		expect(session.currentModelID).toBe("claude-sonnet-4");
	});

	it("prefers sessions columns over event-payload fallbacks for directory, title, and model", () => {
		const events: McSessionEventRow[] = [
			{
				session_id: "sess_pref_cols",
				seq: 1,
				event_id: "evt-pc1",
				type: "session.metadata.updated",
				payload_json: mcEventPayload(
					1,
					"session.metadata.updated",
					{ sessionTree: { cwd: "/from/event" } },
					"sess_pref_cols",
				),
			},
		];
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_pref_cols",
					status: "running",
					workspace_path: "/from/column",
					title: "Column Title",
					provider_id: "openai",
					model_id: "gpt-4",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
			events,
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const session = result.value.sessions[0];
		expect(session.directory).toBe("/from/column");
		expect(session.title).toBe("Column Title");
		expect(session.providerID).toBe("openai");
		expect(session.currentModelID).toBe("gpt-4");
	});

	it("sets sourceMetadata.sessionPath and rawSource to the DB path", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "sess_src",
					status: "running",
					created_at: "2025-01-01T00:00:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const session = result.value.sessions[0];
		expect(session.sourceMetadata?.rawSource).toBe(fixture.dbPath);
		expect(session.sourceMetadata?.sessionPath).toBe(fixture.dbPath);
	});

	it("computes openChildCount and closedChildCount on root sessions", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "root_counts",
					status: "stopped",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
				{
					session_id: "child_running",
					status: "running",
					parent_session_id: "root_counts",
					created_at: "2025-01-01T00:00:01Z",
				},
				{
					session_id: "child_waiting",
					status: "awaiting",
					awaiting_reason: "approval",
					parent_session_id: "root_counts",
					created_at: "2025-01-01T00:00:02Z",
				},
				{
					session_id: "child_done",
					status: "stopped",
					parent_session_id: "root_counts",
					created_at: "2025-01-01T00:00:03Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const root = result.value.sessions[0];
		expect(root.id).toBe("root_counts");
		expect(root.sourceMetadata?.openChildCount).toBe(2);
		expect(root.sourceMetadata?.closedChildCount).toBe(1);
	});

	it("does not create child sessions from session_relations when the child has no sessions row", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "root_only",
					status: "running",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
				},
			],
			relations: [
				{
					relation_id: "rel-ghost",
					parent_session_id: "root_only",
					child_session_id: "ghost_child_no_row",
					kind: "subagent",
					created_at: "2025-01-01T00:00:01Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions).toHaveLength(1);
		expect(result.value.sessions[0].subagentSessions).toHaveLength(0);
	});

	it("sorts roots by time_updated descending", () => {
		const fixture = createMcSqliteFixture({
			sessions: [
				{
					session_id: "root_older",
					status: "stopped",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
					last_activity_at: "2025-01-01T00:10:00Z",
				},
				{
					session_id: "root_newer",
					status: "stopped",
					parent_session_id: null,
					created_at: "2025-01-01T00:00:00Z",
					last_activity_at: "2025-01-01T00:20:00Z",
				},
			],
		});

		const result = getMissionControlSnapshotFromSqlite({
			databasePath: fixture.dbPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.sessions[0].id).toBe("root_newer");
		expect(result.value.sessions[1].id).toBe("root_older");
	});
});

const ORCHESTRATOR_ENV_KEYS = [
	"GCTRL_MC_DB_PATH",
	"MCTRL_DATA_DIR",
	"XDG_DATA_HOME",
] as const;

describe("getMissionControlSnapshot (SQLite-primary orchestrator)", () => {
	let envSnapshot: Partial<
		Record<(typeof ORCHESTRATOR_ENV_KEYS)[number], string | undefined>
	>;

	beforeEach(() => {
		envSnapshot = {};
		for (const key of ORCHESTRATOR_ENV_KEYS) {
			envSnapshot[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ORCHESTRATOR_ENV_KEYS) {
			if (envSnapshot[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = envSnapshot[key];
			}
		}
		cleanupMcSqliteFixtures();
	});

	it("returns missing_database naming memory.db when the SQLite database is missing", () => {
		process.env.GCTRL_MC_DB_PATH = "/nonexistent/path/memory.db";
		process.env.XDG_DATA_HOME = "/nonexistent/xdg";

		const result = getMissionControlSnapshot();

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.code).toBe("missing_database");
		expect(result.error.message).toContain("memory.db");
	});
});
