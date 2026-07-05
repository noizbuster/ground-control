import { spawn } from "node:child_process";
import {
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const FIXTURE_PATH = resolve(
	PROJECT_ROOT,
	".sisyphus/evidence/qa-refresh.sqlite",
);
const STATS_PATH = resolve(
	PROJECT_ROOT,
	".sisyphus/evidence/task-6-render-counts.tmp.json",
);
const OUTPUT_PATH = resolve(
	PROJECT_ROOT,
	".sisyphus/evidence/task-6-render-counts.json",
);
const DB_TARGET_PATH = `${homedir()}/.local/share/opencode/opencode.db`;
const RUN_MS = 6000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const pathExists = async (p: string) => {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
};

const writeToStdin = (stdin: unknown, chunk: string) => {
	const w = stdin as { write?(v: string): void; end?(): void } | null;
	w?.write?.(chunk);
};

const closeStdin = (stdin: unknown) => {
	const w = stdin as { write?(v: string): void; end?(): void } | null;
	w?.end?.();
};

const main = async () => {
	if (!(await pathExists(FIXTURE_PATH))) {
		throw new Error(`Fixture not found: ${FIXTURE_PATH}`);
	}

	await mkdir(dirname(STATS_PATH), { recursive: true });
	await mkdir(dirname(DB_TARGET_PATH), { recursive: true });

	let backupPath: string | null = null;
	let raw: string | null = null;

	try {
		if (await pathExists(DB_TARGET_PATH)) {
			backupPath = `${DB_TARGET_PATH}.gctrl-qa-backup-${Date.now()}`;
			await rename(DB_TARGET_PATH, backupPath);
		}
		await symlink(FIXTURE_PATH, DB_TARGET_PATH);

		const child = spawn("node", ["bin/gctrl.js"], {
			cwd: PROJECT_ROOT,
			stdio: ["pipe", "ignore", "ignore"],
			env: {
				...process.env,
				GCTRL_RENDER_STATS: STATS_PATH,
			},
		});
		const exitedPromise = new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? 0));
			child.on("error", () => resolve(1));
		});

		await sleep(RUN_MS);
		writeToStdin(child.stdin, "q");
		await sleep(200);
		closeStdin(child.stdin);

		const exitCode = await Promise.race([
			exitedPromise,
			sleep(3000).then(() => Number.NaN),
		]);
		if (Number.isNaN(exitCode)) {
			child.kill();
			await exitedPromise;
		}

		if (!(await pathExists(STATS_PATH))) {
			await rm(DB_TARGET_PATH, { force: true });
			if (backupPath) {
				await rename(backupPath, DB_TARGET_PATH);
			}
			throw new Error(
				"App did not produce render stats file. Check that the fixture has waiting sessions.",
			);
		}

		raw = await readFile(STATS_PATH, "utf8");

		await rm(STATS_PATH, { force: true }).catch(() => {});
		await rm(DB_TARGET_PATH, { force: true });

		if (backupPath) {
			await rename(backupPath, DB_TARGET_PATH);
		}
	} catch (err) {
		await rm(DB_TARGET_PATH, { force: true });
		if (backupPath) {
			await rename(backupPath, DB_TARGET_PATH).catch(() => {});
		}
		if (err instanceof Error && err.message.startsWith("App did not")) {
			throw err;
		}
		throw new Error(
			`Harness failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!raw) {
		throw new Error("App did not produce render stats.");
	}

	const stats = JSON.parse(raw) as {
		source: string;
		applyTriggeredRenders: number;
		liveFrameRenders: number;
		liveFrameSkippedDuringApply: number;
		totalLiveCallbacks: number;
		guardActive: boolean;
		capturedAt: string;
	};

	const evidence = {
		description:
			"Render counts captured from actual worker-backed app execution via GCTRL_RENDER_STATS instrumentation. " +
			"The app ran for 6 seconds against the QA fixture (session-gamma has waiting status). " +
			"Waiting sessions are highlighted statically; steady state must not start a live-frame render loop.",
		source: stats.source,
		runDurationMs: RUN_MS,
		fixture:
			"qa-refresh.sqlite (sessions alpha, beta, gamma - gamma has waiting status)",
		applyTriggeredRenders: stats.applyTriggeredRenders,
		liveFrameRenders: stats.liveFrameRenders,
		liveFrameSkippedDuringApply: stats.liveFrameSkippedDuringApply,
		totalLiveCallbacks: stats.totalLiveCallbacks,
		guardActive: stats.guardActive,
		invariants: {
			applyRendersFired: stats.applyTriggeredRenders > 0,
			liveFramesSuppressed: stats.liveFrameRenders === 0,
			noSkippedLiveFrames: stats.liveFrameSkippedDuringApply === 0,
			callbacksAccounted:
				stats.liveFrameRenders + stats.liveFrameSkippedDuringApply ===
				stats.totalLiveCallbacks,
		},
		conclusion:
			stats.applyTriggeredRenders > 0 && stats.liveFrameRenders === 0
				? "PASS: Apply-triggered renders fire, and steady-state live-frame renders stay suppressed."
				: "FAIL: Render evidence did not match the steady-state memory guard.",
		capturedAt: stats.capturedAt,
	};

	await writeFile(OUTPUT_PATH, JSON.stringify(evidence, null, 2));
	console.log(`Wrote ${OUTPUT_PATH}`);
	console.log(
		`apply=${stats.applyTriggeredRenders} live=${stats.liveFrameRenders} skipped=${stats.liveFrameSkippedDuringApply} callbacks=${stats.totalLiveCallbacks}`,
	);
	console.log(evidence.conclusion);
};

void main();
