import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	getString,
	parseArgs,
	runCommand,
	runShell,
	safeCopy,
	shellQuote,
	writeCommand,
	writeJson,
	writeText,
} from "./codex-capture/shared";
import { summarizeWithCurrentSource } from "./codex-capture/source-status";
import {
	captureRelatedRows,
	collectLogPaths,
	collectRelatedEdges,
	collectRelatedThreads,
} from "./codex-capture/sqlite";

const addRelatedIds = (
	relatedIds: Set<string>,
	rows: readonly Record<string, unknown>[],
): void => {
	for (const row of rows) {
		for (const key of ["id", "parent_thread_id", "child_thread_id"]) {
			const id = getString(row, key);
			if (id) {
				relatedIds.add(id);
			}
		}
	}
};

const writeReadme = async (
	outputRoot: string,
	sessionId: string,
): Promise<void> => {
	await writeText(
		join(outputRoot, "README.txt"),
		[
			`Codex capture for ${sessionId}`,
			`Created: ${new Date().toISOString()}`,
			"",
			"Key files:",
			"- metadata.json",
			"- current-source-status.json",
			"- sqlite/related-threads.json",
			"- sqlite/related-edges.json",
			"- sqlite/related-rows-by-table.json",
			"- commands/processes.txt",
			"- commands/tmux-panes.txt",
			"- rollouts/*.jsonl",
			"- state/*.sqlite*",
			"",
		].join("\n"),
	);
};

const copyStateFiles = async (
	stateDb: string,
	outputRoot: string,
): Promise<readonly Record<string, unknown>[]> => {
	const stateCopies = [];
	for (const suffix of ["", "-wal", "-shm"] as const) {
		const source = `${stateDb}${suffix}`;
		const copied = await safeCopy(
			source,
			join(outputRoot, "state", `${basename(stateDb)}${suffix}`),
		);
		stateCopies.push({ source, copied });
	}
	return stateCopies;
};

const captureTmuxPanes = async (
	outputRoot: string,
	tmuxPanes: string,
): Promise<void> => {
	for (const line of tmuxPanes.split(/\r?\n/u)) {
		const paneId = line.split(/\s/u)[0];
		if (!paneId) {
			continue;
		}
		const safePaneName = paneId.replace(/[^A-Za-z0-9_.-]/gu, "_");
		const result = await runShell(
			`tmux capture-pane -pt ${shellQuote(paneId)} -S -300 2>/dev/null || true`,
		);
		await writeCommand(join(outputRoot, "tmux", `${safePaneName}.txt`), result);
	}
};

const main = async (): Promise<void> => {
	const options = await parseArgs(Bun.argv.slice(2));
	const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
	const outputRoot = resolve(
		options.outputDir,
		`${stamp}-${options.sessionId.slice(0, 8)}`,
	);
	await mkdir(outputRoot, { recursive: true });

	const captureCommand = async (name: string, command: readonly string[]) => {
		const result = await runCommand(command);
		await writeCommand(join(outputRoot, "commands", `${name}.txt`), result);
		return result;
	};

	const threadRows = await collectRelatedThreads(
		options.stateDb,
		options.sessionId,
	);
	const edgeRows = await collectRelatedEdges(
		options.stateDb,
		options.sessionId,
	);
	const relatedIds = new Set<string>([options.sessionId]);
	addRelatedIds(relatedIds, threadRows);
	addRelatedIds(relatedIds, edgeRows);

	const logPaths = await collectLogPaths(
		options.sessionId,
		options.sessionsDir,
		threadRows,
	);
	const stateCopies = await copyStateFiles(options.stateDb, outputRoot);

	for (const logPath of logPaths) {
		await safeCopy(logPath, join(outputRoot, "rollouts", basename(logPath)));
		await captureCommand(`tail-${basename(logPath)}`, [
			"tail",
			"-n",
			String(options.tailLines),
			logPath,
		]);
	}

	await writeJson(
		join(outputRoot, "sqlite", "related-threads.json"),
		threadRows,
	);
	await writeJson(join(outputRoot, "sqlite", "related-edges.json"), edgeRows);
	await writeJson(
		join(outputRoot, "sqlite", "related-rows-by-table.json"),
		await captureRelatedRows(options.stateDb, relatedIds),
	);

	await captureCommand("sqlite-schema", [
		"sqlite3",
		options.stateDb,
		".schema",
	]);
	await captureCommand("sqlite-wal-status", [
		"sqlite3",
		options.stateDb,
		"PRAGMA journal_mode; PRAGMA wal_checkpoint(PASSIVE);",
	]);
	await captureCommand("processes", [
		"bash",
		"-lc",
		`ps -ef | rg ${shellQuote(`codex|gctrl|${options.sessionId}`)} || true`,
	]);
	const tmuxResult = await captureCommand("tmux-panes", [
		"bash",
		"-lc",
		"tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_tty} #{pane_current_command} #{pane_current_path}' 2>/dev/null || true",
	]);
	await captureCommand("file-stats", [
		"bash",
		"-lc",
		[
			`stat -c '%Y %y %n' ${shellQuote(options.stateDb)} ${shellQuote(`${options.stateDb}-wal`)} ${shellQuote(`${options.stateDb}-shm`)} 2>/dev/null || true`,
			...logPaths.map((path) => `stat -c '%Y %y %n' ${shellQuote(path)}`),
		].join("\n"),
	]);
	await captureTmuxPanes(outputRoot, tmuxResult.stdout);

	await writeJson(
		join(outputRoot, "current-source-status.json"),
		await summarizeWithCurrentSource(options, logPaths),
	);
	await writeJson(join(outputRoot, "metadata.json"), {
		capturedAt: new Date().toISOString(),
		sessionId: options.sessionId,
		outputRoot,
		stateDb: options.stateDb,
		sessionsDir: options.sessionsDir,
		stateCopies,
		logPaths,
		relatedIds: [...relatedIds].sort(),
		bunVersion: Bun.version,
		argv: Bun.argv,
	});
	await writeReadme(outputRoot, options.sessionId);

	console.log(outputRoot);
};

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
