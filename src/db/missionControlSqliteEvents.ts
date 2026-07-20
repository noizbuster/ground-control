// Mission Control SQLite event-payload metadata fallbacks.
//
// session_events.payload_json holds a serialized AgentEventEnvelope with the
// event fields nested under `payload.event.*`. This module scans those payloads
// latest-first to fill directory/title/model gaps the `sessions` columns leave
// null. Lifecycle status is intentionally NOT read here — status stays owned by
// the sessions + session_awaits status mapping.

import type { DatabaseSync } from "node:sqlite";

export interface McMetadataFallbacksBySession {
	readonly directory: ReadonlyMap<string, string>;
	readonly title: ReadonlyMap<string, string>;
	readonly model: ReadonlyMap<
		string,
		{ readonly providerID: string; readonly currentModelID: string }
	>;
}

interface EventPayloadRow {
	session_id: string;
	seq: number;
	type: string | null;
	payload_json: string | null;
}

const MAX_EVENTS_PER_SESSION = 100;

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const RUN_COMMAND_LIFECYCLE_TITLE = /^run command:\s*\S+/iu;

export const isMissionControlPromptTitleMessage = (
	message: string,
	event: Readonly<Record<string, unknown>>,
): boolean => {
	const trimmed = message.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (RUN_COMMAND_LIFECYCLE_TITLE.test(trimmed)) {
		return false;
	}
	const run = event.run;
	if (isJsonObject(run) && run.command === "run") {
		return false;
	}
	return true;
};

const parsePayloadEvent = (
	payloadJson: string | null,
): Record<string, unknown> | undefined => {
	if (!payloadJson) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		if (!isJsonObject(parsed)) {
			return undefined;
		}
		const event = (parsed as { event?: unknown }).event;
		return isJsonObject(event) ? event : undefined;
	} catch {
		return undefined;
	}
};

// Queries explicit metadata titles independently so old renames remain visible,
// then scans session_events.payload_json latest-first (seq DESC) per session for
// directory, prompt-title, and model fallbacks. The generic scan remains capped.
// Only the requested session ids are queried; the caller decides who needs
// fallbacks based on raw column nullity.
export const fetchEventMetadataFallbacks = (
	database: DatabaseSync,
	sessionIds: readonly string[],
): McMetadataFallbacksBySession => {
	const directoryBySession = new Map<string, string>();
	const titleBySession = new Map<string, string>();
	const promptTitleBySession = new Map<string, string>();
	const modelBySession = new Map<
		string,
		{ providerID: string; currentModelID: string }
	>();

	if (sessionIds.length === 0) {
		return {
			directory: directoryBySession,
			title: titleBySession,
			model: modelBySession,
		};
	}

	const placeholders = sessionIds.map(() => "?").join(", ");
	const metadataTitleRows = database
		.prepare(
			`SELECT session_id, seq, type, payload_json
			 FROM session_events
			 WHERE session_id IN (${placeholders})
			   AND type = 'session.metadata.updated'
			 ORDER BY session_id, seq DESC`,
		)
		.all(...sessionIds) as unknown as EventPayloadRow[];

	for (const row of metadataTitleRows) {
		if (titleBySession.has(row.session_id)) {
			continue;
		}
		const event = parsePayloadEvent(row.payload_json);
		if (!event || !isJsonObject(event.sessionTree)) {
			continue;
		}
		const name = (event.sessionTree as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) {
			titleBySession.set(row.session_id, name);
		}
	}

	const rows = database
		.prepare(
			`SELECT session_id, seq, type, payload_json
			 FROM session_events
			 WHERE session_id IN (${placeholders})
			 ORDER BY session_id, seq DESC`,
		)
		.all(...sessionIds) as unknown as EventPayloadRow[];

	const directoryDone = new Set<string>();
	const promptTitleDone = new Set<string>();
	const modelDone = new Set<string>();
	const scannedBySession = new Map<string, number>();

	for (const row of rows) {
		const scanned = scannedBySession.get(row.session_id) ?? 0;
		if (scanned >= MAX_EVENTS_PER_SESSION) {
			continue;
		}
		scannedBySession.set(row.session_id, scanned + 1);

		const event = parsePayloadEvent(row.payload_json);
		if (!event) {
			continue;
		}

		if (!directoryDone.has(row.session_id) && isJsonObject(event.sessionTree)) {
			const cwd = (event.sessionTree as { cwd?: unknown }).cwd;
			if (typeof cwd === "string" && cwd.length > 0) {
				directoryBySession.set(row.session_id, cwd);
				directoryDone.add(row.session_id);
			}
		}

		if (
			!promptTitleDone.has(row.session_id) &&
			row.type === "run.command.received" &&
			typeof event.message === "string" &&
			isMissionControlPromptTitleMessage(event.message, event)
		) {
			promptTitleBySession.set(row.session_id, event.message.trim());
			promptTitleDone.add(row.session_id);
		}

		if (!modelDone.has(row.session_id)) {
			const selection = event.modelProviderSelection;
			if (isJsonObject(selection)) {
				const providerID = (selection as { providerID?: unknown }).providerID;
				const modelID = (selection as { modelID?: unknown }).modelID;
				if (typeof providerID === "string" && typeof modelID === "string") {
					modelBySession.set(row.session_id, {
						providerID,
						currentModelID: modelID,
					});
					modelDone.add(row.session_id);
				}
			}
		}
	}

	for (const [sessionId, promptTitle] of promptTitleBySession) {
		if (!titleBySession.has(sessionId)) {
			titleBySession.set(sessionId, promptTitle);
		}
	}

	return {
		directory: directoryBySession,
		title: titleBySession,
		model: modelBySession,
	};
};
