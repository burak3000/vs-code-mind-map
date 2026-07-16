import { flextree } from "d3-flextree";
import { MindNode } from "../model/types";
import { wrapText, lineLength } from "../model/textWrap";
import { getImageEmbed } from "../model/links";

export type LayoutMode = "balanced" | "right-only" | "left-only";

export interface LayoutConfig {
	nodeHeight: number; // px, single-line row height — baseline, tuned for `baselineFontSize`
	siblingGap: number; // px, vertical gap between sibling rows
	levelGap: number; // px, horizontal gap between depth levels
	charWidth: number; // px, approx width per character — baseline, tuned for `baselineFontSize`
	minNodeWidth: number; // baseline
	maxCharsPerLine: number; // default wrap width in characters (~60) before text moves to a new line — depth-invariant; a node's own manualWidth (already in real px) overrides the *pixel* ceiling this maps to, not this character count
	lineHeight: number; // px added per extra wrapped line, on top of nodeHeight — baseline
	paddingX: number; // baseline
	mode: LayoutMode;
	rootFontSize: number; // px at depth 0 — visual hierarchy (R15): the main topic reads as the largest
	fontSizeStep: number; // px subtracted per depth level below root
	minFontSize: number; // px floor so deep nodes stay legible instead of shrinking to nothing
	baselineFontSize: number; // the font size nodeHeight/charWidth/lineHeight/paddingX/minNodeWidth above were tuned for — used to derive the scale factor at any given depth
	/** Fixed thumbnail box for an image embed (plan item 07, decision A) — baseline px, depth-scaled like everything else. Fixed size (not aspect-ratio-derived) so layout never depends on an image actually loading. */
	imageThumbWidth: number;
	imageThumbHeight: number;
	imageThumbGap: number; // px between the last text line and the thumbnail
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
	nodeHeight: 28,
	siblingGap: 10,
	levelGap: 60,
	charWidth: 7,
	minNodeWidth: 40,
	maxCharsPerLine: 60,
	lineHeight: 16,
	paddingX: 16,
	mode: "balanced",
	rootFontSize: 21.6,
	fontSizeStep: 2.4,
	minFontSize: 12,
	baselineFontSize: 12,
	imageThumbWidth: 120,
	imageThumbHeight: 90,
	imageThumbGap: 6,
};

type FontScaleConfig = Pick<LayoutConfig, "rootFontSize" | "fontSizeStep" | "minFontSize" | "baselineFontSize">;
type WrapWidthConfig = FontScaleConfig & Pick<LayoutConfig, "charWidth" | "paddingX" | "maxCharsPerLine">;
/** Exactly what `computeNodeBox` needs — kept as its own type (not the full `LayoutConfig`) so callers like `SvgRenderer` (which never needs `mode`/`siblingGap`/`levelGap`) can depend on the narrower shape. */
export type NodeBoxConfig = WrapWidthConfig & Pick<LayoutConfig, "nodeHeight" | "lineHeight" | "minNodeWidth" | "imageThumbWidth" | "imageThumbHeight" | "imageThumbGap">;

/** Visual hierarchy by depth (R15): root reads largest, each level down a bit smaller, floored so deep nodes stay legible. */
export function fontSizeForDepth(depth: number, cfg: FontScaleConfig): number {
	return Math.max(cfg.minFontSize, cfg.rootFontSize - depth * cfg.fontSizeStep);
}

/** Ratio against the font size all the baseline px constants (nodeHeight/charWidth/lineHeight/paddingX/minNodeWidth) were tuned for — multiply any of them by this to get the value actually used at a given depth, so box geometry stays proportional to the font size rendered there. */
export function scaleForDepth(depth: number, cfg: FontScaleConfig): number {
	return fontSizeForDepth(depth, cfg) / cfg.baselineFontSize;
}

/** The default (non-manualWidth) wrap ceiling in px at a given depth: `maxCharsPerLine` characters at that depth's scaled char width — the character-count threshold itself doesn't change with depth, only the pixel width it maps to. */
export function defaultWrapWidthForDepth(depth: number, cfg: WrapWidthConfig): number {
	const scale = scaleForDepth(depth, cfg);
	return cfg.maxCharsPerLine * (cfg.charWidth * scale) + cfg.paddingX * scale;
}

export interface NodeBox {
	w: number;
	h: number;
	lines: ReturnType<typeof wrapText>;
	/**
	 * Node-local position/size of the image thumbnail area (plan item 07),
	 * or null if `text` has no image embed. Kept here (not recomputed
	 * separately) so layout and render agree on the exact same geometry —
	 * same reasoning as `wrapCeilingFor` in the renderer needing to match
	 * this function's own wrap-width math exactly.
	 */
	imageBox: { x: number; y: number; w: number; h: number } | null;
}

/**
 * Wraps `text` to fit within `manualWidth` (if the node's been drag-resized
 * — already a real px value, not scaled further) or the depth-scaled
 * default ceiling, and derives the box size from the wrapped lines: width
 * shrinks to the longest actual line (never wider than the wrap ceiling),
 * height grows by the depth-scaled `lineHeight` per line beyond the first.
 * If `text` has an image embed (R-image-display), a fixed-size thumbnail
 * area is appended below the text — fixed size, not derived from the
 * image's own intrinsic dimensions, so box geometry never depends on
 * whether/when the image actually finishes loading (decision A: no
 * layout reflow on image load).
 */
export function computeNodeBox(text: string, cfg: NodeBoxConfig, depth: number, manualWidth?: number): NodeBox {
	const scale = scaleForDepth(depth, cfg);
	const charWidth = cfg.charWidth * scale;
	const paddingX = cfg.paddingX * scale;
	const nodeHeight = cfg.nodeHeight * scale;
	const lineHeight = cfg.lineHeight * scale;
	const minNodeWidth = cfg.minNodeWidth * scale;

	const maxWidthPx = manualWidth ?? defaultWrapWidthForDepth(depth, cfg);
	const maxCharsPerLine = Math.max(1, Math.floor((maxWidthPx - paddingX) / charWidth));
	const lines = wrapText(text, maxCharsPerLine);
	const longestChars = Math.max(1, ...lines.map(lineLength));
	const textW = Math.min(maxWidthPx, Math.max(minNodeWidth, longestChars * charWidth + paddingX));
	const textH = lines.length <= 1 ? nodeHeight : nodeHeight + (lines.length - 1) * lineHeight;

	const embed = getImageEmbed(text);
	if (!embed) return { w: textW, h: textH, lines, imageBox: null };

	const thumbW = cfg.imageThumbWidth * scale;
	const thumbH = cfg.imageThumbHeight * scale;
	const gap = cfg.imageThumbGap * scale;
	const w = Math.max(textW, thumbW);
	const h = textH + gap + thumbH;
	const imageBox = { x: (w - thumbW) / 2, y: textH + gap, w: thumbW, h: thumbH };
	return { w, h, lines, imageBox };
}

export function estimateNodeWidth(text: string, cfg: NodeBoxConfig, depth: number, manualWidth?: number): number {
	return computeNodeBox(text, cfg, depth, manualWidth).w;
}

/**
 * Per-node box cache, keyed by node identity: flextree's internal
 * accessors call `nodeSize` several times per node per layout pass
 * (verified empirically, see DECISIONS.md's M5 entry on the same
 * gotcha for width estimation) — wrapping is real per-character work
 * (tokenize + greedy-pack), so recomputing it on every one of those
 * calls would multiply an already-non-trivial cost. Invalidated
 * whenever the node's own text, manualWidth, or depth (drag-reorder can
 * change depth) actually changes; otherwise reused across calls within
 * *and* across layout passes.
 */
const boxCache = new WeakMap<MindNode, { text: string; manualWidth: number | undefined; depth: number; box: NodeBox }>();

function nodeBoxFor(node: MindNode, cfg: LayoutConfig): NodeBox {
	const cached = boxCache.get(node);
	if (cached && cached.text === node.text && cached.manualWidth === node.manualWidth && cached.depth === node.depth) return cached.box;
	const box = computeNodeBox(node.text, cfg, node.depth, node.manualWidth);
	boxCache.set(node, { text: node.text, manualWidth: node.manualWidth, depth: node.depth, box });
	return box;
}

/**
 * Splits by each branch's already-assigned `branchSide` (contiguous
 * document-order split — see `assignMissingSides`/DECISIONS.md) for the
 * anticlockwise arrangement: left reads top→bottom, so it keeps document
 * order (flextree places the first array element topmost); right reads
 * bottom→top, so its array is reversed before `layoutSide` sees it — the
 * first (lowest-index, earliest-in-document) right branch ends up last in
 * the reversed array and therefore bottommost, matching "read the right
 * side from the bottom up in document order".
 */
function partitionChildren(children: MindNode[]): { left: MindNode[]; right: MindNode[] } {
	return {
		left: children.filter((c) => c.branchSide === "L"),
		right: children.filter((c) => c.branchSide !== "L").reverse(),
	};
}

/**
 * Lays out a pre-filtered (auto-only, i.e. no `manualPos`) list of siblings
 * by wrapping them under a zero-sized virtual root anchored at
 * (anchorX, anchorY), running flextree once, then writing absolute x/y
 * back onto each real node — mirrored (x negated relative to the anchor)
 * for the left side.
 *
 * Manually-positioned nodes (R12) are invisible to this flextree call
 * (the `children` accessor filters them out at every level, so they don't
 * consume layout space or get an auto position) — after the auto region
 * is positioned, any manually-positioned direct child found on one of
 * *those* nodes gets its own independent recursive sub-layout anchored at
 * its pin (`layoutManualNode`). The anchor node's own direct manual
 * children are the caller's responsibility (see `computeLayout` and
 * `layoutManualNode` for the two anchor cases: root, and a manual node).
 */
function layoutSide(autoChildren: MindNode[], cfg: LayoutConfig, side: "L" | "R", anchorX: number, anchorY: number, anchorDepthExtent: number): void {
	if (autoChildren.length === 0) return;

	const virtualRoot: MindNode = {
		id: "__virtual_root__",
		text: "",
		children: autoChildren,
		parent: null,
		depth: -1,
		folded: false,
		subtreeCount: 0,
	};

	const layoutFn = flextree<MindNode>({
		children: (node) => {
			if (node === virtualRoot) return node.children.length ? node.children : null;
			if (node.folded || node.children.length === 0) return null;
			// flextree's internal accessors get called multiple times per node
			// (verified empirically — see DECISIONS.md), so avoid allocating a
			// filtered array on every call in the common case (no manual
			// children at all): reuse the original array unless it's actually
			// needed.
			const hasManual = node.children.some((c) => c.manualPos);
			if (!hasManual) return node.children;
			const kids = node.children.filter((c) => !c.manualPos);
			return kids.length ? kids : null;
		},
		// The virtual root's breadth extent (first component) must be 0 so it
		// doesn't consume vertical space among the top-level children — but
		// its depth extent (second component) must match what the anchor node
		// itself contributes, or children collapse onto the anchor's own x
		// instead of being pushed out past its box.
		nodeSize: (n) => {
			if (n.data === virtualRoot) return [0, anchorDepthExtent];
			const box = nodeBoxFor(n.data, cfg);
			return [box.h + cfg.siblingGap, box.w + cfg.levelGap];
		},
	});

	const laidOut = layoutFn(layoutFn.hierarchy(virtualRoot));

	laidOut.each((n) => {
		if (n.data === virtualRoot) return;
		const node = n.data;
		const depthAxis = n.y;
		const box = nodeBoxFor(node, cfg);
		const w = box.w;
		// `depthAxis` is the box's *inner* edge (the one facing the anchor/
		// parent) on both sides — flextree derives it from ancestors' own
		// extents only, never this node's own width, so it stays put as
		// text changes length. A box always spans [x, x+w] in local rect
		// space regardless of side, so the outer edge is where growth must
		// go: on the right side that's naturally x+w (box already grows
		// rightward, away from the parent). On the left side the box must
		// grow leftward instead — achieved by anchoring the *right* edge at
		// the mirrored depthAxis and placing x that many pixels further
		// left, rather than negating depthAxis directly as `x` (which used
		// to leave the inner edge fixed and grow the box back toward the
		// parent instead of away from it).
		const x = side === "L" ? anchorX - depthAxis - w : anchorX + depthAxis;
		node.layout = { x, y: n.x + anchorY, w, h: box.h, side };
	});

	// Manually-positioned nodes nested anywhere within this auto-laid-out
	// region: found via each auto node's *raw* children list (the flextree
	// children accessor above already excluded them from positioning).
	laidOut.each((n) => {
		if (n.data === virtualRoot) return;
		const node = n.data;
		if (node.folded) return;
		for (const child of node.children) {
			if (child.manualPos) layoutManualNode(child, cfg, node.layout!.x);
		}
	});
}

/**
 * Positions a manually-pinned node at its stored coordinates (R12), then
 * recursively lays out its own subtree anchored there — auto children via
 * a fresh `layoutSide` call, further manual children via recursion. Side
 * (used only for edge-anchor direction, R11) is inferred from which side
 * of its parent the pin actually landed on, so the branch draws correctly
 * regardless of where the user dropped it.
 */
function layoutManualNode(node: MindNode, cfg: LayoutConfig, parentX: number): void {
	const pos = node.manualPos!;
	const side: "L" | "R" = pos.x < parentX ? "L" : "R";
	const box = nodeBoxFor(node, cfg);
	node.layout = { x: pos.x, y: pos.y, w: box.w, h: box.h, side };

	if (node.folded) return;
	const autoKids = node.children.filter((c) => !c.manualPos);
	layoutSide(autoKids, cfg, side, pos.x, pos.y, box.w + cfg.levelGap);
	for (const child of node.children) {
		if (child.manualPos) layoutManualNode(child, cfg, pos.x);
	}
}

/**
 * Tidy-tree layout via d3-flextree — O(n) per full pass over auto-managed
 * nodes (manually-positioned subtrees are O(their own size), computed
 * independently). Writes x/y/w/h/side onto each visible node's `layout`
 * field. Default mode balances first-level auto branches left/right of the
 * root by subtree weight (R11); `right-only`/`left-only` skip the split.
 *
 * Folded nodes' children are excluded entirely, so layout cost is
 * proportional to *visible* nodes (R13), not the full tree.
 */
export function computeLayout(root: MindNode, cfg: LayoutConfig = DEFAULT_LAYOUT_CONFIG): void {
	const rootBox = nodeBoxFor(root, cfg);
	root.layout = { x: 0, y: 0, w: rootBox.w, h: rootBox.h, side: "R" };
	if (root.folded) return;

	const rootDepthExtent = rootBox.w + cfg.levelGap;
	const autoChildren = root.children.filter((c) => !c.manualPos);

	if (cfg.mode === "right-only") {
		layoutSide(autoChildren, cfg, "R", 0, 0, rootDepthExtent);
	} else if (cfg.mode === "left-only") {
		layoutSide(autoChildren, cfg, "L", 0, 0, rootDepthExtent);
	} else {
		const { left, right } = partitionChildren(autoChildren);
		layoutSide(left, cfg, "L", 0, 0, rootDepthExtent);
		layoutSide(right, cfg, "R", 0, 0, rootDepthExtent);
	}

	for (const child of root.children) {
		if (child.manualPos) layoutManualNode(child, cfg, 0);
	}
}
