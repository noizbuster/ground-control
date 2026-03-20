import { lstat, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const DEFAULT_FIXTURE_PATH = ".sisyphus/evidence/qa-refresh.sqlite";
const DEFAULT_OUTPUT_PATH = ".sisyphus/evidence/task-1-refresh-harness.txt";
const DEFAULT_DB_TARGET_PATH = `${homedir()}/.local/share/opencode/opencode.db`;

interface HarnessOptions {
	fixturePath: string;
	outputPath: string;
	sessionName: string;
	startupWaitMs: number;
	captureLines: number;
	injectJ: boolean;
	injectIntervalMs: number;
	injectDurationMs: number;
	allowMissingFixture: boolean;
	dbTargetPath: string;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const parseInteger = (raw: string, flag: string): number => {
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`Expected a non-negative integer for ${flag}, received: ${raw}`);
	}

	return parsed;
};

const parseArgs = (argv: string[]): HarnessOptions => {
	let fixturePath = DEFAULT_FIXTURE_PATH;
	let outputPath = DEFAULT_OUTPUT_PATH;
	let startupWaitMs = 1_500;
	let captureLines = 600;
	let injectJ = false;
	let injectIntervalMs = 150;
	let injectDurationMs = 5_000;
	let allowMissingFixture = false;
	let dbTargetPath = DEFAULT_DB_TARGET_PATH;
	let sessionName = `gctrl-refresh-qa-${Date.now()}`;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const nextToken = argv[index + 1];

		switch (token) {
			case "--fixture":
			case "-f":
				if (!nextToken) {
					throw new Error(`Missing value for ${token}.`);
				}
				fixturePath = nextToken;
				index += 1;
				break;

			case "--output":
			case "-o":
				if (!nextToken) {
					throw new Error(`Missing value for ${token}.`);
				}
				outputPath = nextToken;
				index += 1;
				break;

			case "--session":
				if (!nextToken) {
					throw new Error("Missing value for --session.");
				}
				sessionName = nextToken;
				index += 1;
				break;

			case "--startup-wait-ms":
				if (!nextToken) {
					throw new Error("Missing value for --startup-wait-ms.");
				}
				startupWaitMs = parseInteger(nextToken, token);
				index += 1;
				break;

			case "--capture-lines":
				if (!nextToken) {
					throw new Error("Missing value for --capture-lines.");
				}
				captureLines = parseInteger(nextToken, token);
				index += 1;
				break;

			case "--inject-j":
				injectJ = true;
				break;

			case "--inject-interval-ms":
				if (!nextToken) {
					throw new Error("Missing value for --inject-interval-ms.");
				}
				injectIntervalMs = parseInteger(nextToken, token);
				index += 1;
				break;

			case "--inject-duration-ms":
				if (!nextToken) {
					throw new Error("Missing value for --inject-duration-ms.");
				}
				injectDurationMs = parseInteger(nextToken, token);
				index += 1;
				break;

			case "--allow-missing-fixture":
				allowMissingFixture = true;
				break;

			case "--db-target":
				if (!nextToken) {
					throw new Error("Missing value for --db-target.");
				}
				dbTargetPath = nextToken;
				index += 1;
				break;

			default:
				if (token.startsWith("-")) {
					throw new Error(`Unknown argument: ${token}`);
				}

				fixturePath = token;
				break;
		}
	}

	return {
		fixturePath,
		outputPath,
		sessionName,
		startupWaitMs,
		captureLines,
		injectJ,
		injectIntervalMs,
		injectDurationMs,
		allowMissingFixture,
		dbTargetPath,
	};
};

const decode = (buffer: unknown): string => {
	if (typeof buffer === "string") {
		return buffer;
	}

	if (buffer instanceof Uint8Array) {
		return new TextDecoder().decode(buffer);
	}

	if (buffer instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(buffer));
	}

	return "";
};

const runCommand = (cmd: string[], cwd = PROJECT_ROOT): CommandResult => {
	const result = Bun.spawnSync({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	return {
		stdout: decode(result.stdout),
		stderr: decode(result.stderr),
		exitCode: result.exitCode,
	};
};

const runTmux = (args: string[], allowFailure = false): string => {
	const result = runCommand(["tmux", ...args]);
	if (result.exitCode !== 0 && !allowFailure) {
		const detail = result.stderr.trim() || result.stdout.trim();
		throw new Error(`tmux ${args.join(" ")} failed: ${detail}`);
	}

	return result.stdout;
};

const sleep = (ms: number): Promise<void> => {
	if (ms <= 0) {
		return Promise.resolve();
	}

	return new Promise((resolveSleep) => {
		setTimeout(resolveSleep, ms);
	});
};

const pathExists = async (path: string): Promise<boolean> => {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error) {
			const errnoError = error as Error & { code?: string };
			if (errnoError.code === "ENOENT") {
				return false;
			}
		}

		throw error;
	}
};

const writeToStdin = (stdin: unknown, chunk: string): void => {
	if (
		typeof stdin === "object" &&
		stdin !== null &&
		"write" in stdin &&
		typeof (stdin as { write?: (value: string) => unknown }).write ===
			"function"
	) {
		(stdin as { write: (value: string) => unknown }).write(chunk);
	}
};

const closeStdin = (stdin: unknown): void => {
	if (
		typeof stdin === "object" &&
		stdin !== null &&
		"end" in stdin &&
		typeof (stdin as { end?: () => void }).end === "function"
	) {
		(stdin as { end: () => void }).end();
	}
};

const runHarnessInTmux = async (options: HarnessOptions): Promise<string> => {
	let tmuxSessionStarted = false;

	try {
		runTmux(
			[
				"new-session",
				"-d",
				"-s",
				options.sessionName,
				"-c",
				PROJECT_ROOT,
				"bun run start",
			],
			false,
		);
		tmuxSessionStarted = true;

		await sleep(options.startupWaitMs);

		if (options.injectJ) {
			const startsAt = Date.now();
			while (Date.now() - startsAt < options.injectDurationMs) {
				runTmux(["send-keys", "-t", options.sessionName, "j"]);
				await sleep(options.injectIntervalMs);
			}
		}

		await sleep(500);

		return runTmux([
			"capture-pane",
			"-p",
			"-S",
			`-${options.captureLines}`,
			"-t",
			options.sessionName,
		]);
	} finally {
		if (tmuxSessionStarted) {
			runTmux(["kill-session", "-t", options.sessionName], true);
		}
	}
};

const runHarnessWithScriptFallback = async (
	options: HarnessOptions,
	outputPath: string,
): Promise<string> => {
	const scriptPath = Bun.which("script");
	if (!scriptPath) {
		throw new Error(
			"tmux is not available and 'script' fallback command was not found.",
		);
	}

	const transcriptPath = `${outputPath}.raw-${Date.now()}`;
	const child = Bun.spawn({
		cmd: [scriptPath, "-q", "-c", "bun run start", transcriptPath],
		cwd: PROJECT_ROOT,
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderrTextPromise = child.stderr
		? new Response(child.stderr).text()
		: Promise.resolve("");

	try {
		await sleep(options.startupWaitMs);

		if (options.injectJ) {
			const startsAt = Date.now();
			while (Date.now() - startsAt < options.injectDurationMs) {
				writeToStdin(child.stdin, "j");
				await sleep(options.injectIntervalMs);
			}
		}

		await sleep(350);
		writeToStdin(child.stdin, "q");
		await sleep(150);
		closeStdin(child.stdin);

		const exitCode = await Promise.race([
			child.exited,
			sleep(2_000).then(() => Number.NaN),
		]);

		if (Number.isNaN(exitCode)) {
			child.kill();
			await child.exited;
		}
	} finally {
		closeStdin(child.stdin);
	}

	const stderrText = (await stderrTextPromise).trim();
	const transcriptExists = await pathExists(transcriptPath);
	if (!transcriptExists) {
		throw new Error(
			`Fallback harness did not produce transcript. ${stderrText || "No stderr output."}`,
		);
	}

	const transcript = await Bun.file(transcriptPath).text();
	await rm(transcriptPath, { force: true });
	return transcript;
};

const main = async () => {
	const options = parseArgs(Bun.argv.slice(2));
	const fixturePath = resolve(PROJECT_ROOT, options.fixturePath);
	const outputPath = resolve(PROJECT_ROOT, options.outputPath);
	const dbTargetPath = resolve(PROJECT_ROOT, options.dbTargetPath);
	const harnessMode = Bun.which("tmux") ? "tmux" : "script-fallback";

	const fixtureExists = await pathExists(fixturePath);
	if (!fixtureExists && !options.allowMissingFixture) {
		throw new Error(
			`Fixture database not found at ${fixturePath}. Run scripts/create-refresh-qa-db.ts first or pass --allow-missing-fixture.`,
		);
	}

	await mkdir(dirname(outputPath), { recursive: true });
	await mkdir(dirname(dbTargetPath), { recursive: true });

	let backupPath: string | null = null;

	try {
		if (await pathExists(dbTargetPath)) {
			backupPath = `${dbTargetPath}.gctrl-qa-backup-${Date.now()}`;
			await rename(dbTargetPath, backupPath);
		}

		await symlink(fixturePath, dbTargetPath);

		const pane =
			harnessMode === "tmux"
				? await runHarnessInTmux(options)
				: await runHarnessWithScriptFallback(options, outputPath);

		const report = [
			`harness_mode=${harnessMode}`,
			`fixture_path=${fixturePath}`,
			`fixture_exists=${fixtureExists}`,
			`inject_j=${options.injectJ}`,
			`inject_interval_ms=${options.injectIntervalMs}`,
			`inject_duration_ms=${options.injectDurationMs}`,
			`startup_wait_ms=${options.startupWaitMs}`,
			`captured_at=${new Date().toISOString()}`,
			"",
			pane,
		].join("\n");

		await writeFile(outputPath, report, "utf8");
		console.log(`Captured harness pane at ${outputPath}`);
	} finally {
		await rm(dbTargetPath, { force: true });

		if (backupPath) {
			await rename(backupPath, dbTargetPath);
		}
	}
};

void main();
