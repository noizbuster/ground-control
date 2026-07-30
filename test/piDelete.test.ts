import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteOmpSession,
	deletePiSession,
	setOmpArtifactDeletionAfterQuarantineForTesting,
	setOmpArtifactDeletionBeforeCleanupForTesting,
	setPiSessionDeletionBeforeQuarantineForTesting,
	setPiSessionDeletionBeforeUnlinkForTesting,
} from "../src/db/pi";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "gctrl-pi-delete-"));
	tempRoots.push(root);
	return root;
};

afterEach(() => {
	setOmpArtifactDeletionAfterQuarantineForTesting(undefined);
	setOmpArtifactDeletionBeforeCleanupForTesting(undefined);
	setPiSessionDeletionBeforeQuarantineForTesting(undefined);
	setPiSessionDeletionBeforeUnlinkForTesting(undefined);
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

	it("deletes only the selected duplicate-ID root and its path-linked descendants", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "-repo-app");
		mkdirSync(projectDir, { recursive: true });
		const selectedRootPath = join(projectDir, "selected-root.jsonl");
		const copiedRootPath = join(projectDir, "copied-root.jsonl");
		const selectedChildPath = join(projectDir, "selected-child.jsonl");
		const copiedChildPath = join(projectDir, "copied-child.jsonl");
		for (const path of [selectedRootPath, copiedRootPath]) {
			writeSession(path, {
				type: "session",
				version: 3,
				id: "pi-duplicate-root",
				timestamp: "2026-05-29T09:00:00.000Z",
				cwd: "/repo/app",
			});
		}
		writeSession(selectedChildPath, {
			type: "session",
			version: 3,
			id: "pi-selected-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: selectedRootPath,
		});
		writeSession(copiedChildPath, {
			type: "session",
			version: 3,
			id: "pi-copied-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: copiedRootPath,
		});

		const unqualifiedResult = await deletePiSession("pi-duplicate-root", {
			sessionRoots: [root],
		});
		expect(unqualifiedResult.ok).toBe(false);
		expect(existsSync(selectedRootPath)).toBe(true);
		expect(existsSync(selectedChildPath)).toBe(true);
		expect(existsSync(copiedRootPath)).toBe(true);
		expect(existsSync(copiedChildPath)).toBe(true);

		const result = await deletePiSession("pi-duplicate-root", {
			sessionRoots: [root],
			sessionPath: selectedRootPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.deletedSessionPaths.sort()).toEqual(
			[selectedRootPath, selectedChildPath].sort(),
		);
		expect(existsSync(selectedRootPath)).toBe(false);
		expect(existsSync(selectedChildPath)).toBe(false);
		expect(existsSync(copiedRootPath)).toBe(true);
		expect(existsSync(copiedChildPath)).toBe(true);
	});

	it("restores a replacement that wins before session quarantine", async () => {
		const root = createTempRoot();
		const sessionPath = join(root, "pre-quarantine-race.jsonl");
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "pi-pre-quarantine-race",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
			title: "original",
		});
		setPiSessionDeletionBeforeQuarantineForTesting((path) => {
			if (path !== sessionPath) {
				return;
			}
			writeSession(sessionPath, {
				type: "session",
				version: 3,
				id: "pi-pre-quarantine-race",
				timestamp: "2026-05-29T09:00:00.000Z",
				cwd: "/repo/app",
				title: "replacement",
			});
		});

		const result = await deletePiSession("pi-pre-quarantine-race", {
			sessionRoots: [root],
			sessionPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.cause).toContain(`was restored to ${sessionPath}`);
		expect(readFileSync(sessionPath, "utf8")).toContain(
			'"title":"replacement"',
		);
	});

	it("preserves a replacement created after detached session validation", async () => {
		const root = createTempRoot();
		const sessionPath = join(root, "race.jsonl");
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "pi-race",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
			title: "original",
		});
		setPiSessionDeletionBeforeUnlinkForTesting((path) => {
			if (path !== sessionPath) {
				return;
			}
			writeSession(sessionPath, {
				type: "session",
				version: 3,
				id: "pi-race",
				timestamp: "2026-05-29T09:00:00.000Z",
				cwd: "/repo/app",
				title: "replacement",
			});
		});

		const result = await deletePiSession("pi-race", {
			sessionRoots: [root],
			sessionPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.deletedSessionPaths).toEqual([sessionPath]);
		expect(existsSync(sessionPath)).toBe(true);
		expect(readFileSync(sessionPath, "utf8")).toContain(
			'"title":"replacement"',
		);
	});

	it("does not delete a same-path replacement with a different session ID", async () => {
		const root = createTempRoot();
		const replacementPath = join(root, "replacement.jsonl");
		writeSession(replacementPath, {
			type: "session",
			version: 3,
			id: "pi-replacement",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});

		const result = await deletePiSession("pi-original", {
			sessionRoots: [root],
			sessionPath: replacementPath,
		});

		expect(result.ok).toBe(false);
		expect(existsSync(replacementPath)).toBe(true);
	});

	it("rolls back an earlier staged family member when a descendant fails validation", async () => {
		const root = createTempRoot();
		const parentPath = join(root, "a-parent.jsonl");
		const childPath = join(root, "z-child.jsonl");
		writeSession(parentPath, {
			type: "session",
			version: 3,
			id: "pi-transaction-parent",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
			title: "original parent",
		});
		writeSession(childPath, {
			type: "session",
			version: 3,
			id: "pi-transaction-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: parentPath,
			title: "original child",
		});
		setPiSessionDeletionBeforeQuarantineForTesting((path) => {
			if (path !== childPath) {
				return;
			}
			writeSession(parentPath, {
				type: "session",
				version: 3,
				id: "pi-transaction-parent",
				timestamp: "2026-05-29T09:00:00.000Z",
				cwd: "/repo/app",
				title: "replacement parent",
			});
			writeSession(childPath, {
				type: "session",
				version: 3,
				id: "pi-transaction-child",
				timestamp: "2026-05-29T09:01:00.000Z",
				cwd: "/repo/app",
				parentSession: parentPath,
				title: "replacement child",
			});
		});

		const result = await deletePiSession("pi-transaction-parent", {
			sessionRoots: [root],
			sessionPath: parentPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.cause).toContain("changed before deletion");
		expect(readFileSync(parentPath, "utf8")).toContain(
			'"title":"replacement parent"',
		);
		expect(readFileSync(childPath, "utf8")).toContain(
			'"title":"replacement child"',
		);
		const parentRecoveryDirectory = readdirSync(root).find((name) =>
			name.startsWith("a-parent.jsonl.recovery-"),
		);
		expect(parentRecoveryDirectory).toBeDefined();
		if (!parentRecoveryDirectory) {
			throw new Error("Expected a recovered parent session.");
		}
		expect(
			readFileSync(
				join(root, parentRecoveryDirectory, "a-parent.jsonl"),
				"utf8",
			),
		).toContain('"title":"original parent"');
		expect(readdirSync(root).some((name) => name.includes(".deleting-"))).toBe(
			false,
		);
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

		const result = await deleteOmpSession("omp-session", {
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

	it("stages artifact-layout children before moving the selected parent artifact", async () => {
		const root = createTempRoot();
		const parentPath = join(root, "parent.jsonl");
		const parentArtifactPath = join(root, "parent");
		const childPath = join(parentArtifactPath, "ScoutLane.jsonl");
		const unrelatedPath = join(root, "unrelated.jsonl");
		mkdirSync(parentArtifactPath, { recursive: true });
		writeSession(parentPath, {
			type: "session",
			version: 3,
			id: "omp-artifact-layout-parent",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		writeSession(childPath, {
			type: "session",
			version: 3,
			id: "omp-artifact-layout-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
		});
		writeSession(unrelatedPath, {
			type: "session",
			version: 3,
			id: "omp-artifact-layout-unrelated",
			timestamp: "2026-05-29T09:02:00.000Z",
			cwd: "/repo/app",
		});

		const result = await deleteOmpSession("omp-artifact-layout-parent", {
			sessionRoots: [root],
			sessionPath: parentPath,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.value.deletedSessionPaths.sort()).toEqual(
			[parentPath, childPath].sort(),
		);
		expect(result.value.deletedArtifactPaths).toEqual([parentArtifactPath]);
		expect(existsSync(parentPath)).toBe(false);
		expect(existsSync(childPath)).toBe(false);
		expect(existsSync(parentArtifactPath)).toBe(false);
		expect(existsSync(unrelatedPath)).toBe(true);
	});

	it("leaves artifacts untouched when a later selected session fails validation", async () => {
		const root = createTempRoot();
		const parentPath = join(root, "a-omp-parent.jsonl");
		const parentArtifactPath = join(root, "a-omp-parent");
		const childPath = join(root, "z-omp-child.jsonl");
		mkdirSync(parentArtifactPath, { recursive: true });
		writeFileSync(
			join(parentArtifactPath, "tool-output.json"),
			'{"title":"original parent artifact"}\n',
		);
		writeSession(parentPath, {
			type: "session",
			version: 3,
			id: "omp-transaction-parent",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
			title: "original parent",
		});
		writeSession(childPath, {
			type: "session",
			version: 3,
			id: "omp-transaction-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: parentPath,
			title: "original child",
		});
		setPiSessionDeletionBeforeQuarantineForTesting((path) => {
			if (path !== childPath) {
				return;
			}
			writeSession(parentPath, {
				type: "session",
				version: 3,
				id: "omp-transaction-parent",
				timestamp: "2026-05-29T09:00:00.000Z",
				cwd: "/repo/app",
				title: "replacement parent",
			});
			writeSession(childPath, {
				type: "session",
				version: 3,
				id: "omp-transaction-child",
				timestamp: "2026-05-29T09:01:00.000Z",
				cwd: "/repo/app",
				parentSession: parentPath,
				title: "replacement child",
			});
		});

		const result = await deleteOmpSession("omp-transaction-parent", {
			sessionRoots: [root],
			sessionPath: parentPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(readFileSync(parentPath, "utf8")).toContain(
			'"title":"replacement parent"',
		);
		expect(readFileSync(childPath, "utf8")).toContain(
			'"title":"replacement child"',
		);
		expect(existsSync(parentArtifactPath)).toBe(true);
		expect(
			readFileSync(join(parentArtifactPath, "tool-output.json"), "utf8"),
		).toContain('"title":"original parent artifact"');
		expect(readdirSync(root).some((name) => name.includes(".deleting-"))).toBe(
			false,
		);
	});

	it("rejects an artifact that appears after initially being absent during cleanup preflight", async () => {
		const root = createTempRoot();
		const parentPath = join(root, "preflight-artifact-parent.jsonl");
		const parentArtifactPath = join(root, "preflight-artifact-parent");
		const childPath = join(root, "preflight-artifact-child.jsonl");
		const childArtifactPath = join(root, "preflight-artifact-child");
		mkdirSync(parentArtifactPath, { recursive: true });
		writeSession(parentPath, {
			type: "session",
			version: 3,
			id: "omp-preflight-artifact-parent",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		writeSession(childPath, {
			type: "session",
			version: 3,
			id: "omp-preflight-artifact-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: parentPath,
		});
		setOmpArtifactDeletionBeforeCleanupForTesting((artifactPath) => {
			if (artifactPath !== parentArtifactPath) {
				return;
			}
			expect(existsSync(parentPath)).toBe(false);
			expect(existsSync(childPath)).toBe(false);
			mkdirSync(childArtifactPath, { recursive: true });
			writeFileSync(
				join(childArtifactPath, "tool-output.json"),
				'{"title":"new artifact"}\n',
			);
		});

		const result = await deleteOmpSession("omp-preflight-artifact-parent", {
			sessionRoots: [root],
			sessionPath: parentPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.cause).toContain(
			`OMP artifact ${childArtifactPath} appeared before deletion.`,
		);
		expect(existsSync(parentPath)).toBe(true);
		expect(existsSync(childPath)).toBe(true);
		expect(
			readFileSync(join(childArtifactPath, "tool-output.json"), "utf8"),
		).toContain('"title":"new artifact"');
		expect(readdirSync(root).some((name) => name.includes(".deleting-"))).toBe(
			false,
		);
	});

	it("rejects a selected session that reappears during cleanup preflight", async () => {
		const root = createTempRoot();
		const parentPath = join(root, "preflight-session-parent.jsonl");
		const parentArtifactPath = join(root, "preflight-session-parent");
		const childPath = join(root, "preflight-session-child.jsonl");
		mkdirSync(parentArtifactPath, { recursive: true });
		writeSession(parentPath, {
			type: "session",
			version: 3,
			id: "omp-preflight-session-parent",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		writeSession(childPath, {
			type: "session",
			version: 3,
			id: "omp-preflight-session-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: parentPath,
			title: "original",
		});
		setOmpArtifactDeletionBeforeCleanupForTesting((artifactPath) => {
			if (artifactPath !== parentArtifactPath) {
				return;
			}
			writeSession(childPath, {
				type: "session",
				version: 3,
				id: "omp-preflight-session-child",
				timestamp: "2026-05-29T09:01:00.000Z",
				cwd: "/repo/app",
				parentSession: parentPath,
				title: "replacement",
			});
		});

		const result = await deleteOmpSession("omp-preflight-session-parent", {
			sessionRoots: [root],
			sessionPath: parentPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.cause).toContain(
			`OMP session ${childPath} reappeared while deleting its artifact.`,
		);
		expect(readFileSync(childPath, "utf8")).toContain('"title":"replacement"');
		expect(existsSync(parentPath)).toBe(true);
		expect(readdirSync(root).some((name) => name.includes(".deleting-"))).toBe(
			false,
		);
	});

	it("keeps every staged object recoverable when a later cleanup preflight hook fails", async () => {
		const root = createTempRoot();
		const parentPath = join(root, "preflight-failure-parent.jsonl");
		const parentArtifactPath = join(root, "preflight-failure-parent");
		const childPath = join(root, "preflight-failure-child.jsonl");
		const childArtifactPath = join(root, "preflight-failure-child");
		for (const artifactPath of [parentArtifactPath, childArtifactPath]) {
			mkdirSync(artifactPath, { recursive: true });
			writeFileSync(join(artifactPath, "tool-output.json"), "{}\n");
		}
		writeSession(parentPath, {
			type: "session",
			version: 3,
			id: "omp-preflight-failure-parent",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		writeSession(childPath, {
			type: "session",
			version: 3,
			id: "omp-preflight-failure-child",
			timestamp: "2026-05-29T09:01:00.000Z",
			cwd: "/repo/app",
			parentSession: parentPath,
		});
		let preflightCalls = 0;
		setOmpArtifactDeletionBeforeCleanupForTesting(() => {
			preflightCalls += 1;
			if (preflightCalls === 2) {
				throw new Error("later cleanup preflight failure");
			}
		});

		const result = await deleteOmpSession("omp-preflight-failure-parent", {
			sessionRoots: [root],
			sessionPath: parentPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(preflightCalls).toBe(2);
		expect(result.error.cause).toContain("later cleanup preflight failure");
		expect(existsSync(parentPath)).toBe(true);
		expect(existsSync(childPath)).toBe(true);
		expect(
			readdirSync(root).filter((name) => name.includes(".recovery-")).length,
		).toBe(2);
		expect(readdirSync(root).some((name) => name.includes(".deleting-"))).toBe(
			false,
		);
	});
	it("preserves an OMP artifact replaced after snapshot before quarantine", async () => {
		const root = createTempRoot();
		const sessionPath = join(root, "artifact-race.jsonl");
		const artifactPath = join(root, "artifact-race");
		mkdirSync(artifactPath, { recursive: true });
		writeFileSync(
			join(artifactPath, "tool-output.json"),
			'{"title":"original"}\n',
		);
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "omp-artifact-race",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		setPiSessionDeletionBeforeUnlinkForTesting((path) => {
			if (path !== sessionPath) {
				return;
			}
			rmSync(artifactPath, { recursive: true, force: true });
			mkdirSync(artifactPath, { recursive: true });
			writeFileSync(
				join(artifactPath, "tool-output.json"),
				'{"title":"replacement"}\n',
			);
		});

		const result = await deleteOmpSession("omp-artifact-race", {
			sessionRoots: [root],
			sessionPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(readFileSync(sessionPath, "utf8")).toContain(
			'"id":"omp-artifact-race"',
		);
		expect(existsSync(artifactPath)).toBe(true);
		expect(
			readFileSync(join(artifactPath, "tool-output.json"), "utf8"),
		).toContain('"title":"replacement"');
	});

	it("restores an OMP artifact when its session reappears after artifact quarantine", async () => {
		const root = createTempRoot();
		const sessionPath = join(root, "post-artifact-race.jsonl");
		const artifactPath = join(root, "post-artifact-race");
		mkdirSync(artifactPath, { recursive: true });
		writeFileSync(
			join(artifactPath, "tool-output.json"),
			'{"title":"original"}\n',
		);
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "omp-post-artifact-race",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		setOmpArtifactDeletionAfterQuarantineForTesting(
			(detachedSessionPath, detachedArtifactPath) => {
				if (detachedSessionPath !== sessionPath) {
					return;
				}
				expect(detachedArtifactPath).toBe(artifactPath);
				expect(existsSync(artifactPath)).toBe(false);
				mkdirSync(artifactPath, { recursive: true });
				writeFileSync(
					join(artifactPath, "tool-output.json"),
					'{"title":"replacement"}\n',
				);
				writeSession(sessionPath, {
					type: "session",
					version: 3,
					id: "omp-post-artifact-race",
					timestamp: "2026-05-29T09:00:00.000Z",
					cwd: "/repo/app",
					title: "replacement",
				});
			},
		);

		const result = await deleteOmpSession("omp-post-artifact-race", {
			sessionRoots: [root],
			sessionPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.cause).toContain(
			"reappeared while deleting its artifact",
		);
		expect(readFileSync(sessionPath, "utf8")).toContain(
			'"title":"replacement"',
		);
		expect(
			readFileSync(join(artifactPath, "tool-output.json"), "utf8"),
		).toContain('"title":"replacement"');
		const artifactRecoveryDirectory = readdirSync(root).find((name) =>
			name.startsWith("post-artifact-race.recovery-"),
		);
		expect(artifactRecoveryDirectory).toBeDefined();
		if (!artifactRecoveryDirectory) {
			throw new Error("Expected a recovered OMP artifact.");
		}
		expect(
			readFileSync(
				join(
					root,
					artifactRecoveryDirectory,
					"post-artifact-race",
					"tool-output.json",
				),
				"utf8",
			),
		).toContain('"title":"original"');
	});

	it("preserves a recreated OMP session and its artifacts after validation", async () => {
		const root = createTempRoot();
		const sessionPath = join(root, "race.jsonl");
		const artifactPath = join(root, "race");
		mkdirSync(artifactPath, { recursive: true });
		writeFileSync(
			join(artifactPath, "tool-output.json"),
			'{"title":"original"}\n',
		);
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "omp-race",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		setPiSessionDeletionBeforeUnlinkForTesting((path) => {
			if (path !== sessionPath) {
				return;
			}
			writeSession(sessionPath, {
				type: "session",
				version: 3,
				id: "omp-race",
				timestamp: "2026-05-29T09:00:00.000Z",
				cwd: "/repo/app",
				title: "replacement",
			});
			mkdirSync(artifactPath, { recursive: true });
			writeFileSync(
				join(artifactPath, "tool-output.json"),
				'{"title":"replacement"}\n',
			);
		});

		const result = await deleteOmpSession("omp-race", {
			sessionRoots: [root],
			sessionPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(readFileSync(sessionPath, "utf8")).toContain(
			'"title":"replacement"',
		);
		expect(existsSync(artifactPath)).toBe(true);
		expect(
			readFileSync(join(artifactPath, "tool-output.json"), "utf8"),
		).toContain('"title":"replacement"');
	});

	it("recovers a dangling artifact symlink after cleanup fails", async () => {
		const root = createTempRoot();
		const sessionPath = join(root, "dangling-artifact.jsonl");
		const artifactPath = join(root, "dangling-artifact");
		symlinkSync(join(root, "missing-artifact-target"), artifactPath);
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "omp-dangling-artifact",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});
		setOmpArtifactDeletionBeforeCleanupForTesting((path) => {
			if (path === artifactPath) {
				throw new Error("forced artifact cleanup failure");
			}
		});

		const result = await deleteOmpSession("omp-dangling-artifact", {
			sessionRoots: [root],
			sessionPath,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.cause).toContain("forced artifact cleanup failure");
		expect(existsSync(sessionPath)).toBe(true);
		expect(lstatSync(artifactPath).isSymbolicLink()).toBe(true);
		expect(readdirSync(root).some((name) => name.includes(".deleting-"))).toBe(
			false,
		);
	});
	it("does not delete an omp session matched only by an ID prefix", async () => {
		const root = createTempRoot();
		const sessionPath = join(root, "longer-id.jsonl");
		const artifactPath = join(root, "longer-id");
		mkdirSync(artifactPath, { recursive: true });
		writeSession(sessionPath, {
			type: "session",
			version: 3,
			id: "omp-session-child",
			timestamp: "2026-05-29T09:00:00.000Z",
			cwd: "/repo/app",
		});

		const result = await deleteOmpSession("omp-session", {
			sessionRoots: [root],
		});

		expect(result.ok).toBe(false);
		expect(existsSync(sessionPath)).toBe(true);
		expect(existsSync(artifactPath)).toBe(true);
	});
});
