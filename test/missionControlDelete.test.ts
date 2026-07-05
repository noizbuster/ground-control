import { afterEach, describe, expect, it } from "vitest";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
			mctrlExecutable: fakeMctrl,
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
			mctrlExecutable: fakeMctrl,
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
			mctrlExecutable: fakeMctrl,
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
			mctrlExecutable: fakeMctrl,
			force: true,
		});

		expect(result.ok).toBe(true);
		// Verifies argv: session delete <id> --force (force is the 5th positional after the executable path).
		expect(existsSync(markerPath)).toBe(true);
	});
});
