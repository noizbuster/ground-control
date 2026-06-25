import { describe, expect, it } from "vitest";
import {
	buildClaudeSessionSnapshot,
	resolveClaudeStatus,
	summarizeClaudeSessionLogContent,
	type ClaudeActiveSessionRecord,
	type ClaudeSessionLogSummary,
} from "../src/db/claude";
import { SessionStatus } from "../src/types";

const rootSessionId = "3a3d1d4d-06cc-4fba-ad8f-511a9381f82e";
const childSessionId = `${rootSessionId}:worker-1`;

const activeRootSession: ClaudeActiveSessionRecord = {
	pid: 1457,
	sessionId: rootSessionId,
	cwd: "/repo/app",
	startedAt: 1_700_000_000_000,
	entrypoint: "cli",
	version: "2.1.118",
};

describe("summarizeClaudeSessionLogContent", () => {
	it("extracts Claude Code metadata and message state", () => {
		const summary = summarizeClaudeSessionLogContent(
			[
				JSON.stringify({
					type: "system",
					subtype: "local_command",
					timestamp: "2026-04-22T08:59:59.900Z",
					content:
						"<command-name>/rename</command-name><command-message>rename</command-message><command-args>auth-refactor</command-args>",
				}),
				JSON.stringify({
					type: "system",
					timestamp: "2026-04-22T09:00:00.000Z",
					cwd: "/repo/app",
					version: "2.1.118",
					entrypoint: "cli",
					gitBranch: "main",
				}),
				JSON.stringify({
					type: "ai-title",
					timestamp: "2026-04-22T09:00:00.100Z",
					aiTitle: "Refactor auth flow",
				}),
				JSON.stringify({
					type: "permission-mode",
					timestamp: "2026-04-22T09:00:00.200Z",
					permissionMode: "plan",
				}),
				JSON.stringify({
					type: "user",
					timestamp: "2026-04-22T09:00:01.000Z",
					promptId: "prompt-1",
					message: {
						role: "user",
						content: [{ type: "text", text: "investigate auth" }],
					},
				}),
				JSON.stringify({
					type: "assistant",
					timestamp: "2026-04-22T09:00:02.000Z",
					uuid: "assistant-1",
					message: {
						id: "assistant-1",
						role: "assistant",
						model: "claude-sonnet-4-20250514",
						stop_reason: "end_turn",
						content: [{ type: "text", text: "Done." }],
					},
				}),
			].join("\n"),
		);

		expect(summary.explicitSessionName).toBe("auth-refactor");
		expect(summary.aiTitle).toBe("Refactor auth flow");
		expect(summary.permissionMode).toBe("plan");
		expect(summary.cwd).toBe("/repo/app");
		expect(summary.cliVersion).toBe("2.1.118");
		expect(summary.currentModelID).toBe("claude-sonnet-4-20250514");
		expect(summary.messageCount).toBe(2);
		expect(summary.firstUserPrompt).toBe("investigate auth");
		expect(summary.lastUserPrompt).toBe("investigate auth");
		expect(summary.lastAssistantText).toBe("Done.");
		expect(summary.taskState).toBe("completed");
	});
});

describe("resolveClaudeStatus", () => {
	it("keeps active sessions waiting after an end_turn response", () => {
		const summary: ClaudeSessionLogSummary = {
			messageCount: 2,
			taskState: "completed",
			lastConversationRole: "assistant",
			lastAssistantStopReason: "end_turn",
		};

		expect(
			resolveClaudeStatus({
				summary,
				activeSession: activeRootSession,
			}),
		).toEqual({
			status: SessionStatus.waiting,
			finishReason: "end_turn",
			statusDetail: "Idle between prompts",
		});
	});
});

describe("buildClaudeSessionSnapshot", () => {
	it("builds Claude root and subagent sessions with source-aware status", () => {
		const snapshot = buildClaudeSessionSnapshot({
			logs: [
				{
					id: rootSessionId,
					parentId: null,
					summary: {
						explicitSessionName: "auth-refactor",
						aiTitle: "Refactor auth flow",
						firstUserPrompt: "investigate auth",
						cwd: "/repo/app",
						entrypoint: "cli",
						cliVersion: "2.1.118",
						messageCount: 3,
						currentModelID: "claude-sonnet-4-20250514",
						lastConversationRole: "assistant",
						lastAssistantStopReason: "end_turn",
						startedAtMs: 1_700_000_000_000,
						completedAtMs: 1_700_000_010_000,
						lastTimestampMs: 1_700_000_010_000,
						taskState: "completed",
					},
				},
				{
					id: childSessionId,
					parentId: rootSessionId,
					summary: {
						cwd: "/repo/app",
						agentId: "worker-1",
						agentNickname: "Scout",
						messageCount: 1,
						currentModelID: "claude-sonnet-4-20250514",
						lastConversationRole: "user",
						lastUserPrompt: "check auth tests",
						lastUserWasToolResultOnly: false,
						startedAtMs: 1_700_000_005_000,
						lastTimestampMs: 1_700_000_020_000,
						taskState: "running",
					},
				},
			],
			activeSessions: new Map([[rootSessionId, activeRootSession]]),
		});

		expect(snapshot.sessions).toHaveLength(1);
		const [root] = snapshot.sessions;
		expect(root.sessionSource).toBe("claude");
		expect(root.title).toBe("auth-refactor");
		expect(root.status).toBe(SessionStatus.running);
		expect(root.statusDetail).toBe("Awaiting 1 child session");
		expect(root.capabilities?.attach).toBe(true);
		expect(root.capabilities?.delete).toBe(true);
		expect(root.sourceMetadata?.sourceCategory).toBe("CLI");
		expect(root.sourceMetadata?.openChildCount).toBe(1);
		expect(root.sourceMetadata?.closedChildCount).toBe(0);
		expect(snapshot.messageCountBySessionId[root.id]).toBe(3);

		expect(root.subagentSessions).toHaveLength(1);
		const [child] = root.subagentSessions ?? [];
		expect(child.parent_id).toBe(root.id);
		expect(child.status).toBe(SessionStatus.running);
		expect(child.currentAgent).toBe("Scout");
		expect(child.sourceMetadata?.agentRole).toBe("subagent");
		expect(child.sourceMetadata?.agentNickname).toBe("Scout");
		expect(snapshot.statusBySessionId[child.id]).toBe(SessionStatus.running);
	});

	it("falls back from aiTitle to first user prompt for root session titles", () => {
		const snapshot = buildClaudeSessionSnapshot({
			logs: [
				{
					id: rootSessionId,
					parentId: null,
					summary: {
						firstUserPrompt: "investigate auth",
						lastUserPrompt: "commit",
						cwd: "/repo/app",
						messageCount: 2,
						lastConversationRole: "assistant",
						lastAssistantStopReason: "end_turn",
						startedAtMs: 1_700_000_000_000,
						lastTimestampMs: 1_700_000_010_000,
						taskState: "completed",
					},
				},
			],
		});

		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]?.title).toBe("investigate auth");
	});
});
