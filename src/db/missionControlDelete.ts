import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { which } from "../lib/which";
import { createQueryFailedDatabaseError, type DatabaseResult } from "./index";

export interface MissionControlDeleteResult {
	deletedSessionIds: string[];
	stdout: string;
}

export interface DeleteMissionControlSessionOptions {
	force?: boolean;
	mcExecutable?: string;
	databasePath?: string;
	expectedTreeToken?: string;
	environment?: NodeJS.ProcessEnv;
}

const MISSION_CONTROL_DELETE_LINE_PATTERN =
	/^Deleted session (\S+) \((\d+) events\)$/;

const runMissionControlDelete = (
	executable: string,
	args: string[],
	environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: environment,
		});
		let stdoutText = "";
		let stderrText = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdoutText += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderrText += chunk;
		});
		child.on("close", (code) => {
			resolve({ stdout: stdoutText, stderr: stderrText, exitCode: code ?? 1 });
		});
		child.on("error", reject);
	});
};

export const deleteMissionControlSession = async (
	sessionId: string,
	options: DeleteMissionControlSessionOptions = {},
): Promise<DatabaseResult<MissionControlDeleteResult>> => {
	const executable =
		options.mcExecutable ?? which("mc") ?? which("mctrl") ?? "mctrl";
	const args = ["session", "delete", sessionId];
	if (options.force) {
		args.push("--force");
	}
	if (options.expectedTreeToken) {
		args.push("--expected-tree-token", options.expectedTreeToken);
	}
	const environment = {
		...(options.environment ?? process.env),
		...(options.databasePath
			? { MCTRL_DATA_DIR: dirname(options.databasePath) }
			: {}),
	};

	try {
		const { stdout, stderr, exitCode } = await runMissionControlDelete(
			executable,
			args,
			environment,
		);

		if (exitCode !== 0) {
			const rawMessage = (stderr || stdout).trim();
			const message =
				rawMessage.length > 0
					? rawMessage
					: `${executable} session delete exited with code ${exitCode}.`;
			return {
				ok: false,
				error: {
					code: "query_failed",
					message,
				},
			};
		}

		const deletedSessionIds: string[] = [];
		for (const line of stdout.split("\n")) {
			const match = MISSION_CONTROL_DELETE_LINE_PATTERN.exec(line.trim());
			if (match) {
				deletedSessionIds.push(match[1]);
			}
		}

		// Bundled mc historically no-op'd with exit 0 and empty stdout when the
		// Vite chunk broke isCliEntrypoint(). Treat missing confirmation as
		// failure so Ground Control never claims a delete that did not run.
		if (
			deletedSessionIds.length === 0 ||
			!deletedSessionIds.includes(sessionId)
		) {
			const rawMessage = (stderr || stdout).trim();
			const base = `${executable} session delete exited 0 without confirming deletion of ${sessionId}.`;
			const message =
				rawMessage.length > 0 ? `${base} Output: ${rawMessage}` : base;
			return {
				ok: false,
				error: {
					code: "query_failed",
					message,
				},
			};
		}

		return {
			ok: true,
			value: {
				deletedSessionIds,
				stdout,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: createQueryFailedDatabaseError(
				error,
				"Mission Control session delete failed.",
			),
		};
	}
};
