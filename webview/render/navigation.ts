import { MindNode } from "../model/types";

export type Direction = "up" | "down" | "left" | "right";

/**
 * Arrow-key navigation (R4): nearest node in a screen direction, using
 * cached layout positions — no tree walk, just a scan over the already-
 * computed visible list.
 */
export function findNearestInDirection(nodes: MindNode[], from: MindNode, direction: Direction): MindNode | null {
	if (!from.layout) return null;
	const fx = from.layout.x + from.layout.w / 2;
	const fy = from.layout.y + from.layout.h / 2;

	let best: MindNode | null = null;
	let bestScore = Infinity;

	for (const node of nodes) {
		if (node === from || !node.layout) continue;
		const nx = node.layout.x + node.layout.w / 2;
		const ny = node.layout.y + node.layout.h / 2;
		const dx = nx - fx;
		const dy = ny - fy;

		let primary: number;
		let secondary: number;
		if (direction === "right") {
			if (dx <= 0) continue;
			primary = dx;
			secondary = Math.abs(dy);
		} else if (direction === "left") {
			if (dx >= 0) continue;
			primary = -dx;
			secondary = Math.abs(dy);
		} else if (direction === "down") {
			if (dy <= 0) continue;
			primary = dy;
			secondary = Math.abs(dx);
		} else {
			if (dy >= 0) continue;
			primary = -dy;
			secondary = Math.abs(dx);
		}

		// Weight off-axis distance more heavily so a roughly-straight move
		// wins over a diagonal one that happens to be slightly closer.
		const score = primary + secondary * 2;
		if (score < bestScore) {
			bestScore = score;
			best = node;
		}
	}

	return best;
}

/** Vertically-nearest child of `node` (used for the "away from root" move) — null if folded or childless. */
function nearestChildByVertical(node: MindNode): MindNode | null {
	if (node.folded || node.children.length === 0 || !node.layout) return null;
	const fy = node.layout.y + node.layout.h / 2;

	let best: MindNode | null = null;
	let bestDist = Infinity;
	for (const child of node.children) {
		if (!child.layout) continue;
		const dist = Math.abs(child.layout.y + child.layout.h / 2 - fy);
		if (dist < bestDist) {
			bestDist = dist;
			best = child;
		}
	}
	return best;
}

/**
 * Previous/next sibling (same parent) ordered by on-screen vertical
 * position — null at the first/last sibling or if `node` has no parent.
 * Restricted to siblings on the same `side` as `node`: first-level
 * branches split across left/right (balanced mode) are laid out with each
 * side centered independently, so their `y` values aren't a single
 * consistent order — sorting *all* of root's children by `y` regardless of
 * side let Up/Down jump straight across the root into the opposite branch
 * (bug: a right-side branch's "down" press could land on a left-side one).
 * Deeper siblings all share their parent's side already, so this filter is
 * a no-op there.
 */
function siblingInDirection(node: MindNode, direction: "up" | "down"): MindNode | null {
	const allSiblings = node.parent?.children;
	if (!allSiblings || allSiblings.length <= 1) return null;
	const side = node.layout?.side;
	const siblings = side ? allSiblings.filter((n) => n.layout?.side === side) : allSiblings;
	if (siblings.length <= 1) return null;

	const sorted = siblings.slice().sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0));
	const idx = sorted.indexOf(node);
	if (idx === -1) return null;
	if (direction === "down") return idx < sorted.length - 1 ? sorted[idx + 1] : null;
	return idx > 0 ? sorted[idx - 1] : null;
}

/**
 * Structural, tree-aware arrow navigation (R-arrow-keys): follows
 * parent/child/sibling relationships instead of a pure geometric scan, so
 * arrows behave like XMind rather than occasionally jumping into a cousin
 * branch or across the root. `findNearestInDirection` remains the fallback
 * for manually-positioned nodes and for walking up/down across a sibling
 * group's edge without crossing to the other side of the root.
 *
 * Cost: O(siblings) for the common parent/child/sibling case — `node`'s
 * siblings are always all visible when `node` itself is (a folded ancestor
 * would have hidden `node` too), so no extra visibility filtering is
 * needed. Only the two fallback branches (root left/right, and up/down
 * past a sibling-group edge) touch the O(visible) `visibleNodes` list,
 * strictly no worse than the previous always-O(visible) behavior.
 */
export function navigateFrom(node: MindNode, direction: Direction, visibleNodes: MindNode[]): MindNode | null {
	if (node.depth === 0) {
		if (direction === "left" || direction === "right") {
			const side: "L" | "R" = direction === "left" ? "L" : "R";
			const candidates = node.children.filter((c) => c.layout?.side === side);
			return findNearestInDirection(candidates, node, direction);
		}
		return findNearestInDirection(visibleNodes, node, direction);
	}

	const side = node.layout?.side;

	if (direction === "left" || direction === "right") {
		const towardRoot = (side === "R" && direction === "left") || (side === "L" && direction === "right");
		if (towardRoot) return node.parent;
		return nearestChildByVertical(node);
	}

	const sibling = siblingInDirection(node, direction);
	if (sibling) return sibling;

	const sameSide = visibleNodes.filter((n) => n.layout?.side === side);
	return findNearestInDirection(sameSide, node, direction);
}
