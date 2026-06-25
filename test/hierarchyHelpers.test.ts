import { describe, expect, it } from "vitest";
import {
	getDisplayStatus,
	getStatusLabel,
	truncateLabelStart,
} from "../src/lib/hierarchyHelpers";
import { SessionStatus } from "../src/types";

describe("hierarchy status helpers", () => {
	it("distinguishes idle waiting sessions from real awaiting-user states", () => {
		expect(
			getStatusLabel(SessionStatus.waiting, {
				finishReason: "end_turn",
			}),
		).toBe("Idle");
		expect(
			getStatusLabel(SessionStatus.waiting, {
				finishReason: "active_session",
			}),
		).toBe("Idle");
		expect(
			getStatusLabel(SessionStatus.waiting, {
				finishReason: "toolUse",
			}),
		).toBe("Idle");
		expect(
			getStatusLabel(SessionStatus.waiting, {
				finishReason: "tool_use",
			}),
		).toBe("Idle");
		expect(
			getStatusLabel(SessionStatus.waiting, {
				finishReason: "tool-calls",
			}),
		).toBe("Waiting");
		expect(getStatusLabel(SessionStatus.waiting)).toBe("Waiting");
	});

	it("renders idle waiting sessions with completed visuals", () => {
		expect(
			getDisplayStatus(SessionStatus.waiting, {
				finishReason: "end_turn",
			}),
		).toBe(SessionStatus.completed);
		expect(
			getDisplayStatus(SessionStatus.waiting, {
				finishReason: "active_session",
			}),
		).toBe(SessionStatus.completed);
		expect(
			getDisplayStatus(SessionStatus.waiting, {
				finishReason: "toolUse",
			}),
		).toBe(SessionStatus.completed);
		expect(
			getDisplayStatus(SessionStatus.waiting, {
				finishReason: "tool_use",
			}),
		).toBe(SessionStatus.completed);
		expect(
			getDisplayStatus(SessionStatus.waiting, {
				finishReason: "tool-calls",
			}),
		).toBe(SessionStatus.waiting);
	});
});

describe("hierarchy label helpers", () => {
	it("preserves the start of long titles and places ellipses at the end", () => {
		const title = truncateLabelStart(
			"TASK: Determine likely test/build/QA infrastructure implied by specs",
			24,
		);

		expect(title.startsWith("TASK: Determine")).toBe(true);
		expect(title.endsWith("...")).toBe(true);
		expect(title.startsWith("...")).toBe(false);
	});
});
