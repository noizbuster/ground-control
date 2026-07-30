import { describe, expect, it } from "vitest";
import { isSessionStopShortcut } from "../src/lib/sessionStopShortcut";

describe("session stop shortcut", () => {
	it("accepts Ctrl+K including the terminal control sequence", () => {
		expect(
			isSessionStopShortcut({
				name: "k",
				ctrl: true,
				shift: false,
				sequence: "\u000b",
			}),
		).toBe(true);
		expect(
			isSessionStopShortcut({
				name: "unknown",
				ctrl: false,
				shift: false,
				sequence: "\u000b",
			}),
		).toBe(true);
	});

	it("retains Shift+K and rejects unmodified K", () => {
		expect(
			isSessionStopShortcut({
				name: "k",
				ctrl: false,
				shift: true,
				sequence: "K",
			}),
		).toBe(true);
		expect(
			isSessionStopShortcut({
				name: "k",
				ctrl: false,
				shift: false,
				sequence: "k",
			}),
		).toBe(false);
	});
});
