// Mission Control SQLite session status mapping.
//
// Maps (sessions.status, awaiting reason) to (SessionStatus, statusDetail) per
// the status table. The awaiting reason prefers the joined session_awaits.reason;
// the caller resolves that preference before passing `awaitingReason` here.
// Relocated from the snapshot module to keep that module under the 250 pure-LOC
// ceiling; the mapping itself is unchanged.

import { SessionStatus } from "../types";

export type MappedSessionStatus = {
	status: SessionStatus;
	statusDetail: string | undefined;
};

export const mapMissionControlSessionStatus = (
	status: string | null,
	awaitingReason: string | null,
): MappedSessionStatus => {
	switch (status) {
		case "running":
			return { status: SessionStatus.running, statusDetail: undefined };
		case "awaiting":
			switch (awaitingReason) {
				case "approval":
					return {
						status: SessionStatus.waiting,
						statusDetail: "Awaiting approval",
					};
				case "user_input":
					return {
						status: SessionStatus.waiting,
						statusDetail: "Awaiting user input",
					};
				case "subagent":
					return {
						status: SessionStatus.waiting,
						statusDetail: "Awaiting subagent",
					};
				default:
					return {
						status: SessionStatus.waiting,
						statusDetail: "Awaiting Mission Control",
					};
			}
		case "idle":
			return {
				status: SessionStatus.waiting,
				statusDetail: "Idle between prompts",
			};
		case "stopped":
			return { status: SessionStatus.completed, statusDetail: undefined };
		case "failed":
			return { status: SessionStatus.failed, statusDetail: "Session failed" };
		default: {
			const displayValue = typeof status === "string" ? status : String(status);
			return {
				status: SessionStatus.unknown,
				statusDetail: `Unrecognized Mission Control status: ${displayValue}`,
			};
		}
	}
};
