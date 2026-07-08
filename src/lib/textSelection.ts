export interface TextSelectionSnapshot {
	readonly isDragging?: boolean;
	readonly isStart?: boolean;
	getSelectedText(): string;
}

export const getTextSelectionText = (
	selection: TextSelectionSnapshot | null,
): string => {
	return typeof selection?.getSelectedText === "function"
		? selection.getSelectedText().trim()
		: "";
};

export const isTextSelectionInProgress = (
	selection: Pick<TextSelectionSnapshot, "isDragging" | "isStart"> | null,
): boolean => {
	return Boolean(selection?.isDragging || selection?.isStart);
};
