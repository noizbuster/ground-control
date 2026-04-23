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
		expect(getDefaultSessionCapabilities("claude")).toEqual({
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

	it("marks Claude Code delete as available while keeping child abort disabled", () => {
		const session = { sessionSource: "claude", capabilities: undefined } as const;
		expect(canAttachToSession(session)).toBe(true);
		expect(canDeleteSession(session)).toBe(true);
		expect(canAbortSessionChildren(session)).toBe(false);
		expect(getSessionCapabilitySummary(session)).toBe(
			"attach, delete, hierarchy",
		);
	});

	it("builds provider-specific attach commands", () => {
		const resolveExecutable = (name: string) => `/usr/bin/${name}`;
		const existingDirectory = process.cwd();

		expect(
			getAttachLaunchSpec(
				{
					id: "open-session",
					directory: existingDirectory,
					sessionSource: "opencode",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/opencode", "--session", "open-session"],
			cwd: existingDirectory,
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "codex-session",
					directory: existingDirectory,
					sessionSource: "codex",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/codex", "resume", "codex-session"],
			cwd: existingDirectory,
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "claude-session",
					directory: existingDirectory,
					sessionSource: "claude",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/claude", "--resume", "claude-session"],
			cwd: existingDirectory,
		});
	});

	it("falls back to the current directory and root session id for Claude attach", () => {
		const resolveExecutable = (name: string) => `/usr/bin/${name}`;

		expect(
			getAttachLaunchSpec(
				{
					id: "root-session:worker-1",
					directory: "/definitely/missing",
					sessionSource: "claude",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/claude", "--resume", "root-session"],
			cwd: "/fallback",
		});
	});

	it("summarizes session sources", () => {
		expect(getSessionSourceLabel("opencode")).toBe("OpenCode");
		expect(getSessionSourceLabel("claude")).toBe("Claude Code");
		expect(countSessionsBySource([
			{ sessionSource: "opencode" },
			{ sessionSource: "codex" },
			{ sessionSource: "codex" },
			{ sessionSource: "claude" },
		])).toEqual({
			opencode: 1,
			codex: 2,
			claude: 1,
		});
	});
});
