import { describe, expect, it } from "vitest";
import { createRefreshCoordinator } from "../src/lib/refreshCoordinator";

describe("refresh coordinator request tickets", () => {
	it("identifies the exact queued request that follows an active refresh", async () => {
		// Given: one refresh is active.
		const coordinator = createRefreshCoordinator();
		expect(coordinator.requestRefresh()).toEqual({
			requestId: 1,
			shouldDispatch: true,
		});

		// When: the K action requests a post-stop refresh while it is active.
		const queued = coordinator.requestRefresh();
		const completion = coordinator.waitForRefresh(queued.requestId);
		let completed = false;
		void completion.then(() => {
			completed = true;
		});
		await Promise.resolve();

		// Then: the action receives the ID that will be dispatched next.
		expect(queued).toEqual({ requestId: 2, shouldDispatch: false });
		expect(completed).toBe(false);
		expect(coordinator.completeRefresh(1)).toBe(2);
		expect(coordinator.shouldApplyResponse(2)).toBe(true);
		coordinator.settleRefresh(2, { ok: true });
		await completion;
		expect(completed).toBe(true);
	});
});
