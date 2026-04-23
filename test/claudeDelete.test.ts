import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteClaudeSession } from "../src/db/claude";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-claude-delete-"));
	tempRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const readCurrentProcessStartTime = (): string => {
	const stat = readFileSync("/proc/self/stat", "utf8");
	const closingParenIndex = stat.lastIndexOf(")");
	const fields = stat
		.slice(closingParenIndex + 2)
		.trim()
		.split(/\s+/u);
	return fields[19] ?? "";
};

describe("deleteClaudeSession", () => {
	it("removes Claude transcript, child logs, and per-session storage", async () => {
		const root = createTempRoot();
		const claudeRoot = join(root, ".claude");
		const projectsDirectory = join(claudeRoot, "projects", "-repo-main");
		const sessionsDirectory = join(claudeRoot, "sessions");
		const fileHistoryDirectory = join(claudeRoot, "file-history");
		const sessionEnvDirectory = join(claudeRoot, "session-env");
		const tasksDirectory = join(claudeRoot, "tasks");
		mkdirSync(projectsDirectory, { recursive: true });
		mkdirSync(sessionsDirectory, { recursive: true });
		mkdirSync(fileHistoryDirectory, { recursive: true });
		mkdirSync(sessionEnvDirectory, { recursive: true });
		mkdirSync(tasksDirectory, { recursive: true });

		const rootSessionId = "93ddbb2d-6d74-4ad6-a245-50606cdbe1e3";
		const transcriptPath = join(projectsDirectory, `${rootSessionId}.jsonl`);
		const sessionDirectory = join(projectsDirectory, rootSessionId);
		const subagentPath = join(
			sessionDirectory,
			"subagents",
			"agent-worker-1.jsonl",
		);
		const staleActiveSessionPath = join(sessionsDirectory, "12345.json");
		const fileHistoryPath = join(fileHistoryDirectory, rootSessionId);
		const sessionEnvPath = join(sessionEnvDirectory, rootSessionId);
		const tasksPath = join(tasksDirectory, rootSessionId);
		const unrelatedTranscriptPath = join(
			projectsDirectory,
			"74409bc0-25a7-46f2-bc65-27bd31ae7c79.jsonl",
		);

		mkdirSync(join(sessionDirectory, "subagents"), { recursive: true });
		mkdirSync(fileHistoryPath, { recursive: true });
		mkdirSync(sessionEnvPath, { recursive: true });
		mkdirSync(tasksPath, { recursive: true });
		writeFileSync(transcriptPath, "{\"type\":\"summary\"}\n");
		writeFileSync(subagentPath, "{\"type\":\"subagent\"}\n");
		writeFileSync(join(fileHistoryPath, "checkpoint.json"), "{}\n");
		writeFileSync(join(sessionEnvPath, "env.json"), "{}\n");
		writeFileSync(join(tasksPath, "tasks.json"), "{}\n");
		writeFileSync(unrelatedTranscriptPath, "{\"type\":\"summary\"}\n");
		writeFileSync(
			staleActiveSessionPath,
			JSON.stringify({
				pid: process.pid,
				procStart: "0",
				sessionId: rootSessionId,
			}),
		);

		const result = await deleteClaudeSession(`${rootSessionId}:worker-1`, {
			projectsDirectory: join(claudeRoot, "projects"),
			sessionsDirectory,
			rootDirectories: [claudeRoot],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.deletedPaths.sort()).toEqual(
			[
				transcriptPath,
				sessionDirectory,
				staleActiveSessionPath,
				fileHistoryPath,
				sessionEnvPath,
				tasksPath,
			].sort(),
		);
		expect(existsSync(transcriptPath)).toBe(false);
		expect(existsSync(sessionDirectory)).toBe(false);
		expect(existsSync(staleActiveSessionPath)).toBe(false);
		expect(existsSync(fileHistoryPath)).toBe(false);
		expect(existsSync(sessionEnvPath)).toBe(false);
		expect(existsSync(tasksPath)).toBe(false);
		expect(existsSync(unrelatedTranscriptPath)).toBe(true);
	});

	it("refuses to delete a live Claude session", async () => {
		const root = createTempRoot();
		const claudeRoot = join(root, ".claude");
		const projectsDirectory = join(claudeRoot, "projects", "-repo-main");
		const sessionsDirectory = join(claudeRoot, "sessions");
		mkdirSync(projectsDirectory, { recursive: true });
		mkdirSync(sessionsDirectory, { recursive: true });

		const rootSessionId = "3a3d1d4d-06cc-4fba-ad8f-511a9381f82e";
		const transcriptPath = join(projectsDirectory, `${rootSessionId}.jsonl`);
		const activeSessionPath = join(sessionsDirectory, "live.json");
		writeFileSync(transcriptPath, "{\"type\":\"summary\"}\n");
		writeFileSync(
			activeSessionPath,
			JSON.stringify({
				pid: process.pid,
				procStart: readCurrentProcessStartTime(),
				sessionId: rootSessionId,
			}),
		);

		const result = await deleteClaudeSession(rootSessionId, {
			projectsDirectory: join(claudeRoot, "projects"),
			sessionsDirectory,
			rootDirectories: [claudeRoot],
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}

		expect(result.error.message).toContain("still active");
		expect(existsSync(transcriptPath)).toBe(true);
		expect(existsSync(activeSessionPath)).toBe(true);
	});
});
