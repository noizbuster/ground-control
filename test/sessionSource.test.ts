import { describe, expect, it } from "bun:test";
import {
	canAbortSessionChildren,
	canAttachToSession,
	canDeleteSession,
	countSessionsBySource,
	getDefaultSessionCapabilities,
	getSessionCapabilitySummary,
	getSessionSourceLabel,
} from "../src/lib/sessionSource";

describe("sessionSource helpers", () => {
	it("returns provider-specific defaults", () => {
		expect(getDefaultSessionCapabilities("opencode")).toEqual({
			attach: true,
			delete: true,
			abortChildren: true,
			hierarchy: true,
		});
		expect(getDefaultSessionCapabilities("codex")).toEqual({
			attach: false,
			delete: true,
			abortChildren: false,
			hierarchy: true,
		});
	});

	it("gates unsupported codex actions", () => {
		const session = { sessionSource: "codex", capabilities: undefined } as const;
		expect(canAttachToSession(session)).toBe(false);
		expect(canDeleteSession(session)).toBe(true);
		expect(canAbortSessionChildren(session)).toBe(false);
		expect(getSessionCapabilitySummary(session)).toBe("delete, hierarchy");
	});

	it("summarizes session sources", () => {
		expect(getSessionSourceLabel("opencode")).toBe("OpenCode");
		expect(countSessionsBySource([
			{ sessionSource: "opencode" },
			{ sessionSource: "codex" },
			{ sessionSource: "codex" },
		])).toEqual({
			opencode: 1,
			codex: 2,
		});
	});
});
