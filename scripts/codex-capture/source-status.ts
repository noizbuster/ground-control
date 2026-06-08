import { readFile } from "node:fs/promises";
import type { CaptureOptions } from "./shared";

export const summarizeWithCurrentSource = async (
	options: CaptureOptions,
	logPaths: readonly string[],
): Promise<unknown> => {
	process.env.GCTRL_CODEX_STATE_DB_PATH = options.stateDb;
	process.env.GCTRL_CODEX_SESSIONS_DIR = options.sessionsDir;

	const codex = await import("../../src/db/codex");
	const snapshotResult = codex.getCodexSnapshot();
	const logSummaries = [];
	for (const logPath of logPaths) {
		const content = await readFile(logPath, "utf8");
		const summary = codex.summarizeCodexSessionLogContent(content);
		logSummaries.push({
			path: logPath,
			summary,
			status: codex.resolveCodexStatus({ summary }),
		});
	}

	return {
		snapshot: snapshotResult,
		logSummaries,
	};
};
