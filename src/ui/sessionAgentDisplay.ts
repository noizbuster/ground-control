import { getAgentDisplayName } from "../config/colors";

const ROOT_UNKNOWN_AGENT_LABEL = "Default";
const UNKNOWN_AGENT_LABEL = "Unknown";

export interface SessionAgentDisplayOptions {
	isRoot?: boolean;
}

export const getSessionAgentDisplayName = (
	agentName?: string,
	options: SessionAgentDisplayOptions = {},
): string => {
	const displayName = getAgentDisplayName(agentName);
	const isUnknownAgent = displayName.trim().toLowerCase() === "unknown";

	if (options.isRoot === true && isUnknownAgent) {
		return ROOT_UNKNOWN_AGENT_LABEL;
	}

	if (isUnknownAgent) {
		return UNKNOWN_AGENT_LABEL;
	}

	return displayName;
};
