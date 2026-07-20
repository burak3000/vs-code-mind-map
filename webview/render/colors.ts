import { MindNode } from "../model/types";

const PALETTE_KEYS = Array.from({ length: 8 }, (_, i) => `c${i}`);

/** Recursively clears `colorKey` on `node` and every descendant — used to strip any stale key from nodes below the first level (see `assignMissingColors`). */
function clearColorKeyDeep(node: MindNode): void {
	node.colorKey = undefined;
	node.children.forEach(clearColorKeyDeep);
}

/**
 * Assigns a stable palette slot to any first-level branch that doesn't
 * already have one (R9). Never touches an existing colorKey, so adding or
 * removing one branch doesn't visually reshuffle the colors of unrelated
 * branches.
 *
 * Enforces the invariant "`colorKey` lives only on a direct child of root"
 * before assigning: any node whose parent isn't the root has its `colorKey`
 * cleared first (F1). Without this, a first-level branch's `colorKey`
 * pasted or drag-reordered to a position *inside* another branch would
 * keep shadowing `resolveNodeColorKey`'s upward walk with its old, now
 * stale color instead of inheriting the branch it actually lives under
 * now. This runs every `onChange`, so it also self-heals the drag-reorder
 * path (`moveNode`, which never sets/clears `colorKey` itself) — one fix
 * point instead of one per mutation path. O(nodes), folded into this
 * existing per-onChange walk — no new pass, nothing on the keystroke hot
 * path. See DECISIONS.md.
 */
export function assignMissingColors(root: MindNode): void {
	for (const child of root.children) {
		child.children.forEach(clearColorKeyDeep);
	}

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
