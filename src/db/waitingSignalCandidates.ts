import { SessionStatus } from "../types";
import {
	detectSessionStatus,
	type LatestMessageResultsBySessionId,
} from "./index";

const isWaitingSignalCandidateStatus = (status: SessionStatus): boolean => {
	return status !== SessionStatus.completed && status !== SessionStatus.failed;
};

export const getWaitingSignalCandidateIds = (
	sessionIds: string[],
	latestMessages: LatestMessageResultsBySessionId,
): string[] => {
	return sessionIds.filter((sessionId) => {
		const latestMessage = latestMessages[sessionId];
		if (!latestMessage) {
			return false;
		}

		return isWaitingSignalCandidateStatus(
			detectSessionStatus(latestMessage.message),
		);
	});
};
