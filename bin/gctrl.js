#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const bunPackageDir = dirname(require.resolve("bun/package.json"));
const bunPath = resolve(bunPackageDir, "bin", "bun.exe");
const entryPath = resolve(__dirname, "..", "dist", "index.js");

// Belt-and-suspenders: the parent (last holder of the PTY) re-emits the
// leave-alt-screen sequence on child exit. Covers the case where the child is
// killed by a signal before its own restorePrimaryScreen() runs. ?2026l flushes
// any open Synchronized-Update window so Kitty applies the ?1049l immediately.
const RESTORE_PRIMARY_SCREEN =
	"\x1b[?2026l\x1b[?1049l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h";

const restorePrimaryScreen = () => {
	try {
		writeSync(1, RESTORE_PRIMARY_SCREEN);
	} catch {}
};

const child = spawn(bunPath, [entryPath], {
	stdio: "inherit",
	env: process.env,
});

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forcedKillDelayMs = 2000;

let shutdownSignal = null;
let childExited = false;
let forcedKillTimer = null;

const isChildAlive = () => child.exitCode === null && child.signalCode === null;

const clearForcedKillTimer = () => {
	if (forcedKillTimer) {
		clearTimeout(forcedKillTimer);
		forcedKillTimer = null;
	}
};

const removeSignalHandlers = () => {
	for (const signal of forwardedSignals) {
		process.removeListener(signal, handleSignal);
	}
};

const terminateSelf = (signal) => {
	removeSignalHandlers();
	try {
		process.kill(process.pid, signal);
	} catch {
		process.exit(1);
	}
};

const forwardSignal = (signal) => {
	if (!isChildAlive()) {
		return false;
	}

	try {
		return child.kill(signal);
	} catch {
		return false;
	}
};

const scheduleForcedKill = () => {
	clearForcedKillTimer();
	forcedKillTimer = setTimeout(() => {
		forcedKillTimer = null;
		forwardSignal("SIGKILL");
	}, forcedKillDelayMs);
};

function handleSignal(signal) {
	if (childExited) {
		terminateSelf(signal);
		return;
	}

	if (shutdownSignal) {
		if (!forwardSignal("SIGKILL")) {
			terminateSelf(signal);
		}
		return;
	}

	shutdownSignal = signal;
	if (!forwardSignal(signal)) {
		terminateSelf(signal);
		return;
	}

	scheduleForcedKill();
}

for (const signal of forwardedSignals) {
	process.on(signal, handleSignal);
}

child.on("error", () => {
	clearForcedKillTimer();
	removeSignalHandlers();
	process.exit(1);
});

child.on("exit", (code, signal) => {
	childExited = true;
	clearForcedKillTimer();
	removeSignalHandlers();

	restorePrimaryScreen();

	if (signal) {
		terminateSelf(signal);
		return;
	}

	process.exit(code ?? 0);
});

process.on("exit", () => {
	if (childExited) {
		return;
	}

	forwardSignal("SIGTERM");
});
