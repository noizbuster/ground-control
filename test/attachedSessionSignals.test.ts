import { describe, expect, it } from "bun:test";
import {
	getExternalAttachedDirectoryKey,
	parseAttachedSessionIdsFromProcessList,
} from "../src/lib/attachedSessionSignals";

describe("parseAttachedSessionIdsFromProcessList", () => {
	it("extracts explicit OpenCode and Codex session ids", () => {
		const processList = [
			'101 MainThread node /usr/bin/opencode --session "ses_123"',
			"202 MainThread node /usr/bin/codex resume 019db4b3-fb8c-7290-8308-a04afb48001b",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(
			processList,
			() => "/repo/app",
		);

		expect([...result.sessionIds].sort()).toEqual([
			"019db4b3-fb8c-7290-8308-a04afb48001b",
			"ses_123",
		]);
	});

	it("uses source-qualified directory pinning and ignores codex app-server", () => {
		const processList = [
			"301 MainThread node /usr/bin/opencode",
			"401 codex /vendor/codex/codex --dangerously-bypass-approvals-and-sandbox",
			"402 codex /vendor/codex/codex --dangerously-bypass-approvals-and-sandbox",
			"499 codex /vendor/codex/codex app-server --analytics-default-enabled",
		].join("\n");

		const result = parseAttachedSessionIdsFromProcessList(processList, (pid) => {
			if (pid >= 400) {
				return "/repo/codex";
			}

			return "/repo/opencode";
		});

		expect(result.sessionIds.size).toBe(0);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("opencode", "/repo/opencode"),
			),
		).toBe(1);
		expect(
			result.directoryProcessCounts.get(
				getExternalAttachedDirectoryKey("codex", "/repo/codex"),
			),
		).toBe(1);
		expect(result.directoryProcessCounts.size).toBe(2);
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
});
