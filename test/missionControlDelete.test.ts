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
import { deleteMissionControlSession } from "../src/db/missionControl";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-mc-delete-"));
	tempRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const writeExecutable = (path: string, script: string): string => {
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return path;
};

const SHEBANG = "#!/usr/bin/env bash\n";
// PATH-isolated tests need a direct shebang: env(1) cannot find bash when PATH
// contains only the temp dir, so #!/usr/bin/env bash exits 127. Use /bin/bash.
const ISOLATED_SHEBANG = "#!/bin/bash\n";

describe("deleteMissionControlSession", () => {
	it("parses deleted session ids from mctrl stdout and returns ok", async () => {
		const root = createTempRoot();
		const fakeMctrl = writeExecutable(
			join(root, "mctrl"),
			`${SHEBANG}echo "Deleted session mc-root (12 events)"
echo "Deleted session mc-child (3 events)"
`,
		);

		const result = await deleteMissionControlSession("mc-root", {
			mcExecutable: fakeMctrl,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.deletedSessionIds).toEqual(["mc-root", "mc-child"]);
		expect(result.value.stdout).toContain("Deleted session mc-root");
	});

	it("surfaces live-lock failure with the stderr message", async () => {
		const root = createTempRoot();
		const fakeMctrl = writeExecutable(
			join(root, "mctrl"),
			`${SHEBANG}echo "Refusing to delete 1 session(s) with active locks: mc-root. Close the active session(s) first or rerun with --force." >&2
exit 1
`,
		);

		const result = await deleteMissionControlSession("mc-root", {
			mcExecutable: fakeMctrl,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.message).toContain("active locks");
		expect(result.error.message).toContain("--force");
	});

	it("surfaces not-found failure when mctrl exits non-zero without live-lock text", async () => {
		const root = createTempRoot();
		const fakeMctrl = writeExecutable(
			join(root, "mctrl"),
			`${SHEBANG}echo "Session not found: missing-id" >&2
exit 1
`,
		);

		const result = await deleteMissionControlSession("missing-id", {
			mcExecutable: fakeMctrl,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.message).toContain("Session not found");
	});

	it("passes --force when the force option is set", async () => {
		const root = createTempRoot();
		const markerPath = join(root, "force-invoked");
		const fakeMctrl = writeExecutable(
			join(root, "mctrl"),
			`${SHEBANG}if [ "$4" = "--force" ]; then
  touch "${markerPath}"
fi
echo "Deleted session mc-root (1 events)"
`,
		);

		const result = await deleteMissionControlSession("mc-root", {
			mcExecutable: fakeMctrl,
			force: true,
		});

		expect(result.ok).toBe(true);
		// Verifies argv: session delete <id> --force (force is the 5th positional after the executable path).
		expect(existsSync(markerPath)).toBe(true);
	});

	it("prefers mc over mctrl when both are resolvable on PATH", async () => {
		const root = createTempRoot();
		const mcMarker = join(root, "mc-invoked");
		const mctrlMarker = join(root, "mctrl-invoked");
		// Marker creation uses shell builtins only: an isolated PATH has no
		// `touch`, so a bare `touch "$m"` would silently fail and hide which
		// binary actually ran. `echo >` + redirection are builtins.
		writeExecutable(
			join(root, "mc"),
			`${ISOLATED_SHEBANG}echo x > "${mcMarker}"
echo "Deleted session mc-root (1 events)"
`,
		);
		writeExecutable(
			join(root, "mctrl"),
			`${ISOLATED_SHEBANG}echo x > "${mctrlMarker}"
echo "Deleted session mc-root (1 events)"
`,
		);
		const originalPath = process.env.PATH;
		process.env.PATH = root;
		try {
			const result = await deleteMissionControlSession("mc-root");

			expect(result.ok).toBe(true);
			expect(existsSync(mcMarker)).toBe(true);
			expect(existsSync(mctrlMarker)).toBe(false);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("falls back to mctrl when only mctrl is resolvable on PATH", async () => {
		const root = createTempRoot();
		writeExecutable(
			join(root, "mctrl"),
			`${ISOLATED_SHEBANG}echo "Deleted session mc-root (2 events)"
`,
		);
		const originalPath = process.env.PATH;
		process.env.PATH = root;
		try {
			const result = await deleteMissionControlSession("mc-root");

			expect(result.ok).toBe(true);
			if (!result.ok) {
				return;
			}
			expect(result.value.deletedSessionIds).toEqual(["mc-root"]);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("routes guarded non-force delete to the selected data directory", async () => {
		const root = createTempRoot();
		const argvPath = join(root, "argv");
		const dataDirPath = join(root, "data-dir");
		const databasePath = join(root, "selected-store", "mission-control.db");
		const token = "a".repeat(64);
		const fakeMc = writeExecutable(
			join(root, "mc"),
			`${SHEBANG}printf '%s\n' "$@" > "${argvPath}"
printf '%s' "$MCTRL_DATA_DIR" > "${dataDirPath}"
echo "Deleted session mc-child (2 events)"
`,
		);

		const result = await deleteMissionControlSession("mc-child", {
			mcExecutable: fakeMc,
			databasePath,
			expectedTreeToken: token,
		});

		expect(result.ok).toBe(true);
		expect(readFileSync(argvPath, "utf8").trim().split("\n")).toEqual([
			"session",
			"delete",
			"mc-child",
			"--expected-tree-token",
			token,
		]);
		expect(readFileSync(dataDirPath, "utf8")).toBe(dirname(databasePath));
		expect(readFileSync(argvPath, "utf8")).not.toContain("--force");
	});
});
