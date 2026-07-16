import { MindNode } from "../model/types";

const PALETTE_KEYS = Array.from({ length: 8 }, (_, i) => `c${i}`);

/**
 * Assigns a stable palette slot to any first-level branch that doesn't
 * already have one (R9). Never touches an existing colorKey, so adding or
 * removing one branch doesn't visually reshuffle the colors of unrelated
 * branches.
 */
export function assignMissingColors(root: MindNode): void {
	const used = new Set(root.children.map((c) => c.colorKey).filter((c): c is string => !!c));
	root.children.forEach((child, index) => {
		if (child.colorKey) return;
		const next = PALETTE_KEYS.find((k) => !used.has(k)) ?? PALETTE_KEYS[index % PALETTE_KEYS.length];
		child.colorKey = next;
		used.add(next);
	});
}

/** Resolves a node's effective branch color by walking up to the nearest ancestor with a colorKey. Root itself resolves to null (neutral/no branch color). */
export function resolveNodeColorKey(node: MindNode): string | null {
	let cur: MindNode | null = node;
	while (cur) {
		if (cur.colorKey) return cur.colorKey;
		cur = cur.parent;
	}
	return null;
}

/** Tapered branch stroke width by depth (R10): thick near the root, floors at a minimum so deep leaves stay visible. */
export function strokeWidthForDepth(depth: number): number {
	return Math.max(1.5, 10 * Math.pow(0.66, depth));
}
