import { describe, expect, it } from "bun:test";
import {
	canAbortSessionChildren,
	canAttachToSession,
	canDeleteSession,
	countSessionsBySource,
	getAttachLaunchSpec,
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
			attach: true,
			delete: true,
			abortChildren: false,
			hierarchy: true,
		});
	});

	it("gates unsupported codex actions", () => {
		const session = { sessionSource: "codex", capabilities: undefined } as const;
		expect(canAttachToSession(session)).toBe(true);
		expect(canDeleteSession(session)).toBe(true);
		expect(canAbortSessionChildren(session)).toBe(false);
		expect(getSessionCapabilitySummary(session)).toBe("attach, delete, hierarchy");
	});

	it("builds provider-specific attach commands", () => {
		const resolveExecutable = (name: string) => `/usr/bin/${name}`;

		expect(
			getAttachLaunchSpec(
				{
					id: "open-session",
					directory: "/repo/open",
					sessionSource: "opencode",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/opencode", "--session", "open-session"],
			cwd: "/repo/open",
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "codex-session",
					directory: "/repo/codex",
					sessionSource: "codex",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/codex", "resume", "codex-session"],
			cwd: "/repo/codex",
		});
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
