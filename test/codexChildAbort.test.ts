import { afterEach, describe, expect, it } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortCodexChildSession } from "../src/db/codex-child-abort";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-codex-child-abort-"));
	tempRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const createFakeCodexExecutable = (root: string): string => {
	const executablePath = join(root, "codex");
	const requestsPath = join(root, "requests.jsonl");
	const script = `#!/usr/bin/env bun
const requestsPath = ${JSON.stringify(requestsPath)};
const { appendFileSync } = await import("node:fs");
let buffer = "";
const respond = (message) => {
  if (message.method === "initialized") return;
  if (typeof message.id !== "number") return;
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {} }));
    return;
  }
  if (message.method === "thread/resume") {
    console.log(JSON.stringify({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          turns: [
            { id: "turn-complete", status: "completed" },
            { id: "turn-active", status: "inProgress" }
          ]
        }
      }
    }));
    return;
  }
  if (message.method === "turn/interrupt") {
    console.log(JSON.stringify({ id: message.id, result: {} }));
    return;
  }
  console.log(JSON.stringify({
    id: message.id,
    error: { message: "unexpected method " + message.method }
  }));
};
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/u);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    appendFileSync(requestsPath, line + "\\n");
    respond(JSON.parse(line));
  }
});
`;
	writeFileSync(executablePath, script, { mode: 0o755 });
	return executablePath;
};

describe("abortCodexChildSession", () => {
	it("resumes the child thread and interrupts the active turn", async () => {
		const root = createTempRoot();
		mkdirSync(root, { recursive: true });
		const codexExecutable = createFakeCodexExecutable(root);

		const result = await abortCodexChildSession(
			{
				id: "child-thread",
				directory: "/repo/app",
				sourceMetadata: {},
			},
			{
				codexExecutable,
				timeoutMs: 1000,
			},
		);

		expect(result).toEqual({ ok: true });

		const requestLines = readFileSync(join(root, "requests.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(requestLines.map((request) => request.method)).toEqual([
			"initialize",
			"initialized",
			"thread/resume",
			"turn/interrupt",
		]);
		expect(requestLines[2].params).toEqual({
			threadId: "child-thread",
			cwd: "/repo/app",
		});
		expect(requestLines[3].params).toEqual({
			threadId: "child-thread",
			turnId: "turn-active",
		});
	});

	it("uses the logged turn id when the child session already has one", async () => {
		const root = createTempRoot();
		const codexExecutable = createFakeCodexExecutable(root);

		const result = await abortCodexChildSession(
			{
				id: "child-thread",
				directory: "/repo/app",
				sourceMetadata: { lastTurnId: "turn-from-log" },
			},
			{
				codexExecutable,
				timeoutMs: 1000,
			},
		);

		expect(result).toEqual({ ok: true });

		const requestLines = readFileSync(join(root, "requests.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(requestLines[3].params).toEqual({
			threadId: "child-thread",
			turnId: "turn-from-log",
		});
	});
});
