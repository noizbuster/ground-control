import { describe, expect, it, vi } from "vitest";
import {
	findJsonlSessionProcessIds,
	type JsonlSessionProcess,
	stopJsonlSession,
} from "../src/db/jsonl-session-stop";

const sessionPath = "/tmp/omp-sessions/-repo/child.jsonl";

const processEntry = (
	overrides: Partial<JsonlSessionProcess> = {},
): JsonlSessionProcess => ({
	pid: 101,
	comm: "bun",
	args: ["bun", "/home/noiz/.bun/bin/omp", "--resume", sessionPath],
	cwd: "/repo",
	...overrides,
});

describe("JSONL harness session stop", () => {
	it("matches only OMP processes explicitly resumed from the exact session path", () => {
		const processes = [
			processEntry(),
			processEntry({
				pid: 102,
				args: ["bun", "/home/noiz/.bun/bin/omp", "--resume", "other.jsonl"],
			}),
			processEntry({
				pid: 103,
				comm: "python",
			}),
			processEntry({
				pid: 104,
				args: ["bun", "/home/noiz/.bun/bin/pi", "--session", sessionPath],
			}),
			processEntry({
				pid: 105,
				comm: "node",
				args: ["node", "tool.js", "omp", "--resume", sessionPath],
			}),
		];

		expect(findJsonlSessionProcessIds("omp", sessionPath, processes)).toEqual([
			101,
		]);
	});

	it("resolves a relative resume path against the target process working directory", () => {
		const processes = [
			processEntry({
				comm: "omp",
				args: ["omp", "-r", "child.jsonl"],
				cwd: "/tmp/omp-sessions/-repo",
			}),
		];

		expect(findJsonlSessionProcessIds("omp", sessionPath, processes)).toEqual([
			101,
		]);
	});

	it("sends SIGINT only to verified OMP session processes", () => {
		const sendSignal = vi.fn();
		const result = stopJsonlSession("omp", {
			sessionPath,
			processes: [
				processEntry(),
				processEntry({ pid: 102, args: ["omp", "--resume", "elsewhere.jsonl"] }),
			],
			sendSignal,
		});

		expect(result).toEqual({ ok: true, pids: [101] });
		expect(sendSignal).toHaveBeenCalledExactlyOnceWith(101, "SIGINT");
	});

	it("refuses to signal when the session path cannot identify a process", () => {
		const sendSignal = vi.fn();
		const result = stopJsonlSession("omp", {
			sessionPath,
			processes: [processEntry({ args: ["omp", "--resume", "elsewhere.jsonl"] })],
			sendSignal,
		});

		expect(result).toEqual({
			ok: false,
			error: "No running OMP process matched the exact session path.",
		});
		expect(sendSignal).not.toHaveBeenCalled();
	});

	it("refuses an ID-only resume reference even when the process arguments match", () => {
		const sendSignal = vi.fn();
		const processes: JsonlSessionProcess[] = [
			{
				pid: 201,
				comm: "gjc",
				args: ["gjc", "--resume", "gjc-session-id"],
			},
		];

		expect(
			findJsonlSessionProcessIds("gjc", "gjc-session-id", processes),
		).toEqual([]);
		expect(
			stopJsonlSession("gjc", {
				sessionPath: "gjc-session-id",
				processes,
				sendSignal,
			}),
		).toEqual({
			ok: false,
			error:
				"GJC session path is unavailable; refusing to signal an unverified process.",
		});
		expect(sendSignal).not.toHaveBeenCalled();
	});

	it("matches direct and Bun-wrapped GJC processes, including a gjc process title", () => {
		const gjcSessionPath =
			"/tmp/gjc-sessions/v2-project/gjc-session.jsonl";
		const processes: JsonlSessionProcess[] = [
			{
				pid: 201,
				comm: "gjc",
				args: [
					"bun",
					"/usr/lib/gajae-code/bin/gjc.js",
					"--resume",
					gjcSessionPath,
				],
			},
			{
				pid: 202,
				comm: "bun",
				args: [
					"bun",
					"/usr/lib/gajae-code/bin/gjc.js",
					"--resume",
					gjcSessionPath,
				],
			},
			{
				pid: 203,
				comm: "gjc",
				args: ["gjc", "--resume", gjcSessionPath],
			},
			{
				pid: 204,
				comm: "gjc",
				args: ["gjc", "--resume", sessionPath],
			},
		];

		expect(
			findJsonlSessionProcessIds("gjc", gjcSessionPath, processes),
		).toEqual([201, 202, 203]);
		expect(
			findJsonlSessionProcessIds("omp", gjcSessionPath, processes),
		).toEqual([]);
	});

	it("sends SIGINT only to the exact GJC session process", () => {
		const gjcSessionPath =
			"/tmp/gjc-sessions/v2-project/gjc-session.jsonl";
		const sendSignal = vi.fn();
		const result = stopJsonlSession("gjc", {
			sessionPath: gjcSessionPath,
			processes: [
				{
					pid: 201,
					comm: "gjc",
					args: ["gjc", "--resume", gjcSessionPath],
				},
				{
					pid: 202,
					comm: "gjc",
					args: ["gjc", "--resume", sessionPath],
				},
			],
			sendSignal,
		});

		expect(result).toEqual({ ok: true, pids: [201] });
		expect(sendSignal).toHaveBeenCalledExactlyOnceWith(201, "SIGINT");
	});
});
