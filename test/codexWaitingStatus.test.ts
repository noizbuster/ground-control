import { describe, expect, it } from "bun:test";
import {
	resolveCodexStatus,
	summarizeCodexSessionLogContent,
} from "../src/db/codex";
import { SessionStatus } from "../src/types";

const stringifyEvent = (entry: {
	readonly timestamp: string;
	readonly type: string;
	readonly payload: Record<string, unknown>;
}): string => JSON.stringify(entry);

const buildTaskStartedEvent = (timestamp: string): string =>
	stringifyEvent({
		timestamp,
		type: "event_msg",
		payload: {
			type: "task_started",
			turn_id: "turn-1",
			started_at: Date.parse(timestamp),
		},
	});

const buildExecCommandCall = (params: {
	readonly timestamp: string;
	readonly callId: string;
	readonly yieldTimeMs: number;
	readonly sandboxPermissions?: string;
}): string =>
	stringifyEvent({
		timestamp: params.timestamp,
		type: "response_item",
		payload: {
			type: "function_call",
			name: "exec_command",
			call_id: params.callId,
			arguments: JSON.stringify({
				cmd: "rm -f evidence/task-05-desktop-browser-mobile.png",
				workdir: "/repo",
				yield_time_ms: params.yieldTimeMs,
				sandbox_permissions: params.sandboxPermissions,
				justification: params.sandboxPermissions
					? "Need approval for this test command."
					: undefined,
			}),
		},
	});

describe("Codex waiting status detection", () => {
	it("maps stale open exec calls to waiting when their yield window has expired", () => {
		const oldTimestamp = "2024-01-01T00:00:00.000Z";
		const summary = summarizeCodexSessionLogContent(
			[
				buildTaskStartedEvent(oldTimestamp),
				buildExecCommandCall({
					timestamp: oldTimestamp,
					callId: "call_stale",
					yieldTimeMs: 100,
				}),
			].join("\n"),
		);

		expect(resolveCodexStatus({ summary })).toEqual({
			status: SessionStatus.waiting,
			finishReason: "awaiting_user",
			statusDetail: "Awaiting user input",
		});
	});

	it("keeps fresh open exec calls running before their yield window expires", () => {
		const currentTimestamp = new Date().toISOString();
		const summary = summarizeCodexSessionLogContent(
			[
				buildTaskStartedEvent(currentTimestamp),
				buildExecCommandCall({
					timestamp: currentTimestamp,
					callId: "call_fresh",
					yieldTimeMs: 3_600_000,
				}),
			].join("\n"),
		);

		expect(resolveCodexStatus({ summary })).toEqual({
			status: SessionStatus.running,
			finishReason: "task_started",
			statusDetail: "Task running",
		});
	});

	it("maps approval-gated exec calls to waiting when no regular calls are running", () => {
		const currentTimestamp = new Date().toISOString();
		const summary = summarizeCodexSessionLogContent(
			[
				buildTaskStartedEvent(currentTimestamp),
				buildExecCommandCall({
					timestamp: currentTimestamp,
					callId: "call_approval",
					yieldTimeMs: 3_600_000,
					sandboxPermissions: "require_escalated",
				}),
			].join("\n"),
		);

		expect(resolveCodexStatus({ summary })).toEqual({
			status: SessionStatus.waiting,
			finishReason: "awaiting_approval",
			statusDetail: "Awaiting approval",
		});
	});
});
