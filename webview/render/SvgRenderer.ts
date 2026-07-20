import { DropPosition, MindMapModel, MindNode, NodeLayout } from "../model/types";
import { collectVisibleNodes } from "../model/visibility";
import { resolveNodeColorKey, strokeWidthForDepth } from "./colors";
import { getBadgeDef } from "../model/statusBadges";
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

/** R2: cross-document relation indicator — a small badge shown only on a node whose text links to a different document (as opposed to a same-doc relation, which gets an R1a arrow instead). */
interface CrossDocBadgeDom {
	g: SVGGElement;
	circle: SVGCircleElement;
	text: SVGTextElement;
	title: SVGTitleElement;
}

/** Image thumbnail (R-image-display, decision A: fixed-size thumb, click to open). `placeholder` shows until `image` loads (or permanently, with `missing` on top, if it errors) — created lazily, only for nodes whose text actually has an image embed. */
interface ImageDom {
	g: SVGGElement;
	placeholder: SVGRectElement;
	image: SVGImageElement;
	missing: SVGTextElement;
}

/** Status badge (plans/09) — a small glyph+color indicator for the node's workflow status (Done/Started/Blocked/Red Flag/Green Flag/Ready to work on, model/statusBadges.ts). Created lazily, only for nodes with a `statusBadge` whose key `getBadgeDef` recognizes. */
interface StatusBadgeDom {
	g: SVGGElement;
	circle: SVGCircleElement;
	text: SVGTextElement;
	title: SVGTitleElement;
	badgeKey: string | null;
}

interface NodeDom {
	g: SVGGElement;
	rect: SVGRectElement;
	text: SVGTextElement;
	resizeHandle: SVGRectElement;
	colorClass: string | null;
	badge: BadgeDom | null;
	image: ImageDom | null;
	crossDocBadge: CrossDocBadgeDom | null;
	statusBadge: StatusBadgeDom | null;
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
/**
 * How far the fold badge sits beyond the resize handle's outer edge
 * (`RESIZE_HANDLE_HALF_WIDTH`), so the two no longer occupy the same node
 * edge. Side-by-side, in outward order from the box: resize handle
 * (unchanged, still adjacent to the box edge — a grab handle belongs right
 * on the thing it resizes), then the fold badge beyond it, at the branch's
 * actual tip. `BADGE_OUTWARD_GAP` is 0 (touching, not overlapping) rather
 * than a visible gap — a real gap is empty canvas with no element on it at
 * all, and a right-click landing there misses `.mm-node` entirely, falling
 * through to nothing instead of opening the node's context menu (see
 * DECISIONS.md — this was shipped once with a 4px gap and had to be
 * corrected). Zero gap still keeps the badge's hit-circle
 * (`BADGE_HIT_RADIUS`) from reaching back INTO the resize handle's column,
 * so the two remain non-overlapping, just adjacent instead of spaced apart.
 */
const RESIZE_HANDLE_HALF_WIDTH = 3;
const BADGE_HIT_RADIUS = 13;
const BADGE_OUTWARD_GAP = 0;
const BADGE_OUTWARD_OFFSET = RESIZE_HANDLE_HALF_WIDTH + BADGE_OUTWARD_GAP + BADGE_HIT_RADIUS;

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
 * Point on `rect`'s boundary reached by walking out from its center in
 * direction `(dx, dy)` — i.e. where a ray toward the other node's center
 * first exits this node's box. Used so a relation arrow leaves from the
 * side of the source facing the target and lands on the side of the
 * target facing the source (e.g. the source's right edge to the target's
 * left edge when the target sits to the right), rather than passing
 * through both boxes center-to-center, which is what made arrows hard to
 * trace on wide maps.
 */
function rectBoundaryPoint(rect: LayoutSnapshot, dx: number, dy: number): { x: number; y: number } {
	const cx = rect.x + rect.w / 2;
	const cy = rect.y + rect.h / 2;
	if (dx === 0 && dy === 0) return { x: cx, y: cy };
	const hw = rect.w / 2;
	const hh = rect.h / 2;
	const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
	const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
	const t = Math.min(tx, ty);
	return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Cheap cubic-Bezier relation arrow (R1a, D5: cheap Bezier+arrowhead over a
 * rich/routed/animated variant — start cheap, revisit only if requested).
 * A single S-curve anchored at box edges (`rectBoundaryPoint`) rather than
 * box centers, with the endpoint pulled back a few px so the arrowhead
 * marker (`#mm-relation-arrowhead`, set up in the constructor) doesn't
 * render on top of the target's border. Unlike `edgePath`'s
 * tapered-ribbon-as-filled-polygon, this is a plain stroked path — O(1)
 * per relation (no per-sample loop), a fraction of an edge's cost.
 */
function relationPath(source: LayoutSnapshot, target: LayoutSnapshot): string {
	const sourceCx = source.x + source.w / 2;
	const sourceCy = source.y + source.h / 2;
	const targetCx = target.x + target.w / 2;
	const targetCy = target.y + target.h / 2;
	const dx = targetCx - sourceCx;
	const dy = targetCy - sourceCy;

	const start = rectBoundaryPoint(source, dx, dy);
	const end = rectBoundaryPoint(target, -dx, -dy);

	const ex = end.x - start.x;
	const ey = end.y - start.y;
	const dist = Math.hypot(ex, ey) || 1;
	const pullback = Math.min(dist / 2, 6);
	const x2 = end.x - (ex / dist) * pullback;
	const y2 = end.y - (ey / dist) * pullback;
	const midX = start.x + (x2 - start.x) / 2;
	return `M ${start.x},${start.y} C ${midX},${start.y} ${midX},${y2} ${x2},${y2}`;
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
	private readonly relationsG: SVGGElement;
	private readonly nodesG: SVGGElement;

	private readonly nodeEls = new Map<string, NodeDom>();
	private readonly edgeEls = new Map<string, SVGPathElement>(); // keyed by child node id
	private readonly lastLayout = new Map<string, LayoutSnapshot>();
	private readonly lastSide = new Map<string, "L" | "R">();
	private readonly lastText = new Map<string, string>();
	private readonly lastEdgeD = new Map<string, string>(); // keyed by child node id

	/** R1a: same-doc relation arrows — keyed by `${sourceId}::${targetId}`, same dirty-tracked-`d` + cull-driven add/remove discipline as `edgeEls`/`lastEdgeD`. See `updateRelations`. */
	private readonly relationEls = new Map<string, SVGPathElement>();
	private readonly lastRelationD = new Map<string, string>();
	/** The active same-doc relation (source id, target id) pairs as of the last `update()` — recomputed by the caller (`model/relations.ts`'s `resolveRelations`) on model change, *not* here, and *not* on every pan/zoom recull (R1a item 4: never recompute all arrows on pan/zoom). */
	private activeRelations: { sourceId: string; targetId: string }[] = [];
	/** Snapshot of the fold-visible node id set as of the last `update()` — O(1) membership test so `updateRelations` can skip a relation whose endpoint is currently folded away (R1a item 3) without re-walking the fold tree on every recull. */
	private lastFoldVisibleIds: Set<string> = new Set();

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
	/** R2: fired when a node's cross-document relation badge is clicked. */
	private onCrossDocBadgeClick: ((nodeId: string) => void) | null = null;
	/** plans/09: fired when a node's status badge is clicked — opens the same quick-pick menu as Cmd+Shift+I. */
	private onStatusBadgeClick: ((nodeId: string) => void) | null = null;
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
	/** F3: fired once per applied frame (from `scheduleApplyViewport`'s rAF callback, after the transform is written and `recull()` runs) whenever `tx`/`ty`/`scale` change — never per raw wheel/pointermove event, so this stays batched. Lets the view layer keep an open inline editor glued to its node during pan/zoom without this class knowing an editor exists. */
	private onViewportChange: (() => void) | null = null;

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
		private readonly textCfg: TextMetricsConfig = DEFAULT_LAYOUT_CONFIG,
		/** R1a item 5 (`showRelations` setting): when false, `updateRelations` never runs and `relationsG` stays permanently empty — "no arrows/relation layer work happens" at all, not just hidden via CSS. Baked in at construction like the other settings-derived constructor params (`animationNodeThreshold`), so a mid-session toggle takes effect the next time the map is (re)opened. */
		private readonly showRelations: boolean = true
	) {
		while (container.firstChild) container.removeChild(container.firstChild);

		this.svg = el("svg");
		this.svg.setAttribute("width", "100%");
		this.svg.setAttribute("height", "100%");
		this.svg.classList.add("mm-svg");
		container.appendChild(this.svg);

		// R1a: arrowhead marker for relation arrows, defined once and referenced
		// by every relation path's `marker-end` (see `updateRelations`).
		const defs = el("defs");
		const marker = el("marker");
		marker.setAttribute("id", "mm-relation-arrowhead");
		marker.setAttribute("viewBox", "0 0 10 10");
		marker.setAttribute("refX", "9");
		marker.setAttribute("refY", "5");
		marker.setAttribute("markerWidth", "6");
		marker.setAttribute("markerHeight", "6");
		marker.setAttribute("orient", "auto-start-reverse");
		const markerPath = el("path");
		markerPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
		markerPath.classList.add("mm-relation-arrowhead-path");
		marker.appendChild(markerPath);
		defs.appendChild(marker);
		this.svg.appendChild(defs);

		this.viewportG = el("g");
		this.viewportG.classList.add("mm-viewport");
		this.svg.appendChild(this.viewportG);

		this.edgesG = el("g");
		this.edgesG.classList.add("mm-edges");
		this.viewportG.appendChild(this.edgesG);

		// Between edgesG and nodesG (R1a item 3): relation arrows read as
		// underneath node boxes but above branch edges.
		this.relationsG = el("g");
		this.relationsG.classList.add("mm-relations");
		this.viewportG.appendChild(this.relationsG);

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

	/** R2: cross-document relation badge click — the view layer resolves the node's cross-doc relation(s) and opens the target via the existing `openLink` path. */
	setCrossDocBadgeClickHandler(fn: (nodeId: string) => void): void {
		this.onCrossDocBadgeClick = fn;
	}

	/** plans/09: status badge click — the view layer opens the same quick-pick status menu as Cmd+Shift+I, positioned via `getNodeScreenRect`. */
	setStatusBadgeClickHandler(fn: (nodeId: string) => void): void {
		this.onStatusBadgeClick = fn;
	}

	/** F3: subscribe to viewport (pan/zoom) changes, fired once per applied frame — see `onViewportChange`'s field doc for why this is batched and not per-event. */
	setViewportChangeHandler(fn: () => void): void {
		this.onViewportChange = fn;
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
	mount(model: MindMapModel, activeRelations: { sourceId: string; targetId: string }[] = []): void {
		this.nodeEls.forEach((dom) => dom.g.remove());
		this.edgeEls.forEach((edge) => edge.remove());
		this.relationEls.forEach((path) => path.remove());
		this.nodeEls.clear();
		this.edgeEls.clear();
		this.relationEls.clear();
		this.lastLayout.clear();
		this.lastSide.clear();
		this.lastText.clear();
		this.lastEdgeD.clear();
		this.lastRelationD.clear();
		this.update(model, activeRelations);
	}

	/**
	 * Dirty-tracked update: create/update/remove only what changed.
	 * `activeRelations` (R1a) is supplied by the caller — `model/relations.ts`'s
	 * `resolveRelations`, run once per model change in `MindMapView.onChange` —
	 * rather than recomputed here, so this stays a pure "draw what I'm given"
	 * step with no relation-resolution cost of its own.
	 */
	update(model: MindMapModel, activeRelations: { sourceId: string; targetId: string }[] = []): void {
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

		// R1a item 5: showRelations=false means zero relation work, not just a
		// hidden layer — activeRelations is simply never stored or drawn.
		if (this.showRelations) {
			this.lastFoldVisibleIds = new Set(foldVisible.map((n) => n.id));
			this.activeRelations = activeRelations;
			this.updateRelations();
		}
	}

	/** Re-applies culling against the last-known model without a full relayout — called on pan/zoom so panning a huge map keeps trimming the DOM as new nodes scroll into view. No-op below the culling threshold. */
	private recull(): void {
		if (!this.cullingActive || !this.lastModel) return;
		const foldVisible = collectVisibleNodes(this.lastModel.root);
		this.applyVisibleSet(this.cullToViewport(foldVisible));
		// R1a item 4: relations are re-culled on pan/zoom too (mirrors edges,
		// which already redraw-but-diff-skip every recull) — cheap, since it's
		// bounded by `activeRelations.length` (a membership test + a `d`-string
		// rebuild-and-compare per relation, no DOM write unless something
		// actually changed), never a re-walk of the fold tree or a full
		// re-resolution of relation links. `lastFoldVisibleIds`/`activeRelations`
		// themselves are untouched here — only set by `update()` — so pure
		// pan/zoom never re-derives them.
		if (this.showRelations && this.cullingActive) this.updateRelations();
	}

	/**
	 * Dirty-tracked + culled relation-arrow sync (R1a item 4), the same
	 * discipline `upsertEdge` uses for branches: rebuild each active
	 * relation's path string and only write the DOM attribute when it
	 * actually changed, so a pure pan/zoom (no layout change, geometry
	 * unchanged) is a cheap membership-check-and-skip. Reads endpoint
	 * geometry straight from `node.layout` (always current for a
	 * fold-visible node, regardless of DOM culling) rather than the
	 * renderer's own `lastLayout` cache, since a relation's target commonly
	 * won't have DOM of its own (off-screen, culled out) even while its
	 * source is visible.
	 */
	private updateRelations(): void {
		const model = this.lastModel;
		if (!model) return;
		const bounds = this.cullingActive ? this.getViewportBoundsUserSpace() : null;
		const seen = new Set<string>();

		for (const { sourceId, targetId } of this.activeRelations) {
			const key = `${sourceId}::${targetId}`;
			if (seen.has(key)) continue; // dedupe: e.g. two links in one node's text pointing at the same target
			const source = model.byId.get(sourceId);
			const target = model.byId.get(targetId);
			// Skip relations whose endpoint is folded/hidden/unresolved (R1a
			// item 3) — fold-visibility is an O(1) lookup against the snapshot
			// `update()` took, not a fold-tree re-walk, so this stays cheap even
			// when called from `recull()` on every pan/zoom frame.
			if (!source?.layout || !target?.layout || !this.lastFoldVisibleIds.has(sourceId) || !this.lastFoldVisibleIds.has(targetId)) {
				continue;
			}
			if (bounds && !this.intersectsBounds(source.layout, bounds) && !this.intersectsBounds(target.layout, bounds)) {
				continue; // both endpoints fully outside the viewport + margin
			}

			seen.add(key);
			let path = this.relationEls.get(key);
			let isNew = false;
			if (!path) {
				path = el("path");
				path.classList.add("mm-relation");
				path.setAttribute("marker-end", "url(#mm-relation-arrowhead)");
				this.relationsG.appendChild(path);
				this.relationEls.set(key, path);
				isNew = true;
			}
			const d = relationPath(source.layout, target.layout);
			if (isNew || this.lastRelationD.get(key) !== d) {
				path.setAttribute("d", d);
				this.lastRelationD.set(key, d);
			}
		}

		for (const [key, path] of this.relationEls) {
			if (!seen.has(key)) {
				path.remove();
				this.relationEls.delete(key);
				this.lastRelationD.delete(key);
			}
		}
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
			dom = { g, rect, text, resizeHandle, colorClass: null, badge: null, image: null, crossDocBadge: null, statusBadge: null };
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
		this.upsertCrossDocBadge(node, dom, layout);
		this.upsertStatusBadge(node, dom, layout);
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
			// Invisible, larger hit-target behind the visible circle (fill
			// "transparent", not "none" — SVG only hit-tests a painted fill,
			// and "none" has no paint value at all, so the pointer would fall
			// through to whatever's beneath). The badge now sits beyond the
			// resize handle (see BADGE_OUTWARD_OFFSET) rather than on top of
			// it, but the badge itself is still only ~16px across, so this
			// stays as a general "easier to hit" margin.
			const hitCircle = el("circle");
			hitCircle.setAttribute("r", String(BADGE_HIT_RADIUS));
			hitCircle.setAttribute("fill", "transparent");
			g.appendChild(hitCircle);
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
		// Side-by-side with the resize handle, not stacked on it: the handle
		// stays put at the box's outer edge (local x=0 for "L", x=layout.w
		// for "R"); the badge sits BADGE_OUTWARD_OFFSET further out, away
		// from the box in the same outward direction the branch already
		// grows for this side — negative x (further left) for "L", positive
		// x (further right) for "R" — so it reads as "further along the
		// branch," not as a second control fighting the resize handle for
		// the same spot.
		const badgeX = side === "L" ? -BADGE_OUTWARD_OFFSET : layout.w + BADGE_OUTWARD_OFFSET;
		dom.badge.g.setAttribute("transform", `translate(${badgeX}, ${layout.h / 2})`);
		dom.badge.g.classList.toggle("mm-fold-badge-folded", node.folded);
		dom.badge.text.textContent = node.folded ? String(node.subtreeCount) : "–";
	}

	/**
	 * R2: cross-document relation indicator — a small badge on any node whose
	 * text has at least one *cross-doc* resolved relation (a same-map
	 * relation gets an R1a arrow instead, not this badge; a node with no
	 * link gets neither — see `model/relations.ts`'s classification). Reuses
	 * `node.resolvedRelations`, cached by `resolveRelations` and already
	 * current by the time `upsertNode` runs, so this is a cheap per-node
	 * check (`.some`, no allocation in the common no-relations case) inside
	 * the existing per-node dirty-tracked render path — no new global pass,
	 * matching the same cost profile as `upsertBadge`'s fold indicator.
	 */
	private upsertCrossDocBadge(node: MindNode, dom: NodeDom, layout: LayoutSnapshot): void {
		const relations = node.resolvedRelations;
		const hasCrossDoc = !!relations && relations.some((r) => r.kind === "cross-doc");
		if (!hasCrossDoc) {
			if (dom.crossDocBadge) {
				dom.crossDocBadge.g.remove();
				dom.crossDocBadge = null;
			}
			return;
		}

		if (!dom.crossDocBadge) {
			const g = el("g");
			g.classList.add("mm-cross-doc-badge");
			const circle = el("circle");
			circle.setAttribute("r", "7");
			g.appendChild(circle);
			const text = el("text");
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("dominant-baseline", "central");
			text.textContent = "↗"; // ↗ — external-link glyph
			g.appendChild(text);
			const title = el("title");
			g.appendChild(title);
			dom.g.appendChild(g);
			dom.crossDocBadge = { g, circle, text, title };
		}

		const side = node.layout!.side;
		const badgeX = side === "L" ? 0 : layout.w;
		dom.crossDocBadge.g.setAttribute("transform", `translate(${badgeX}, -8)`);
		const targets = relations!.filter((r) => r.kind === "cross-doc").map((r) => r.rawTarget);
		dom.crossDocBadge.title.textContent = `Links to: ${targets.join(", ")}`;
	}

	/**
	 * Status badge (plans/09): a small glyph+color indicator for the node's
	 * workflow status, shown only when `node.statusBadge` is set to a key
	 * `getBadgeDef` recognizes (an unrecognized value — e.g. written by a
	 * newer plugin version — round-trips through save/load but renders
	 * nothing here, matching `nodeHasPersistableMeta`'s "capture, don't
	 * validate" policy in sync/metadata.ts). Same cheap "always call, no-op
	 * fast" cost profile as `upsertBadge`/`upsertCrossDocBadge` above — a map
	 * lookup and a couple of attribute writes, no allocation in the common
	 * (no badge) case. Placed at the corner opposite the cross-doc badge
	 * (which sits at `x = side==="L" ? 0 : w`) so the two never overlap even
	 * on a node that has both.
	 */
	private upsertStatusBadge(node: MindNode, dom: NodeDom, layout: LayoutSnapshot): void {
		const def = getBadgeDef(node.statusBadge);
		if (!def) {
			if (dom.statusBadge) {
				dom.statusBadge.g.remove();
				dom.statusBadge = null;
			}
			return;
		}

		if (!dom.statusBadge) {
			const g = el("g");
			g.classList.add("mm-status-badge");
			const circle = el("circle");
			circle.setAttribute("r", "8");
			g.appendChild(circle);
			const text = el("text");
			text.setAttribute("text-anchor", "middle");
			text.setAttribute("dominant-baseline", "central");
			g.appendChild(text);
			const title = el("title");
			g.appendChild(title);
			dom.g.appendChild(g);
			dom.statusBadge = { g, circle, text, title, badgeKey: null };
		}

		const side = node.layout!.side;
		const badgeX = side === "L" ? layout.w : 0;
		dom.statusBadge.g.setAttribute("transform", `translate(${badgeX}, -8)`);

		if (dom.statusBadge.badgeKey !== def.key) {
			if (dom.statusBadge.badgeKey) dom.statusBadge.g.classList.remove(`mm-status-badge-${dom.statusBadge.badgeKey}`);
			dom.statusBadge.g.classList.add(`mm-status-badge-${def.key}`);
			dom.statusBadge.badgeKey = def.key;
			dom.statusBadge.text.textContent = def.glyph;
			dom.statusBadge.title.textContent = def.label;
		}
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

	/** Comfortable screen-space padding (px) a just-created node should land within — F2/D4: pan only far enough to clear this margin, never re-center. Zoom-independent (screen px, not world px) since it's about visual/click comfort at the current zoom level, not a fixed world distance. */
	private static readonly ENSURE_VISIBLE_MARGIN = 60;

	/**
	 * F2 (D4 — minimal-pan, resolved decision, see DECISIONS.md): pans just
	 * far enough that `rect` (world-space) clears a comfortable margin
	 * inside the viewport — never recenters, and does nothing at all if
	 * `rect` already clears the margin on every side. Returns whether a pan
	 * happened, so "already visible -> no viewport change" is directly
	 * testable.
	 *
	 * Unlike `centerOnWorldPoint` and the drag/wheel pan handlers, this
	 * applies the transform and re-culls *synchronously* instead of via the
	 * rAF-batched `scheduleApplyViewport` — callers that need to
	 * immediately follow up with `getNodeScreenRect` (namely: positioning
	 * the inline editor right after creating an off-screen node, see
	 * `MindMapView.onEditRequest`) can't wait a frame for `recull()` to run
	 * and create the node's DOM element. This is a one-off programmatic
	 * pan, not a per-pointer-move gesture, so skipping the rAF batch here
	 * doesn't reopen the perf concern that batching solves for drag/wheel.
	 */
	ensureWorldRectVisible(rect: { x: number; y: number; w: number; h: number }): boolean {
		const w = this.container.clientWidth || 800;
		const h = this.container.clientHeight || 600;
		const margin = SvgRenderer.ENSURE_VISIBLE_MARGIN;

		const screenLeft = this.view.tx + rect.x * this.view.scale;
		const screenRight = this.view.tx + (rect.x + rect.w) * this.view.scale;
		const screenTop = this.view.ty + rect.y * this.view.scale;
		const screenBottom = this.view.ty + (rect.y + rect.h) * this.view.scale;

		let dx = 0;
		if (screenLeft < margin) dx = margin - screenLeft;
		else if (screenRight > w - margin) dx = w - margin - screenRight;

		let dy = 0;
		if (screenTop < margin) dy = margin - screenTop;
		else if (screenBottom > h - margin) dy = h - margin - screenBottom;

		if (dx === 0 && dy === 0) return false;

		this.view.tx += dx;
		this.view.ty += dy;
		this.viewportG.setAttribute("transform", `translate(${this.view.tx}, ${this.view.ty}) scale(${this.view.scale})`);
		this.recull();
		return true;
	}

	/**
	 * Additive pair (getViewport/setViewport) — the ONE intentional
	 * divergence of this file from the byte-identical reference port,
	 * user-authorized for M5 webview state persistence so a hidden->revealed
	 * reload can restore the exact pan/zoom (not just re-center on the
	 * selection). See DECISIONS.md's dated 2026-07-18 entry for the full
	 * authorization + maintenance note. Purely additive: no existing method's
	 * behavior changes, and `setViewport` reuses the exact same
	 * `scheduleApplyViewport` apply path every other pan/zoom mutation
	 * already uses (rAF-batched transform write + recull) rather than
	 * hand-rolling a second transform path.
	 *
	 * Returns a copy so a caller can't mutate the live `view` field through
	 * the returned object.
	 */
	getViewport(): Viewport {
		return { tx: this.view.tx, ty: this.view.ty, scale: this.view.scale };
	}

	setViewport(v: Viewport): void {
		this.view.tx = v.tx;
		this.view.ty = v.ty;
		this.view.scale = v.scale;
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
			// F3: once per applied frame, not per raw wheel/pointermove event —
			// keeps this on the same batched cadence as the transform write
			// itself. The callback (MindMapView) no-ops immediately when no
			// inline editor is open, so this is a no-cost call in the common case.
			this.onViewportChange?.();
		});
	};

	private onPointerDown = (evt: PointerEvent): void => {
		// Right-click (button 2) must never start a drag/resize/pan gesture
		// or call capturePointer — none of that had a button check before,
		// so a right-click's pointerdown was captured by this.svg like any
		// other, and that capture could retarget the mouse events Chromium
		// derives afterward (the same class of problem `resolveClickOrigin`
		// already works around for `click`/`dblclick`) — plausibly breaking
		// the `contextmenu` event that follows. Left (0) and middle (1,
		// used for pan — see the README) still fall through unchanged.
		if (evt.button === 2) return;
		const target = evt.target as Element;
		// Fold/cross-doc badges sit at the same node edge as the resize
		// handle (which spans the node's full height, while a badge is only
		// ~16px tall) and are themselves nested inside `.mm-node` — without
		// this early return, a click a few px off the badge's vertical
		// center hits the resize strip instead (an accidental width-resize
		// drag), and even a clean hit on the badge falls through to the
		// generic node-drag branch below, where a few px of hand jitter
		// between pointerdown/up gets misread as a drag/reorder instead of
		// a click, silently swallowing the fold-toggle click. Returning here
		// makes both badges a dead zone for drag/resize, so a click there
		// always reaches the plain `click` handler's badge logic.
		if (target.closest(".mm-fold-badge") || target.closest(".mm-cross-doc-badge")) return;
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
		const crossDocBadge = target.closest(".mm-cross-doc-badge");
		if (crossDocBadge) {
			const nodeG = crossDocBadge.closest(".mm-node") as SVGGElement | null;
			if (nodeG?.dataset.nodeId) this.onCrossDocBadgeClick?.(nodeG.dataset.nodeId);
			return;
		}
		const statusBadge = target.closest(".mm-status-badge");
		if (statusBadge) {
			const nodeG = statusBadge.closest(".mm-node") as SVGGElement | null;
			if (nodeG?.dataset.nodeId) this.onStatusBadgeClick?.(nodeG.dataset.nodeId);
			return;
		}
		const link = target.closest(".mm-node-link") as SVGElement | null;
		if (link?.dataset.linkKind && link.dataset.linkTarget) {
			if (evt.ctrlKey || evt.metaKey) {
				this.onLinkClick?.(link.dataset.linkKind as LinkKind, link.dataset.linkTarget);
				return;
			}
			// Plain click on link text: fall through to normal node
			// selection instead of navigating — a node whose text is (or
			// contains) a link was otherwise unselectable by clicking it,
			// since every click on the label immediately navigated away.
			// Mod+click is still the deliberate "open this link" gesture.
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

	/**
	 * Right-click (R-context-menu): `onPointerDown` now bails out entirely
	 * for button-2 pointerdowns (see there) before it ever calls
	 * `capturePointer`, which should make the retargeting `resolveClickOrigin`
	 * exists for a non-issue here. Still resolves via `resolveClickOrigin`
	 * rather than raw `evt.target` anyway, matching `onClick`'s established
	 * defensive pattern — cheap, and hedges against any other, unforeseen
	 * cause of the same retargeting symptom. The resize handle and both
	 * badges are excluded even though they're nested inside `.mm-node` (so a
	 * bare `closest(".mm-node")` would otherwise match them too) — the
	 * node's context menu is for the node itself, not its small edge
	 * controls; right-clicking one of those is a no-op rather than falling
	 * back to the OS/Electron native menu.
	 */
	private onContextMenu = (evt: MouseEvent): void => {
		const target = this.resolveClickOrigin(evt);
		if (!target) return;
		if (target.closest(".mm-resize-handle") || target.closest(".mm-fold-badge") || target.closest(".mm-cross-doc-badge")) {
			evt.preventDefault();
			return;
		}
		const nodeG = target.closest(".mm-node") as SVGGElement | null;
		const nodeId = nodeG?.dataset.nodeId;
		if (!nodeId) return;
		evt.preventDefault();
		this.onNodeContextMenu?.(nodeId, evt);
	};
}
