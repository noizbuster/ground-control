import { describe, expect, it } from "vitest";
import {
	canAbortSessionChildren,
	canAttachToSession,
	canDeleteSession,
	countSessionsBySource,
	getAttachLaunchEnvironment,
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
			abortChildren: true,
			hierarchy: true,
		});
		expect(getDefaultSessionCapabilities("claude")).toEqual({
			attach: true,
			delete: true,
			abortChildren: false,
			hierarchy: true,
		});
		expect(getDefaultSessionCapabilities("pi")).toEqual({
			attach: true,
			delete: true,
			abortChildren: false,
			hierarchy: true,
		});
		expect(getDefaultSessionCapabilities("omp")).toEqual({
			attach: true,
			delete: true,
			abortChildren: false,
			hierarchy: true,
		});
	});

	it("enables codex attach, delete, and child abort actions", () => {
		const session = {
			sessionSource: "codex",
			capabilities: undefined,
		} as const;
		expect(canAttachToSession(session)).toBe(true);
		expect(canDeleteSession(session)).toBe(true);
		expect(canAbortSessionChildren(session)).toBe(true);
		expect(getSessionCapabilitySummary(session)).toBe(
			"attach, delete, abort child sessions, hierarchy",
		);
	});

	it("marks Claude Code delete as available while keeping child abort disabled", () => {
		const session = {
			sessionSource: "claude",
			capabilities: undefined,
		} as const;
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
					parent_id: null,
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
					parent_id: null,
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
					parent_id: null,
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

		expect(
			getAttachLaunchSpec(
				{
					id: "pi-session",
					parent_id: null,
					directory: existingDirectory,
					sessionSource: "pi",
					sourceMetadata: { sessionPath: "/sessions/pi-session.jsonl" },
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/pi", "--session", "pi-session"],
			cwd: existingDirectory,
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "pi-session-without-path",
					parent_id: null,
					directory: existingDirectory,
					sessionSource: "pi",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/pi", "--session", "pi-session-without-path"],
			cwd: existingDirectory,
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "pi-child",
					parent_id: "pi-session",
					directory: existingDirectory,
					sessionSource: "pi",
					sourceMetadata: { sessionPath: "/sessions/pi-child.jsonl" },
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/pi", "--session", "/sessions/pi-child.jsonl"],
			cwd: existingDirectory,
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "omp-session",
					parent_id: null,
					directory: existingDirectory,
					sessionSource: "omp",
					sourceMetadata: { sessionPath: "/sessions/omp-session.jsonl" },
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/omp", "--resume", "/sessions/omp-session.jsonl"],
			cwd: existingDirectory,
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "omp-session-without-path",
					parent_id: null,
					directory: existingDirectory,
					sessionSource: "omp",
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/omp", "--resume", "omp-session-without-path"],
			cwd: existingDirectory,
		});

		expect(
			getAttachLaunchSpec(
				{
					id: "omp-child",
					parent_id: "omp-session",
					directory: existingDirectory,
					sessionSource: "omp",
					sourceMetadata: { sessionPath: "/sessions/omp-child.jsonl" },
				},
				{
					resolveExecutable,
					fallbackDirectory: "/fallback",
				},
			),
		).toEqual({
			cmd: ["/usr/bin/omp", "--resume", "/sessions/omp-child.jsonl"],
			cwd: existingDirectory,
		});
	});

	it("falls back to the current directory and root session id for Claude attach", () => {
		const resolveExecutable = (name: string) => `/usr/bin/${name}`;

		expect(
			getAttachLaunchSpec(
				{
					id: "root-session:worker-1",
					parent_id: null,
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

	it("prepends the resolved attach executable directory to PATH", () => {
		expect(
			getAttachLaunchEnvironment(
				{
					cmd: ["/home/noiz/.bun/bin/omp", "--resume", "session"],
					cwd: "/repo",
				},
				{ PATH: "/repo/node_modules/.bin:/usr/bin", HOME: "/home/noiz" },
			),
		).toEqual({
			PATH: "/home/noiz/.bun/bin:/repo/node_modules/.bin:/usr/bin",
			HOME: "/home/noiz",
		});

		expect(
			getAttachLaunchEnvironment(
				{ cmd: ["omp", "--resume", "session"], cwd: "/repo" },
				{ PATH: "/repo/node_modules/.bin:/usr/bin" },
			),
		).toEqual({ PATH: "/repo/node_modules/.bin:/usr/bin" });
	});

	it("summarizes session sources", () => {
		expect(getSessionSourceLabel("opencode")).toBe("OpenCode");
		expect(getSessionSourceLabel("claude")).toBe("Claude Code");
		expect(getSessionSourceLabel("pi")).toBe("Pi");
		expect(getSessionSourceLabel("omp")).toBe("omp");
		expect(
			countSessionsBySource([
				{ sessionSource: "opencode" },
				{ sessionSource: "codex" },
				{ sessionSource: "codex" },
				{ sessionSource: "claude" },
				{ sessionSource: "pi" },
				{ sessionSource: "omp" },
				{ sessionSource: "omp" },
			]),
		).toEqual({
			opencode: 1,
			codex: 2,
			claude: 1,
			pi: 1,
			omp: 2,
		});
	});
});

describe("mission-control source", () => {
	it("returns mission-control specific default capabilities", () => {
		expect(getDefaultSessionCapabilities("mission-control")).toEqual({
			attach: true,
			delete: true,
			abortChildren: true,
			hierarchy: true,
		});
	});

	it("enables child-only abort for mission-control sessions", () => {
		expect(
			canAbortSessionChildren({
				sessionSource: "mission-control",
				capabilities: undefined,
			}),
		).toBe(true);
	});

	it("returns the Mission Control label", () => {
		expect(getSessionSourceLabel("mission-control")).toBe("Mission Control");
	});

	it("builds the mission-control attach command preferring mc when resolvable", () => {
		const resolveExecutable = (name: string) =>
			name === "mc"
				? "/usr/bin/mc"
				: name === "mctrl"
					? "/usr/bin/mctrl"
					: undefined;
		const existingDirectory = process.cwd();

		const spec = getAttachLaunchSpec(
			{
				id: "mc-session",
				parent_id: null,
				directory: existingDirectory,
				sessionSource: "mission-control",
				capabilities: undefined,
				sourceMetadata: undefined,
			},
			{
				resolveExecutable,
				fallbackDirectory: "/fallback",
			},
		);

		expect(spec).toEqual({
			cmd: ["/usr/bin/mc", "--session", "mc-session"],
			cwd: existingDirectory,
		});
		// Regression guard: MC sessions must NOT silently fall through to the omp command.
		expect(spec?.cmd.join(" ")).not.toContain("omp");
	});

	it("falls back to mctrl for mission-control attach when mc is not resolvable", () => {
		const resolveExecutable = (name: string) =>
			name === "mctrl" ? "/usr/bin/mctrl" : undefined;
		const existingDirectory = process.cwd();

		const spec = getAttachLaunchSpec(
			{
				id: "mc-session",
				parent_id: null,
				directory: existingDirectory,
				sessionSource: "mission-control",
				capabilities: undefined,
				sourceMetadata: undefined,
			},
			{
				resolveExecutable,
				fallbackDirectory: "/fallback",
			},
		);

		expect(spec).toEqual({
			cmd: ["/usr/bin/mctrl", "--session", "mc-session"],
			cwd: existingDirectory,
		});
	});

	it("uses the mctrl literal for mission-control attach when neither binary is resolvable", () => {
		const resolveExecutable = () => undefined;
		const existingDirectory = process.cwd();

		const spec = getAttachLaunchSpec(
			{
				id: "mc-session",
				parent_id: null,
				directory: existingDirectory,
				sessionSource: "mission-control",
				capabilities: undefined,
				sourceMetadata: undefined,
			},
			{
				resolveExecutable,
				fallbackDirectory: "/fallback",
			},
		);

		expect(spec).toEqual({
			cmd: ["mctrl", "--session", "mc-session"],
			cwd: existingDirectory,
		});
	});

	it("still returns the omp command for omp sessions after the guard refactor", () => {
		const resolveExecutable = () => "/usr/bin/omp";
		const existingDirectory = process.cwd();

		const spec = getAttachLaunchSpec(
			{
				id: "o1",
				parent_id: null,
				directory: existingDirectory,
				sessionSource: "omp",
				capabilities: undefined,
				sourceMetadata: undefined,
			},
			{
				resolveExecutable,
				fallbackDirectory: "/fallback",
			},
		);

		expect(spec).toEqual({
			cmd: ["/usr/bin/omp", "--resume", "o1"],
			cwd: existingDirectory,
		});
		expect(spec?.cmd.join(" ")).toContain("omp");
		expect(spec?.cmd.join(" ")).toContain("--resume");
	});

	it("enables delete for mission-control sessions", () => {
		const session = {
			sessionSource: "mission-control",
			capabilities: undefined,
		} as const;
		expect(canDeleteSession(session)).toBe(true);
	});

	it("counts mission-control sessions by source", () => {
		expect(
			countSessionsBySource([
				{ sessionSource: "opencode" },
				{ sessionSource: "mission-control" },
				{ sessionSource: "mission-control" },
			]),
		).toEqual({
			opencode: 1,
			"mission-control": 2,
		});
	});
});
