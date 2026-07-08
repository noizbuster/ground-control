import { TextBufferView } from "@opentui/core";

interface TextBufferViewSelectionPrototype {
	guard(): void;
	getSelection(): { start: number; end: number } | null;
	lib: { textBufferViewGetSelectionInfo(viewPtr: unknown): unknown };
	viewPtr: unknown;
}

export const patchTextBufferViewSelection = () => {
	const proto =
		TextBufferView.prototype as unknown as TextBufferViewSelectionPrototype;
	proto.getSelection = function (): { start: number; end: number } | null {
		proto.guard.call(this);
		const packedInfo = this.lib.textBufferViewGetSelectionInfo(this.viewPtr);
		const asBigInt =
			typeof packedInfo === "bigint"
				? packedInfo
				: BigInt(packedInfo as number);
		if (asBigInt === 0xffff_ffff_ffff_ffffn) {
			return null;
		}
		return {
			start: Number(asBigInt >> 32n),
			end: Number(asBigInt & 0xffff_ffffn),
		};
	};
};
