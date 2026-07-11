import { describe, expect, it, vi } from "vitest";
import { prepareMissionControlChildAbort } from "../src/lib/missionControlChildAbort";
import {
	mcSession,
	selectedParent,
} from "./missionControlChildAbortFixture";

describe("Mission Control successful stop refresh", () => {
	it("awaits the exact refresh before completing", async () => {
		// Given: the stop succeeds while the post-stop refresh remains pending.
		const refreshCompletion = Promise.withResolvers<void>();
		const events: string[] = [];
		const refreshAfterStop = vi.fn(() => {
			events.push("refresh-started");
			return refreshCompletion.promise.then(() => {
				events.push("refresh-completed");
			});
		});
		const resultPromise = prepareMissionControlChildAbort(
			selectedParent([
				mcSession({
					id: "child",
					parentId: "parent",
					abortable: true,
					lease: "eligible",
				}),
			]),
			{
				stopChildren: vi.fn().mockImplementation(async () => {
					events.push("stop-completed");
					return { exitCode: 0, stdout: "aggregate", stderr: "" };
				}),
				readSnapshot: vi.fn(),
				refreshAfterStop,
			},
		);
		await Promise.resolve();
		await Promise.resolve();

		// When: the action is observed before the refresh completes.
		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});
		await Promise.resolve();

		// Then: completion is withheld until that exact refresh resolves.
		expect(refreshAfterStop).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		refreshCompletion.resolve();
		await expect(resultPromise).resolves.toEqual({
			kind: "stopped",
			stdout: "aggregate",
		});
		expect(events).toEqual([
			"stop-completed",
			"refresh-started",
			"refresh-completed",
		]);
	});

	it("fails closed when the exact refresh fails", async () => {
		// Given: the stop succeeds but the selected-database refresh fails.
		const refreshAfterStop = vi
			.fn()
			.mockRejectedValue(new Error("selected database refresh failed"));

		// When: the successful stop enters its completion refresh.
		const result = await prepareMissionControlChildAbort(
			selectedParent([
				mcSession({
					id: "child",
					parentId: "parent",
					abortable: true,
					lease: "eligible",
				}),
			]),
			{
				stopChildren: vi
					.fn()
					.mockResolvedValue({ exitCode: 0, stdout: "aggregate", stderr: "" }),
				readSnapshot: vi.fn(),
				refreshAfterStop,
			},
		);

		// Then: no successful action result can expose stale state.
		expect(refreshAfterStop).toHaveBeenCalledOnce();
		expect(result).toEqual({
			kind: "failed",
			error: "selected database refresh failed",
		});
	});
});
