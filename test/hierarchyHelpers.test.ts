import { describe, expect, it } from "bun:test";
import { getDisplayStatus, getStatusLabel } from "../src/lib/hierarchyHelpers";
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
				finishReason: "tool-calls",
			}),
		).toBe(SessionStatus.waiting);
	});
});
