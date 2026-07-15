import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopMissionControlChildren } from "../src/db/missionControl";

const tempRoots: string[] = [];

const createRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-mc-stop-"));
	tempRoots.push(root);
	return root;
};

const executable = (path: string, script: string): string => {
	writeFileSync(path, `#!/bin/bash\n${script}`);
	chmodSync(path, 0o755);
	return path;
};

afterEach(() => {
	for (const root of tempRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("stopMissionControlChildren", () => {
	it("awaits one child-only call and routes the selected database parent", async () => {
		const root = createRoot();
		const argvPath = join(root, "argv");
		const dataDirPath = join(root, "data-dir");
		const countPath = join(root, "count");
		const databasePath = join(root, "selected", "mission-control.db");
		const fakeMc = executable(
			join(root, "mc"),
			`printf '%s\n' "$@" > "${argvPath}"
printf '%s' "$MCTRL_DATA_DIR" > "${dataDirPath}"
printf 'one' >> "${countPath}"
printf 'Stopped 1/2 session(s); 1 failed.'
exit 1
`,
		);

		const result = await stopMissionControlChildren("mc-parent", {
			databasePath,
			mcExecutable: fakeMc,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("Stopped 1/2 session(s); 1 failed.");
		expect(readFileSync(argvPath, "utf8").trim().split("\n")).toEqual([
			"session",
			"stop",
			"mc-parent",
			"--child-only",
		]);
		expect(readFileSync(dataDirPath, "utf8")).toBe(dirname(databasePath));
		expect(readFileSync(countPath, "utf8")).toBe("one");
	});

	it("falls back to mctrl only when mc is unavailable", async () => {
		const root = createRoot();
		const markerPath = join(root, "mctrl-used");
		executable(join(root, "mctrl"), `printf 'yes' > "${markerPath}"\n`);
		const originalPath = process.env.PATH;
		process.env.PATH = root;
		try {
			const result = await stopMissionControlChildren("mc-parent", {
				databasePath: join(root, "mission-control.db"),
			});
			expect(result.exitCode).toBe(0);
			expect(existsSync(markerPath)).toBe(true);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("prefers mc when both executable names are available", async () => {
		const root = createRoot();
		const mcMarker = join(root, "mc-used");
		const aliasMarker = join(root, "mctrl-used");
		executable(join(root, "mc"), `printf 'yes' > "${mcMarker}"\n`);
		executable(join(root, "mctrl"), `printf 'yes' > "${aliasMarker}"\n`);
		const originalPath = process.env.PATH;
		process.env.PATH = root;
		try {
			const result = await stopMissionControlChildren("mc-parent", {
				databasePath: join(root, "mission-control.db"),
			});
			expect(result.exitCode).toBe(0);
			expect(existsSync(mcMarker)).toBe(true);
			expect(existsSync(aliasMarker)).toBe(false);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("rejects a hung stop without entering an exit-1 fallback", async () => {
		const root = createRoot();
		const fakeMc = executable(join(root, "mc"), "exec /bin/sleep 1\n");

		await expect(
			stopMissionControlChildren("mc-parent", {
				databasePath: join(root, "mission-control.db"),
				mcExecutable: fakeMc,
				timeoutMs: 20,
			}),
		).rejects.toThrow("Mission Control child stop timed out.");
	});
});
