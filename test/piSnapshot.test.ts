import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildPiSessionSnapshot,
	type PiSessionLogRecord,
	resolvePiSessionRoots,
} from "../src/db/pi";
import { SessionStatus } from "../src/types";

const withEnvironment = <T>(
	updates: Record<string, string | undefined>,
	run: () => T,
): T => {
	const previous: Record<string, string | undefined> = {};
	for (const key of Object.keys(updates)) {
		previous[key] = process.env[key];
		const value = updates[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return run();
	} finally {
		for (const key of Object.keys(updates)) {
			const value = previous[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
};

const piRootLog: PiSessionLogRecord = {
	source: "pi",
	root: "/tmp/pi-sessions",
	path: "/tmp/pi-sessions/-repo-app/pi-root.jsonl",
	mtimeMs: 1_700_000_003_000,
	header: {
		type: "session",
		version: 3,
		id: "pi-root",
		timestamp: "2026-05-29T09:00:00.000Z",
		cwd: "/repo/app",
	},
	entries: [
		{
			type: "session_info",
			timestamp: "2026-05-29T09:00:00.100Z",
			name: "Investigate pi support",
		},
		{
			type: "model_change",
			timestamp: "2026-05-29T09:00:00.200Z",
			provider: "anthropic",
			modelId: "claude-sonnet-4",
		},
		{
			type: "thinking_level_change",
			timestamp: "2026-05-29T09:00:00.300Z",
			thinkingLevel: "high",
		},
		{
			type: "message",
			timestamp: "2026-05-29T09:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "please add pi support" }],
			},
		},
		{
			type: "message",
			timestamp: "2026-05-29T09:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stop_reason: "stop",
			},
		},
	],
};

describe("buildPiSessionSnapshot", () => {
	it("resolves upstream omp session root candidates", () => {
		withEnvironment(
			{
				GCTRL_OMP_SESSIONS_DIR: undefined,
				PI_CODING_AGENT_DIR: undefined,
				PI_CONFIG_DIR: ".custom-omp",
				XDG_CONFIG_HOME: "/tmp/gctrl-xdg-config",
				XDG_DATA_HOME: "/tmp/gctrl-xdg-data",
			},
			() => {
				const roots = resolvePiSessionRoots("omp");

				expect(roots).toContain(
					join("/tmp/gctrl-xdg-data", "omp", "sessions"),
				);
				expect(roots).toContain(
					join("/tmp/gctrl-xdg-data", "omp", "agent", "sessions"),
				);
				expect(roots).toContain(
					join("/tmp/gctrl-xdg-config", "omp", "sessions"),
				);
				expect(roots).toContain(
					join(homedir(), ".custom-omp", "sessions"),
				);
				expect(roots).toContain(
					join(homedir(), ".custom-omp", "agent", "sessions"),
				);
			},
		);
	});

	it("builds Pi sessions with metadata, model, reasoning, and completed status", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "pi",
			logs: [piRootLog],
		});

		expect(snapshot.sessions).toHaveLength(1);
		const [session] = snapshot.sessions;
		expect(session.sessionSource).toBe("pi");
		expect(session.title).toBe("Investigate pi support");
		expect(session.project_label).toBe("app");
		expect(session.status).toBe(SessionStatus.completed);
		expect(session.finishReason).toBe("stop");
		expect(session.currentModelID).toBe("claude-sonnet-4");
		expect(session.providerID).toBe("anthropic");
		expect(session.currentReasoningEffort).toBe("high");
		expect(session.sourceMetadata?.sessionPath).toBe(piRootLog.path);
		expect(session.capabilities).toEqual({
			attach: true,
			delete: true,
			abortChildren: false,
			hierarchy: true,
		});
		expect(snapshot.messageCountBySessionId["pi-root"]).toBe(2);
		expect(snapshot.statusBySessionId["pi-root"]).toBe(SessionStatus.completed);
	});

	it("builds omp hierarchy and marks roots with active children as running", () => {
		const rootPath = "/tmp/omp-sessions/-repo-app/omp-root.jsonl";
		const childPath = "/tmp/omp-sessions/-repo-app/omp-child.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: rootPath,
					mtimeMs: 1_700_000_020_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-root",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
						title: "Root title from header",
						titleSource: "manual",
					},
					entries: [
						{
							type: "mode_change",
							timestamp: "2026-05-29T09:00:00.200Z",
							mode: "code",
						},
						{
							type: "model_change",
							timestamp: "2026-05-29T09:00:00.300Z",
							model: "openai/gpt-5.4",
							role: "planner",
						},
						{
							type: "message",
							timestamp: "2026-05-29T09:00:01.000Z",
							message: {
								role: "assistant",
								content: "ready",
								stop_reason: "stop",
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: childPath,
					mtimeMs: 1_700_000_030_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-child",
						timestamp: "2026-05-29T09:01:00.000Z",
						cwd: "/repo/app",
						parentSession: rootPath,
					},
					entries: [
						{
							type: "session_init",
							timestamp: "2026-05-29T09:01:00.100Z",
							task: "continue",
							tools: ["bash"],
						},
						{
							type: "message",
							timestamp: "2026-05-29T09:01:01.000Z",
							message: { role: "user", content: "continue" },
						},
					],
				},
			],
		});

		expect(snapshot.sessions).toHaveLength(1);
		const [root] = snapshot.sessions;
		expect(root.sessionSource).toBe("omp");
		expect(root.title).toBe("Root title from header");
		expect(root.currentModelID).toBe("gpt-5.4");
		expect(root.providerID).toBe("openai");
		expect(root.currentVariant).toBe("planner");
		expect(root.currentAgent).toBeUndefined();
		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Awaiting 1 child session");
		expect(root.sourceMetadata?.sourceCategory).toBe("omp");
		expect(root.sourceMetadata?.openChildCount).toBe(1);
		expect(root.sourceMetadata?.closedChildCount).toBe(0);
		expect(root.subagentSessions).toHaveLength(1);
		const [child] = root.subagentSessions ?? [];
		expect(child.id).toBe("omp-child");
		expect(child.parent_id).toBe("omp-root");
		expect(child.status).toBe(SessionStatus.running);
		expect(child.sourceMetadata?.parentSessionPath).toBe(rootPath);
		expect(child.currentAgent).toBe("subagent");
		expect(child.sourceMetadata?.agentRole).toBe("subagent");
	});

	it("uses the current Pi entry tree branch for counts and status", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "pi",
			logs: [
				{
					source: "pi",
					root: "/tmp/pi-sessions",
					path: "/tmp/pi-sessions/-repo-app/branched.jsonl",
					mtimeMs: 1_700_000_040_000,
					header: {
						type: "session",
						version: 3,
						id: "pi-branched",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "root-msg",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "start" },
						},
						{
							type: "message",
							id: "active-user",
							parentId: "root-msg",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: { role: "user", content: "active branch" },
						},
						{
							type: "message",
							id: "inactive-assistant",
							parentId: "root-msg",
							timestamp: "2026-05-29T09:00:03.000Z",
							message: {
								role: "assistant",
								content: "inactive",
								stopReason: "stop",
							},
						},
						{
							type: "leaf",
							id: "leaf-marker",
							parentId: "inactive-assistant",
							targetId: "active-user",
							timestamp: "2026-05-29T09:00:04.000Z",
						},
					],
				},
			],
		});

		expect(snapshot.messageCountBySessionId["pi-branched"]).toBe(2);
		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.running);
		expect(snapshot.sessions[0]?.title).toBe("start");
	});

	it("maps assistant tool-use stops to running while awaiting tool results", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "pi",
			logs: [
				{
					source: "pi",
					root: "/tmp/pi-sessions",
					path: "/tmp/pi-sessions/-repo-app/tool-use.jsonl",
					mtimeMs: 1_700_000_050_000,
					header: {
						type: "session",
						version: 3,
						id: "pi-tool-use",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "run tests" },
						},
						{
							type: "message",
							id: "assistant",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "call-1",
										name: "bash",
										arguments: {},
									},
								],
								provider: "anthropic",
								model: "claude-sonnet-4",
								stopReason: "toolUse",
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.running);
		expect(snapshot.sessions[0]?.finishReason).toBe("toolUse");
		expect(snapshot.sessions[0]?.statusDetail).toBe("Awaiting tool result");
	});

	it("maps OMP ask tool-use stops to awaiting user input", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/awaiting-user.jsonl",
					mtimeMs: 1_700_000_050_100,
					header: {
						type: "session",
						version: 3,
						id: "omp-awaiting-user",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "continue safely" },
						},
						{
							type: "active_tools_change",
							id: "tools",
							parentId: "user",
							timestamp: "2026-05-29T09:00:01.500Z",
							activeToolNames: ["bash"],
						},
						{
							type: "message",
							id: "assistant",
							parentId: "tools",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "ask-1",
										name: "ask",
										arguments: { questions: [] },
									},
								],
								stopReason: "toolUse",
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.waiting);
		expect(snapshot.sessions[0]?.finishReason).toBe("awaiting_user");
		expect(snapshot.sessions[0]?.statusDetail).toBe("Awaiting user input");
		expect(snapshot.statusBySessionId["omp-awaiting-user"]).toBe(
			SessionStatus.waiting,
		);
	});

	it("maps idle yield tool-use handoffs to waiting without opening child counts", () => {
		const parentPath = "/tmp/omp-sessions/-repo-app/idle-yield-parent.jsonl";
		const childPath = "/tmp/omp-sessions/-repo-app/idle-yield-child.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: parentPath,
					mtimeMs: 1_700_000_050_100,
					header: {
						type: "session",
						version: 3,
						id: "omp-idle-yield-parent",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
						title: "Idle yield parent",
					},
					entries: [
						{
							type: "message",
							id: "assistant",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: {
								role: "assistant",
								content: "ready",
								stopReason: "stop",
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: childPath,
					mtimeMs: 1_700_000_050_200,
					header: {
						type: "session",
						version: 3,
						id: "omp-idle-yield-child",
						timestamp: "2026-05-29T09:00:02.000Z",
						cwd: "/repo/app",
						parentSession: parentPath,
					},
					entries: [
						{
							type: "active_tools_change",
							id: "tools",
							parentId: null,
							timestamp: "2026-05-29T09:00:03.000Z",
							activeToolNames: [],
						},
						{
							type: "message",
							id: "assistant",
							parentId: "tools",
							timestamp: "2026-05-29T09:00:04.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "yield-1",
										toolCall: {
											name: "yield",
											arguments: {},
										},
									},
								],
								stopReason: "toolUse",
							},
						},
					],
				},
			],
		});

		const [parent] = snapshot.sessions;
		const [child] = parent.subagentSessions ?? [];
		expect(child.status).toBe(SessionStatus.waiting);
		expect(child.finishReason).toBe("toolUse");
		expect(child.statusDetail).toBe("Idle between prompts");
		expect(snapshot.statusBySessionId["omp-idle-yield-child"]).toBe(
			SessionStatus.waiting,
		);
		expect(parent.sourceMetadata?.openChildCount).toBe(0);
		expect(parent.sourceMetadata?.closedChildCount).toBe(1);
		expect(parent.status).toBe(SessionStatus.completed);
	});

	it("treats yield-only tool-use handoffs as idle even with stale active tools", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/stale-active-tools-yield.jsonl",
					mtimeMs: 1_700_000_050_200,
					header: {
						type: "session",
						version: 3,
						id: "omp-stale-active-tools-yield",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "active_tools_change",
							id: "tools",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							activeToolNames: ["bash"],
						},
						{
							type: "message",
							id: "assistant",
							parentId: "tools",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: [
									{ type: "toolCall", id: "yield-1", name: "yield" },
								],
								stopReason: "toolUse",
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.waiting);
		expect(snapshot.sessions[0]?.statusDetail).toBe("Idle between prompts");
		expect(snapshot.sessions[0]?.finishReason).toBe("toolUse");
		expect(snapshot.statusBySessionId["omp-stale-active-tools-yield"]).toBe(
			SessionStatus.waiting,
		);
	});

	it("ignores stale running task progress for idle yield children", () => {
		const parentPath = "/tmp/omp-sessions/-repo-app/stale-progress-parent.jsonl";
		const childPath = "/tmp/omp-sessions/-repo-app/stale-progress-child.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: parentPath,
					mtimeMs: 1_700_000_050_300,
					header: {
						type: "session",
						version: 3,
						id: "omp-stale-progress-parent",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
						title: "Stale progress parent",
					},
					entries: [
						{
							type: "message",
							id: "progress",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							details: {
								progress: [
									{
										id: "IdleLane",
										sessionId: "omp-stale-progress-child",
										agent: "task",
										status: "running",
									},
								],
							},
							message: {
								role: "toolResult",
								toolName: "task",
								content: [{ type: "text", text: "still running" }],
							},
						},
						{
							type: "message",
							id: "assistant",
							parentId: "progress",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: "parent done",
								stopReason: "stop",
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: childPath,
					mtimeMs: 1_700_000_050_400,
					header: {
						type: "session",
						version: 3,
						id: "omp-stale-progress-child",
						timestamp: "2026-05-29T09:00:03.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant",
							parentId: null,
							timestamp: "2026-05-29T09:00:04.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "yield-1",
										name: "yield",
										arguments: {},
									},
								],
								stopReason: "toolUse",
							},
						},
					],
				},
			],
		});

		const [parent] = snapshot.sessions;
		const [child] = parent.subagentSessions ?? [];
		expect(child.status).toBe(SessionStatus.waiting);
		expect(child.finishReason).toBe("toolUse");
		expect(child.statusDetail).toBe("Idle between prompts");
		expect(snapshot.statusBySessionId["omp-stale-progress-child"]).toBe(
			SessionStatus.waiting,
		);
		expect(parent.sourceMetadata?.openChildCount).toBe(0);
		expect(parent.sourceMetadata?.closedChildCount).toBe(1);
		expect(parent.status).toBe(SessionStatus.completed);
	});

	it("uses completed omp task metadata over a child tool-use tail", () => {
		const parentPath = "/tmp/omp-sessions/-repo-app/completed-parent.jsonl";
		const childPath = "/tmp/omp-sessions/-repo-app/completed-child.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: parentPath,
					mtimeMs: 1_700_000_051_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-completed-parent",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "spawn a worker" },
						},
						{
							type: "message",
							id: "tool-result",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "toolResult",
								toolName: "task",
								content: [{ type: "text", text: "worker finished" }],
								details: {
									results: [
										{
											id: "DoneLane",
											sessionId: "omp-completed-child",
											agent: "task",
											status: "completed",
										},
									],
									progress: [
										{
											id: "DoneLane",
											sessionId: "omp-completed-child",
											agent: "task",
											status: "running",
										},
									],
								},
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: childPath,
					mtimeMs: 1_700_000_052_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-completed-child",
						timestamp: "2026-05-29T09:00:03.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant",
							parentId: null,
							timestamp: "2026-05-29T09:00:04.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "yield-1",
										name: "yield",
										arguments: {},
									},
								],
								stopReason: "toolUse",
							},
						},
					],
				},
			],
		});

		const [parent] = snapshot.sessions;
		const [child] = parent.subagentSessions ?? [];
		expect(child.status).toBe(SessionStatus.completed);
		expect(child.statusDetail).toBe("Task complete");
		expect(child.finishReason).toBeUndefined();
		expect(snapshot.statusBySessionId["omp-completed-child"]).toBe(
			SessionStatus.completed,
		);
		expect(parent.sourceMetadata?.openChildCount).toBe(0);
	});

	it("completes OMP task children from success metadata and yield result tails", () => {
		const parentPath = "/tmp/omp-sessions/-repo-app/yield-result-parent.jsonl";
		const childPath = "/tmp/omp-sessions/-repo-app/yield-result-child.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: parentPath,
					mtimeMs: 1_700_000_052_100,
					header: {
						type: "session",
						version: 3,
						id: "omp-yield-result-parent",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "spawn a task" },
						},
						{
							type: "message",
							id: "task-result",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "toolResult",
								toolName: "task",
								content: [{ type: "text", text: "task finished" }],
								details: {
									results: [
										{
											id: "YieldLane",
											sessionId: "omp-yield-result-child",
											agent: "task",
											exitCode: 0,
											aborted: false,
											extractedToolData: {
												yield: [{ status: "success" }],
											},
										},
									],
								},
							},
						},
						{
							type: "message",
							id: "assistant",
							parentId: "task-result",
							timestamp: "2026-05-29T09:00:03.000Z",
							message: {
								role: "assistant",
								content: "parent done",
								stopReason: "stop",
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: childPath,
					mtimeMs: 1_700_000_052_200,
					header: {
						type: "session",
						version: 3,
						id: "omp-yield-result-child",
						timestamp: "2026-05-29T09:00:04.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant-yield",
							parentId: null,
							timestamp: "2026-05-29T09:00:05.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "yield-1",
										name: "yield",
										arguments: {},
									},
								],
								stopReason: "toolUse",
							},
						},
						{
							type: "message",
							id: "yield-result",
							parentId: "assistant-yield",
							timestamp: "2026-05-29T09:00:06.000Z",
							message: {
								role: "toolResult",
								toolName: "yield",
								content: [{ type: "text", text: "Result submitted." }],
								details: { status: "success" },
							},
						},
					],
				},
			],
		});

		const [parent] = snapshot.sessions;
		const [child] = parent.subagentSessions ?? [];
		expect(child.status).toBe(SessionStatus.completed);
		expect(child.statusDetail).toBe("Task complete");
		expect(child.finishReason).toBeUndefined();
		expect(snapshot.statusBySessionId["omp-yield-result-child"]).toBe(
			SessionStatus.completed,
		);
		expect(parent.sourceMetadata?.openChildCount).toBe(0);
		expect(parent.sourceMetadata?.closedChildCount).toBe(1);
	});

	it("does not infer completed task metadata for failed, aborted, or incomplete results", () => {
		const parentPath = "/tmp/omp-sessions/-repo-app/not-completed-parent.jsonl";
		const failedChildPath = "/tmp/omp-sessions/-repo-app/not-completed-failed.jsonl";
		const abortedChildPath =
			"/tmp/omp-sessions/-repo-app/not-completed-aborted.jsonl";
		const incompleteChildPath =
			"/tmp/omp-sessions/-repo-app/not-completed-incomplete.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: parentPath,
					mtimeMs: 1_700_000_052_300,
					header: {
						type: "session",
						version: 3,
						id: "omp-not-completed-parent",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "task-result",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: {
								role: "toolResult",
								toolName: "task",
								content: [{ type: "text", text: "task ended" }],
								details: {
									results: [
										{
											id: "FailedLane",
											sessionId: "omp-not-completed-failed",
											agent: "task",
											exitCode: 1,
											aborted: false,
											extractedToolData: {
												yield: [{ status: "success" }],
											},
										},
										{
											id: "AbortedLane",
											sessionId: "omp-not-completed-aborted",
											agent: "task",
											exitCode: 0,
											aborted: true,
											extractedToolData: {
												yield: [{ status: "success" }],
											},
										},
										{
											id: "IncompleteLane",
											sessionId: "omp-not-completed-incomplete",
											agent: "task",
											aborted: false,
										},
									],
									progress: [
										{
											id: "FailedLane",
											sessionId: "omp-not-completed-failed",
											agent: "task",
											status: "running",
										},
										{
											id: "AbortedLane",
											sessionId: "omp-not-completed-aborted",
											agent: "task",
											status: "running",
										},
									],
								},
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: failedChildPath,
					mtimeMs: 1_700_000_052_400,
					header: {
						type: "session",
						version: 3,
						id: "omp-not-completed-failed",
						timestamp: "2026-05-29T09:00:02.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant-yield",
							parentId: null,
							timestamp: "2026-05-29T09:00:03.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "yield-1",
										name: "yield",
										arguments: {},
									},
								],
								stopReason: "toolUse",
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: abortedChildPath,
					mtimeMs: 1_700_000_052_500,
					header: {
						type: "session",
						version: 3,
						id: "omp-not-completed-aborted",
						timestamp: "2026-05-29T09:00:04.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant-yield",
							parentId: null,
							timestamp: "2026-05-29T09:00:05.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "yield-1",
										name: "yield",
										arguments: {},
									},
								],
								stopReason: "toolUse",
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: incompleteChildPath,
					mtimeMs: 1_700_000_052_600,
					header: {
						type: "session",
						version: 3,
						id: "omp-not-completed-incomplete",
						timestamp: "2026-05-29T09:00:06.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant-yield",
							parentId: null,
							timestamp: "2026-05-29T09:00:07.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "yield-1",
										name: "yield",
										arguments: {},
									},
								],
								stopReason: "toolUse",
							},
						},
					],
				},
			],
		});

		const [parent] = snapshot.sessions;
		const childrenById = new Map(
			(parent.subagentSessions ?? []).map((child) => [child.id, child]),
		);
		expect(childrenById.get("omp-not-completed-failed")?.status).toBe(
			SessionStatus.failed,
		);
		expect(childrenById.get("omp-not-completed-failed")?.statusDetail).toBe(
			"Task failed",
		);
		expect(childrenById.get("omp-not-completed-aborted")?.status).toBe(
			SessionStatus.unknown,
		);
		expect(childrenById.get("omp-not-completed-aborted")?.statusDetail).toBe(
			"Task aborted",
		);
		expect(childrenById.get("omp-not-completed-incomplete")?.status).toBe(
			SessionStatus.waiting,
		);
		expect(childrenById.get("omp-not-completed-incomplete")?.finishReason).toBe(
			"toolUse",
		);
		expect(snapshot.statusBySessionId["omp-not-completed-failed"]).toBe(
			SessionStatus.failed,
		);
		expect(snapshot.statusBySessionId["omp-not-completed-aborted"]).toBe(
			SessionStatus.unknown,
		);
		expect(snapshot.statusBySessionId["omp-not-completed-incomplete"]).toBe(
			SessionStatus.waiting,
		);
	});

	it("keeps successful non-yield toolResult tails running", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/bash-result-tail.jsonl",
					mtimeMs: 1_700_000_052_600,
					header: {
						type: "session",
						version: 3,
						id: "omp-bash-result-tail",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant-bash",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "bash-1",
										name: "bash",
										arguments: {},
									},
								],
								stopReason: "toolUse",
							},
						},
						{
							type: "message",
							id: "bash-result",
							parentId: "assistant-bash",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "toolResult",
								toolName: "bash",
								content: [{ type: "text", text: "Result submitted." }],
								details: { status: "success" },
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.running);
		expect(snapshot.sessions[0]?.finishReason).toBe("toolUse");
		expect(snapshot.statusBySessionId["omp-bash-result-tail"]).toBe(
			SessionStatus.running,
		);
	});

	it("marks OMP sessions completed when the final assistant message stops after tool work", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/stopped-after-tools.jsonl",
					mtimeMs: 1_700_000_052_700,
					header: {
						type: "session",
						version: 3,
						id: "omp-stopped-after-tools",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "active_tools_change",
							id: "tools",
							parentId: null,
							timestamp: "2026-05-29T09:00:00.500Z",
							activeToolNames: ["bash"],
						},
						{
							type: "message",
							id: "assistant-tool",
							parentId: "tools",
							timestamp: "2026-05-29T09:00:01.000Z",
							message: {
								role: "assistant",
								content: [
									{ type: "toolCall", id: "bash-1", name: "bash" },
								],
								stopReason: "toolUse",
							},
						},
						{
							type: "message",
							id: "tool-result",
							parentId: "assistant-tool",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "toolResult",
								toolName: "bash",
								content: [{ type: "text", text: "done" }],
							},
						},
						{
							type: "message",
							id: "assistant-stop",
							parentId: "tool-result",
							timestamp: "2026-05-29T09:00:03.000Z",
							message: {
								role: "assistant",
								content: "done",
								stopReason: "stop",
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.completed);
		expect(snapshot.sessions[0]?.finishReason).toBe("stop");
		expect(snapshot.statusBySessionId["omp-stopped-after-tools"]).toBe(
			SessionStatus.completed,
		);
	});

	it("marks OMP sessions completed when stale active tools are appended after final stop", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/post-stop-active-tools.jsonl",
					mtimeMs: 1_700_000_052_800,
					header: {
						type: "session",
						version: 3,
						id: "omp-post-stop-active-tools",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant-stop",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: {
								role: "assistant",
								content: "done",
								stopReason: "stop",
							},
						},
						{
							type: "active_tools_change",
							id: "stale-tools",
							parentId: null,
							timestamp: "2026-05-29T09:00:02.000Z",
							activeToolNames: ["bash"],
						},
						{
							type: "leaf",
							id: "leaf-marker",
							parentId: "stale-tools",
							targetId: "stale-tools",
							timestamp: "2026-05-29T09:00:03.000Z",
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.completed);
		expect(snapshot.sessions[0]?.finishReason).toBe("stop");
		expect(snapshot.statusBySessionId["omp-post-stop-active-tools"]).toBe(
			SessionStatus.completed,
		);
	});

	it("maps pi end-turn sessions to idle waiting semantics", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "pi",
			logs: [
				{
					source: "pi",
					root: "/tmp/pi-sessions",
					path: "/tmp/pi-sessions/-repo-app/end-turn.jsonl",
					mtimeMs: 1_700_000_053_000,
					header: {
						type: "session",
						version: 3,
						id: "pi-end-turn",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "hello" },
						},
						{
							type: "message",
							id: "assistant",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: "ready",
								stop_reason: "end_turn",
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.status).toBe(SessionStatus.waiting);
		expect(snapshot.sessions[0]?.finishReason).toBe("end_turn");
		expect(snapshot.sessions[0]?.statusDetail).toBe("Idle between prompts");
		expect(snapshot.statusBySessionId["pi-end-turn"]).toBe(SessionStatus.waiting);
	});

	it("uses OMP default model role for the displayed model and keeps non-default roles as metadata", () => {
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/model-roles.jsonl",
					mtimeMs: 1_700_000_060_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-model-roles",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "model_change",
							id: "default-model",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							model: "openai/gpt-5.4",
							role: "default",
						},
						{
							type: "model_change",
							id: "smol-model",
							parentId: "default-model",
							timestamp: "2026-05-29T09:00:02.000Z",
							model: "openai/gpt-5.4-mini",
							role: "smol",
						},
						{
							type: "message",
							id: "assistant",
							parentId: "smol-model",
							timestamp: "2026-05-29T09:00:03.000Z",
							message: {
								role: "assistant",
								content: "done",
								provider: "fallback",
								model: "wrong-fallback",
								stopReason: "stop",
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions[0]?.currentModelID).toBe("gpt-5.4");
		expect(snapshot.sessions[0]?.providerID).toBe("openai");
		expect(snapshot.sessions[0]?.currentVariant).toBeUndefined();
		expect(snapshot.sessions[0]?.sourceMetadata?.modelRole).toBe("smol");
	});

	it("uses active tool changes and silent OMP aborts for status detail", () => {
		const activeToolSnapshot = buildPiSessionSnapshot({
			source: "pi",
			logs: [
				{
					source: "pi",
					root: "/tmp/pi-sessions",
					path: "/tmp/pi-sessions/-repo-app/active-tools.jsonl",
					mtimeMs: 1_700_000_070_000,
					header: {
						type: "session",
						version: 3,
						id: "pi-active-tools",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "active_tools_change",
							id: "tools",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							activeToolNames: ["bash"],
						},
					],
				},
			],
		});
		expect(activeToolSnapshot.sessions[0]?.status).toBe(SessionStatus.running);
		expect(activeToolSnapshot.sessions[0]?.statusDetail).toBe("Running bash");
		expect(
			activeToolSnapshot.sessions[0]?.sourceMetadata?.activeToolNames,
		).toEqual(["bash"]);

		const silentAbortSnapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/silent-abort.jsonl",
					mtimeMs: 1_700_000_080_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-silent-abort",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "plan" },
						},
						{
							type: "message",
							id: "assistant",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: [],
								stopReason: "aborted",
								errorMessage: "__omp.silent_abort__",
							},
						},
					],
				},
			],
		});
		expect(silentAbortSnapshot.sessions[0]?.status).toBe(SessionStatus.unknown);
		expect(silentAbortSnapshot.sessions[0]?.statusDetail).toBe(
			"Silent internal abort",
		);
	});

	it("uses only the latest assistant error for OMP status", () => {
		const recoveredSnapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/recovered-after-error.jsonl",
					mtimeMs: 1_700_000_085_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-recovered-after-error",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "start" },
						},
						{
							type: "message",
							id: "assistant-aborted",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: [],
								stopReason: "aborted",
								errorMessage: "Operation aborted",
							},
						},
						{
							type: "message",
							id: "user-continue",
							parentId: "assistant-aborted",
							timestamp: "2026-05-29T09:00:03.000Z",
							message: { role: "user", content: "continue" },
						},
						{
							type: "message",
							id: "assistant-stop",
							parentId: "user-continue",
							timestamp: "2026-05-29T09:00:04.000Z",
							message: {
								role: "assistant",
								content: "done",
								stopReason: "stop",
							},
						},
					],
				},
			],
		});
		expect(recoveredSnapshot.sessions[0]?.status).toBe(SessionStatus.completed);
		expect(recoveredSnapshot.sessions[0]?.statusDetail).toBeUndefined();
		expect(recoveredSnapshot.sessions[0]?.finishReason).toBe("stop");

		const latestErrorSnapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: "/tmp/omp-sessions/-repo-app/latest-error.jsonl",
					mtimeMs: 1_700_000_086_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-latest-error",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "start" },
						},
						{
							type: "message",
							id: "assistant-error",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "assistant",
								content: [],
								stopReason: "aborted",
								errorMessage: "Operation aborted",
							},
						},
					],
				},
			],
		});
		expect(latestErrorSnapshot.sessions[0]?.status).toBe(SessionStatus.failed);
		expect(latestErrorSnapshot.sessions[0]?.statusDetail).toBe(
			"Operation aborted",
		);
	});

	it("links omp task artifact sessions into the parent hierarchy", () => {
		const parentPath = "/tmp/omp-sessions/-repo-app/parent.jsonl";
		const childPath = "/tmp/omp-sessions/-repo-app/parent/ScoutLane.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: parentPath,
					mtimeMs: 1_700_000_090_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-parent",
						timestamp: "2026-05-29T09:00:00.000Z",
						cwd: "/repo/app",
						title: "Parent task run",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:00:01.000Z",
							message: { role: "user", content: "spawn a scout" },
						},
						{
							type: "message",
							id: "tool-result",
							parentId: "user",
							timestamp: "2026-05-29T09:00:02.000Z",
							message: {
								role: "toolResult",
								toolName: "task",
								content: [{ type: "text", text: "done" }],
								details: {
									results: [
										{
											id: "ScoutLane",
											agent: "explore",
											status: "completed",
											outputPath:
												"/tmp/omp-sessions/-repo-app/parent/ScoutLane.md",
										},
									],
								},
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: childPath,
					mtimeMs: 1_700_000_091_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-child-artifact",
						timestamp: "2026-05-29T09:00:03.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "assistant",
							parentId: null,
							timestamp: "2026-05-29T09:00:04.000Z",
							message: {
								role: "assistant",
								content: "done",
								stopReason: "stop",
							},
						},
					],
				},
			],
		});

		expect(snapshot.sessions).toHaveLength(1);
		const [parent] = snapshot.sessions;
		expect(parent.id).toBe("omp-parent");
		expect(parent.subagentSessions).toHaveLength(1);
		const [child] = parent.subagentSessions ?? [];
		expect(child.id).toBe("omp-child-artifact");
		expect(child.parent_id).toBe("omp-parent");
		expect(child.currentAgent).toBe("explore");
		expect(child.sourceMetadata?.sessionPath).toBe(childPath);
		expect(child.status).toBe(SessionStatus.completed);
	});
	it("links running omp task progress sessions before output artifacts exist", () => {
		const parentPath = "/tmp/omp-sessions/-repo-app/progress-parent.jsonl";
		const childPath = "/tmp/omp-sessions/-repo-app/running-child.jsonl";
		const snapshot = buildPiSessionSnapshot({
			source: "omp",
			logs: [
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: parentPath,
					mtimeMs: 1_700_000_092_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-progress-parent",
						timestamp: "2026-05-29T09:01:00.000Z",
						cwd: "/repo/app",
						title: "Parent with running task",
					},
					entries: [
						{
							type: "message",
							id: "tool-progress",
							parentId: null,
							timestamp: "2026-05-29T09:01:01.000Z",
							details: {
								progress: [
									{
										id: "RunningLane",
										sessionId: "omp-progress-child",
										agent: "task",
										status: "running",
									},
								],
							},
							message: {
								role: "toolResult",
								toolName: "task",
								content: [{ type: "text", text: "still running" }],
							},
						},
					],
				},
				{
					source: "omp",
					root: "/tmp/omp-sessions",
					path: childPath,
					mtimeMs: 1_700_000_093_000,
					header: {
						type: "session",
						version: 3,
						id: "omp-progress-child",
						timestamp: "2026-05-29T09:01:02.000Z",
						cwd: "/repo/app",
					},
					entries: [
						{
							type: "message",
							id: "user",
							parentId: null,
							timestamp: "2026-05-29T09:01:03.000Z",
							message: { role: "user", content: "work on it" },
						},
					],
				},
			],
		});

		expect(snapshot.sessions).toHaveLength(1);
		const [parent] = snapshot.sessions;
		expect(parent.id).toBe("omp-progress-parent");
		expect(parent.status).toBe(SessionStatus.running);
		expect(parent.subagentSessions).toHaveLength(1);
		const [child] = parent.subagentSessions ?? [];
		expect(child.id).toBe("omp-progress-child");
		expect(child.parent_id).toBe("omp-progress-parent");
		expect(child.currentAgent).toBe("task");
		expect(child.status).toBe(SessionStatus.running);
	});

	it("keeps artifact-layout descendants deeper than two levels under their root", () => {
		const rootPath = "/tmp/omp-sessions/-repo-app/root.jsonl";
		const scoutPath = "/tmp/omp-sessions/-repo-app/root/Scout.jsonl";
		const workerPath = "/tmp/omp-sessions/-repo-app/root/Scout/Worker.jsonl";
		const leafPath =
			"/tmp/omp-sessions/-repo-app/root/Scout/Worker/Leaf.jsonl";
		const logs: PiSessionLogRecord[] = [
			{
				source: "omp",
				root: "/tmp/omp-sessions",
				path: rootPath,
				mtimeMs: 1_700_000_100_000,
				header: {
					type: "session",
					version: 3,
					id: "omp-root-deep",
					timestamp: "2026-05-29T09:02:00.000Z",
					cwd: "/repo/app",
					title: "Deep parent",
				},
				entries: [
					{
						type: "message",
						id: "assistant",
						parentId: null,
						timestamp: "2026-05-29T09:02:01.000Z",
						message: { role: "assistant", content: "done", stopReason: "stop" },
					},
				],
			},
			{
				source: "omp",
				root: "/tmp/omp-sessions",
				path: scoutPath,
				mtimeMs: 1_700_000_101_000,
				header: {
					type: "session",
					version: 3,
					id: "omp-scout",
					timestamp: "2026-05-29T09:02:02.000Z",
					cwd: "/repo/app",
				},
				entries: [
					{
						type: "message",
						id: "assistant",
						parentId: null,
						timestamp: "2026-05-29T09:02:03.000Z",
						message: { role: "assistant", content: "done", stopReason: "stop" },
					},
				],
			},
			{
				source: "omp",
				root: "/tmp/omp-sessions",
				path: workerPath,
				mtimeMs: 1_700_000_102_000,
				header: {
					type: "session",
					version: 3,
					id: "omp-worker",
					timestamp: "2026-05-29T09:02:04.000Z",
					cwd: "/repo/app",
				},
				entries: [
					{
						type: "message",
						id: "assistant",
						parentId: null,
						timestamp: "2026-05-29T09:02:05.000Z",
						message: { role: "assistant", content: "done", stopReason: "stop" },
					},
				],
			},
			{
				source: "omp",
				root: "/tmp/omp-sessions",
				path: leafPath,
				mtimeMs: 1_700_000_103_000,
				header: {
					type: "session",
					version: 3,
					id: "omp-leaf",
					timestamp: "2026-05-29T09:02:06.000Z",
					cwd: "/repo/app",
				},
				entries: [
					{
						type: "message",
						id: "assistant",
						parentId: null,
						timestamp: "2026-05-29T09:02:07.000Z",
						message: { role: "assistant", content: "done", stopReason: "stop" },
					},
				],
			},
		];
		const snapshot = buildPiSessionSnapshot({ source: "omp", logs });

		expect(snapshot.sessions).toHaveLength(1);
		const [root] = snapshot.sessions;
		expect(root.id).toBe("omp-root-deep");
		expect(root.subagentSessions).toHaveLength(3);
		const parentById = new Map(
			(root.subagentSessions ?? []).map((session) => [
				session.id,
				session.parent_id,
			]),
		);
		expect(parentById.get("omp-scout")).toBe("omp-root-deep");
		expect(parentById.get("omp-worker")).toBe("omp-scout");
		expect(parentById.get("omp-leaf")).toBe("omp-worker");
	});

});
