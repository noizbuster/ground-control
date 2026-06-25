// Dev mode: rebuilds dist/ on src/ changes AND relaunches the app on every
// rebuild, with a clean shutdown when the app exits on its own.
//
// Runs two concurrent processes:
//   1. esbuild watch (src/ -> dist/) via scripts/build.mjs --watch
//   2. the app itself: node --import dist/lib/ffi-register.mjs --experimental-sqlite dist/index.js
//
// Why dev.mjs owns the app lifecycle instead of using `node --watch`:
// `node --watch` does NOT exit when the watched process exits cleanly — it
// hangs in "Waiting for file changes before restarting...". So quitting the
// TUI (exit 0) would leave `pnpm dev` stuck. By spawning the app directly and
// polling dist/ output mtimes ourselves, we both restart on rebuild AND tear
// down the moment the app exits on its own (user quit). bin/gctrl.js is
// intentionally not used: it spawns dist/index.js as a subprocess, which would
// hide its exit from us, and its signal forwarding is unnecessary here.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const distDir = resolve(projectRoot, "dist");
const distIndex = resolve(distDir, "index.js");
const distWorker = resolve(distDir, "db", "refresh-worker.js");
const registerPath = resolve(distDir, "lib", "ffi-register.mjs");

// Matches bin/gctrl.js. Emitted on restart/teardown because dev mode bypasses
// the launcher's own restorePrimaryScreen(), and a SIGTERM'd TUI can leave the
// terminal in raw/alt-screen mode.
const RESTORE_PRIMARY_SCREEN =
	"\x1b[?2026l\x1b[?1049l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h";
const writeScreenRestore = () => process.stdout.write(RESTORE_PRIMARY_SCREEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mtime = (file) => (existsSync(file) ? statSync(file).mtimeMs : -1);

// 1. Wipe dist/ for a known-empty baseline. Otherwise a stale dist/index.js
//    from a prior `pnpm build` would make the initial-build poll below return
//    instantly, before build.mjs runs its own startup rmSync — and that later
//    wipe would delete the FFI hooks copied in step 4.
rmSync(distDir, { recursive: true, force: true });

// 2. Start esbuild watch. build.mjs wipes dist/ (no-op now) then compiles
//    before entering watch mode.
const builder = spawn("node", ["scripts/build.mjs", "--watch"], {
	cwd: projectRoot,
	stdio: "inherit",
});

let teardownStarted = false;
let app = null;
let restarting = false;
const teardown = (code) => {
	if (teardownStarted) return;
	teardownStarted = true;
	writeScreenRestore();
	builder.kill("SIGTERM");
	if (app?.exitCode === null && app?.signalCode === null) app.kill("SIGTERM");
	process.exit(code);
};

builder.on("exit", (code) => teardown(code ?? 0));

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => teardown(0));
}

// 3. Wait for the initial build. dist/ was empty, so dist/index.js can only
//    appear once build.mjs's startup wipe + initial compile are done.
const BUILD_TIMEOUT_MS = 30_000;
const startedAt = Date.now();
while (!existsSync(distIndex)) {
	if (Date.now() - startedAt > BUILD_TIMEOUT_MS) {
		console.error("[dev] timed out waiting for initial build (dist/index.js)");
		teardown(1);
	}
	await sleep(200);
}

// 4. Copy the hand-written FFI hooks into dist/lib/. build.mjs watch mode does
//    not run copy-hooks, and the baseline wipe removed any stale copies.
const copyHooks = spawnSync("node", ["scripts/copy-hooks.mjs"], {
	cwd: projectRoot,
	stdio: "inherit",
});
if (copyHooks.status !== 0) {
	console.error("[dev] copy-hooks failed");
	teardown(copyHooks.status ?? 1);
}

// 5. App lifecycle: launch, restart on dist/ rebuild, tear down on natural exit.
//    - rebuild while running -> SIGTERM + relaunch
//    - rebuild while crashed -> relaunch (dev stays alive across crashes so
//      you can iterate on a bug; only a CLEAN quit tears down)
//    - clean exit (code 0, user quit) -> teardown
//    - crash (non-zero) -> stay alive, restart on next rebuild
const FORCED_KILL_DELAY_MS = 1500;

function launchApp() {
	app = spawn(
		process.execPath,
		["--import", registerPath, "--experimental-sqlite", distIndex],
		{ cwd: projectRoot, stdio: "inherit", env: process.env },
	);
	app.on("exit", (code, signal) => {
		if (restarting) {
			restarting = false;
			launchApp();
			return;
		}
		if (teardownStarted) return;
		if (signal || code !== 0) {
			// Crashed (or signal-killed outside our control): keep dev alive so
			// the next rebuild relaunches. Mirrors `node --watch`'s "waiting for
			// file changes" behavior, without its clean-exit hang.
			app = null;
			console.log(
				signal
					? `\n[dev] app killed by ${signal}; will relaunch on next rebuild`
					: `\n[dev] app exited with code ${code}; will relaunch on next rebuild`,
			);
			return;
		}
		teardown(0);
	});
}

function restartApp() {
	if (restarting || teardownStarted) return;
	if (!app) {
		console.log("\n[dev] rebuild detected, relaunching...");
		launchApp();
		return;
	}
	restarting = true;
	console.log("\n[dev] rebuild detected, restarting...");
	app.kill("SIGTERM");
	const forceKill = setTimeout(() => {
		if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
	}, FORCED_KILL_DELAY_MS);
	app.once("exit", () => clearTimeout(forceKill));
}

launchApp();

// 6. Poll dist/ output mtimes for esbuild rebuilds. Polling (vs fs.watch) is
//    immune to atomic-rename inode changes and reliably catches esbuild's
//    writes. Both entry outputs are tracked so worker-only edits also restart.
let lastIndexMtime = mtime(distIndex);
let lastWorkerMtime = mtime(distWorker);
setInterval(() => {
	if (restarting || teardownStarted) return;
	const indexMtime = mtime(distIndex);
	const workerMtime = mtime(distWorker);
	if (indexMtime !== lastIndexMtime || workerMtime !== lastWorkerMtime) {
		lastIndexMtime = indexMtime;
		lastWorkerMtime = workerMtime;
		restartApp();
	}
}, 400);
