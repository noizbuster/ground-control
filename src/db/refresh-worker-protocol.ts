/**
 * Canonical request/response contract for refresh worker communication.
 * All payloads are structured-clone-safe (no DB handles, Maps, Sets, functions, or class instances).
 */

import type { Session, SessionStatus } from "../types";
import type { DatabaseError } from "./index";

export type RefreshRequestId = number;

export interface RefreshRequest {
	readonly kind: "refresh-request";
	readonly requestId: RefreshRequestId;
}

export interface RefreshSnapshotPayload {
	readonly sessions: Session[];
	readonly statusBySessionId: Partial<Record<string, SessionStatus>>;
	readonly messageCountBySessionId: Partial<Record<string, number>>;
	readonly sessionIssues: Partial<Record<string, string>>;
}

export interface RefreshSuccessResponse {
	readonly ok: true;
	readonly requestId: RefreshRequestId;
	readonly snapshot: RefreshSnapshotPayload;
}

export interface RefreshErrorResponse {
	readonly ok: false;
	readonly requestId: RefreshRequestId;
	readonly error: DatabaseError;
}

export type RefreshResponse = RefreshSuccessResponse | RefreshErrorResponse;

export function createRequest(requestId: RefreshRequestId): RefreshRequest {
	return { kind: "refresh-request", requestId };
}

export function createSuccessResponse(
	requestId: RefreshRequestId,
	snapshot: RefreshSnapshotPayload,
): RefreshSuccessResponse {
	return { ok: true, requestId, snapshot };
}

export function createErrorResponse(
	requestId: RefreshRequestId,
	error: DatabaseError,
): RefreshErrorResponse {
	return { ok: false, requestId, error };
}

export function isRefreshRequest(msg: unknown): msg is RefreshRequest {
	return (
		typeof msg === "object" &&
		msg !== null &&
		(msg as RefreshRequest).kind === "refresh-request"
	);
}

export function isRefreshResponse(msg: unknown): msg is RefreshResponse {
	if (typeof msg !== "object" || msg === null) {
		return false;
	}

	const response = msg as RefreshResponse;
	if (response.ok !== true && response.ok !== false) {
		return false;
	}

	return typeof response.requestId === "number";
}
