import { describe, expect, it, vi } from "vitest";
import {
	findOmpSessionProcessIds,
	stopOmpSession,
	type OmpProcess,
} from "../src/db/omp-session-stop";

const sessionPath = "/tmp/omp-sessions/-repo/child.jsonl";

const processEntry = (overrides: Partial<OmpProcess> = {}): OmpProcess => ({
	pid: 101,
	comm: "bun",
	args: ["bun", "/home/noiz/.bun/bin/omp", "--resume", sessionPath],
	cwd: "/repo",
	...overrides,
});

describe("OMP session stop", () => {
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

		expect(findOmpSessionProcessIds(sessionPath, processes)).toEqual([101]);
	});

	it("resolves a relative resume path against the target process working directory", () => {
		const processes = [
			processEntry({
				comm: "omp",
				args: ["omp", "-r", "child.jsonl"],
				cwd: "/tmp/omp-sessions/-repo",
			}),
		];

		expect(findOmpSessionProcessIds(sessionPath, processes)).toEqual([101]);
	});

	it("sends SIGINT only to verified OMP session processes", () => {
		const sendSignal = vi.fn();
		const result = stopOmpSession({
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
		const result = stopOmpSession({
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
});
