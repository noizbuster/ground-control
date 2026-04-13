import { describe, expect, it } from "bun:test";
import type { LatestMessageResultsBySessionId } from "../src/db/index";
import { getWaitingSignalCandidateIds } from "../src/db/waitingSignalCandidates";
import type { MessageData } from "../src/types";

const validMessage = (message: MessageData) => ({
	ok: true as const,
	value: message,
});

const invalidMessage = (message: string) => ({
	ok: false as const,
	error: {
		code: "invalid_json" as const,
		message,
	},
});

const latestMessages: LatestMessageResultsBySessionId = {
	running: {
		sessionId: "running",
		rawData: "running",
		message: validMessage({
			role: "assistant",
			time: { created: 1 },
		}),
	},
	waiting: {
		sessionId: "waiting",
		rawData: "waiting",
		message: validMessage({
			role: "assistant",
			time: { created: 2 },
			tools: { question: true },
		}),
	},
	completed: {
		sessionId: "completed",
		rawData: "completed",
		message: validMessage({
			role: "assistant",
			time: { created: 3, completed: 4 },
			finish: "stop",
		}),
	},
	failed: {
		sessionId: "failed",
		rawData: "failed",
		message: validMessage({
			role: "assistant",
			time: { created: 5 },
			finish: "error",
		}),
	},
	unknown: {
		sessionId: "unknown",
		rawData: "unknown",
		message: invalidMessage("boom"),
	},
};

describe("getWaitingSignalCandidateIds", () => {
	it("keeps only non-terminal sessions with latest messages", () => {
		expect(
			getWaitingSignalCandidateIds(
				["running", "waiting", "completed", "failed", "unknown", "missing"],
				latestMessages,
			),
		).toEqual(["running", "waiting", "unknown"]);
	});

	it("preserves input order while filtering", () => {
		expect(
			getWaitingSignalCandidateIds(
				["unknown", "failed", "running", "completed", "waiting"],
				latestMessages,
			),
		).toEqual(["unknown", "running", "waiting"]);
	});
});
