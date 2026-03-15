import type { MessageData } from "../types";
import { SessionStatus } from "../types";

type MessageParseResultLike =
	| { ok: true; value: MessageData }
	| { ok: false; error: { message: string } | string };

type SessionMessageInput =
	| MessageData
	| MessageParseResultLike
	| null
	| undefined;

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null;
};

const isValidRole = (role: unknown): role is MessageData["role"] => {
	return role === "user" || role === "assistant";
};

const isValidFinish = (finish: unknown): finish is MessageData["finish"] => {
	return (
		finish === undefined ||
		finish === "stop" ||
		finish === "tool-calls" ||
		finish === "error"
	);
};

const isValidMessageData = (value: unknown): value is MessageData => {
	if (!isRecord(value)) {
		return false;
	}

	if (!isValidRole(value.role)) {
		return false;
	}

	const time = value.time;
	if (!isRecord(time) || typeof time.created !== "number") {
		return false;
	}

	const completed = time.completed;
	if (completed !== undefined && typeof completed !== "number") {
		return false;
	}

	if (!isValidFinish(value.finish)) {
		return false;
	}

	if (value.agent !== undefined && typeof value.agent !== "string") {
		return false;
	}

	if (value.mode !== undefined && typeof value.mode !== "string") {
		return false;
	}

	if (value.tokens !== undefined) {
		if (
			!isRecord(value.tokens) ||
			typeof value.tokens.input !== "number" ||
			typeof value.tokens.output !== "number"
		) {
			return false;
		}
	}

	return true;
};

const hasCompletedMarker = (message: MessageData): boolean => {
	if (message.finish === "stop") {
		return true;
	}

	const completed = message.time?.completed;
	return typeof completed === "number" && Number.isFinite(completed);
};

const hasFailedMarker = (message: MessageData): boolean => {
	return message.finish === "error";
};

const hasQuestionToolSignal = (message: MessageData): boolean => {
	const mode = message.mode?.trim().toLowerCase();
	const agent = message.agent?.trim().toLowerCase();

	if (!mode && !agent) {
		return false;
	}

	if (
		(mode && mode === "question") ||
		(mode &&
			(mode === "tool:question" ||
				mode === "question-tool" ||
				mode === "question_tool"))
	) {
		return true;
	}

	return (
		!!agent &&
		(agent === "question" ||
			agent.endsWith("/question") ||
			agent.endsWith(":question"))
	);
};

const hasIdleEvidence = (message: MessageData): boolean => {
	return !hasCompletedMarker(message) && !hasFailedMarker(message);
};

const sanitizeMessageData = (
	input: SessionMessageInput,
): MessageData | null => {
	if (!input) {
		return null;
	}

	if (isRecord(input) && "ok" in input) {
		return input.ok && isValidMessageData(input.value) ? input.value : null;
	}

	if (isValidMessageData(input)) {
		return input;
	}

	return null;
};

export const detectFailedState = (
	messageInput: SessionMessageInput,
): boolean => {
	const message = sanitizeMessageData(messageInput);
	return message ? hasFailedMarker(message) : false;
};

export const detectCompletedState = (
	messageInput: SessionMessageInput,
): boolean => {
	const message = sanitizeMessageData(messageInput);
	return message ? hasCompletedMarker(message) : false;
};

export const detectWaitingState = (
	messageInput: SessionMessageInput,
): boolean => {
	const message = sanitizeMessageData(messageInput);

	if (!message) {
		return false;
	}

	return hasQuestionToolSignal(message) && hasIdleEvidence(message);
};

export const detectRunningState = (
	messageInput: SessionMessageInput,
): boolean => {
	const message = sanitizeMessageData(messageInput);

	if (!message) {
		return false;
	}

	return (
		!hasFailedMarker(message) &&
		!detectWaitingState(message) &&
		!hasCompletedMarker(message)
	);
};

export const getSessionStatus = (
	messageInput: SessionMessageInput,
): SessionStatus => {
	if (detectFailedState(messageInput)) {
		return SessionStatus.failed;
	}

	if (detectWaitingState(messageInput)) {
		return SessionStatus.waiting;
	}

	if (detectCompletedState(messageInput)) {
		return SessionStatus.completed;
	}

	if (detectRunningState(messageInput)) {
		return SessionStatus.running;
	}

	return SessionStatus.unknown;
};
