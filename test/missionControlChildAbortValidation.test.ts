import { describe, expect, it, vi } from "vitest";
import {
	executeMissionControlFallback,
	prepareMissionControlChildAbort,
} from "../src/lib/missionControlChildAbort";
import {
	mcSession,
	selectedParent,
	snapshot,
} from "./missionControlChildAbortFixture";

const prepare = async (child: ReturnType<typeof mcSession>) => {
	const result = await prepareMissionControlChildAbort(
		selectedParent([child]),
		{
			stopChildren: vi
				.fn()
				.mockResolvedValue({ exitCode: 1, stdout: "partial", stderr: "" }),
			readSnapshot: vi
				.fn()
				.mockResolvedValue({ ok: true, value: snapshot([child]) }),
			refreshAfterStop: async () => undefined,
		},
	);
	if (result.kind !== "fallback") throw new Error("expected fallback plan");
	return result.plan;
};

describe("Mission Control fallback validation refresh", () => {
	it.each([
		"token",
		"status",
		"lease",
	] as const)("blocks delete when second refresh changes %s", async (change) => {
		const original = mcSession({
			id: "child",
			parentId: "parent",
			abortable: true,
			lease: "eligible",
		});
		const changed = mcSession({
			id: "child",
			parentId: "parent",
			abortable: true,
			lease: change === "lease" ? "retry" : "eligible",
			token: change === "token" ? "f".repeat(64) : undefined,
			rawStatus: change === "status" ? "awaiting" : "running",
		});
		const plan = await prepare(original);
		const deleteSession = vi.fn();

		const result = await executeMissionControlFallback(plan, ["child"], {
			readSnapshot: vi
				.fn()
				.mockResolvedValue({ ok: true, value: snapshot([changed]) }),
			deleteSession,
		});

		expect(result.ok).toBe(false);
		expect(deleteSession).not.toHaveBeenCalled();
	});

	it("does not delete when the validation refresh fails", async () => {
		const child = mcSession({
			id: "child",
			parentId: "parent",
			abortable: true,
			lease: "eligible",
		});
		const plan = await prepare(child);
		const deleteSession = vi.fn();

		const result = await executeMissionControlFallback(plan, ["child"], {
			readSnapshot: vi.fn().mockRejectedValue(new Error("worker failed")),
			deleteSession,
		});

		expect(result).toEqual({ ok: false, error: "worker failed" });
		expect(deleteSession).not.toHaveBeenCalled();
	});
});
