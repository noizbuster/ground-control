import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CODEX_ROOT = join(homedir(), ".codex");
const DEFAULT_SESSIONS_DIR = join(CODEX_ROOT, "sessions");
const DEFAULT_OUTPUT_DIR = ".gctrl-captures/codex";
const DEFAULT_TAIL_LINES = 240;

export type CaptureOptions = {
	readonly sessionId: string;
	readonly outputDir: string;
	readonly stateDb: string;
	readonly sessionsDir: string;
	readonly tailLines: number;
};

export type CommandResult = {
	readonly cmd: readonly string[];
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

const usage = [
	"Usage: npm run capture:codex -- <session-id> [--output-dir DIR] [--state-db PATH] [--sessions-dir DIR] [--tail-lines N]",
	"",
	"Environment overrides honored by default:",
	"  GCTRL_CODEX_STATE_DB_PATH",
	"  GCTRL_CODEX_SESSIONS_DIR",
].join("\n");

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const getString = (
	record: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
};

const parsePositiveInteger = (value: string, label: string): number => {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return parsed;
};

const requireValue = (
	argv: readonly string[],
	index: number,
	token: string,
): string => {
	const value = argv[index + 1];
	if (!value) {
		throw new Error(`Missing value for ${token}.`);
	}
	return value;
};

const findLatestStateDb = async (): Promise<string> => {
	const entries = await readdir(CODEX_ROOT);
	const candidates = [];
	for (const entry of entries) {
		if (!/^state_.*\.sqlite$/u.test(entry)) {
			continue;
		}
		const path = join(CODEX_ROOT, entry);
		const info = await stat(path);
		candidates.push({ path, mtimeMs: info.mtimeMs });
	}
	candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
	const latest = candidates[0]?.path;
	if (!latest) {
		throw new Error(`No Codex state_*.sqlite database found in ${CODEX_ROOT}.`);
	}
	return latest;
};

export const parseArgs = async (
	argv: readonly string[],
): Promise<CaptureOptions> => {
	let sessionId = "";
	let outputDir = DEFAULT_OUTPUT_DIR;
	let stateDb = process.env.GCTRL_CODEX_STATE_DB_PATH;
	let sessionsDir =
		process.env.GCTRL_CODEX_SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
	let tailLines = DEFAULT_TAIL_LINES;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		switch (token) {
			case "--help":
			case "-h":
				console.log(usage);
				process.exit(0);
				break;
			case "--output-dir":
			case "-o":
				outputDir = requireValue(argv, index, token);
				index += 1;
				break;
			case "--state-db":
				stateDb = requireValue(argv, index, token);
				index += 1;
				break;
			case "--sessions-dir":
				sessionsDir = requireValue(argv, index, token);
				index += 1;
				break;
			case "--tail-lines":
				tailLines = parsePositiveInteger(
					requireValue(argv, index, token),
					token,
				);
				index += 1;
				break;
			default:
				if (token.startsWith("-")) {
					throw new Error(`Unknown argument: ${token}`);
				}
				if (sessionId) {
					throw new Error(`Unexpected extra argument: ${token}`);
				}
				sessionId = token.trim();
		}
	}

	if (!sessionId) {
		throw new Error(`Missing Codex session id.\n\n${usage}`);
	}

	return {
		sessionId,
		outputDir,
		stateDb: resolve(stateDb ?? (await findLatestStateDb())),
		sessionsDir: resolve(sessionsDir),
		tailLines,
	};
};

export const shellQuote = (value: string): string =>
	`'${value.replace(/'/gu, "'\\''")}'`;

export const runCommand = async (
	cmd: readonly string[],
): Promise<CommandResult> => {
	const child = Bun.spawn({ cmd: [...cmd], stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { cmd, exitCode, stdout, stderr };
};

export const runShell = (script: string): Promise<CommandResult> =>
	runCommand(["bash", "-lc", script]);

export const writeJson = async (
	path: string,
	value: unknown,
): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const writeText = async (path: string, value: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value);
};

export const writeCommand = async (
	path: string,
	result: CommandResult,
): Promise<void> => {
	await writeText(
		path,
		[
			`$ ${result.cmd.join(" ")}`,
			`exit=${result.exitCode}`,
			"",
			"--- stdout ---",
			result.stdout,
			"--- stderr ---",
			result.stderr,
		].join("\n"),
	);
};

export const pathExists = async (path: string): Promise<boolean> => {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error) {
			return false;
		}
		throw error;
	}
};

export const safeCopy = async (from: string, to: string): Promise<boolean> => {
	if (!(await pathExists(from))) {
		return false;
	}
	await mkdir(dirname(to), { recursive: true });
	await copyFile(from, to);
	return true;
};
