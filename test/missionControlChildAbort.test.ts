import { describe, expect, it, vi } from "vitest";
import { resolveKillFallbackRoute } from "../src/lib/killFallbackRoute";
import {
	executeMissionControlFallback,
	prepareMissionControlChildAbort,
} from "../src/lib/missionControlChildAbort";
import {
	DATABASE_PATH,
	mcSession,
	selectedParent,
	snapshot,
} from "./missionControlChildAbortFixture";

const refreshAfterStop = async (): Promise<void> => undefined;

describe("Mission Control child-only abort action", () => {
	it("never falls back after stop exit 2", async () => {
		const children = [
			mcSession({
				id: "child",
				parentId: "parent",
				abortable: true,
				lease: "eligible",
			}),
		];
		const readSnapshot = vi.fn();
		const stopChildren = vi
			.fn()
			.mockResolvedValue({ exitCode: 2, stdout: "aggregate", stderr: "" });
		const refreshAfterStop = vi.fn();

		const result = await prepareMissionControlChildAbort(
			selectedParent(children),
			{
				stopChildren,
				readSnapshot,
				refreshAfterStop,
			},
		);

		expect(stopChildren).toHaveBeenCalledOnce();
		expect(stopChildren).toHaveBeenCalledWith("parent", DATABASE_PATH);
		expect(readSnapshot).not.toHaveBeenCalled();
		expect(refreshAfterStop).not.toHaveBeenCalled();
		expect(result.kind).toBe("failed");
	});

	it("fails closed when the stop process cannot start", async () => {
		const child = mcSession({
			id: "child",
			parentId: "parent",
			abortable: true,
			lease: "eligible",
		});
		const readSnapshot = vi.fn();

		const result = await prepareMissionControlChildAbort(
			selectedParent([child]),
			{
				stopChildren: vi.fn().mockRejectedValue(new Error("spawn failed")),
				readSnapshot,
				refreshAfterStop,
			},
		);

		expect(result).toEqual({ kind: "failed", error: "spawn failed" });
		expect(readSnapshot).not.toHaveBeenCalled();
	});

	it.each([
		["retry", "Owner still active; retry stop"],
		["no_delete", "lease state is unknown; no delete"],
	] as const)("refuses %s lease survivors", async (lease, message) => {
		const children = [
			mcSession({ id: "child", parentId: "parent", abortable: true, lease }),
		];
		const result = await prepareMissionControlChildAbort(
			selectedParent(children),
			{
				stopChildren: vi
					.fn()
					.mockResolvedValue({ exitCode: 1, stdout: "failed", stderr: "" }),
				readSnapshot: vi
					.fn()
					.mockResolvedValue({ ok: true, value: snapshot(children) }),
				refreshAfterStop,
			},
		);

		expect(result).toMatchObject({ kind: "failed" });
		if (result.kind === "failed") expect(result.error).toContain(message);
	});

	it("groups owner-death survivors into minimal roots and deletes each once", async () => {
		const first = [
			mcSession({
				id: "child",
				parentId: "parent",
				abortable: true,
				lease: "eligible",
			}),
			mcSession({
				id: "grandchild",
				parentId: "child",
				abortable: true,
				lease: "eligible",
			}),
			mcSession({
				id: "sibling",
				parentId: "parent",
				abortable: true,
				lease: "eligible",
			}),
		];
		const readSnapshot = vi
			.fn()
			.mockResolvedValue({ ok: true, value: snapshot(first) });
		const prepared = await prepareMissionControlChildAbort(
			selectedParent(first),
			{
				stopChildren: vi
					.fn()
					.mockResolvedValue({ exitCode: 1, stdout: "partial", stderr: "" }),
				readSnapshot,
				refreshAfterStop,
			},
		);
		expect(prepared.kind).toBe("fallback");
		if (prepared.kind !== "fallback") return;
		expect(prepared.plan.roots.map((root) => root.sessionId)).toEqual([
			"child",
			"sibling",
		]);

		const deleteSession = vi.fn().mockResolvedValue({
			ok: true,
			value: { deletedSessionIds: [], stdout: "" },
		});
		const executed = await executeMissionControlFallback(
			prepared.plan,
			["child", "sibling"],
			{ readSnapshot, deleteSession },
		);

		expect(executed).toEqual({
			ok: true,
			deletedRootIds: ["child", "sibling"],
		});
		expect(readSnapshot).toHaveBeenCalledTimes(2);
		expect(deleteSession).toHaveBeenCalledTimes(2);
		expect(deleteSession).toHaveBeenNthCalledWith(1, "child", {
			databasePath: DATABASE_PATH,
			expectedTreeToken: first[0].sourceMetadata?.missionControl?.treeToken,
		});
		expect(deleteSession).toHaveBeenNthCalledWith(2, "sibling", {
			databasePath: DATABASE_PATH,
			expectedTreeToken: first[2].sourceMetadata?.missionControl?.treeToken,
		});
	});

	it("fails closed on either refresh failure and unstable hierarchy", async () => {
		const child = mcSession({
			id: "child",
			parentId: "parent",
			abortable: true,
			lease: "eligible",
		});
		const stopChildren = vi
			.fn()
			.mockResolvedValue({ exitCode: 1, stdout: "partial", stderr: "" });
		for (const readSnapshot of [
			vi.fn().mockResolvedValue({
				ok: false,
				error: { code: "query_failed", message: "db failed" },
			}),
			vi.fn().mockResolvedValue({
				ok: true,
				value: snapshot([], { parent: "unstable" }),
			}),
		]) {
			const result = await prepareMissionControlChildAbort(
				selectedParent([child]),
				{ stopChildren, readSnapshot, refreshAfterStop },
			);
			expect(result.kind).toBe("failed");
		}
	});

	it("keeps an MC fallback plan on the MC route when its UI parent disappears", async () => {
		const child = mcSession({
			id: "child",
			parentId: "parent",
			abortable: true,
			lease: "eligible",
		});
		const prepared = await prepareMissionControlChildAbort(
			selectedParent([child]),
			{
				stopChildren: vi
					.fn()
					.mockResolvedValue({ exitCode: 1, stdout: "partial", stderr: "" }),
				readSnapshot: vi
					.fn()
					.mockResolvedValue({ ok: true, value: snapshot([child]) }),
				refreshAfterStop,
			},
		);
		if (prepared.kind !== "fallback") throw new Error("expected fallback plan");

		expect(resolveKillFallbackRoute(prepared.plan, undefined)).toBe(
			"mission-control",
		);
		expect(resolveKillFallbackRoute(null, "mission-control")).toBe(
			"stale-mission-control",
		);
	});
});
