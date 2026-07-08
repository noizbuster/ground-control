import { MouseButton } from "@opentui/core";

export interface DetailMouseEvent {
	readonly button: MouseButton;
	readonly isDragging?: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

export interface DetailMouseContext {
	readonly isDetailMode: boolean;
	readonly isSideviewMode: boolean;
	setFocusedPane(pane: "detail"): void;
	closeDetailView(): void;
}

export const handleDetailMouseDown = (
	event: DetailMouseEvent,
	context: DetailMouseContext,
): void => {
	if (
		event.button === MouseButton.RIGHT &&
		context.isDetailMode &&
		!context.isSideviewMode
	) {
		event.preventDefault();
		event.stopPropagation();
		context.closeDetailView();
		return;
	}

	if (event.button === MouseButton.LEFT && !event.isDragging) {
		context.setFocusedPane("detail");
	}
};
