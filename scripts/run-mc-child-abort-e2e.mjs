import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const options = parseArguments(process.argv.slice(2));
const mcWorktree = resolve(options.mcWorktree);
const gcWorktree = resolve(options.gcWorktree);
const fixtureEntry = join(
	mcWorktree,
	"tests",
	"fixtures",
	"session-stop-owner.ts",
);
const cliEntry = join(mcWorktree, "apps", "cli", "dist", "index.js");
const nativeSidecar = join(
	mcWorktree,
	"native",
	"sidecar",
	"target",
	"debug",
	`mission-control-sidecar${process.platform === "win32" ? ".exe" : ""}`,
);

for (const path of [
	mcWorktree,
	gcWorktree,
	fixtureEntry,
	cliEntry,
	nativeSidecar,
]) {
	if (!existsSync(path))
		throw new Error(`required Task 13 path does not exist: ${path}`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "gctrl-mc-child-abort-e2e-"));
const runtimeRoot = join(temporaryRoot, "runtime");
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

try {
	const exitCode = await runVitest({
		cwd: gcWorktree,
		environment: {
			...process.env,
			GC_WORKTREE: gcWorktree,
			MC_WORKTREE: mcWorktree,
			MC_CLI_ENTRY: cliEntry,
			MC_NATIVE_SIDECAR: nativeSidecar,
			MC_OWNER_FIXTURE_ENTRY: fixtureEntry,
			GCTRL_MC_E2E_TEMP_ROOT: temporaryRoot,
			MCTRL_DATA_DIR: join(temporaryRoot, "default-data"),
			XDG_RUNTIME_DIR: runtimeRoot,
		},
	});
	process.exitCode = exitCode;
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(args) {
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (
			(key !== "--mc-worktree" && key !== "--gc-worktree") ||
			value === undefined ||
			!isAbsolute(value)
		) {
			throw new TypeError(
				"usage: run-mc-child-abort-e2e.mjs --mc-worktree <absolute-path> --gc-worktree <absolute-path>",
			);
		}
		values.set(key, value);
	}
	if (values.size !== 2) {
		throw new TypeError(
			"usage: run-mc-child-abort-e2e.mjs --mc-worktree <absolute-path> --gc-worktree <absolute-path>",
		);
	}
	return {
		mcWorktree: values.get("--mc-worktree"),
		gcWorktree: values.get("--gc-worktree"),
	};
}

function runVitest({ cwd, environment }) {
	const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	const args = [
		"exec",
		"vitest",
		"run",
		"test/missionControlChildAbort.e2e.test.ts",
		"--reporter=verbose",
	];
	return new Promise((resolveExit, reject) => {
		const child = spawn(executable, args, {
			cwd,
			env: environment,
			stdio: "inherit",
			shell: false,
		});
		child.once("error", reject);
		child.once("close", (code) => resolveExit(code ?? 1));
	});
}
