/**
 * Canonical request/response contract for refresh worker communication.
 * All payloads are structured-clone-safe (no DB handles, Maps, Sets, functions, or class instances).
 */

import type { Session, SessionStatus } from "../types";
import type { DatabaseError } from "./index";

export type RefreshRequestId = number;
export type RefreshGeneration = number;

export interface RefreshRequest {
	readonly kind: "refresh-request";
	readonly requestId: RefreshRequestId;
	readonly generation: RefreshGeneration;
}

export interface RefreshResetRequest {
	readonly kind: "refresh-reset";
	readonly generation: RefreshGeneration;
}

export interface RefreshWorkerReadyRequest {
	readonly kind: "refresh-worker-ready";
	readonly generation: RefreshGeneration;
}

export type RefreshWorkerRequest =
	| RefreshRequest
	| RefreshResetRequest
	| RefreshWorkerReadyRequest;

export interface RefreshSnapshotPayload {
	readonly sessions: Session[];
	readonly statusBySessionId: Partial<Record<string, SessionStatus>>;
	readonly messageCountBySessionId: Partial<Record<string, number>>;
	readonly sessionIssues: Partial<Record<string, string>>;
	readonly sourceIssues: string[];
}

export interface RefreshSuccessResponse {
	readonly ok: true;
	readonly requestId: RefreshRequestId;
	readonly generation: RefreshGeneration;
	readonly snapshot: RefreshSnapshotPayload;
}

export interface RefreshErrorResponse {
	readonly ok: false;
	readonly requestId: RefreshRequestId;
	readonly generation: RefreshGeneration;
	readonly error: DatabaseError;
}

export type RefreshResponse = RefreshSuccessResponse | RefreshErrorResponse;

export interface RefreshResetAcknowledgement {
	readonly kind: "refresh-reset-ack";
	readonly generation: RefreshGeneration;
}

export interface RefreshWorkerReadyAcknowledgement {
	readonly kind: "refresh-worker-ready-ack";
	readonly generation: RefreshGeneration;
}

export type RefreshWorkerControlAcknowledgement =
	| RefreshResetAcknowledgement
	| RefreshWorkerReadyAcknowledgement;

export function createRequest(
	requestId: RefreshRequestId,
	generation: RefreshGeneration,
): RefreshRequest {
	return { kind: "refresh-request", requestId, generation };
}

export function createRefreshResetRequest(
	generation: RefreshGeneration,
): RefreshResetRequest {
	return { kind: "refresh-reset", generation };
}

export function createRefreshWorkerReadyRequest(
	generation: RefreshGeneration,
): RefreshWorkerReadyRequest {
	return { kind: "refresh-worker-ready", generation };
}

export function createSuccessResponse(
	requestId: RefreshRequestId,
	generation: RefreshGeneration,
	snapshot: RefreshSnapshotPayload,
): RefreshSuccessResponse {
	return { ok: true, requestId, generation, snapshot };
}

export function createErrorResponse(
	requestId: RefreshRequestId,
	generation: RefreshGeneration,
	error: DatabaseError,
): RefreshErrorResponse {
	return { ok: false, requestId, generation, error };
}

export function isRefreshRequest(msg: unknown): msg is RefreshRequest {
	return (
		typeof msg === "object" &&
		msg !== null &&
		(msg as RefreshRequest).kind === "refresh-request" &&
		typeof (msg as RefreshRequest).requestId === "number" &&
		typeof (msg as RefreshRequest).generation === "number"
	);
}

export function isRefreshWorkerRequest(
	msg: unknown,
): msg is RefreshWorkerRequest {
	if (isRefreshRequest(msg)) {
		return true;
	}
	if (typeof msg !== "object" || msg === null) {
		return false;
	}
	const request = msg as RefreshResetRequest | RefreshWorkerReadyRequest;
	return (
		(request.kind === "refresh-reset" ||
			request.kind === "refresh-worker-ready") &&
		typeof request.generation === "number"
	);
}

export function isRefreshResponse(msg: unknown): msg is RefreshResponse {
	if (typeof msg !== "object" || msg === null) {
		return false;
	}

	const response = msg as RefreshResponse;
	return (
		(response.ok === true || response.ok === false) &&
		typeof response.requestId === "number" &&
		typeof response.generation === "number"
	);
}

export function isRefreshWorkerControlAcknowledgement(
	msg: unknown,
): msg is RefreshWorkerControlAcknowledgement {
	if (typeof msg !== "object" || msg === null) {
		return false;
	}
	const acknowledgement = msg as RefreshWorkerControlAcknowledgement;
	return (
		(acknowledgement.kind === "refresh-reset-ack" ||
			acknowledgement.kind === "refresh-worker-ready-ack") &&
		typeof acknowledgement.generation === "number"
	);
}
