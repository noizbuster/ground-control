import { describe, expect, it } from "vitest";
import {
	buildMissionControlSnapshot,
	type MissionControlSessionLogRecord,
} from "../src/db/missionControl";
import { SessionStatus } from "../src/types";

describe("buildMissionControlSnapshot", () => {
	it("projects a completed session with full metadata", () => {
		const log: MissionControlSessionLogRecord = {
			path: "/fake/root/session_completed.jsonl",
			root: "/fake/root",
			sessionId: "session_completed",
			createdAt: "2025-01-01T00:00:00Z",
			mtimeMs: 0,
			envelopes: [
				{ type: "session.started", createdAt: "2025-01-01T00:00:00Z" },
				{
					type: "session.metadata.updated",
					createdAt: "2025-01-01T00:00:01Z",
					sessionTree: {
						cwd: "/home/user/project",
						sessionName: "test",
						parentSessionId: null,
					},
				},
				{
					type: "run.command.received",
					createdAt: "2025-01-01T00:00:02Z",
					message: "Fix the bug in auth.ts",
				},
				{
					type: "model.call.completed",
					createdAt: "2025-01-01T00:00:10Z",
					modelProviderSelection: {
						providerID: "anthropic",
						modelID: "claude-sonnet-4",
					},
				},
				{ type: "session.stopped", createdAt: "2025-01-01T00:01:00Z" },
			],
		};
		const snap = buildMissionControlSnapshot({ logs: [log] });

		expect(snap.sessions).toHaveLength(1);
		expect(snap.sessions[0].status).toBe(SessionStatus.completed);
		expect(snap.sessions[0].title).toBe("Fix the bug in auth.ts");
		expect(snap.sessions[0].directory).toBe("/home/user/project");
		expect(snap.sessions[0].currentModelID).toBe("claude-sonnet-4");
		expect(snap.sessions[0].providerID).toBe("anthropic");
		expect(snap.sessions[0].project_label).toBe("project");
		expect(snap.statusBySessionId["session_completed"]).toBe(
			SessionStatus.completed,
		);
		expect(snap.messageCountBySessionId["session_completed"]).toBe(2);
		expect(snap.sessions[0].sourceMetadata?.sessionPath).toBe(
			"/fake/root/session_completed.jsonl",
		);
	});

	it("maps a started-but-not-stopped session to running", () => {
		const log: MissionControlSessionLogRecord = {
			path: "/fake/root/session_running.jsonl",
			root: "/fake/root",
			sessionId: "session_running",
			createdAt: "2025-01-01T00:00:00Z",
			mtimeMs: 0,
			envelopes: [
				{ type: "session.started", createdAt: "2025-01-01T00:00:00Z" },
				{
					type: "session.metadata.updated",
					createdAt: "2025-01-01T00:00:01Z",
					sessionTree: {
						cwd: "/home/user/project",
						sessionName: "test",
						parentSessionId: null,
					},
				},
				{
					type: "run.command.received",
					createdAt: "2025-01-01T00:00:02Z",
					message: "Fix the bug",
				},
				{
					type: "model.call.completed",
					createdAt: "2025-01-01T00:00:10Z",
					modelProviderSelection: {
						providerID: "anthropic",
						modelID: "claude-sonnet-4",
					},
				},
			],
		};
		const snap = buildMissionControlSnapshot({ logs: [log] });

		expect(snap.sessions).toHaveLength(1);
		expect(snap.sessions[0].status).toBe(SessionStatus.running);
		expect(snap.statusBySessionId["session_running"]).toBe(
			SessionStatus.running,
		);
	});

	it("maps a task.failed session without session.stopped to failed", () => {
		const log: MissionControlSessionLogRecord = {
			path: "/fake/root/session_failed.jsonl",
			root: "/fake/root",
			sessionId: "session_failed",
			createdAt: "2025-01-01T00:00:00Z",
			mtimeMs: 0,
			envelopes: [
				{ type: "session.started", createdAt: "2025-01-01T00:00:00Z" },
				{ type: "task.failed", createdAt: "2025-01-01T00:00:05Z" },
			],
		};
		const snap = buildMissionControlSnapshot({ logs: [log] });

		expect(snap.sessions).toHaveLength(1);
		expect(snap.sessions[0].status).toBe(SessionStatus.failed);
		expect(snap.statusBySessionId["session_failed"]).toBe(
			SessionStatus.failed,
		);
	});

	it("assembles child sessions under their parent by id", () => {
		const parentLog: MissionControlSessionLogRecord = {
			path: "/fake/root/parent.jsonl",
			root: "/fake/root",
			sessionId: "parent",
			createdAt: "2025-01-01T00:00:00Z",
			mtimeMs: 0,
			envelopes: [
				{ type: "session.started", createdAt: "2025-01-01T00:00:00Z" },
				{
					type: "session.metadata.updated",
					createdAt: "2025-01-01T00:00:01Z",
					sessionTree: {
						cwd: "/home/user/project",
						sessionName: "parent",
						parentSessionId: null,
					},
				},
				{ type: "session.stopped", createdAt: "2025-01-01T00:01:00Z" },
			],
		};
		const childLog: MissionControlSessionLogRecord = {
			path: "/fake/root/child.jsonl",
			root: "/fake/root",
			sessionId: "child",
			createdAt: "2025-01-01T00:00:30Z",
			mtimeMs: 0,
			envelopes: [
				{ type: "session.started", createdAt: "2025-01-01T00:00:30Z" },
				{
					type: "session.metadata.updated",
					createdAt: "2025-01-01T00:00:31Z",
					sessionTree: {
						cwd: "/home/user/project",
						sessionName: "child",
						parentSessionId: "parent",
					},
				},
			],
		};
		const snap = buildMissionControlSnapshot({
			logs: [parentLog, childLog],
		});

		expect(snap.sessions).toHaveLength(1);
		expect(snap.sessions[0].id).toBe("parent");
		expect(snap.sessions[0].subagentSessions).toHaveLength(1);
		expect(snap.sessions[0].subagentSessions?.[0]?.id).toBe("child");
		expect(snap.sessions[0].subagentSessions?.[0]?.parent_id).toBe("parent");
	});

	it("falls back gracefully for a header-only log with zero envelopes", () => {
		const log: MissionControlSessionLogRecord = {
			path: "/fake/root/session_empty.jsonl",
			root: "/fake/root",
			sessionId: "session_empty",
			createdAt: "2025-01-01T00:00:00Z",
			mtimeMs: 0,
			envelopes: [],
		};
		const snap = buildMissionControlSnapshot({ logs: [log] });

		expect(snap.sessions).toHaveLength(1);
		expect(snap.sessions[0].status).toBe(SessionStatus.unknown);
		expect(snap.sessions[0].title).toBe("session_session_empty");
		expect(snap.sessions[0].directory).toBe("");
		expect(snap.sessions[0].project_label).toBe("Mission Control");
		expect(snap.sessions[0].time_created).toBe(
			Date.parse("2025-01-01T00:00:00Z"),
		);
		expect(snap.sessions[0].time_updated).toBe(
			snap.sessions[0].time_created,
		);
		expect(snap.statusBySessionId["session_empty"]).toBe(
			SessionStatus.unknown,
		);
		expect(snap.messageCountBySessionId["session_empty"]).toBe(0);
	});

	it("falls back to empty directory when sessionTree lacks cwd", () => {
		const log: MissionControlSessionLogRecord = {
			path: "/fake/root/no_cwd.jsonl",
			root: "/fake/root",
			sessionId: "no_cwd",
			createdAt: "2025-01-01T00:00:00Z",
			mtimeMs: 0,
			envelopes: [
				{ type: "session.started", createdAt: "2025-01-01T00:00:00Z" },
				{
					type: "session.metadata.updated",
					createdAt: "2025-01-01T00:00:01Z",
					sessionTree: { sessionName: "test" },
				},
				{
					type: "run.command.received",
					createdAt: "2025-01-01T00:00:02Z",
					message: "hello",
				},
			],
		};
		const snap = buildMissionControlSnapshot({ logs: [log] });

		expect(snap.sessions[0].directory).toBe("");
		expect(snap.sessions[0].project_label).toBe("Mission Control");
		expect(snap.sessions[0].title).toBe("hello");
		expect(snap.sessions[0].status).toBe(SessionStatus.running);
	});

	it("records a session issue when a child references a missing parent", () => {
		const orphanLog: MissionControlSessionLogRecord = {
			path: "/fake/root/orphan.jsonl",
			root: "/fake/root",
			sessionId: "orphan",
			createdAt: "2025-01-01T00:00:00Z",
			mtimeMs: 0,
			envelopes: [
				{ type: "session.started", createdAt: "2025-01-01T00:00:00Z" },
				{
					type: "session.metadata.updated",
					createdAt: "2025-01-01T00:00:01Z",
					sessionTree: {
						cwd: "/home/user/project",
						sessionName: "orphan",
						parentSessionId: "ghost_parent",
					},
				},
			],
		};
		const snap = buildMissionControlSnapshot({ logs: [orphanLog] });

		expect(snap.sessions).toHaveLength(0);
		expect(snap.sessionIssues["orphan"]).toBe(
			"Mission Control root session not found.",
		);
	});
});
