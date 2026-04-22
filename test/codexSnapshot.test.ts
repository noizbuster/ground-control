import { describe, expect, it } from "bun:test";
import {
	buildCodexSessionSnapshot,
	resolveCodexStatus,
	summarizeCodexSessionLogContent,
	type CodexThreadRow,
	type CodexThreadSpawnEdgeRow,
} from "../src/db/codex";
import { SessionStatus } from "../src/types";

const rootThread: CodexThreadRow = {
	id: "root-thread-0000-0000-0000-000000000001".slice(0, 36),
	source: "cli",
	model_provider: "openai",
	cwd: "/repo/app",
	title: "$plan",
	agent_role: null,
	agent_nickname: null,
	model: "gpt-5.4",
	reasoning_effort: "high",
	archived: 0,
	created_at_ms: 1_700_000_000_000,
	updated_at_ms: 1_700_000_010_000,
};

const childThread: CodexThreadRow = {
	id: "child-thread-000-0000-0000-000000000002".slice(0, 36),
	source: JSON.stringify({
		subagent: {
			thread_spawn: {
				parent_thread_id: rootThread.id,
				agent_role: "explore",
				agent_nickname: "Scout",
			},
		},
	}),
	model_provider: "openai",
	cwd: "/repo/app",
	title: "Inspect tree",
	agent_role: "explore",
	agent_nickname: "Scout",
	model: "gpt-5.4-mini",
	reasoning_effort: "medium",
	archived: 0,
	created_at_ms: 1_700_000_005_000,
	updated_at_ms: 1_700_000_020_000,
};

const grandchildThread: CodexThreadRow = {
	id: "grandchild-thread-0000-0000-00000003".slice(0, 36),
	source: JSON.stringify({
		subagent: {
			thread_spawn: {
				parent_thread_id: childThread.id,
				agent_role: "explore",
				agent_nickname: "Sprout",
			},
		},
	}),
	model_provider: "openai",
	cwd: "/repo/app",
	title: "Inspect leaf",
	agent_role: "explore",
	agent_nickname: "Sprout",
	model: "gpt-5.4-mini",
	reasoning_effort: "medium",
	archived: 0,
	created_at_ms: 1_700_000_006_000,
	updated_at_ms: 1_700_000_030_000,
};

const openEdge: CodexThreadSpawnEdgeRow = {
	parent_thread_id: rootThread.id,
	child_thread_id: childThread.id,
	status: "open",
};

const childOpenGrandchildEdge: CodexThreadSpawnEdgeRow = {
	parent_thread_id: childThread.id,
	child_thread_id: grandchildThread.id,
	status: "open",
};

describe("summarizeCodexSessionLogContent", () => {
	it("extracts session meta, message counts, and task state", () => {
		const summary = summarizeCodexSessionLogContent([
			JSON.stringify({
				timestamp: "2026-04-22T09:00:00.000Z",
				type: "session_meta",
				payload: {
					id: rootThread.id,
					cwd: "/repo/app",
					originator: "codex_cli",
					cli_version: "0.122.0",
					source: "cli",
					model_provider: "openai",
				},
			}),
			JSON.stringify({
				timestamp: "2026-04-22T09:00:01.000Z",
				type: "event_msg",
				payload: {
					type: "task_started",
					turn_id: "turn-1",
					started_at: 1_700_000_001,
				},
			}),
			JSON.stringify({
				timestamp: "2026-04-22T09:00:02.000Z",
				type: "event_msg",
				payload: { type: "user_message", message: "hello" },
			}),
			JSON.stringify({
				timestamp: "2026-04-22T09:00:03.000Z",
				type: "response_item",
				payload: { type: "message", role: "assistant" },
			}),
			JSON.stringify({
				timestamp: "2026-04-22T09:00:04.000Z",
				type: "event_msg",
				payload: {
					type: "task_complete",
					turn_id: "turn-1",
					completed_at: 1_700_000_004,
					last_agent_message: "done",
				},
			}),
		].join("\n"));

		expect(summary.sessionMeta?.originator).toBe("codex_cli");
		expect(summary.messageCount).toBe(2);
		expect(summary.taskState).toBe("completed");
		expect(summary.lastTurnId).toBe("turn-1");
		expect(summary.lastAgentMessage).toBe("done");
	});
});

describe("resolveCodexStatus", () => {
	it("keeps completed roots active when open child threads exist", () => {
		expect(
			resolveCodexStatus({
				summary: { messageCount: 0, taskState: "completed" },
				edgeStats: { openChildCount: 2, closedChildCount: 0 },
			}),
		).toEqual({
			status: SessionStatus.running,
			finishReason: "awaiting_child_threads",
			statusDetail: "Awaiting 2 child threads",
		});
	});

	it("maps aborted turns to unknown with explicit detail", () => {
		expect(
			resolveCodexStatus({
				summary: {
					messageCount: 0,
					taskState: "aborted",
					abortedReason: "interrupted",
				},
			}),
		).toEqual({
			status: SessionStatus.unknown,
			finishReason: "turn_aborted",
			statusDetail: "Turn aborted (interrupted)",
		});
	});
});

describe("buildCodexSessionSnapshot", () => {
	it("builds a root plus child hierarchy with codex metadata", () => {
		const snapshot = buildCodexSessionSnapshot({
			threads: [rootThread, childThread],
			edges: [openEdge],
			logSummaries: {
				[rootThread.id]: {
					messageCount: 3,
					taskState: "completed",
					sessionMeta: {
						cwd: "/repo/app",
						originator: "codex_cli",
						cli_version: "0.122.0",
						source: "cli",
					},
				},
				[childThread.id]: {
					messageCount: 1,
					taskState: "running",
					sessionMeta: {
						cwd: "/repo/app",
						originator: "codex_exec",
						source: "exec",
					},
				},
			},
		});

		expect(snapshot.sessions).toHaveLength(1);
		const [root] = snapshot.sessions;
		expect(root.sessionSource).toBe("codex");
		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Awaiting 1 child thread");
		expect(root.capabilities?.attach).toBe(false);
		expect(root.sourceMetadata?.sourceCategory).toBe("CLI");
		expect(root.currentReasoningEffort).toBe("high");
		expect(snapshot.messageCountBySessionId[root.id]).toBe(3);

		expect(root.subagentSessions).toHaveLength(1);
		const [child] = root.subagentSessions ?? [];
		expect(child.parent_id).toBe(root.id);
		expect(child.status).toBe(SessionStatus.running);
		expect(child.sourceMetadata?.agentRole).toBe("explore");
		expect(child.sourceMetadata?.agentNickname).toBe("Scout");
		expect(snapshot.statusBySessionId[child.id]).toBe(SessionStatus.running);
	});

	it("treats terminal child sessions as closed even when the edge is still open", () => {
		const snapshot = buildCodexSessionSnapshot({
			threads: [rootThread, childThread],
			edges: [openEdge],
			logSummaries: {
				[rootThread.id]: {
					messageCount: 3,
					taskState: "completed",
				},
				[childThread.id]: {
					messageCount: 1,
					taskState: "completed",
				},
			},
		});

		const [root] = snapshot.sessions;
		expect(root.status).toBe(SessionStatus.completed);
		expect(root.statusDetail).toBe("Task complete");
		expect(root.sourceMetadata?.openChildCount).toBe(0);
		expect(root.sourceMetadata?.closedChildCount).toBe(1);
		expect(snapshot.statusBySessionId[root.id]).toBe(SessionStatus.completed);
	});

	it("keeps parents active when a completed child is still awaiting its own child thread", () => {
		const snapshot = buildCodexSessionSnapshot({
			threads: [rootThread, childThread, grandchildThread],
			edges: [openEdge, childOpenGrandchildEdge],
			logSummaries: {
				[rootThread.id]: {
					messageCount: 3,
					taskState: "completed",
				},
				[childThread.id]: {
					messageCount: 1,
					taskState: "completed",
				},
				[grandchildThread.id]: {
					messageCount: 1,
					taskState: "running",
				},
			},
		});

		const [root] = snapshot.sessions;
		const child = root.subagentSessions?.find(
			(session) => session.id === childThread.id,
		);

		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Awaiting 1 child thread");
		expect(child?.status).toBe(SessionStatus.running);
		expect(child?.statusDetail).toBe("Awaiting 1 child thread");
		expect(snapshot.statusBySessionId[root.id]).toBe(SessionStatus.running);
		expect(snapshot.statusBySessionId[childThread.id]).toBe(
			SessionStatus.running,
		);
	});
});
