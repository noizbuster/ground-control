import { describe, expect, it } from "vitest";
import {
	getExternalAttachedDirectoryKey,
	isSessionProcessComm,
	parseAttachedSessionIdsFromProcessList,
} from "../src/lib/attachedSessionSignals";

describe("parseAttachedSessionIdsFromProcessList", () => {
	it("extracts explicit OpenCode, Codex, Claude, Pi, and omp session ids", () => {
		const processList = [
			'101 MainThread node /usr/bin/opencode --session "ses_123"',
			"202 MainThread node /usr/bin/codex resume 019db4b3-fb8c-7290-8308-a04afb48001b",
			"303 claude claude --resume 3a3d1d4d-06cc-4fba-ad8f-511a9381f82e",
			"304 pi pi --session pi-session-id",
			"305 omp omp --resume=omp-session-id",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/app",
		);

		expect([...result.sessionIds].sort()).toEqual([
			"019db4b3-fb8c-7290-8308-a04afb48001b",
			"3a3d1d4d-06cc-4fba-ad8f-511a9381f82e",
			"omp-session-id",
			"pi-session-id",
			"ses_123",
		]);
	});

	it("shares directory slots across non-Pi-family sources and ignores codex app-server", () => {
		const processList = [
			"301 MainThread node /usr/bin/opencode",
			"401 MainThread node /usr/bin/codex 현재 attach 여부를 점검해줘",
			"701 claude claude",
			"499 codex /vendor/codex/codex app-server --analytics-default-enabled",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/shared",
		);

		expect(result.sessionIds.size).toBe(0);
		expect(
			getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
		).toBe(getExternalAttachedDirectoryKey("codex", "/repo/shared"));
		expect(
			getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
		).toBe(getExternalAttachedDirectoryKey("claude", "/repo/shared"));
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
			),
		).toBe(3);
		expect(result.directoryProcessCounts.size).toBe(1);
	});

	it("keeps Pi and omp directory slots isolated from other sources", () => {
		const processList = [
			"301 MainThread node /usr/bin/opencode",
			"801 pi pi --session /tmp/pi-session.jsonl",
			"802 MainThread node /usr/bin/omp --resume /tmp/omp-session.jsonl",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/shared",
		);

		expect(result.sessionIds.size).toBe(0);
		expect(
			getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
		).not.toBe(getExternalAttachedDirectoryKey("pi", "/repo/shared"));
		expect(
			getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
		).not.toBe(getExternalAttachedDirectoryKey("omp", "/repo/shared"));
		expect(
			getExternalAttachedDirectoryKey("pi", "/repo/shared"),
		).not.toBe(getExternalAttachedDirectoryKey("omp", "/repo/shared"));
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
			),
		).toBe(1);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("pi", "/repo/shared"),
			),
		).toBe(1);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("omp", "/repo/shared"),
			),
		).toBe(1);
		expect(result.directoryProcessCounts.size).toBe(3);
	});

	it("ignores internal opencode and codex helper binaries for slot counting", () => {
		const processList = [
			"301 MainThread node /usr/bin/opencode",
			"302 .opencode /usr/lib/node_modules/opencode-ai/bin/.opencode",
			"401 MainThread node /usr/bin/codex 현재 attach 여부를 점검해줘",
			"402 codex /usr/lib/node_modules/@openai/codex/vendor/x86_64/codex/codex --dangerously-bypass-approvals-and-sandbox",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/shared",
		);

		expect(result.sessionIds.size).toBe(0);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
			),
		).toBe(2);
		expect(result.directoryProcessCounts.size).toBe(1);
	});

	it("treats direct codex prompt invocations as session-bearing", () => {
		const processList =
			"501 MainThread node /usr/bin/codex 현재 attach 여부를 점검해줘";

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/codex",
		);

		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("codex", "/repo/codex"),
			),
		).toBe(1);
	});

	it("treats interactive Claude invocations as session-bearing and ignores print mode", () => {
		const processList = [
			"701 claude claude",
			'702 claude claude -p "summarize this diff"',
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/claude",
		);

		expect(result.sessionIds.size).toBe(0);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("claude", "/repo/claude"),
			),
		).toBe(1);
	});

	it("treats interactive Pi and omp invocations as session-bearing and ignores machine modes", () => {
		const processList = [
			"801 pi pi --session /tmp/pi-session.jsonl",
			"802 MainThread node /usr/bin/omp --resume /tmp/omp-session.jsonl",
			"803 pi pi --print summarize",
			"804 omp omp export",
			"805 omp omp --json",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/pi",
		);

		expect(result.sessionIds.size).toBe(0);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("pi", "/repo/pi"),
			),
		).toBe(1);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("omp", "/repo/pi"),
			),
		).toBe(1);
		expect(result.directoryProcessCounts.size).toBe(2);
	});

	it("does not add fallback directory slots for internal codex vendor children of resumed sessions", () => {
		const sessionId = "019db4b3-fb8c-7290-8308-a04afb48001b";
		const processList = [
			`601 MainThread node /usr/bin/codex resume ${sessionId}`,
			"602 codex /usr/lib/node_modules/@openai/codex/vendor/x86_64/codex/codex --dangerously-bypass-approvals-and-sandbox",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/codex",
		);

		expect([...result.sessionIds]).toEqual([sessionId]);
		expect(result.directoryProcessCounts.size).toBe(0);
	});
});

describe("mission-control process detection", () => {
	it("extracts mctrl and mission-control-sidecar --session ids", () => {
		const processList = [
			"601 mctrl mctrl --session session_abc123",
			"605 mission-control-sidecar mission-control-sidecar --session sidecar_session",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/mc",
		);

		expect([...result.sessionIds].sort()).toEqual([
			"session_abc123",
			"sidecar_session",
		]);
	});

	it("excludes mctrl subcommands like session list from session ids and directory counts", () => {
		const processList = "602 mctrl mctrl session list";

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/mc",
		);

		expect(result.sessionIds.size).toBe(0);
		expect(result.directoryProcessCounts.size).toBe(0);
	});

	it("does not detect bare mc as mission-control (Midnight Commander collision)", () => {
		const processList = "603 mc mc --session x";

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/mc",
		);

		expect(result.sessionIds.has("x")).toBe(false);
		expect(result.directoryProcessCounts.size).toBe(0);
	});

	it("falls back to mission-control directory key for bare mctrl invocations", () => {
		const processList = "604 mctrl mctrl";

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/mc",
		);

		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("mission-control", "/repo/mc"),
			),
		).toBe(1);
		expect(result.directoryProcessCounts.size).toBe(1);
	});

	it("isolates mission-control directory keys from opencode, pi, and omp", () => {
		expect(getExternalAttachedDirectoryKey("mission-control", "/dir")).toBe(
			"mission-control:/dir",
		);
		expect(getExternalAttachedDirectoryKey("opencode", "/dir")).toBe("/dir");
		expect(getExternalAttachedDirectoryKey("pi", "/dir")).toBe("pi:/dir");
		expect(getExternalAttachedDirectoryKey("omp", "/dir")).toBe("omp:/dir");
		expect(
			getExternalAttachedDirectoryKey("mission-control", "/dir"),
		).not.toBe(getExternalAttachedDirectoryKey("opencode", "/dir"));
	});
});

describe("isSessionProcessComm", () => {
	it("accepts direct session launchers", () => {
		expect(isSessionProcessComm("opencode")).toBe(true);
		expect(isSessionProcessComm("codex")).toBe(true);
		expect(isSessionProcessComm("claude")).toBe(true);
		expect(isSessionProcessComm("pi")).toBe(true);
		expect(isSessionProcessComm("omp")).toBe(true);
		expect(isSessionProcessComm("mctrl")).toBe(true);
	});

	it("accepts runtime wrappers that may launch a session", () => {
		expect(isSessionProcessComm("node")).toBe(true);
		expect(isSessionProcessComm("bun")).toBe(true);
		expect(isSessionProcessComm("deno")).toBe(true);
	});

	it("accepts the kernel-truncated form of long launcher names", () => {
		// "mission-control-sidecar" is 24 chars; /proc/<pid>/comm truncates to 15.
		expect(isSessionProcessComm("mission-control")).toBe(true);
	});

	it("rejects unrelated processes so the /proc scan skips their cmdline", () => {
		expect(isSessionProcessComm("gnome-shell")).toBe(false);
		expect(isSessionProcessComm("code")).toBe(false);
		expect(isSessionProcessComm("chrome")).toBe(false);
		expect(isSessionProcessComm("kthreadd")).toBe(false);
		expect(isSessionProcessComm("bash")).toBe(false);
		expect(isSessionProcessComm("zsh")).toBe(false);
		expect(isSessionProcessComm("python3")).toBe(false);
	});
});
