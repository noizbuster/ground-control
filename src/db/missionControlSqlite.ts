import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MC_DB_FILENAME = "memory.db";
const MC_XDG_SUBDIR = "mission-control";

const trimToUndefined = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

// Absolute paths pass through; relative paths are rooted at the user's homedir
// (not cwd), so `~`-style values resolve regardless of where gctrl was launched.
const resolveHomeRelative = (value: string): string =>
	isAbsolute(value) ? value : join(homedir(), value);

// Mission Control SQLite DB path with three-level precedence:
//   1. GCTRL_MC_DB_PATH (when set and non-empty)
//   2. ${MCTRL_DATA_DIR}/memory.db (when MCTRL_DATA_DIR is set)
//   3. ${XDG_DATA_HOME:-~/.local/share}/mission-control/memory.db
export const resolveMissionControlDatabasePath = (): string => {
	const override = trimToUndefined(process.env.GCTRL_MC_DB_PATH);
	if (override) {
		return resolveHomeRelative(override);
	}

	const dataDir = trimToUndefined(process.env.MCTRL_DATA_DIR);
	if (dataDir) {
		return join(resolveHomeRelative(dataDir), MC_DB_FILENAME);
	}

	const xdgDataHome =
		trimToUndefined(process.env.XDG_DATA_HOME) ??
		join(homedir(), ".local", "share");
	return join(xdgDataHome, MC_XDG_SUBDIR, MC_DB_FILENAME);
};
