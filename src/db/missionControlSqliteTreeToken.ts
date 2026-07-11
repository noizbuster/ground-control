import { createHash } from "node:crypto";

export interface McCanonicalTreeNode {
	readonly sessionId: string;
	readonly parentSessionId: string | null;
	readonly depth: number;
}

const compareUtf8 = (left: string, right: string): number =>
	Buffer.compare(Buffer.from(left), Buffer.from(right));

export const getMcCanonicalTreeNodes = (
	targetId: string,
	parents: ReadonlyMap<string, string | null>,
	component: ReadonlySet<string>,
): McCanonicalTreeNode[] => {
	const children = new Map<string, string[]>();
	for (const sessionId of component) {
		const parentId = parents.get(sessionId) ?? null;
		if (parentId === null || !component.has(parentId)) continue;
		const siblings = children.get(parentId) ?? [];
		siblings.push(sessionId);
		children.set(parentId, siblings);
	}
	const nodes: McCanonicalTreeNode[] = [
		{
			sessionId: targetId,
			parentSessionId: parents.get(targetId) ?? null,
			depth: 0,
		},
	];
	let level = [targetId];
	for (let depth = 1; level.length > 0; depth += 1) {
		const next = level.flatMap((parentId) =>
			(children.get(parentId) ?? []).sort(compareUtf8),
		);
		nodes.push(
			...next.map((sessionId) => ({
				sessionId,
				parentSessionId: parents.get(sessionId) ?? null,
				depth,
			})),
		);
		level = next;
	}
	return nodes;
};

export const computeMcCanonicalTreeToken = (
	targetId: string,
	parents: ReadonlyMap<string, string | null>,
	component: ReadonlySet<string>,
): string => {
	const encoded = getMcCanonicalTreeNodes(targetId, parents, component)
		.map(
			({ sessionId, parentSessionId, depth }) =>
				`${depth}\0${parentSessionId ?? ""}\0${sessionId}`,
		)
		.join("\n");
	return createHash("sha256").update(encoded, "utf8").digest("hex");
};
