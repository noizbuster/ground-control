export interface SessionStopKey {
	readonly name: string;
	readonly ctrl: boolean;
	readonly shift: boolean;
	readonly sequence: string;
}

/** Ctrl+K is canonical; Shift+K remains accepted for existing users. */
export const isSessionStopShortcut = (key: SessionStopKey): boolean =>
	(key.name === "k" && (key.ctrl || key.shift)) || key.sequence === "\u000b";
