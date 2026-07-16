import { DropPosition, MindMapModel, MindNode, NodeLayout } from "../model/types";
import { collectVisibleNodes } from "../model/visibility";
import { resolveNodeColorKey, strokeWidthForDepth } from "./colors";
import { LinkKind, getImageEmbed, parseTextSegments } from "../model/links";
import { wrapText, WordToken } from "../model/textWrap";
import { DEFAULT_LAYOUT_CONFIG, LayoutConfig, NodeBoxConfig, computeNodeBox, defaultWrapWidthForDepth, fontSizeForDepth, scaleForDepth } from "../layout/layoutEngine";

/** Only the text-metric fields the renderer needs to reproduce layoutEngine's exact wrap points and depth-based font sizing (plus image-thumb geometry, R-image-display) — kept narrow so the renderer doesn't depend on layout-mode fields it has no use for. */
export type TextMetricsConfig = Pick<
	LayoutConfig,
	"charWidth" | "paddingX" | "maxCharsPerLine" | "lineHeight" | "nodeHeight" | "minNodeWidth" | "rootFontSize" | "fontSizeStep" | "minFontSize" | "baselineFontSize"
> &
	NodeBoxConfig;

const SVG_NS = "http://www.w3.org/2000/svg";

interface Viewport {
	tx: number;
	ty: number;
	scale: number;
}

interface BadgeDom {
	g: SVGGElement;
	circle: SVGCircleElement;
	text: SVGTextElement;
}

/** Image thumbnail (R-image-display, decision A: fixed-size thumb, click to open). `placeholder` shows until `image` loads (or permanently, with `missing` on top, if it errors) — created lazily, only for nodes whose text actually has an image embed. */
interface ImageDom {
	g: SVGGElement;
	placeholder: SVGRectElement;
	image: SVGImageElement;
	missing: SVGTextElement;
}

interface NodeDom {
	g: SVGGElement;
	rect: SVGRectElement;
	text: SVGTextElement;
	resizeHandle: SVGRectElement;
	colorClass: string | null;
	badge: BadgeDom | null;
	image: ImageDom | null;
}

interface LayoutSnapshot {
	x: number;
	y: number;
	w: number;
	h: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

/**
 * Default for the above-this-many-visible-nodes animation cutoff (fold/
 * unfold position transitions skip above it) — asked the user per
 * addendum §8 item 2; 500 was the chosen default. Overridable per
 * instance via the constructor (wired to Settings in M6).
 */
const DEFAULT_ANIMATION_NODE_THRESHOLD = 500;

/**
 * Above this many visible (folding-visible) nodes, viewport culling kicks
 * in: nodes/edges outside the current pan/zoom window (plus a margin) are
 * detached from the DOM instead of sitting there permanently (addendum
 * §4.3 — "nodes and branches outside the visible viewport are not
 * rendered ... on large maps"). Below the threshold, everything renders
 * unconditionally — culling bookkeeping isn't worth it for small maps, and
 * it avoids any behavior change for the common case.
 */
const CULL_THRESHOLD = 300;
/** User-space padding around the viewport so nodes don't pop in/out right at the edge while panning. */
const CULL_MARGIN = 400;

function el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
	return document.createElementNS(SVG_NS, tag);
}

/**
 * Sample count for the tapered-ribbon outline (R10, high-fidelity variant —
 * chosen over per-edge-constant width per the user's explicit decision,
 * see DECISIONS.md). 16 segments is the usual amount for a smooth-looking
 * variable-width stroke approximation; cost is O(1) per edge (a fixed
 * number of point/tangent evaluations), so total cost stays O(n) in the
 * number of edges, same as the constant-width version it replaces.
 */
const TAPER_SAMPLES = 16;

interface Point {
	x: number;
	y: number;
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
	const mt = 1 - t;
	const a = mt * mt * mt;
	const b = 3 * mt * mt * t;
	const c = 3 * mt * t * t;
	const d = t * t * t;
	return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function cubicTangent(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
	const mt = 1 - t;
	return {
		x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
		y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
	};
}

/**
 * Organic S-curve Bezier (R8) rendered as a *filled, continuously tapered
 * ribbon* rather than a constant-width stroke: width interpolates from the
 * parent depth's branch width down to the child depth's (R10), so a single
 * connector itself narrows along its length instead of only narrowing
 * level-to-level. Built by offsetting sampled points on the centerline
 * curve along its normal by a linearly-interpolated half-width, then
 * closing the two offset rows into one filled polygon (the standard
 * variable-width-stroke-as-polygon technique — true varying stroke width
 * isn't expressible as a single SVG `<path>` stroke). Anchors are
 * side-aware (R11): a right-side branch runs from the parent's right edge
 * to the child's *near* edge (the side facing the parent) — deliberately
 * short, not stretched across the child's own (possibly wide, wrapped)
 * box: an earlier attempt anchored this at the child's *far* edge instead
 * so the branch would visually run under the child's text, but for a wide
 * box that turned a short hop into a long diagonal sweep that crossed
 * straight through *other* nodes' text nearby (see DECISIONS.md). Text
 * sits next to this short tip instead (see `upsertNode`'s side-aware text
 * anchor), not on top of a long line. A left-side (mirrored) branch runs
 * the other way round.
 */
function edgePath(parentLayout: LayoutSnapshot, childLayout: LayoutSnapshot, side: "L" | "R", parentDepth: number, childDepth: number): string {
	const x1 = side === "R" ? parentLayout.x + parentLayout.w : parentLayout.x;
	const y1 = parentLayout.y + parentLayout.h / 2;
	const x2 = side === "R" ? childLayout.x : childLayout.x + childLayout.w;
	const y2 = childLayout.y + childLayout.h / 2;
	const midX = x1 + (x2 - x1) / 2;

	const p0: Point = { x: x1, y: y1 };
	const p1: Point = { x: midX, y: y1 };
	const p2: Point = { x: midX, y: y2 };
	const p3: Point = { x: x2, y: y2 };

	const halfWidthStart = strokeWidthForDepth(parentDepth) / 2;
	const halfWidthEnd = strokeWidthForDepth(childDepth) / 2;

	const top: Point[] = [];
	const bottom: Point[] = [];
	for (let i = 0; i <= TAPER_SAMPLES; i++) {
		const t = i / TAPER_SAMPLES;
		const pt = cubicPoint(p0, p1, p2, p3, t);
		const tangent = cubicTangent(p0, p1, p2, p3, t);
		const len = Math.hypot(tangent.x, tangent.y) || 1;
		const nx = -tangent.y / len;
		const ny = tangent.x / len;
		const halfWidth = halfWidthStart + (halfWidthEnd - halfWidthStart) * t;
		top.push({ x: pt.x + nx * halfWidth, y: pt.y + ny * halfWidth });
		bottom.push({ x: pt.x - nx * halfWidth, y: pt.y - ny * halfWidth });
	}

	let d = `M ${top[0].x},${top[0].y}`;
	for (let i = 1; i < top.length; i++) d += ` L ${top[i].x},${top[i].y}`;
	for (let i = bottom.length - 1; i >= 0; i--) d += ` L ${bottom[i].x},${bottom[i].y}`;
	d += " Z";
	return d;
}

/**
 * Hand-rolled, incrementally-updated SVG renderer (plan §5, §9.5). `mount`
 * does one full build (file open); `update` after that only touches nodes
 * whose text/position/width actually changed plus their incident edges —
 * never a full teardown+rebuild (addendum §4.3 is explicit that this is
 * mandatory, not a nice-to-have). Pan/zoom stays on one root `transform`,
 * rAF-batched, independent of node updates (GPU-composited).
 */
export class SvgRenderer {
	private readonly svg: SVGSVGElement;
	private readonly viewportG: SVGGElement;
	private readonly edgesG: SVGGElement;
	private readonly nodesG: SVGGElement;

	private readonly nodeEls = new Map<string, NodeDom>();
	private readonly edgeEls = new Map<string, SVGPathElement>(); // keyed by child node id
	private readonly lastLayout = new Map<string, LayoutSnapshot>();
	private readonly lastSide = new Map<string, "L" | "R">();
	private readonly lastText = new Map<string, string>();
	private readonly lastEdgeD = new Map<string, string>(); // keyed by child node id

	private readonly view: Viewport;
	private rafHandle: number | null = null;
	private dragging = false;
	private lastPointerX = 0;
	private lastPointerY = 0;
	private panStartX = 0;
	private panStartY = 0;
	/** Set at pointerup when a background pointerdown/up pair moved more than the click threshold (an actual pan, not a click) — the native `click` event that follows still fires regardless, so `onClick` checks this to avoid clearing the selection after every pan gesture. */
	private suppressNextBackgroundClick = false;
	private selectedIds: Set<string> = new Set();
	private primaryId: string | null = null;

	private onNodeClick: ((nodeId: string, evt: MouseEvent) => void) | null = null;
	private onNodeDblClick: ((nodeId: string) => void) | null = null;
	private onBadgeClick: ((nodeId: string) => void) | null = null;
	/** Fired on a plain click that lands on empty canvas (not a node/badge/link) — lets the caller clear the current selection, giving visible confirmation that the canvas itself received the click (see: users couldn't tell whether clicking the background did anything). */
	private onBackgroundClick: (() => void) | null = null;
	private onLinkClick: ((kind: LinkKind, target: string) => void) | null = null;
	private onImageClick: ((kind: LinkKind, target: string) => void) | null = null;
	private onManualMove: ((nodeId: string, pos: { x: number; y: number }) => void) | null = null;
	private onReorder: ((nodeId: string, targetId: string, position: DropPosition) => void) | null = null;
	private onManualWidth: ((nodeId: string, width: number) => void) | null = null;
	private onNodeContextMenu: ((nodeId: string, evt: MouseEvent) => void) | null = null;
	/** Resolves an image embed to a displayable URL — needs `app.metadataCache`/`app.vault`, so it's supplied by the view layer rather than imported here (same reasoning as every other Obsidian-API-dependent callback in this class). */
	private imageResolver: ((node: MindNode) => string | null) | null = null;

	private dragNode: { nodeId: string; manual: boolean; startClientX: number; startClientY: number; origX: number; origY: number } | null = null;
	private resizeNode: { nodeId: string; side: "L" | "R"; startClientX: number; origX: number; origWidth: number } | null = null;
	private dropTargetId: string | null = null;
	private dropPosition: DropPosition | null = null;
	/** Insertion line shown for a "before"/"after" (same-level reorder) drop — a plain highlight box on the target (as used for "inside") can't distinguish "nest into" from "reorder next to", so this draws a separate line at the target's top/bottom edge instead. Hidden (no `y1`/`y2` set, `display: none`) whenever `dropPosition` isn't "before"/"after". */
	private readonly dropIndicator: SVGLineElement;

	private lastModel: MindMapModel | null = null;
	private cullingActive = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly animationNodeThreshold: number = DEFAULT_ANIMATION_NODE_THRESHOLD,
		private readonly textCfg: TextMetricsConfig = DEFAULT_LAYOUT_CONFIG
	) {
		while (container.firstChild) container.removeChild(container.firstChild);

		this.svg = el("svg");
		this.svg.setAttribute("width", "100%");
		this.svg.setAttribute("height", "100%");
		this.svg.classList.add("mm-svg");
		container.appendChild(this.svg);

		this.viewportG = el("g");
		this.viewportG.classList.add("mm-viewport");
		this.svg.appendChild(this.viewportG);

		this.edgesG = el("g");
		this.edgesG.classList.add("mm-edges");
		this.viewportG.appendChild(this.edgesG);

		this.nodesG = el("g");
		this.nodesG.classList.add("mm-nodes");
		this.viewportG.appendChild(this.nodesG);

		this.dropIndicator = el("line");
		this.dropIndicator.classList.add("mm-drop-indicator");
		this.dropIndicator.style.display = "none";
		this.viewportG.appendChild(this.dropIndicator);

		// Center horizontally rather than pinning root near the left edge:
		// balanced layout (M3) can put branches on either side of the root.
		this.view = { tx: container.clientWidth / 2, ty: container.clientHeight / 2, scale: 1 };
		this.scheduleApplyViewport();

		this.svg.addEventListener("pointerdown", this.onPointerDown);
		this.svg.addEventListener("pointermove", this.onPointerMove);
		this.svg.addEventListener("pointerup", this.onPointerUp);
		this.svg.addEventListener("pointerleave", this.onPointerUp);
		this.svg.addEventListener("wheel", this.onWheel, { passive: false });
		this.svg.addEventListener("click", this.onClick);
		this.svg.addEventListener("contextmenu", this.onContextMenu);
	}

	/** `evt` is passed through so the caller can read modifier keys (Ctrl/Cmd = toggle, Shift = range — R-multi-select). */
	setNodeClickHandler(fn: (nodeId: string, evt: MouseEvent) => void): void {
		this.onNodeClick = fn;
	}

	setNodeContextMenuHandler(fn: (nodeId: string, evt: MouseEvent) => void): void {
		this.onNodeContextMenu = fn;
	}

	/** R-image-display: called once per node whose box has an image embed (on creation, and whenever its text/size/side changes) to get the URL to load. Returning null leaves the placeholder/missing-glyph showing. */
	setImageResolver(fn: (node: MindNode) => string | null): void {
		this.imageResolver = fn;
	}

	setNodeDblClickHandler(fn: (nodeId: string) => void): void {
		this.onNodeDblClick = fn;
	}

	setBadgeClickHandler(fn: (nodeId: string) => void): void {
		this.onBadgeClick = fn;
	}

	/** Plain click on empty canvas (not panned) — see `onBackgroundClick`. */
	setBackgroundClickHandler(fn: () => void): void {
		this.onBackgroundClick = fn;
	}

	setLinkClickHandler(fn: (kind: LinkKind, target: string) => void): void {
		this.onLinkClick = fn;
	}

	/** R-image-display: fired when the image thumbnail itself is clicked — kept separate from `setLinkClickHandler` because the two should navigate differently (a new tab for an image, so the map stays open; the current tab for a regular link click). */
	setImageClickHandler(fn: (kind: LinkKind, target: string) => void): void {
		this.onImageClick = fn;
	}

	/** Alt+drag (R12): fired once on drop with the node's final absolute position. */
	setManualMoveHandler(fn: (nodeId: string, pos: { x: number; y: number }) => void): void {
		this.onManualMove = fn;
	}

	/**
	 * Plain drag (drag-reorder): fired once on drop with the node dropped
	 * onto and where relative to it — `"inside"` nests as its last child,
	 * `"before"`/`"after"` reorders as its sibling (same-level reorder).
	 */
	setReorderHandler(fn: (nodeId: string, targetId: string, position: DropPosition) => void): void {
		this.onReorder = fn;
	}

	/** Resize-handle drag: fired once on drop with the node's final wrap width. */
	setManualWidthHandler(fn: (nodeId: string, width: number) => void): void {
		this.onManualWidth = fn;
	}

	/** Full build — intended for file open only, not per-edit. */
	mount(model: MindMapModel): void {
		this.nodeEls.forEach((dom) => dom.g.remove());
		this.edgeEls.forEach((edge) => edge.remove());
		this.nodeEls.clear();
		this.edgeEls.clear();
		this.lastLayout.clear();
		this.lastSide.clear();
		this.lastText.clear();
		this.lastEdgeD.clear();
		this.update(model);
	}

	/** Dirty-tracked update: create/update/remove only what changed. */
	update(model: MindMapModel): void {
		this.lastModel = model;
		const foldVisible = collectVisibleNodes(model.root);
		// CSS transition on .mm-node transform, gated by this class — cheap
		// (GPU-composited) at typical sizes, skipped above the threshold so a
		// fold/unfold on a huge map never has to animate hundreds of nodes at
		// once (edges are not tweened either way; they redraw instantly).
		this.svg.classList.toggle("mm-animated", foldVisible.length <= this.animationNodeThreshold);

		this.cullingActive = foldVisible.length > CULL_THRESHOLD;
		const inViewport = this.cullingActive ? this.cullToViewport(foldVisible) : foldVisible;
		this.applyVisibleSet(inViewport);
	}

	/** Re-applies culling against the last-known model without a full relayout — called on pan/zoom so panning a huge map keeps trimming the DOM as new nodes scroll into view. No-op below the culling threshold. */
	private recull(): void {
		if (!this.cullingActive || !this.lastModel) return;
		const foldVisible = collectVisibleNodes(this.lastModel.root);
		this.applyVisibleSet(this.cullToViewport(foldVisible));
	}

	private applyVisibleSet(visible: MindNode[]): void {
		const visibleIds = new Set(visible.map((n) => n.id));
		for (const [id, dom] of this.nodeEls) {
			if (!visibleIds.has(id)) {
				dom.g.remove();
				this.nodeEls.delete(id);
				this.lastLayout.delete(id);
				this.lastSide.delete(id);
				this.lastText.delete(id);
				const edge = this.edgeEls.get(id);
				if (edge) {
					edge.remove();
					this.edgeEls.delete(id);
					this.lastEdgeD.delete(id);
				}
			}
		}

		for (const node of visible) {
			if (!node.layout) continue;
			this.upsertNode(node);
			// The edge only needs the parent's *layout* (position data), not
			// its DOM — so it still draws correctly even when the parent
			// itself was culled out (off-screen), as long as the child is on
			// screen. `node.parent.layout` always exists for any non-root
			// node (folding a parent would have excluded this child from
			// `visible` entirely, not just culled it).
			if (node.parent?.layout) this.upsertEdge(node, node.parent);
		}
	}

	private cullToViewport(nodes: MindNode[]): MindNode[] {
		const bounds = this.getViewportBoundsUserSpace();
		return nodes.filter((n) => n.layout && this.intersectsBounds(n.layout, bounds));
	}

	private getViewportBoundsUserSpace(): { minX: number; maxX: number; minY: number; maxY: number } {
		const w = this.container.clientWidth || 800;
		const h = this.container.clientHeight || 600;
		return {
			minX: (-this.view.tx) / this.view.scale - CULL_MARGIN,
			maxX: (w - this.view.tx) / this.view.scale + CULL_MARGIN,
			minY: (-this.view.ty) / this.view.scale - CULL_MARGIN,
			maxY: (h - this.view.ty) / this.view.scale + CULL_MARGIN,
		};
	}

	private intersectsBounds(layout: LayoutSnapshot, bounds: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
		return layout.x + layout.w >= bounds.minX && layout.x <= bounds.maxX && layout.y + layout.h >= bounds.minY && layout.y <= bounds.maxY;
	}

	private upsertNode(node: MindNode): void {
		const layout = node.layout!;
		const isRoot = node.parent === null;
		let dom = this.nodeEls.get(node.id);
		if (!dom) {
			const g = el("g");
			g.classList.add("mm-node");
			if (isRoot) g.classList.add("mm-node-root");
			g.dataset.nodeId = node.id;

			const rect = el("rect");
			rect.setAttribute("rx", "4");
			rect.classList.add("mm-node-rect");
			g.appendChild(rect);

			const text = el("text");
			// Overwritten below (`textAnchorFor`/font-size block) on the very
			// first layout pass — this is just a harmless initial value.
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("dominant-baseline", "central");
			text.classList.add("mm-node-text");
			g.appendChild(text);

			const resizeHandle = el("rect");
			resizeHandle.classList.add("mm-resize-handle");
			resizeHandle.setAttribute("width", "6");
			g.appendChild(resizeHandle);

			this.nodesG.appendChild(g);
			dom = { g, rect, text, resizeHandle, colorClass: null, badge: null, image: null };
			this.nodeEls.set(node.id, dom);
			if (this.selectedIds.has(node.id)) g.classList.add("mm-selected");
			if (node.id === this.primaryId) g.classList.add("mm-selected-primary");
		}

		const prevLayout = this.lastLayout.get(node.id);
		const sizeChanged = !prevLayout || prevLayout.w !== layout.w || prevLayout.h !== layout.h;
		const sideChanged = this.lastSide.get(node.id) !== layout.side;
		if (!prevLayout || prevLayout.x !== layout.x || prevLayout.y !== layout.y) {
			dom.g.setAttribute("transform", `translate(${layout.x}, ${layout.y})`);
		}
		if (sizeChanged || sideChanged) {
			dom.rect.setAttribute("width", String(layout.w));
			dom.rect.setAttribute("height", String(layout.h));
			const [anchor, textX] = this.textAnchorFor(node, layout);
			dom.text.setAttribute("text-anchor", anchor);
			dom.text.setAttribute("x", String(textX));
			// R15 visual hierarchy: font size (and everything derived from it)
			// scales down with depth, root reading largest. `y` looks like a
			// constant per node but isn't a global one — see the height-formula
			// note on `computeNodeBox`: box height grows symmetrically by this
			// same depth's `lineHeight` per extra line, so the first line's
			// centered baseline always sits at half *this depth's* single-line
			// height, with later lines cascading from there via `dy`.
			dom.text.setAttribute("font-size", String(fontSizeForDepth(node.depth, this.textCfg)));
			dom.text.setAttribute("y", String((this.textCfg.nodeHeight * scaleForDepth(node.depth, this.textCfg)) / 2));
			const handleX = layout.side === "L" ? -3 : layout.w - 3;
			dom.resizeHandle.setAttribute("x", String(handleX));
			dom.resizeHandle.setAttribute("height", String(layout.h));
		}
		this.lastLayout.set(node.id, { x: layout.x, y: layout.y, w: layout.w, h: layout.h });
		this.lastSide.set(node.id, layout.side);

		if (this.lastText.get(node.id) !== node.text || sizeChanged || sideChanged) {
			this.renderNodeText(dom.text, node);
			this.upsertImage(dom, node);
			this.lastText.set(node.id, node.text);
		}

		const colorKey = resolveNodeColorKey(node);
		const colorClass = colorKey ? `mm-color-${colorKey}` : null;
		if (dom.colorClass !== colorClass) {
			if (dom.colorClass) dom.g.classList.remove(dom.colorClass);
			if (colorClass) dom.g.classList.add(colorClass);
			dom.colorClass = colorClass;
		}

		this.upsertBadge(node, dom, layout);
	}

	/** The wrap ceiling in px for a node — a manually drag-resized width overrides the depth-scaled default; must match `computeNodeBox`'s exactly, or wrapped line count here could disagree with the box height layoutEngine already committed to. */
	private wrapCeilingFor(node: MindNode): number {
		return node.manualWidth ?? defaultWrapWidthForDepth(node.depth, this.textCfg);
	}

	/**
	 * Text sits right next to the branch's (deliberately short, see
	 * `edgePath`) tip instead of centered in the middle of the node's own
	 * box: for a right-side node that's its *near* (left) edge, growing
	 * rightward away from the parent; for a left-side node, its near
	 * (right) edge, growing leftward. The root has no incoming branch at
	 * all and keeps its own visible box, so it stays centered as before.
	 */
	private textAnchorFor(node: MindNode, layout: NodeLayout): ["start" | "middle" | "end", number] {
		if (node.parent === null) return ["middle", layout.w / 2];
		const edgePadding = this.textCfg.paddingX / 2;
		return layout.side === "R" ? ["start", edgePadding] : ["end", layout.w - edgePadding];
	}

	/**
	 * Renders node text as plain content, or — when it contains a link
	 * (R5) — as a sequence of tspans so the link portion can be styled and
	 * made clickable independently of the surrounding plain text, or — once
	 * the text is long enough to actually wrap — as one tspan per wrapped
	 * line (each further split into per-word tspans so link click targets
	 * survive a line break). Only runs on a text, size, or side change
	 * (rename commit / resize / rebalance), never per keystroke.
	 */
	private renderNodeText(textEl: SVGTextElement, node: MindNode): void {
		const scale = scaleForDepth(node.depth, this.textCfg);
		const maxWidthPx = this.wrapCeilingFor(node);
		const maxCharsPerLine = Math.max(1, Math.floor((maxWidthPx - this.textCfg.paddingX * scale) / (this.textCfg.charWidth * scale)));
		const lines = wrapText(node.text, maxCharsPerLine);

		while (textEl.firstChild) textEl.removeChild(textEl.firstChild);

		if (lines.length <= 1) {
			this.renderSingleLineText(textEl, node.text);
			return;
		}

		const [, lineX] = this.textAnchorFor(node, node.layout!);
		lines.forEach((line, i) => {
			const lineTspan = el("tspan");
			lineTspan.setAttribute("x", String(lineX));
			if (i > 0) lineTspan.setAttribute("dy", String(this.textCfg.lineHeight * scale));
			this.appendWordTspans(lineTspan, line);
			textEl.appendChild(lineTspan);
		});
	}

	private appendWordTspans(parent: SVGTextElement | SVGTSpanElement, line: WordToken[]): void {
		for (const tok of line) {
			const wordSpan = el("tspan");
			wordSpan.textContent = (tok.spaceBefore ? " " : "") + tok.text;
			if (tok.link) {
				wordSpan.classList.add("mm-node-link");
				wordSpan.dataset.linkKind = tok.link.kind;
				wordSpan.dataset.linkTarget = tok.link.target;
			}
			parent.appendChild(wordSpan);
		}
	}

	/** Single-line fast path: a plain `textContent` write with zero extra elements for the common (no-link, unwrapped) case, exactly as before wrapping support existed. */
	private renderSingleLineText(textEl: SVGTextElement, rawText: string): void {
		const segments = parseTextSegments(rawText);
		if (segments.length === 1 && !segments[0].link) {
			textEl.textContent = rawText;
			return;
		}
		for (const seg of segments) {
			const tspan = el("tspan");
			tspan.textContent = seg.text;
			if (seg.link) {
				tspan.classList.add("mm-node-link");
				tspan.dataset.linkKind = seg.link.kind;
				tspan.dataset.linkTarget = seg.link.target;
			}
			textEl.appendChild(tspan);
		}
	}

	/**
	 * Fold affordance (R14): computed straight from the already-maintained
	 * `subtreeCount` cache — O(1), never a subtree walk (addendum §4.6).
	 * Shown on every node that has children, folded or not, so folding is
	 * discoverable by click rather than keyboard-only: folded shows the
	 * hidden-descendant count (click to unfold), unfolded shows a plain
	 * collapse dot (click to fold). Folding is a rare, user-paced action, so
	 * this isn't diffed as tightly as node/edge updates; the cost is bounded
	 * by how many *visible* nodes have children, not by tree size (already-
	 * culled nodes never reach this).
	 */
	private upsertBadge(node: MindNode, dom: NodeDom, layout: LayoutSnapshot): void {
		const shouldShow = node.subtreeCount > 0;
		if (!shouldShow) {
			if (dom.badge) {
				dom.badge.g.remove();
				dom.badge = null;
			}
			return;
		}

		if (!dom.badge) {
			const g = el("g");
			g.classList.add("mm-fold-badge");
			const circle = el("circle");
			circle.setAttribute("r", "8");
			g.appendChild(circle);
			const text = el("text");
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("dominant-baseline", "central");
			g.appendChild(text);
			dom.g.appendChild(g);
			dom.badge = { g, circle, text };
		}

		const side = node.layout!.side;
		const badgeX = side === "L" ? 0 : layout.w;
		dom.badge.g.setAttribute("transform", `translate(${badgeX}, ${layout.h / 2})`);
		dom.badge.g.classList.toggle("mm-fold-badge-folded", node.folded);
		dom.badge.text.textContent = node.folded ? String(node.subtreeCount) : "–";
	}

	/**
	 * Image thumbnail (R-image-display): only called when text/size/side
	 * actually changed (same gate as `renderNodeText`), since it re-derives
	 * `imageBox` via `computeNodeBox` — real work (a wrap pass), not a cheap
	 * per-call check like `upsertBadge`'s. Creates the placeholder/image/
	 * missing-glyph group lazily, only for nodes whose text has an image
	 * embed; removes it if a previously-embedded node's text no longer does.
	 * `href` assignment (the actual network/decode trigger) rides along
	 * with the existing culling mechanism for free: above the culling
	 * threshold, an off-screen node's whole DOM (this included) doesn't
	 * exist at all until it scrolls into view and `upsertNode` creates it.
	 */
	private upsertImage(dom: NodeDom, node: MindNode): void {
		const box = computeNodeBox(node.text, this.textCfg, node.depth, node.manualWidth);
		if (!box.imageBox) {
			if (dom.image) {
				dom.image.g.remove();
				dom.image = null;
			}
			return;
		}

		if (!dom.image) {
			const g = el("g");
			g.classList.add("mm-node-image-group");

			const placeholder = el("rect");
			placeholder.setAttribute("rx", "4");
			placeholder.classList.add("mm-image-placeholder");
			g.appendChild(placeholder);

			const image = el("image");
			image.classList.add("mm-node-image");
			g.appendChild(image);

			const missing = el("text");
			missing.classList.add("mm-image-missing");
			missing.setAttribute("text-anchor", "middle");
			missing.setAttribute("dominant-baseline", "central");
			missing.textContent = "?";
			g.appendChild(missing);

			image.addEventListener("load", () => g.classList.add("mm-image-loaded"));
			image.addEventListener("error", () => g.classList.add("mm-image-error"));

			dom.g.appendChild(g);
			dom.image = { g, placeholder, image, missing };
		}

		const { x, y, w, h } = box.imageBox;
		dom.image.g.classList.remove("mm-image-loaded", "mm-image-error");
		dom.image.g.setAttribute("transform", `translate(${x}, ${y})`);
		for (const shape of [dom.image.placeholder, dom.image.image]) {
			shape.setAttribute("width", String(w));
			shape.setAttribute("height", String(h));
		}
		dom.image.missing.setAttribute("x", String(w / 2));
		dom.image.missing.setAttribute("y", String(h / 2));
		dom.image.image.setAttribute("preserveAspectRatio", "xMidYMid slice");

		const embed = getImageEmbed(node.text)!;
		dom.image.image.dataset.linkKind = embed.kind;
		dom.image.image.dataset.linkTarget = embed.target;

		const url = this.imageResolver?.(node) ?? null;
		if (url) dom.image.image.setAttribute("href", url);
		else dom.image.image.removeAttribute("href");
	}

	private upsertEdge(node: MindNode, parent: MindNode): void {
		let edge = this.edgeEls.get(node.id);
		let colorClass: string | null = null;
		let isNew = false;
		if (!edge) {
			edge = el("path");
			edge.classList.add("mm-edge");
			edge.dataset.childId = node.id;
			this.edgesG.appendChild(edge);
			this.edgeEls.set(node.id, edge);
			isNew = true;
		} else {
			colorClass = edge.dataset.colorClass ?? null;
		}

		// Dirty-tracked, same as upsertNode: a Tab/rename/delete anywhere in
		// the tree must not force a DOM write on every other edge too. Width
		// (R10) is now baked directly into the filled ribbon's geometry
		// (tapering from the parent's depth-width to the child's), not a
		// separate `stroke-width` attribute, so it's covered by the same `d`
		// diff — no separate one-time write needed.
		const d = edgePath(parent.layout!, node.layout!, node.layout!.side, parent.depth, node.depth);
		if (isNew || this.lastEdgeD.get(node.id) !== d) {
			edge.setAttribute("d", d);
			this.lastEdgeD.set(node.id, d);
		}

		const resolvedKey = resolveNodeColorKey(node);
		const nextColorClass = resolvedKey ? `mm-color-${resolvedKey}` : null;
		if (colorClass !== nextColorClass) {
			if (colorClass) edge.classList.remove(colorClass);
			if (nextColorClass) edge.classList.add(nextColorClass);
			edge.dataset.colorClass = nextColorClass ?? "";
		}
	}

	/** Single-selection convenience — the plain-click/keyboard-nav case. Implemented in terms of `setSelection` so both paths share one restyle mechanism. */
	selectNode(id: string | null): void {
		this.setSelection(id ? new Set([id]) : new Set(), id);
	}

	/**
	 * Multi-select-aware selection styling (R-multi-select): every selected
	 * node gets `.mm-selected` (same look single-selection always had), the
	 * primary additionally gets `.mm-selected-primary` (an accent on top).
	 * Restyles only the symmetric difference between the old and new sets —
	 * O(Δselection), never O(visible) — so a large selection doesn't cost
	 * more than the handful of nodes that actually changed state.
	 */
	setSelection(ids: Set<string>, primaryId: string | null): void {
		for (const id of this.selectedIds) {
			if (!ids.has(id)) this.nodeEls.get(id)?.g.classList.remove("mm-selected");
		}
		for (const id of ids) {
			if (!this.selectedIds.has(id)) this.nodeEls.get(id)?.g.classList.add("mm-selected");
		}
		if (this.primaryId && this.primaryId !== primaryId) this.nodeEls.get(this.primaryId)?.g.classList.remove("mm-selected-primary");
		if (primaryId && primaryId !== this.primaryId) this.nodeEls.get(primaryId)?.g.classList.add("mm-selected-primary");

		this.selectedIds = new Set(ids);
		this.primaryId = primaryId;
	}

	getSelectedId(): string | null {
		return this.primaryId;
	}

	/**
	 * Returns the node's box in coordinates relative to `container` (the
	 * element passed into the constructor), not the viewport. The inline
	 * editor is positioned `absolute` inside that same container rather
	 * than `fixed` against the viewport — `position: fixed` breaks
	 * silently whenever any ancestor in Obsidian's workspace DOM has a
	 * `transform` set (pane animations, mobile), which makes that ancestor
	 * the containing block instead of the viewport. Anchoring to a
	 * container we control sidesteps that entirely.
	 */
	getNodeScreenRect(nodeId: string): { left: number; top: number; width: number; height: number } | null {
		const layout = this.lastLayout.get(nodeId);
		if (!layout) return null;
		const containerRect = this.container.getBoundingClientRect();
		const svgRect = this.svg.getBoundingClientRect();
		const offsetX = svgRect.left - containerRect.left;
		const offsetY = svgRect.top - containerRect.top;
		return {
			left: offsetX + this.view.tx + layout.x * this.view.scale,
			top: offsetY + this.view.ty + layout.y * this.view.scale,
			width: layout.w * this.view.scale,
			height: layout.h * this.view.scale,
		};
	}

	/**
	 * Screen-px sizing hints for the inline editor overlay on `node`: the
	 * wrap ceiling it should grow width up to (mirrors `wrapCeilingFor`,
	 * scaled by the current zoom), a sane minimum width for an empty node
	 * (~16 chars at the node's own scaled char width), and the depth-scaled
	 * font size — so the overlay's text metrics and growth ceiling agree
	 * with what `renderNodeText`/`computeNodeBox` will actually do on
	 * commit, instead of soft-wrapping at the node's pre-edit (possibly
	 * `minNodeWidth`-only, for a fresh empty node) box width.
	 */
	getNodeEditMetrics(node: MindNode): { minWidth: number; maxWidth: number; fontSize: number } {
		const depthScale = scaleForDepth(node.depth, this.textCfg);
		return {
			minWidth: 16 * this.textCfg.charWidth * depthScale * this.view.scale,
			maxWidth: this.wrapCeilingFor(node) * this.view.scale,
			fontSize: fontSizeForDepth(node.depth, this.textCfg) * this.view.scale,
		};
	}

	centerOnRoot(): void {
		this.view.tx = this.container.clientWidth / 2;
		this.view.ty = this.container.clientHeight / 2;
		this.view.scale = 1;
		this.scheduleApplyViewport();
	}

	/**
	 * Pans (keeping the current zoom level) so the given *world-space*
	 * point lands at the container's center — used for jumping to a search
	 * result or any other node that might currently be off-screen or
	 * culled out of the DOM entirely. Deliberately takes raw coordinates
	 * rather than a node id: the renderer's own layout cache (`lastLayout`)
	 * is pruned for culled/folded-out nodes (see `applyVisibleSet`), but
	 * the model's `node.layout` is always current regardless of culling,
	 * so callers should read the world position from there. `recull()`
	 * (already wired into `scheduleApplyViewport`) brings the target node
	 * back into the DOM once the pan lands it inside the viewport again.
	 */
	centerOnWorldPoint(x: number, y: number): void {
		this.view.tx = this.container.clientWidth / 2 - x * this.view.scale;
		this.view.ty = this.container.clientHeight / 2 - y * this.view.scale;
		this.scheduleApplyViewport();
	}

	destroy(): void {
		this.svg.removeEventListener("pointerdown", this.onPointerDown);
		this.svg.removeEventListener("pointermove", this.onPointerMove);
		this.svg.removeEventListener("pointerup", this.onPointerUp);
		this.svg.removeEventListener("pointerleave", this.onPointerUp);
		this.svg.removeEventListener("wheel", this.onWheel);
		this.svg.removeEventListener("click", this.onClick);
		this.svg.removeEventListener("contextmenu", this.onContextMenu);
		if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
		while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
	}

	private scheduleApplyViewport = (): void => {
		if (this.rafHandle !== null) return;
		this.rafHandle = requestAnimationFrame(() => {
			this.rafHandle = null;
			this.viewportG.setAttribute("transform", `translate(${this.view.tx}, ${this.view.ty}) scale(${this.view.scale})`);
			// Culling only re-runs here (rAF-batched, same as the transform
			// write) when it was already active — panning a small map never
			// pays this cost.
			this.recull();
		});
	};

	private onPointerDown = (evt: PointerEvent): void => {
		const target = evt.target as Element;
		if (target.closest(".mm-resize-handle")) {
			const nodeG = target.closest(".mm-node") as SVGGElement | null;
			const nodeId = nodeG?.dataset.nodeId;
			const layout = nodeId ? this.lastLayout.get(nodeId) : undefined;
			if (nodeId && layout) {
				const side = this.lastModel?.byId.get(nodeId)?.layout?.side ?? "R";
				this.resizeNode = {
					nodeId,
					side,
					startClientX: evt.clientX,
					origX: layout.x,
					origWidth: layout.w,
				};
				this.capturePointer(evt.pointerId);
			}
			return;
		}
		const nodeG = target.closest(".mm-node") as SVGGElement | null;
		if (nodeG?.dataset.nodeId) {
			const nodeId = nodeG.dataset.nodeId;
			const layout = this.lastLayout.get(nodeId);
			if (layout) {
				this.dragNode = {
					nodeId,
					manual: evt.altKey,
					startClientX: evt.clientX,
					startClientY: evt.clientY,
					origX: layout.x,
					origY: layout.y,
				};
				this.capturePointer(evt.pointerId);
			}
			return;
		}
		this.dragging = true;
		this.lastPointerX = evt.clientX;
		this.lastPointerY = evt.clientY;
		this.panStartX = evt.clientX;
		this.panStartY = evt.clientY;
		this.capturePointer(evt.pointerId);
	};

	/** Guarded: some test/embedding environments (jsdom) don't implement the Pointer Events capture API. */
	private capturePointer(pointerId: number): void {
		if (typeof this.svg.setPointerCapture === "function") this.svg.setPointerCapture(pointerId);
	}

	/**
	 * Released explicitly on pointerup rather than relying on the
	 * spec's implicit release — while capture is active, some browsers
	 * retarget the mouse-derived `click`/`dblclick` events that follow to
	 * the capturing element (this.svg) instead of the actual node under
	 * the cursor, which broke `closest(".mm-node")` lookups downstream.
	 * Releasing promptly avoids depending on that timing at all.
	 */
	private releasePointer(pointerId: number): void {
		if (typeof this.svg.releasePointerCapture === "function" && this.svg.hasPointerCapture?.(pointerId)) {
			this.svg.releasePointerCapture(pointerId);
		}
	}

	/** Absolute minimum wrap width a drag-resize can produce, regardless of config — a resize handle dragged to nothing shouldn't be able to collapse a node past readability. */
	private static readonly MIN_RESIZE_WIDTH = 40;

	private onPointerMove = (evt: PointerEvent): void => {
		if (this.resizeNode) {
			const dx = (evt.clientX - this.resizeNode.startClientX) / this.view.scale;
			// Dragging the handle away from the parent (right on the right
			// side, left on the left side) grows the box; the opposite
			// direction shrinks it.
			const grow = this.resizeNode.side === "R" ? dx : -dx;
			const newWidth = Math.max(SvgRenderer.MIN_RESIZE_WIDTH, this.resizeNode.origWidth + grow);
			const dom = this.nodeEls.get(this.resizeNode.nodeId);
			if (dom) {
				dom.rect.setAttribute("width", String(newWidth));
				dom.text.setAttribute("x", String(newWidth / 2));
				if (this.resizeNode.side === "L") {
					const newX = this.resizeNode.origX + (this.resizeNode.origWidth - newWidth);
					dom.g.setAttribute("transform", `translate(${newX}, ${this.lastLayout.get(this.resizeNode.nodeId)?.y ?? 0})`);
					dom.resizeHandle.setAttribute("x", "-3");
				} else {
					dom.resizeHandle.setAttribute("x", String(newWidth - 3));
				}
			}
			return;
		}
		if (this.dragNode) {
			const dx = (evt.clientX - this.dragNode.startClientX) / this.view.scale;
			const dy = (evt.clientY - this.dragNode.startClientY) / this.view.scale;
			if (this.dragNode.manual) {
				// Live preview: move just this node's own transform. No model
				// mutation, no relayout, no other DOM writes per move event.
				const dom = this.nodeEls.get(this.dragNode.nodeId);
				dom?.g.setAttribute("transform", `translate(${this.dragNode.origX + dx}, ${this.dragNode.origY + dy})`);
			} else {
				const targetId = this.findNodeUnderPoint(evt.clientX, evt.clientY, this.dragNode.nodeId);
				const position = targetId ? this.computeDropPosition(targetId, evt.clientY) : null;
				this.setDropTarget(targetId, position);
			}
			return;
		}
		if (!this.dragging) return;
		const dx = evt.clientX - this.lastPointerX;
		const dy = evt.clientY - this.lastPointerY;
		this.lastPointerX = evt.clientX;
		this.lastPointerY = evt.clientY;
		this.view.tx += dx;
		this.view.ty += dy;
		this.scheduleApplyViewport();
	};

	private onPointerUp = (evt: PointerEvent): void => {
		this.releasePointer(evt.pointerId);
		if (this.resizeNode) {
			const { nodeId, side, startClientX, origX, origWidth } = this.resizeNode;
			const dx = (evt.clientX - startClientX) / this.view.scale;
			const grow = side === "R" ? dx : -dx;
			const newWidth = Math.max(SvgRenderer.MIN_RESIZE_WIDTH, origWidth + grow);
			const moved = Math.abs(dx) > 3;
			this.resizeNode = null;
			if (moved) {
				this.onManualWidth?.(nodeId, newWidth);
			} else {
				// Not a real drag — restore the live-preview nudge, if any.
				const dom = this.nodeEls.get(nodeId);
				if (dom) {
					dom.rect.setAttribute("width", String(origWidth));
					dom.text.setAttribute("x", String(origWidth / 2));
					dom.resizeHandle.setAttribute("x", String(side === "L" ? -3 : origWidth - 3));
					if (side === "L") dom.g.setAttribute("transform", `translate(${origX}, ${this.lastLayout.get(nodeId)?.y ?? 0})`);
				}
			}
			return;
		}
		if (this.dragNode) {
			const { nodeId, manual, startClientX, startClientY, origX, origY } = this.dragNode;
			const dx = (evt.clientX - startClientX) / this.view.scale;
			const dy = (evt.clientY - startClientY) / this.view.scale;
			const moved = Math.abs(evt.clientX - startClientX) > 3 || Math.abs(evt.clientY - startClientY) > 3;
			this.dragNode = null;

			if (moved && manual) {
				this.onManualMove?.(nodeId, { x: origX + dx, y: origY + dy });
			} else if (moved) {
				const targetId = this.findNodeUnderPoint(evt.clientX, evt.clientY, nodeId);
				const position = targetId ? this.computeDropPosition(targetId, evt.clientY) : null;
				this.setDropTarget(null, null);
				if (targetId && position) this.onReorder?.(nodeId, targetId, position);
			} else {
				// Not a real drag (just a click that happened to fire pointerdown
				// on a node) — restore the DOM transform in case a manual-drag
				// preview nudged it before the movement threshold was reached.
				const dom = this.nodeEls.get(nodeId);
				dom?.g.setAttribute("transform", `translate(${origX}, ${origY})`);
			}
			return;
		}
		if (this.dragging) {
			this.suppressNextBackgroundClick = Math.abs(evt.clientX - this.panStartX) > 3 || Math.abs(evt.clientY - this.panStartY) > 3;
		}
		this.dragging = false;
	};

	/** Real hit-testing via the DOM (addendum §4.5 allows spatial-index or cheap bounding-box checks; elementsFromPoint is the cheap option here since node counts stay in the low thousands). */
	private findNodeUnderPoint(clientX: number, clientY: number, excludeId: string): string | null {
		const stack: Element[] = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(clientX, clientY) : [];
		for (const el of stack) {
			const nodeG = el.closest(".mm-node") as SVGGElement | null;
			const id = nodeG?.dataset.nodeId;
			if (id && id !== excludeId) return id;
		}
		return null;
	}

	/**
	 * Splits the target node's box into three horizontal bands so a plain
	 * drag can distinguish "nest into" (middle half) from "reorder as
	 * sibling before/after" (top/bottom quarters) — the same three-way split
	 * most outliner UIs use (VS Code's explorer, Notion, etc). Falls back to
	 * `"inside"` when the target is the root (nothing to be a sibling of) or
	 * its box can't be measured (e.g. jsdom in tests, where
	 * `getBoundingClientRect` reports zero height).
	 */
	private computeDropPosition(targetId: string, clientY: number): DropPosition {
		const target = this.lastModel?.byId.get(targetId);
		if (!target?.parent) return "inside";
		const rect = this.nodeEls.get(targetId)?.rect.getBoundingClientRect();
		if (!rect || rect.height <= 0) return "inside";
		const frac = (clientY - rect.top) / rect.height;
		if (frac < 0.25) return "before";
		if (frac > 0.75) return "after";
		return "inside";
	}

	private setDropTarget(nodeId: string | null, position: DropPosition | null): void {
		if (this.dropTargetId === nodeId && this.dropPosition === position) return;
		if (this.dropTargetId) this.nodeEls.get(this.dropTargetId)?.g.classList.remove("mm-drop-target");
		this.dropTargetId = nodeId;
		this.dropPosition = position;
		if (nodeId && position === "inside") this.nodeEls.get(nodeId)?.g.classList.add("mm-drop-target");
		this.updateDropIndicator();
	}

	/** Positions the "before"/"after" insertion line at the target's top/bottom edge, in the same world-space coordinates node boxes use (see `lastLayout`) — hidden whenever the current drop isn't a same-level reorder. */
	private updateDropIndicator(): void {
		const layout = this.dropTargetId ? this.lastLayout.get(this.dropTargetId) : undefined;
		if (!layout || (this.dropPosition !== "before" && this.dropPosition !== "after")) {
			this.dropIndicator.style.display = "none";
			return;
		}
		const y = this.dropPosition === "before" ? layout.y : layout.y + layout.h;
		this.dropIndicator.setAttribute("x1", String(layout.x));
		this.dropIndicator.setAttribute("x2", String(layout.x + layout.w));
		this.dropIndicator.setAttribute("y1", String(y));
		this.dropIndicator.setAttribute("y2", String(y));
		this.dropIndicator.style.display = "";
	}

	/**
	 * Trackpad pinch-to-zoom arrives as a wheel event with `ctrlKey` set
	 * (Chromium/Electron synthesizes it that way, matching how every other
	 * canvas app on macOS tells pinch apart from a two-finger swipe — same
	 * convention Figma/Miro/Excalidraw use). A two-finger swipe is a plain
	 * wheel event carrying `deltaX`/`deltaY`, so it pans instead of zooming.
	 */
	private onWheel = (evt: WheelEvent): void => {
		evt.preventDefault();
		if (evt.ctrlKey) {
			const rect = this.svg.getBoundingClientRect();
			const mx = evt.clientX - rect.left;
			const my = evt.clientY - rect.top;
			const worldX = (mx - this.view.tx) / this.view.scale;
			const worldY = (my - this.view.ty) / this.view.scale;
			const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
			this.view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * factor));
			this.view.tx = mx - worldX * this.view.scale;
			this.view.ty = my - worldY * this.view.scale;
		} else {
			this.view.tx -= evt.deltaX;
			this.view.ty -= evt.deltaY;
		}
		this.scheduleApplyViewport();
	};

	/**
	 * Double-click is detected here ourselves (same-node clicks within
	 * `DOUBLE_CLICK_MS`) rather than via the native `dblclick` event:
	 * while a node has pointer capture (needed for drag support, see
	 * `capturePointer`), the mouse-derived `click`/`dblclick` events that
	 * follow can get retargeted by the browser to the capturing element
	 * (`this.svg`) instead of the actual node — which broke
	 * `closest(".mm-node")` for `dblclick` specifically. Tracking it
	 * ourselves off plain `click` sidesteps that dependency entirely.
	 */
	private static readonly DOUBLE_CLICK_MS = 400;
	private lastClickNodeId: string | null = null;
	private lastClickTime = 0;

	/**
	 * Resolves the element actually under the cursor via coordinates rather
	 * than trusting `evt.target`: while a node has pointer capture (needed
	 * for drag support, see `capturePointer`), browsers can retarget the
	 * `click` event that follows to the *capturing* element (`this.svg`)
	 * instead of whatever was actually clicked — `this.svg` is an ancestor
	 * of every `.mm-node`, not a match itself, so `closest()` from there
	 * always came up empty and single-click-to-select silently did nothing.
	 * Same `elementsFromPoint` approach already used for drag hit-testing
	 * in `findNodeUnderPoint`; falls back to `evt.target` where it's
	 * unavailable (e.g. jsdom in tests).
	 */
	private resolveClickOrigin(evt: MouseEvent): Element | null {
		if (typeof document.elementsFromPoint === "function") {
			const stack = document.elementsFromPoint(evt.clientX, evt.clientY);
			if (stack.length > 0) return stack[0];
		}
		return evt.target as Element | null;
	}

	private onClick = (evt: MouseEvent): void => {
		const target = this.resolveClickOrigin(evt);
		if (!target) {
			this.lastClickNodeId = null;
			return;
		}
		const badge = target.closest(".mm-fold-badge");
		if (badge) {
			const nodeG = badge.closest(".mm-node") as SVGGElement | null;
			if (nodeG?.dataset.nodeId) this.onBadgeClick?.(nodeG.dataset.nodeId);
			return;
		}
		const link = target.closest(".mm-node-link") as SVGElement | null;
		if (link?.dataset.linkKind && link.dataset.linkTarget) {
			this.onLinkClick?.(link.dataset.linkKind as LinkKind, link.dataset.linkTarget);
			return;
		}
		// Image thumbnail (R-image-display, decision A: click opens the image
		// in a new tab, unlike a regular link click which navigates the
		// current one — so this gets its own callback rather than reusing
		// onLinkClick, even though the kind/target shape is identical).
		const image = target.closest(".mm-node-image") as SVGElement | null;
		if (image?.dataset.linkKind && image.dataset.linkTarget) {
			this.onImageClick?.(image.dataset.linkKind as LinkKind, image.dataset.linkTarget);
			return;
		}
		const nodeG = target.closest(".mm-node") as SVGGElement | null;
		const nodeId = nodeG?.dataset.nodeId;
		if (!nodeId) {
			this.lastClickNodeId = null;
			if (this.suppressNextBackgroundClick) this.suppressNextBackgroundClick = false;
			else this.onBackgroundClick?.();
			return;
		}

		const now = Date.now();
		if (this.lastClickNodeId === nodeId && now - this.lastClickTime <= SvgRenderer.DOUBLE_CLICK_MS) {
			this.lastClickNodeId = null; // consumed — a third click starts fresh, not a re-trigger
			this.onNodeDblClick?.(nodeId);
			return;
		}
		this.lastClickTime = now;
		this.lastClickNodeId = nodeId;
		this.onNodeClick?.(nodeId, evt);
	};

	/** Right-click (R-context-menu): not affected by the pointer-capture retargeting `resolveClickOrigin` works around above (a context-menu right-click doesn't participate in the drag pointer-capture flow), so a plain `evt.target.closest` hit-test — same as `onPointerDown` — is enough. */
	private onContextMenu = (evt: MouseEvent): void => {
		const target = evt.target as Element;
		const nodeG = target.closest(".mm-node") as SVGGElement | null;
		const nodeId = nodeG?.dataset.nodeId;
		if (!nodeId) return;
		evt.preventDefault();
		this.onNodeContextMenu?.(nodeId, evt);
	};
}
