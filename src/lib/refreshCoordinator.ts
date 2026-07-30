export type RefreshRequestId = number;

export type RefreshCoordinatorPhase = "idle" | "busy" | "queued";

export interface RefreshCoordinatorSnapshot {
	readonly phase: RefreshCoordinatorPhase;
	readonly activeRequestId: RefreshRequestId | null;
	readonly latestRequestId: RefreshRequestId | null;
	readonly hasQueuedRefresh: boolean;
}

export interface RefreshRequestTicket {
	readonly requestId: RefreshRequestId;
	readonly shouldDispatch: boolean;
}

export type RefreshCompletionResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: Error };

export class RefreshCompletionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RefreshCompletionError";
	}
}

export interface RefreshCoordinator {
	requestRefresh(): RefreshRequestTicket;
	waitForRefresh(requestId: RefreshRequestId): Promise<void>;
	settleRefresh(
		requestId: RefreshRequestId,
		result: RefreshCompletionResult,
	): void;
	completeRefresh(requestId: RefreshRequestId): RefreshRequestId | null;
	cancel(error: Error): void;
	shouldApplyResponse(requestId: RefreshRequestId): boolean;
	getSnapshot(): RefreshCoordinatorSnapshot;
}

interface RefreshCoordinatorState {
	nextRequestId: RefreshRequestId;
	latestRequestId: RefreshRequestId | null;
	activeRequestId: RefreshRequestId | null;
	hasQueuedRefresh: boolean;
}

interface RefreshWaiter {
	readonly requestId: RefreshRequestId;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

const getPhase = (state: RefreshCoordinatorState): RefreshCoordinatorPhase => {
	if (state.activeRequestId === null) {
		return "idle";
	}

	if (state.hasQueuedRefresh) {
		return "queued";
	}

	return "busy";
};

export const createRefreshCoordinator = (): RefreshCoordinator => {
	const state: RefreshCoordinatorState = {
		nextRequestId: 1,
		latestRequestId: null,
		activeRequestId: null,
		hasQueuedRefresh: false,
	};
	const waiters: RefreshWaiter[] = [];

	const issueRequest = (): RefreshRequestId => {
		const requestId = state.nextRequestId;
		state.nextRequestId += 1;
		state.latestRequestId = requestId;
		state.activeRequestId = requestId;
		return requestId;
	};

	return {
		requestRefresh: () => {
			if (state.activeRequestId !== null) {
				state.hasQueuedRefresh = true;
				return { requestId: state.nextRequestId, shouldDispatch: false };
			}

			return { requestId: issueRequest(), shouldDispatch: true };
		},

		waitForRefresh: (requestId) =>
			new Promise((resolve, reject) => {
				waiters.push({ requestId, resolve, reject });
			}),

		settleRefresh: (requestId, result) => {
			const completed = waiters.filter(
				(waiter) => waiter.requestId <= requestId,
			);
			for (const waiter of completed) {
				const waiterIndex = waiters.indexOf(waiter);
				if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
				if (result.ok) waiter.resolve();
				else waiter.reject(result.error);
			}
		},

		completeRefresh: (requestId) => {
			if (state.activeRequestId !== requestId) {
				return null;
			}

			if (state.hasQueuedRefresh) {
				state.hasQueuedRefresh = false;
				return issueRequest();
			}

			state.activeRequestId = null;
			return null;
		},

		cancel: (error) => {
			state.activeRequestId = null;
			state.latestRequestId = null;
			state.hasQueuedRefresh = false;
			for (const waiter of waiters.splice(0)) {
				waiter.reject(error);
			}
		},

		shouldApplyResponse: (requestId) => {
			return requestId === state.latestRequestId;
		},

		getSnapshot: () => {
			return {
				phase: getPhase(state),
				activeRequestId: state.activeRequestId,
				latestRequestId: state.latestRequestId,
				hasQueuedRefresh: state.hasQueuedRefresh,
			};
		},
	};
};
