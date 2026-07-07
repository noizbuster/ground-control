import { spawn } from "node:child_process";
import { which } from "../lib/which";
import { createQueryFailedDatabaseError, type DatabaseResult } from "./index";

export interface MissionControlDeleteResult {
	deletedSessionIds: string[];
	stdout: string;
}

export interface DeleteMissionControlSessionOptions {
	force?: boolean;
	mcExecutable?: string;
}

const MISSION_CONTROL_DELETE_LINE_PATTERN =
	/^Deleted session (\S+) \((\d+) events\)$/;

const runMissionControlDelete = (
	executable: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
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

	try {
		const { stdout, stderr, exitCode } = await runMissionControlDelete(
			executable,
			args,
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
