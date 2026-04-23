import { describe, expect, it } from "bun:test";
import {
	getExternalAttachedDirectoryKey,
	parseAttachedSessionIdsFromProcessList,
} from "../src/lib/attachedSessionSignals";

describe("parseAttachedSessionIdsFromProcessList", () => {
	it("extracts explicit OpenCode, Codex, and Claude session ids", () => {
		const processList = [
			'101 MainThread node /usr/bin/opencode --session "ses_123"',
			"202 MainThread node /usr/bin/codex resume 019db4b3-fb8c-7290-8308-a04afb48001b",
			"303 claude claude --resume 3a3d1d4d-06cc-4fba-ad8f-511a9381f82e",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/app",
		);

		expect([...result.sessionIds].sort()).toEqual([
			"019db4b3-fb8c-7290-8308-a04afb48001b",
			"3a3d1d4d-06cc-4fba-ad8f-511a9381f82e",
			"ses_123",
		]);
	});

	it("shares directory slots across sources and ignores codex app-server", () => {
		const processList = [
			"301 MainThread node /usr/bin/opencode",
			"401 MainThread node /usr/bin/codex 현재 attach 여부를 점검해줘",
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
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("opencode", "/repo/shared"),
			),
		).toBe(2);
		expect(result.directoryProcessCounts.size).toBe(1);
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
