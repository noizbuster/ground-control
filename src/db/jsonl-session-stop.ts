import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

export type JsonlSessionSource = "omp" | "gjc";

export interface JsonlSessionProcess {
	readonly pid: number;
	readonly comm: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

export interface JsonlSessionStopOptions {
	readonly sessionPath?: string;
	readonly processes?: readonly JsonlSessionProcess[];
	readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

export type JsonlSessionStopResult =
	| { readonly ok: true; readonly pids: readonly number[] }
	| { readonly ok: false; readonly error: string };

interface JsonlSessionProcessConfig {
	readonly label: string;
	readonly executable: string;
	readonly runtimeEntryPoints: Record<string, true>;
	readonly sessionFlags: Record<string, true>;
	readonly sessionFlagPrefixes: readonly string[];
}

const RUNTIME_COMMS: Record<string, true> = {
	bun: true,
	node: true,
	deno: true,
};
const JSONL_PROCESS_COMMS: Record<string, true> = {
	omp: true,
	gjc: true,
	...RUNTIME_COMMS,
};
const RUNTIME_FLAGS_WITH_VALUE: Record<string, true> = {
	"--conditions": true,
	"--config": true,
	"--env-file": true,
	"--env-file-if-exists": true,
	"--experimental-config-file": true,
	"--experimental-loader": true,
	"--experimental-package-map": true,
	"--experimental-sea-config": true,
	"--import": true,
	"--input-type": true,
	"--inspect-port": true,
	"--loader": true,
	"--require": true,
	"--watch-path": true,
	"-r": true,
};
const JSONL_SESSION_PROCESS_CONFIGS: Record<
	JsonlSessionSource,
	JsonlSessionProcessConfig
> = {
	omp: {
		label: "OMP",
		executable: "omp",
		runtimeEntryPoints: { omp: true },
		sessionFlags: { "--resume": true, "-r": true, "--session": true },
		sessionFlagPrefixes: ["--resume=", "--session="],
	},
	gjc: {
		label: "GJC",
		executable: "gjc",
		runtimeEntryPoints: { gjc: true, "gjc.js": true },
		sessionFlags: { "--resume": true, "-r": true },
		sessionFlagPrefixes: ["--resume="],
	},
};

const getBasename = (value: string): string => basename(value).toLowerCase();

const getJsonlExecutableIndex = (
	source: JsonlSessionSource,
	process: JsonlSessionProcess,
): number | undefined => {
	const config = JSONL_SESSION_PROCESS_CONFIGS[source];
	const comm = process.comm.toLowerCase();
	if (
		comm === config.executable &&
		getBasename(process.args[0] ?? "") === config.executable
	) {
		return 0;
	}

	const runtime = getBasename(process.args[0] ?? "");
	if (
		RUNTIME_COMMS[runtime] !== true ||
		(comm !== runtime && comm !== config.executable)
	) {
		return undefined;
	}

	let skipsNextToken = false;
	for (let index = 1; index < process.args.length; index += 1) {
		const argument = process.args[index];
		if (skipsNextToken) {
			skipsNextToken = false;
			continue;
		}
		if (RUNTIME_FLAGS_WITH_VALUE[argument] === true) {
			skipsNextToken = true;
			continue;
		}
		if (argument.startsWith("-")) {
			continue;
		}
		return config.runtimeEntryPoints[getBasename(argument)] === true
			? index
			: undefined;
	}

	return undefined;
};

const getJsonlSessionReference = (
	source: JsonlSessionSource,
	args: readonly string[],
	executableIndex: number,
): string | undefined => {
	const config = JSONL_SESSION_PROCESS_CONFIGS[source];
	for (let index = executableIndex + 1; index < args.length; index += 1) {
		const argument = args[index];
		if (config.sessionFlags[argument] === true) {
			return args[index + 1];
		}
		for (const prefix of config.sessionFlagPrefixes) {
			if (argument.startsWith(prefix)) {
				return argument.slice(prefix.length);
			}
		}
	}

	return undefined;
};

const resolveSessionPath = (sessionPath: string, cwd?: string): string =>
	resolve(
		isAbsolute(sessionPath)
			? sessionPath
			: resolve(cwd ?? process.cwd(), sessionPath),
	);

const readJsonlSessionProcesses = (): JsonlSessionProcess[] => {
	if (process.platform !== "linux") {
		return [];
	}

	const processes: JsonlSessionProcess[] = [];
	for (const entry of readdirSync("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
			continue;
		}

		const pid = Number(entry.name);
		if (!Number.isSafeInteger(pid) || pid <= 0) {
			continue;
		}

		try {
			const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
			if (JSONL_PROCESS_COMMS[comm.toLowerCase()] !== true) {
				continue;
			}

			const args = readFileSync(`/proc/${pid}/cmdline`, "utf8")
				.split("\0")
				.filter((argument) => argument.length > 0);
			if (args.length === 0) {
				continue;
			}

			let cwd: string | undefined;
			try {
				cwd = realpathSync(`/proc/${pid}/cwd`);
			} catch {}

			processes.push({ pid, comm, args, cwd });
		} catch {}
	}

	return processes;
};

/**
 * Finds only processes for the requested source that explicitly resumed the
 * exact JSONL file. A session ID or process working directory alone is never
 * sufficient to identify a process for signalling.
 */
export const findJsonlSessionProcessIds = (
	source: JsonlSessionSource,
	sessionPath: string,
	processes: readonly JsonlSessionProcess[],
): number[] => {
	if (!sessionPath.endsWith(".jsonl")) {
		return [];
	}
	const targetPath = resolveSessionPath(sessionPath);
	return processes.flatMap((process) => {
		const executableIndex = getJsonlExecutableIndex(source, process);
		if (executableIndex === undefined) {
			return [];
		}

		const reference = getJsonlSessionReference(
			source,
			process.args,
			executableIndex,
		);
		if (
			!reference ||
			resolveSessionPath(reference, process.cwd) !== targetPath
		) {
			return [];
		}

		return [process.pid];
	});
};

export const stopJsonlSession = (
	source: JsonlSessionSource,
	options: JsonlSessionStopOptions,
): JsonlSessionStopResult => {
	const sourceLabel = JSONL_SESSION_PROCESS_CONFIGS[source].label;
	if (!options.sessionPath?.endsWith(".jsonl")) {
		return {
			ok: false,
			error: `${sourceLabel} session path is unavailable; refusing to signal an unverified process.`,
		};
	}
	if (process.platform !== "linux" && !options.processes) {
		return {
			ok: false,
			error: `${sourceLabel} session stop is currently supported on Linux only.`,
		};
	}

	const pids = findJsonlSessionProcessIds(
		source,
		options.sessionPath,
		options.processes ?? readJsonlSessionProcesses(),
	);
	if (pids.length === 0) {
		return {
			ok: false,
			error: `No running ${sourceLabel} process matched the exact session path.`,
		};
	}

	const sendSignal = options.sendSignal ?? process.kill;
	try {
		for (const pid of pids) {
			sendSignal(pid, "SIGINT");
		}
		return { ok: true, pids };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? `Failed to interrupt ${sourceLabel} session: ${error.message}`
					: `Failed to interrupt ${sourceLabel} session.`,
		};
	}
};
