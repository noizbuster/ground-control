import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getSessionStatus } from "../lib/status";
import { SessionStatus } from "../types";
import { which } from "../lib/which";

export type OpencodeStopMethod = "abort" | "stop-message";

export interface OpencodeSessionStopResult {
	readonly ok: boolean;
	readonly method?: OpencodeStopMethod;
	readonly error?: string;
}

export interface OpencodeSessionStopOptions {
	readonly sessionId: string;
	readonly directory: string;
	readonly opencodeExecutable?: string;
	readonly abortTimeoutMs?: number;
	readonly stopMessageTimeoutMs?: number;
	readonly serveTimeoutMs?: number;
	readonly abortSettleMs?: number;
	readonly stopSettleMs?: number;
	readonly databasePath?: string;
	readonly fetchImpl?: typeof fetch;
	readonly discoverBaseUrls?: () => Promise<readonly string[]>;
	readonly withEphemeralServer?: <T>(
		run: (baseUrl: string) => Promise<T>,
	) => Promise<T>;
	readonly sendStopMessage?: () => Promise<OpencodeSessionStopResult>;
	readonly isSessionStillActive?: () => boolean | Promise<boolean>;
	readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ABORT_TIMEOUT_MS = 3_000;
const DEFAULT_STOP_MESSAGE_TIMEOUT_MS = 12_000;
const DEFAULT_SERVE_TIMEOUT_MS = 8_000;
const DEFAULT_ABORT_SETTLE_MS = 500;
const DEFAULT_STOP_SETTLE_MS = 2_000;

const OPENCODE_DIRECTORY_HEADER = "x-opencode-directory";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const resolveOpencodeDatabasePath = (override?: string): string => {
	const trimmed = override?.trim();
	if (trimmed) return trimmed;
	const envPath = process.env.GCTRL_DB_PATH?.trim();
	if (envPath) return envPath;
	return `${homedir()}/.local/share/opencode/opencode.db`;
};

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const isOpencodeSessionStillActive = (
	sessionId: string,
	databasePath?: string,
): boolean => {
	const dbPath = resolveOpencodeDatabasePath(databasePath);
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(dbPath, { readOnly: true });
		const row = database
			.prepare(
				`SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1`,
			)
			.get(sessionId) as { data: string } | undefined;
		if (!row?.data) return false;
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.data);
		} catch {
			return true;
		}
		const status = getSessionStatus(
			parsed as Parameters<typeof getSessionStatus>[0],
		);
		return (
			status !== SessionStatus.completed && status !== SessionStatus.failed
		);
	} catch {
		return false;
	} finally {
		database?.close();
	}
};

const parseListeningPort = (hexPort: string): number | null => {
	const port = Number.parseInt(hexPort, 16);
	return Number.isFinite(port) && port > 0 ? port : null;
};

const collectOpencodePids = (): number[] => {
	const pids = new Set<number>();
	try {
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			const pid = Number(entry);
			try {
				const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
				if (comm === "opencode") {
					pids.add(pid);
					continue;
				}
			} catch {
				// ignore unreadable comm
			}
			try {
				const exe = readlinkSync(`/proc/${pid}/exe`);
				if (exe.includes("opencode")) pids.add(pid);
			} catch {
				// ignore unreadable exe
			}
		}
	} catch {
		// /proc unavailable
	}
	return [...pids];
};

export const discoverOpencodeListenPorts = (): number[] => {
	const ports = new Set<number>();
	const pids = collectOpencodePids();
	const inodeToPort = new Map<string, number>();

	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"] as const) {
		try {
			const text = readFileSync(table, "utf8");
			for (const line of text.split("\n").slice(1)) {
				const parts = line.trim().split(/\s+/);
				if (parts.length < 10) continue;
				if (parts[3] !== "0A") continue;
				const local = parts[1];
				const inode = parts[9];
				const hexPort = local?.split(":")[1];
				if (!hexPort) continue;
				const port = parseListeningPort(hexPort);
				if (port) inodeToPort.set(inode, port);
			}
		} catch {
			// ignore missing net table
		}
	}

	for (const pid of pids) {
		try {
			for (const fd of readdirSync(`/proc/${pid}/fd`)) {
				let target = "";
				try {
					target = readlinkSync(`/proc/${pid}/fd/${fd}`);
				} catch {
					continue;
				}
				const match = /^socket:\[(\d+)\]$/.exec(target);
				if (!match) continue;
				const port = inodeToPort.get(match[1]);
				if (port) ports.add(port);
			}
		} catch {
			// ignore missing fd table
		}
	}

	return [...ports].sort((a, b) => a - b);
};

export const defaultDiscoverBaseUrls = async (
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 800,
): Promise<string[]> => {
	const ports = discoverOpencodeListenPorts();
	const urls: string[] = [];
	await Promise.all(
		ports.map(async (port) => {
			const baseUrl = `http://127.0.0.1:${port}`;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetchImpl(`${baseUrl}/global/health`, {
					signal: controller.signal,
				});
				if (!response.ok) return;
				const body: unknown = await response.json().catch(() => null);
				if (isRecord(body) && body.healthy === true) {
					urls.push(baseUrl);
				}
			} catch {
				// not an opencode HTTP API
			} finally {
				clearTimeout(timer);
			}
		}),
	);
	return urls;
};

export const postOpencodeSessionAbort = async (
	baseUrl: string,
	sessionId: string,
	directory: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
): Promise<OpencodeSessionStopResult> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const url = new URL(
			`/session/${encodeURIComponent(sessionId)}/abort`,
			baseUrl,
		);
		url.searchParams.set("directory", directory);
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				[OPENCODE_DIRECTORY_HEADER]: directory,
				"content-type": "application/json",
			},
			body: "",
			signal: controller.signal,
		});
		if (!response.ok) {
			return {
				ok: false,
				error: `abort HTTP ${response.status}`,
			};
		}
		return { ok: true, method: "abort" };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "abort request failed",
		};
	} finally {
		clearTimeout(timer);
	}
};

const defaultSendStopMessage = (
	sessionId: string,
	directory: string,
	opencodeExecutable: string,
	timeoutMs: number,
): Promise<OpencodeSessionStopResult> =>
	new Promise((resolve) => {
		const proc = spawn(
			opencodeExecutable,
			["run", "--session", sessionId, "stop"],
			{ cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
		);
		let settled = false;
		const finish = (result: OpencodeSessionStopResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			proc.kill();
			finish({ ok: false, error: "stop message timed out" });
		}, timeoutMs);
		proc.on("close", (code) => {
			if (code === 0) {
				finish({ ok: true, method: "stop-message" });
				return;
			}
			finish({ ok: false, error: `stop message exit code ${code ?? 1}` });
		});
		proc.on("error", (error) => {
			finish({
				ok: false,
				error: error instanceof Error ? error.message : "stop message failed",
			});
		});
	});

const defaultWithEphemeralServer = async <T>(
	opencodeExecutable: string,
	serveTimeoutMs: number,
	run: (baseUrl: string) => Promise<T>,
): Promise<T> => {
	const proc: ChildProcess = spawn(
		opencodeExecutable,
		["serve", "--hostname", "127.0.0.1", "--port", "0"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	let output = "";
	const onChunk = (chunk: string | Buffer) => {
		output += chunk.toString();
	};
	proc.stdout?.setEncoding("utf8");
	proc.stderr?.setEncoding("utf8");
	proc.stdout?.on("data", onChunk);
	proc.stderr?.on("data", onChunk);

	const baseUrl = await new Promise<string>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill();
			reject(new Error("opencode serve timed out before becoming ready"));
		}, serveTimeoutMs);

		const tryParse = () => {
			const match = output.match(
				/listening on (https?:\/\/(?:\d+\.){3}\d+:\d+)/i,
			);
			if (!match || settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(match[1]);
		};

		proc.stdout?.on("data", tryParse);
		proc.stderr?.on("data", tryParse);
		proc.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				new Error(
					`opencode serve exited before ready (code ${code ?? 1}): ${output.slice(-200)}`,
				),
			);
		});
	});

	try {
		return await run(baseUrl);
	} finally {
		proc.kill();
	}
};

export const stopOpencodeSession = async (
	options: OpencodeSessionStopOptions,
): Promise<OpencodeSessionStopResult> => {
	const fetchImpl = options.fetchImpl ?? fetch;
	const abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
	const stopMessageTimeoutMs =
		options.stopMessageTimeoutMs ?? DEFAULT_STOP_MESSAGE_TIMEOUT_MS;
	const serveTimeoutMs = options.serveTimeoutMs ?? DEFAULT_SERVE_TIMEOUT_MS;
	const abortSettleMs = options.abortSettleMs ?? DEFAULT_ABORT_SETTLE_MS;
	const stopSettleMs = options.stopSettleMs ?? DEFAULT_STOP_SETTLE_MS;
	const opencodeExecutable =
		options.opencodeExecutable ?? which("opencode") ?? "opencode";
	const directory = options.directory.trim() || process.cwd();
	const sessionId = options.sessionId;
	const sleep = options.sleep ?? defaultSleep;
	const isStillActive =
		options.isSessionStillActive ??
		(() => isOpencodeSessionStillActive(sessionId, options.databasePath));

	const errors: string[] = [];

	const acceptIfSettled = async (
		result: OpencodeSessionStopResult,
		settleMs: number,
	): Promise<OpencodeSessionStopResult | null> => {
		if (!result.ok) return null;
		if (settleMs > 0) await sleep(settleMs);
		if (await isStillActive()) {
			errors.push(
				`${result.method ?? "stop"} reported ok but session is still active`,
			);
			return null;
		}
		return result;
	};

	const discover =
		options.discoverBaseUrls ?? (() => defaultDiscoverBaseUrls(fetchImpl));

	const baseUrls = await discover();
	for (const baseUrl of baseUrls) {
		const result = await postOpencodeSessionAbort(
			baseUrl,
			sessionId,
			directory,
			fetchImpl,
			abortTimeoutMs,
		);
		const settled = await acceptIfSettled(result, abortSettleMs);
		if (settled) return settled;
		if (result.error) errors.push(`${baseUrl}: ${result.error}`);
	}

	// Only pay for ephemeral serve when no healthy server was discovered.
	if (baseUrls.length === 0) {
		const withServer =
			options.withEphemeralServer ??
			((run) =>
				defaultWithEphemeralServer(opencodeExecutable, serveTimeoutMs, run));

		try {
			const ephemeralResult = await withServer((baseUrl) =>
				postOpencodeSessionAbort(
					baseUrl,
					sessionId,
					directory,
					fetchImpl,
					abortTimeoutMs,
				),
			);
			const settled = await acceptIfSettled(ephemeralResult, abortSettleMs);
			if (settled) return settled;
			if (ephemeralResult.error) {
				errors.push(`ephemeral serve: ${ephemeralResult.error}`);
			}
		} catch (error) {
			errors.push(
				`ephemeral serve: ${error instanceof Error ? error.message : "failed"}`,
			);
		}
	}

	const sendStop =
		options.sendStopMessage ??
		(() =>
			defaultSendStopMessage(
				sessionId,
				directory,
				opencodeExecutable,
				stopMessageTimeoutMs,
			));

	const stopResult = await sendStop();
	const settledStop = await acceptIfSettled(stopResult, stopSettleMs);
	if (settledStop) return settledStop;
	if (stopResult.error) errors.push(stopResult.error);

	return {
		ok: false,
		error: errors.length > 0 ? errors.join("; ") : "failed to stop session",
	};
};
