import { describe, expect, it } from "bun:test";
import {
	buildCodexSessionSnapshot,
	type CodexThreadRow,
	type CodexThreadSpawnEdgeRow,
	resolveCodexStatus,
	summarizeCodexSessionLogContent,
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
		const summary = summarizeCodexSessionLogContent(
			[
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
			].join("\n"),
		);

		expect(summary.sessionMeta?.originator).toBe("codex_cli");
		expect(summary.messageCount).toBe(2);
		expect(summary.taskState).toBe("completed");
		expect(summary.lastTurnId).toBe("turn-1");
		expect(summary.lastAgentMessage).toBe("done");
	});

	it("treats subagent completion notifications as terminal task state", () => {
		const notification = {
			author: "/root/task/member_context",
			recipient: "/root/task",
			other_recipients: [],
			content: [
				"<subagent_notification>",
				JSON.stringify({
					agent_path: "/root/task/member_context",
					status: {
						completed: "Blocked after collecting the member API context.",
					},
				}),
				"</subagent_notification>",
			].join("\n"),
			trigger_turn: false,
		};
		const summary = summarizeCodexSessionLogContent(
			[
				JSON.stringify({
					timestamp: "2026-04-22T09:00:01.000Z",
					type: "event_msg",
					payload: {
						type: "task_started",
						turn_id: "turn-1",
					},
				}),
				JSON.stringify({
					timestamp: "2026-04-22T09:00:02.000Z",
					type: "response_item",
					payload: {
						type: "message",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: JSON.stringify(notification),
							},
						],
					},
				}),
			].join("\n"),
		);

		expect(summary.taskState).toBe("completed");
		expect(summary.completedAtMs).toBe(Date.parse("2026-04-22T09:00:02.000Z"));
		expect(summary.lastAgentMessage).toBe(
			"Blocked after collecting the member API context.",
		);
	});

	it("extracts the latest list_agents roster from tool output", () => {
		const summary = summarizeCodexSessionLogContent(
			[
				JSON.stringify({
					timestamp: "2026-04-22T09:00:01.000Z",
					type: "response_item",
					payload: {
						type: "function_call",
						name: "list_agents",
						call_id: "call-1",
					},
				}),
				JSON.stringify({
					timestamp: "2026-04-22T09:00:02.000Z",
					type: "response_item",
					payload: {
						type: "function_call_output",
						call_id: "call-1",
						output: JSON.stringify({
							agents: [
								{
									agent_name: "/root",
									agent_status: "running",
									last_task_message: "Main thread",
								},
								{
									agent_name: "/root/task",
									agent_status: "shutdown",
									last_task_message: "Done",
								},
							],
						}),
					},
				}),
			].join("\n"),
		);

		expect(summary.latestAgentStates).toEqual([
			{
				agentName: "/root",
				agentStatus: "running",
				lastTaskMessage: "Main thread",
				observedAtMs: Date.parse("2026-04-22T09:00:02.000Z"),
			},
			{
				agentName: "/root/task",
				agentStatus: "shutdown",
				lastTaskMessage: "Done",
				observedAtMs: Date.parse("2026-04-22T09:00:02.000Z"),
			},
		]);
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
		expect(root.capabilities?.attach).toBe(true);
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

	it("closes descendants from their own completion state while the root is running", () => {
		const snapshot = buildCodexSessionSnapshot({
			threads: [rootThread, childThread, grandchildThread],
			edges: [openEdge, childOpenGrandchildEdge],
			logSummaries: {
				[rootThread.id]: {
					messageCount: 3,
					taskState: "running",
				},
				[childThread.id]: {
					messageCount: 1,
					taskState: "completed",
					lastAgentMessage: "Child complete",
				},
				[grandchildThread.id]: {
					messageCount: 1,
					taskState: "completed",
					lastAgentMessage: "Grandchild complete",
				},
			},
		});

		const [root] = snapshot.sessions;
		const activeChildren = root.subagentSessions?.filter(
			(session) => session.status === SessionStatus.running,
		);

		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Task running");
		expect(root.sourceMetadata?.openChildCount).toBe(0);
		expect(root.sourceMetadata?.closedChildCount).toBe(1);
		expect(activeChildren).toHaveLength(0);
		expect(snapshot.statusBySessionId[childThread.id]).toBe(
			SessionStatus.completed,
		);
		expect(snapshot.statusBySessionId[grandchildThread.id]).toBe(
			SessionStatus.completed,
		);
	});

	it("marks active descendants absent from a later agent roster as inactive", () => {
		const snapshot = buildCodexSessionSnapshot({
			threads: [rootThread, childThread],
			edges: [openEdge],
			logSummaries: {
				[rootThread.id]: {
					messageCount: 3,
					taskState: "running",
					latestAgentStates: [
						{
							agentName: "/root",
							agentStatus: "running",
							observedAtMs: 1_700_000_011_000,
						},
					],
				},
				[childThread.id]: {
					messageCount: 1,
					taskState: "running",
					sessionMeta: {
						agent_path: "/root/task",
					},
				},
			},
		});

		const [root] = snapshot.sessions;
		const [child] = root.subagentSessions ?? [];

		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Task running");
		expect(root.sourceMetadata?.openChildCount).toBe(0);
		expect(root.sourceMetadata?.closedChildCount).toBe(1);
		expect(child.status).toBe(SessionStatus.unknown);
		expect(child.statusDetail).toBe("Absent from latest agent list");
		expect(child.finishReason).toBe("subagent_absent_from_agent_roster");
		expect(snapshot.statusBySessionId[childThread.id]).toBe(
			SessionStatus.unknown,
		);
	});

	it("keeps active descendants created after the latest agent roster", () => {
		const snapshot = buildCodexSessionSnapshot({
			threads: [rootThread, childThread],
			edges: [openEdge],
			logSummaries: {
				[rootThread.id]: {
					messageCount: 3,
					taskState: "running",
					latestAgentStates: [
						{
							agentName: "/root",
							agentStatus: "running",
							observedAtMs: 1_700_000_004_000,
						},
					],
				},
				[childThread.id]: {
					messageCount: 1,
					taskState: "running",
					sessionMeta: {
						agent_path: "/root/task",
					},
				},
			},
		});

		const [root] = snapshot.sessions;
		const [child] = root.subagentSessions ?? [];

		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Task running with 1 open child thread");
		expect(child.status).toBe(SessionStatus.running);
		expect(snapshot.statusBySessionId[childThread.id]).toBe(
			SessionStatus.running,
		);
	});

	it("prefers a newer ancestor roster over an older nested running roster", () => {
		const snapshot = buildCodexSessionSnapshot({
			threads: [rootThread, childThread, grandchildThread],
			edges: [openEdge, childOpenGrandchildEdge],
			logSummaries: {
				[rootThread.id]: {
					messageCount: 3,
					taskState: "running",
					latestAgentStates: [
						{
							agentName: "/root",
							agentStatus: "running",
							observedAtMs: 1_700_000_040_000,
						},
					],
				},
				[childThread.id]: {
					messageCount: 1,
					taskState: "running",
					sessionMeta: {
						agent_path: "/root/task",
					},
					latestAgentStates: [
						{
							agentName: "/root/task/grandchild",
							agentStatus: "running",
							observedAtMs: 1_700_000_035_000,
						},
					],
				},
				[grandchildThread.id]: {
					messageCount: 1,
					taskState: "running",
					sessionMeta: {
						agent_path: "/root/task/grandchild",
					},
				},
			},
		});

		const [root] = snapshot.sessions;
		const child = root.subagentSessions?.find(
			(session) => session.id === childThread.id,
		);
		const grandchild = root.subagentSessions?.find(
			(session) => session.id === grandchildThread.id,
		);

		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Task running");
		expect(child?.status).toBe(SessionStatus.unknown);
		expect(grandchild?.status).toBe(SessionStatus.unknown);
		expect(grandchild?.finishReason).toBe("subagent_absent_from_agent_roster");
	});
});
