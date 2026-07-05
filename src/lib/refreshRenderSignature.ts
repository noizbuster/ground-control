import type { RefreshSnapshotPayload } from "../db/refresh-worker-protocol";
import type { Session, SessionSourceMetadata, SubagentSession } from "../types";
import type { SessionFilterMode, SessionSortMode } from "./sessionList";

export interface RefreshRenderSignatureInput {
	readonly snapshot: RefreshSnapshotPayload;
	readonly sessionFilterMode: SessionFilterMode;
	readonly sessionSortMode: SessionSortMode;
	readonly selectedSessionId: string | null;
	readonly externalAttachedSessionIds: ReadonlySet<string>;
	readonly externalAttachedSessionDirectoryCounts: ReadonlyMap<string, number>;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const FIELD_SEPARATOR = 0x1f;

const appendCode = (hash: number, code: number): number =>
	Math.imul(hash ^ code, FNV_PRIME) >>> 0;

const appendText = (hash: number, value: string | undefined | null): number => {
	const text = value ?? "";
	let nextHash = hash;
	for (let index = 0; index < text.length; index += 1) {
		nextHash = appendCode(nextHash, text.charCodeAt(index));
	}
	return appendCode(nextHash, FIELD_SEPARATOR);
};

const appendNumber = (hash: number, value: number | undefined | null): number =>
	appendText(hash, typeof value === "number" ? String(value) : "");

const appendStringArray = (
	hash: number,
	values: readonly string[] | undefined,
): number => {
	let nextHash = appendNumber(hash, values?.length ?? 0);
	for (const value of values ?? []) {
		nextHash = appendText(nextHash, value);
	}
	return nextHash;
};

const appendSortedStringSet = (
	hash: number,
	values: ReadonlySet<string>,
): number => {
	const orderedValues = [...values].sort();
	let nextHash = appendNumber(hash, orderedValues.length);
	for (const value of orderedValues) {
		nextHash = appendText(nextHash, value);
	}
	return nextHash;
};

const appendSortedNumberMap = (
	hash: number,
	values: ReadonlyMap<string, number>,
): number => {
	const orderedEntries = [...values.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);
	let nextHash = appendNumber(hash, orderedEntries.length);
	for (const [key, value] of orderedEntries) {
		nextHash = appendText(nextHash, key);
		nextHash = appendNumber(nextHash, value);
	}
	return nextHash;
};

const appendRecord = <T extends string | number | undefined>(
	hash: number,
	record: Partial<Record<string, T>>,
): number => {
	const orderedEntries = Object.entries(record).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	let nextHash = appendNumber(hash, orderedEntries.length);
	for (const [key, value] of orderedEntries) {
		nextHash = appendText(nextHash, key);
		nextHash = appendText(nextHash, value === undefined ? "" : String(value));
	}
	return nextHash;
};

const appendSourceMetadata = (
	hash: number,
	metadata: SessionSourceMetadata | undefined,
): number => {
	let nextHash = hash;
	nextHash = appendText(nextHash, metadata?.originator);
	nextHash = appendText(nextHash, metadata?.cliVersion);
	nextHash = appendText(nextHash, metadata?.rawSource);
	nextHash = appendText(nextHash, metadata?.sourceCategory);
	nextHash = appendText(nextHash, metadata?.agentRole);
	nextHash = appendText(nextHash, metadata?.agentNickname);
	nextHash = appendText(nextHash, metadata?.agentPath);
	nextHash = appendText(nextHash, metadata?.agentStatus);
	nextHash = appendNumber(nextHash, metadata?.agentListObservedAtMs);
	nextHash = appendText(nextHash, metadata?.reasoningEffort);
	nextHash = appendText(nextHash, metadata?.modelRole);
	nextHash = appendStringArray(nextHash, metadata?.activeToolNames);
	nextHash = appendText(nextHash, metadata?.lastEventType);
	nextHash = appendText(nextHash, metadata?.lastTurnId);
	nextHash = appendText(nextHash, metadata?.abortedReason);
	nextHash = appendNumber(nextHash, metadata?.openChildCount);
	nextHash = appendNumber(nextHash, metadata?.closedChildCount);
	nextHash = appendText(nextHash, metadata?.sessionPath);
	nextHash = appendText(nextHash, metadata?.parentSessionPath);
	return nextHash;
};

const appendBaseSession = (
	hash: number,
	session: Session | SubagentSession,
): number => {
	let nextHash = hash;
	nextHash = appendText(nextHash, session.id);
	nextHash = appendText(nextHash, session.title);
	nextHash = appendText(nextHash, session.directory);
	nextHash = appendText(nextHash, session.project_id);
	nextHash = appendText(nextHash, session.project_name);
	nextHash = appendText(nextHash, session.project_worktree);
	nextHash = appendText(nextHash, session.project_label);
	nextHash = appendText(nextHash, session.parent_id);
	nextHash = appendNumber(nextHash, session.time_created);
	nextHash = appendNumber(nextHash, session.time_updated);
	nextHash = appendText(nextHash, session.sessionSource);
	nextHash = appendText(nextHash, session.currentAgent);
	nextHash = appendText(nextHash, session.currentModelID);
	nextHash = appendText(nextHash, session.currentVariant);
	nextHash = appendText(nextHash, session.currentReasoningEffort);
	nextHash = appendText(nextHash, session.status);
	nextHash = appendText(nextHash, session.statusDetail);
	nextHash = appendText(nextHash, session.finishReason);
	nextHash = appendText(nextHash, session.providerID);
	return appendSourceMetadata(nextHash, session.sourceMetadata);
};

const appendSession = (hash: number, session: Session): number => {
	let nextHash = appendBaseSession(hash, session);
	const subagents = session.subagentSessions ?? [];
	nextHash = appendNumber(nextHash, subagents.length);
	for (const subagent of subagents) {
		nextHash = appendBaseSession(nextHash, subagent);
	}
	return nextHash;
};

export const createRefreshRenderSignature = ({
	snapshot,
	sessionFilterMode,
	sessionSortMode,
	selectedSessionId,
	externalAttachedSessionIds,
	externalAttachedSessionDirectoryCounts,
}: RefreshRenderSignatureInput): string => {
	let hash = FNV_OFFSET;
	hash = appendText(hash, sessionFilterMode);
	hash = appendText(hash, sessionSortMode);
	hash = appendText(hash, selectedSessionId);
	hash = appendSortedStringSet(hash, externalAttachedSessionIds);
	hash = appendSortedNumberMap(hash, externalAttachedSessionDirectoryCounts);
	hash = appendNumber(hash, snapshot.sessions.length);
	for (const session of snapshot.sessions) {
		hash = appendSession(hash, session);
	}
	hash = appendRecord(hash, snapshot.statusBySessionId);
	hash = appendRecord(hash, snapshot.messageCountBySessionId);
	hash = appendRecord(hash, snapshot.sessionIssues);
	hash = appendStringArray(hash, snapshot.sourceIssues);
	return hash.toString(36);
};
