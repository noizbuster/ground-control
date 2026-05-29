import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteOmpSession, deletePiSession } from "../src/db/pi";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-pi-delete-"));
	tempRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const writeSession = (path: string, header: Record<string, unknown>): void => {
	writeFileSync(path, `${JSON.stringify(header)}\n`);
};

describe("deletePiSession", () => {
	it("removes selected Pi JSONL and loaded child sessions only", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "-repo-app");
		mkdirSync(projectDir, { recursive: true });
		const rootPath = join(projectDir, "root.jsonl");
		const childPath = join(projectDir, "child.jsonl");
		const unrelatedPath = join(projectDir, "unrelated.jsonl");
		writeSession(rootPath, {
			type: "session",
			version: 3,
			id: "pi-root",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		writeSession(childPath, {
			type: "session",
			version: 3,
			id: "pi-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: rootPath,
		});
		writeSession(unrelatedPath, {
			type: "session",
			version: 3,
			id: "pi-other",
			timestamp: "2026-05-29T09:02:00.000Z",
			cwd: "/repo/app",
		});

		const result = await deletePiSession("pi-root", { sessionRoots: [root] });

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.deletedSessionPaths.sort()).toEqual(
			[rootPath, childPath].sort(),
		);
		expect(result.value.deletedArtifactPaths).toEqual([]);
		expect(existsSync(rootPath)).toBe(false);
		expect(existsSync(childPath)).toBe(false);
		expect(existsSync(unrelatedPath)).toBe(true);
	});
});

describe("deleteOmpSession", () => {
	it("removes omp JSONL and sibling artifact directories without touching blob storage", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "-repo-app");
		mkdirSync(projectDir, { recursive: true });
		const sessionPath = join(projectDir, "session.jsonl");
		const artifactPath = join(projectDir, "session");
		const blobStorePath = join(root, "blobs");
		const unrelatedPath = join(projectDir, "unrelated.jsonl");
		mkdirSync(artifactPath, { recursive: true });
		mkdirSync(blobStorePath, { recursive: true });
		writeFileSync(join(artifactPath, "tool-output.json"), "{}\n");
		writeFileSync(join(blobStorePath, "blob.bin"), "blob");
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "omp-session",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		writeSession(unrelatedPath, {
			type: "session",
			version: 3,
			id: "omp-other",
			timestamp: "2026-05-29T09:02:00.000Z",
			cwd: "/repo/app",
		});

		const result = await deleteOmpSession("ignored-prefix", {
			sessionRoots: [root],
			sessionPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.deletedSessionPaths).toEqual([sessionPath]);
		expect(result.value.deletedArtifactPaths).toEqual([artifactPath]);
		expect(existsSync(sessionPath)).toBe(false);
		expect(existsSync(artifactPath)).toBe(false);
		expect(existsSync(unrelatedPath)).toBe(true);
		expect(existsSync(blobStorePath)).toBe(true);
	});
});
