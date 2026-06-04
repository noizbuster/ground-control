import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { SubagentSession } from "../types";

type JsonRecord = Readonly<Record<string, unknown>>;

export type CodexChildAbortResult =
	| {
			readonly ok: true;
	  }
	| {
			readonly ok: false;
			readonly error: string;
	  };

export interface AbortCodexChildSessionOptions {
	readonly codexExecutable?: string;
	readonly timeoutMs?: number;
}

type PendingRequest = {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_CODEX_ABORT_TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is JsonRecord => {
	return typeof value === "object" && value !== null && !Array.isArray(value);
};

const getString = (record: JsonRecord, key: string): string | undefined => {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
};

const getRecord = (record: JsonRecord, key: string): JsonRecord | undefined => {
	const value = record[key];
	return isRecord(value) ? value : undefined;
};

const getJsonRpcErrorMessage = (message: JsonRecord): string | undefined => {
	const error = message.error;
	if (typeof error === "string" && error.trim().length > 0) {
		return error;
	}
	if (!isRecord(error)) {
		return undefined;
	}

	return getString(error, "message");
};

const selectActiveTurnId = (result: unknown): string | undefined => {
	if (!isRecord(result)) {
		return undefined;
	}
	const thread = getRecord(result, "thread");
	const turns = thread?.turns;
	if (!Array.isArray(turns)) {
		return undefined;
	}

	for (const turn of [...turns].reverse()) {
		if (!isRecord(turn)) {
			continue;
		}
		if (getString(turn, "status") === "inProgress") {
			return getString(turn, "id");
		}
	}

	for (const turn of [...turns].reverse()) {
		if (!isRecord(turn)) {
			continue;
		}
		const turnId = getString(turn, "id");
		if (turnId) {
			return turnId;
		}
	}

	return undefined;
};

class CodexAppServerClient {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #timeoutMs: number;
	#lineBuffer = "";
	#nextRequestId = 0;

	constructor(codexExecutable: string, timeoutMs: number) {
		this.#timeoutMs = timeoutMs;
		this.#child = spawn(
			codexExecutable,
			["app-server", "--listen", "stdio://"],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.#child.stdout.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk: string) => {
			this.#handleStdout(chunk);
		});
		this.#child.stderr.setEncoding("utf8");
		this.#child.stderr.on("data", () => {});
		this.#child.on("error", (error) => {
			this.#rejectAll(error);
		});
		this.#child.on("exit", (code) => {
			this.#rejectAll(
				new Error(`codex app-server exited with code ${code ?? "unknown"}`),
			);
		});
	}

	request(method: string, params: JsonRecord): Promise<unknown> {
		const id = this.#nextRequestId;
		this.#nextRequestId += 1;

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, this.#timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			this.#write({ id, method, params });
		});
	}

	notify(method: string, params?: JsonRecord): void {
		this.#write(params ? { method, params } : { method });
	}

	close(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
		}
		this.#pending.clear();
		if (!this.#child.stdin.destroyed) {
			this.#child.stdin.end();
		}
		if (this.#child.exitCode === null) {
			this.#child.kill("SIGTERM");
		}
	}

	#write(message: JsonRecord): void {
		this.#child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	#handleStdout(chunk: string): void {
		this.#lineBuffer += chunk;
		const lines = this.#lineBuffer.split(/\r?\n/gu);
		this.#lineBuffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (trimmedLine.length === 0) {
				continue;
			}
			this.#handleLine(trimmedLine);
		}
	}

	#handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch (error) {
			if (error instanceof SyntaxError) {
				return;
			}
			throw error;
		}

		if (!isRecord(message) || typeof message.id !== "number") {
			return;
		}
		const pending = this.#pending.get(message.id);
		if (!pending) {
			return;
		}

		this.#pending.delete(message.id);
		clearTimeout(pending.timer);
		const errorMessage = getJsonRpcErrorMessage(message);
		if (errorMessage) {
			pending.reject(new Error(errorMessage));
			return;
		}
		pending.resolve(message.result);
	}

	#rejectAll(error: Error): void {
		for (const [id, pending] of this.#pending.entries()) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}

export const abortCodexChildSession = async (
	session: Pick<SubagentSession, "id" | "directory" | "sourceMetadata">,
	options: AbortCodexChildSessionOptions = {},
): Promise<CodexChildAbortResult> => {
	const codexExecutable =
		options.codexExecutable ?? Bun.which("codex") ?? "codex";
	const timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_ABORT_TIMEOUT_MS;
	const client = new CodexAppServerClient(codexExecutable, timeoutMs);
	const turnIdFromLog = session.sourceMetadata?.lastTurnId;

	try {
		await client.request("initialize", {
			clientInfo: {
				name: "ground-control",
				title: "ground-control",
				version: "0.0.0",
			},
		});
		client.notify("initialized");

		const resumeParams: Record<string, string> = { threadId: session.id };
		if (session.directory.trim().length > 0) {
			resumeParams.cwd = session.directory;
		}
		const resumeResult = await client.request("thread/resume", resumeParams);
		const turnId = turnIdFromLog ?? selectActiveTurnId(resumeResult);
		if (!turnId) {
			return {
				ok: false,
				error: "Codex child thread has no active turn to interrupt.",
			};
		}

		await client.request("turn/interrupt", {
			threadId: session.id,
			turnId,
		});
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to interrupt Codex child turn.",
		};
	} finally {
		client.close();
	}
};
