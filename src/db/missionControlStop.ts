import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { which } from "../lib/which";

export interface MissionControlStopResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface StopMissionControlChildrenOptions {
	readonly databasePath: string;
	readonly mcExecutable?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
}

const DEFAULT_PROCESS_TIMEOUT_MS = 16_000;

export const stopMissionControlChildren = (
	parentSessionId: string,
	options: StopMissionControlChildrenOptions,
): Promise<MissionControlStopResult> => {
	const executable =
		options.mcExecutable ?? which("mc") ?? which("mctrl") ?? "mctrl";
	const environment = {
		...(options.environment ?? process.env),
		MCTRL_DATA_DIR: dirname(options.databasePath),
	};
	return new Promise((resolve, reject) => {
		const child = spawn(
			executable,
			["session", "stop", parentSessionId, "--child-only"],
			{ stdio: ["ignore", "pipe", "pipe"], env: environment },
		);
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error("Mission Control child stop timed out."));
		}, options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
	});
};
