import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const OWNER_SHUTDOWN_TIMEOUT_MS = 5_000;

export type ProcessResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type OwnerScenario =
	| "active"
	| "blocked"
	| "tree"
	| "noncooperative"
	| "owner-death";

export type OwnerReady = {
	readonly type: "ready";
	readonly scenario: OwnerScenario;
	readonly dbPath: string;
	readonly sessionIds: readonly string[];
};

export class OwnerFixtureProcess {
	readonly ready: Promise<OwnerReady>;
	readonly exited: Promise<number>;
	private readonly acknowledgements: Array<(value: unknown) => void> = [];
	private closed = false;

	constructor(readonly child: ChildProcessWithoutNullStreams) {
		let resolveReady = (_value: OwnerReady): void => {};
		let rejectReady = (_error: Error): void => {};
		this.ready = new Promise<OwnerReady>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const output = createInterface({
			input: child.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		output.on("line", (line) => {
			const value: unknown = JSON.parse(line);
			if (isReady(value)) resolveReady(value);
			else this.acknowledgements.shift()?.(value);
		});
		this.exited = new Promise((resolve) => {
			child.once("close", (code) => {
				this.closed = true;
				if (code !== 0)
					rejectReady(new Error(stderr || `owner fixture exited ${code ?? 1}`));
				resolve(code ?? 1);
			});
		});
	}

	command(value: unknown): Promise<unknown> {
		if (this.closed)
			return Promise.reject(new Error("owner fixture is closed"));
		return new Promise((resolve) => {
			this.acknowledgements.push(resolve);
			this.child.stdin.write(`${JSON.stringify(value)}\n`);
		});
	}

	async shutdown(): Promise<unknown> {
		if (this.closed) return;
		let acknowledgement: unknown;
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<{ readonly kind: "expired" }>((resolve) => {
			timer = setTimeout(
				() => resolve({ kind: "expired" }),
				OWNER_SHUTDOWN_TIMEOUT_MS,
			);
		});
		try {
			const outcome = await Promise.race([
				this.command({ command: "shutdown" }).then(async (value) => {
					acknowledgement = value;
					await this.exited;
					return { kind: "closed" as const };
				}),
				this.exited.then(() => ({ kind: "closed" as const })),
				deadline,
			]);
			if (outcome.kind === "expired") this.kill();
			await this.exited;
			return acknowledgement;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	kill(): void {
		if (!this.closed) this.child.kill();
	}
}

export function startOwnerFixture(input: {
	readonly dataDir: string;
	readonly scenario: OwnerScenario;
	readonly runtimeDir: string;
}): OwnerFixtureProcess {
	const fixtureEntry = requiredEnvironment("MC_OWNER_FIXTURE_ENTRY");
	return new OwnerFixtureProcess(
		spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				fixtureEntry,
				"--data-dir",
				input.dataDir,
				"--scenario",
				input.scenario,
			],
			{
				env: {
					...process.env,
					MCTRL_DATA_DIR: input.dataDir,
					XDG_RUNTIME_DIR: input.runtimeDir,
				},
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			},
		),
	);
}

export function runMissionControl(
	dataDir: string,
	args: readonly string[],
): Promise<ProcessResult> {
	return runProcess(
		process.execPath,
		[requiredEnvironment("MC_CLI_ENTRY"), ...args],
		{
			...process.env,
			MCTRL_DATA_DIR: dataDir,
			MISSION_CONTROL_SIDECAR: requiredEnvironment("MC_NATIVE_SIDECAR"),
		},
	);
}

export function runProcess(
	executable: string,
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) =>
			resolve({ exitCode: code ?? 1, stdout, stderr }),
		);
	});
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0)
		throw new TypeError(`missing ${name}`);
	return value;
}

function isReady(value: unknown): value is OwnerReady {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "ready" &&
		typeof Reflect.get(value, "dbPath") === "string"
	);
}
