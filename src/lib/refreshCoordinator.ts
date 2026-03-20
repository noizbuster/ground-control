export type RefreshRequestId = number;

export type RefreshCoordinatorPhase = "idle" | "busy" | "queued";

export interface RefreshCoordinatorSnapshot {
	readonly phase: RefreshCoordinatorPhase;
	readonly activeRequestId: RefreshRequestId | null;
	readonly latestRequestId: RefreshRequestId | null;
	readonly hasQueuedRefresh: boolean;
}

export interface RefreshCoordinator {
	requestRefresh(): RefreshRequestId | null;
	completeRefresh(requestId: RefreshRequestId): RefreshRequestId | null;
	shouldApplyResponse(requestId: RefreshRequestId): boolean;
	getSnapshot(): RefreshCoordinatorSnapshot;
}

interface RefreshCoordinatorState {
	nextRequestId: RefreshRequestId;
	latestRequestId: RefreshRequestId | null;
	activeRequestId: RefreshRequestId | null;
	hasQueuedRefresh: boolean;
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
				return null;
			}

			return issueRequest();
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
