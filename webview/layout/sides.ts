import { MindNode } from "../model/types";
import { DEFAULT_LAYOUT_CONFIG, estimateSubtreeHeight, LayoutConfig } from "./layoutEngine";

/**
 * Assigns sides to first-level branches so that, read anticlockwise, they
 * match document order (R-anticlockwise-order): left side is the document
 * prefix `1..K` (top→bottom), right side is the suffix `K+1..N`
 * (bottom→top — the reversal for that reading direction happens in
 * `layoutEngine.ts`'s `partitionChildren`, not here). The split index K is
 * chosen to balance total *rendered height* (px, via `estimateSubtreeHeight`
 * — not node count: a branch with a few long/wrapped-text nodes can easily
 * be visually taller than a branch with many short ones, see DECISIONS.md's
 * dated "Rebalance balances by height, not node count" entry), but — per the
 * user's decision (see DECISIONS.md) — only ever *recomputed* on an explicit
 * Rebalance (`clearAllSides` + this function), never as a side effect of an
 * ordinary edit: a branch added/removed anywhere else in the tree would
 * otherwise touch nearly every node's position on every keystroke-adjacent
 * edit (measured pre-fix: one Tab on a 5,000-node map moved 4,999 of them
 * and flipped 2 of 10 branches to the other side).
 *
 * Two cases:
 * - **No branch has a side yet** (first open of a map, or right after
 *   Rebalance clears them all): compute a fresh height-balanced contiguous
 *   split from scratch.
 * - **Some branches already have sides** (the common edit-time case — one
 *   new first-level branch just got created): each side-less branch
 *   inherits the side of its nearest already-assigned neighbor in document
 *   order (previous sibling, falling back to the next one for an insert at
 *   the very front), which is exactly what keeps it contiguous with the
 *   correct run instead of picking a side by weight and potentially
 *   breaking the left/right document-order boundary.
 */
export function assignMissingSides(root: MindNode, cfg: LayoutConfig = DEFAULT_LAYOUT_CONFIG): void {
	const children = root.children;
	if (children.length === 0) return;

	if (children.every((c) => !c.branchSide)) {
		assignInitialSplit(children, cfg);
		return;
	}

	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child.branchSide) continue;

		let side: "L" | "R" | undefined;
		for (let j = i - 1; j >= 0 && !side; j--) side = children[j].branchSide;
		for (let j = i + 1; j < children.length && !side; j++) side = children[j].branchSide;
		child.branchSide = side ?? "L";
	}
}

/**
 * Fresh height-balanced contiguous split: finds the K (0..N) that minimizes
 * `|height(1..K) − height(K+1..N)|` (estimated rendered px, via
 * `estimateSubtreeHeight`) and assigns the first K children (in document
 * order) to Left, the rest to Right. O(N) over *all* nodes in the tree (each
 * visited once across the whole `estimateSubtreeHeight` recursion, reusing
 * `layoutEngine.ts`'s own text-wrap cache) — the same order as the
 * `computeLayout` pass that immediately follows, so this only roughly
 * doubles Rebalance's cost, not the cost of every edit (this function only
 * runs on an explicit Rebalance or first open — see `assignMissingSides`).
 * Ties prefer the larger K (more on the left) so a lone branch (or an
 * exact tie) defaults to the side that starts the anticlockwise reading.
 */
function assignInitialSplit(children: MindNode[], cfg: LayoutConfig): void {
	const weights = children.map((c) => estimateSubtreeHeight(c, cfg));
	const total = weights.reduce((sum, w) => sum + w, 0);

	let prefix = 0;
	let bestK = 0;
	let bestDiff = Infinity;
	for (let k = 0; k <= children.length; k++) {
		const diff = Math.abs(prefix - (total - prefix));
		if (diff <= bestDiff) {
			bestDiff = diff;
			bestK = k;
		}
		if (k < children.length) prefix += weights[k];
	}

	children.forEach((c, i) => {
		c.branchSide = i < bestK ? "L" : "R";
	});
}

/** Clears all side pins so the next layout recomputes a fresh, currently-optimal balance. The user-facing "Rebalance" command wires this up in M5. */
export function clearAllSides(root: MindNode): void {
	for (const child of root.children) child.branchSide = undefined;
}
