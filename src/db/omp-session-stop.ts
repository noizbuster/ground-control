import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

export interface OmpProcess {
	readonly pid: number;
	readonly comm: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

export interface OmpSessionStopOptions {
	readonly sessionPath?: string;
	readonly processes?: readonly OmpProcess[];
	readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

export type OmpSessionStopResult =
	| { readonly ok: true; readonly pids: readonly number[] }
	| { readonly ok: false; readonly error: string };

const OMP_RUNTIME_COMMS: Record<string, true> = {
	bun: true,
	node: true,
	deno: true,
};
const OMP_PROCESS_COMMS: Record<string, true> = {
	omp: true,
	...OMP_RUNTIME_COMMS,
};
const OMP_SESSION_FLAGS: Record<string, true> = {
	"--resume": true,
	"-r": true,
	"--session": true,
};
const OMP_SESSION_FLAG_PREFIXES = ["--resume=", "--session="];

const getBasename = (value: string): string => basename(value).toLowerCase();

const getOmpExecutableIndex = (process: OmpProcess): number | undefined => {
	const comm = process.comm.toLowerCase();
	if (comm === "omp" && getBasename(process.args[0] ?? "") === "omp") {
		return 0;
	}

	if (
		OMP_RUNTIME_COMMS[comm] === true &&
		getBasename(process.args[0] ?? "") === comm &&
		getBasename(process.args[1] ?? "") === "omp"
	) {
		return 1;
	}

	return undefined;
};

const getOmpSessionReference = (
	args: readonly string[],
	executableIndex: number,
): string | undefined => {
	for (let index = executableIndex + 1; index < args.length; index += 1) {
		const argument = args[index];
		if (OMP_SESSION_FLAGS[argument] === true) {
			return args[index + 1];
		}
		for (const prefix of OMP_SESSION_FLAG_PREFIXES) {
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

const readOmpProcesses = (): OmpProcess[] => {
	if (process.platform !== "linux") {
		return [];
	}

	const processes: OmpProcess[] = [];
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
			if (OMP_PROCESS_COMMS[comm.toLowerCase()] !== true) {
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
 * Finds only OMP processes that explicitly resumed the exact JSONL file.
 * A session ID alone is deliberately insufficient: OMP's reliable process
 * identity is the resume path, so this never broad-signals every OMP process
 * in a project.
 */
export const findOmpSessionProcessIds = (
	sessionPath: string,
	processes: readonly OmpProcess[],
): number[] => {
	const targetPath = resolveSessionPath(sessionPath);
	return processes.flatMap((process) => {
		const executableIndex = getOmpExecutableIndex(process);
		if (executableIndex === undefined) {
			return [];
		}

		const reference = getOmpSessionReference(process.args, executableIndex);
		if (
			!reference ||
			resolveSessionPath(reference, process.cwd) !== targetPath
		) {
			return [];
		}

		return [process.pid];
	});
};

export const stopOmpSession = (
	options: OmpSessionStopOptions,
): OmpSessionStopResult => {
	if (!options.sessionPath) {
		return {
			ok: false,
			error:
				"OMP session path is unavailable; refusing to signal an unverified process.",
		};
	}
	if (process.platform !== "linux" && !options.processes) {
		return {
			ok: false,
			error: "OMP session stop is currently supported on Linux only.",
		};
	}

	const pids = findOmpSessionProcessIds(
		options.sessionPath,
		options.processes ?? readOmpProcesses(),
	);
	if (pids.length === 0) {
		return {
			ok: false,
			error: "No running OMP process matched the exact session path.",
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
					? `Failed to interrupt OMP session: ${error.message}`
					: "Failed to interrupt OMP session.",
		};
	}
};
