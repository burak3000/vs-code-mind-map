// @vitest-environment jsdom
//
// Smoke test only: catches crashes/structural regressions in the renderer.
// This is NOT visual verification — jsdom doesn't paint or lay out pixels,
// so colors/sizes/positions on screen must still be checked manually in
// the dev vault (see CLAUDE.md).
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { computeLayout, DEFAULT_LAYOUT_CONFIG, fontSizeForDepth, scaleForDepth } from "../webview/layout/layoutEngine";
import { assignMissingSides } from "../webview/layout/sides";
import { SvgRenderer } from "../webview/render/SvgRenderer";
import { InlineEditor } from "../webview/ui/InlineEditor";
import { buildModel, cleanupRenderers, mount, mountModel } from "./helpers/render";

afterEach(cleanupRenderers);

describe("SvgRenderer", () => {
	it("mount() creates one .mm-node per visible node and one .mm-edge per parent-child edge, and destroy() clears the DOM", () => {
		const { container, renderer } = mount(["# Root", "## Branch A", "- a", "  - a1", "## Branch B", "- b"].join("\n"));
		expect(container.querySelectorAll(".mm-node").length).toBe(6); // Root, Branch A, a, a1, Branch B, b
		expect(container.querySelectorAll(".mm-edge").length).toBe(5); // one per non-root node

		renderer.destroy();
		expect(container.childElementCount).toBe(0);
	});

	it("marks only the root node with mm-node-root (sub-topics render unboxed per CSS)", () => {
		const { model, container } = mount(["# Root", "## Branch A", "- a"].join("\n"));
		const rootG = container.querySelector(`[data-node-id="${model.root.id}"]`)!;
		const branchG = container.querySelector(`[data-node-id="${model.root.children[0].id}"]`)!;
		expect(rootG.classList.contains("mm-node-root")).toBe(true);
		expect(branchG.classList.contains("mm-node-root")).toBe(false);
	});

	it("renders each node's font-size strictly decreasing with depth, root largest (R15: visual hierarchy by size)", () => {
		const { model, container } = mount(["# Root", "## Branch A", "- a", "  - a1"].join("\n"), { mode: "right-only" });
		const fontSizeOf = (id: string) => Number(container.querySelector(`[data-node-id="${id}"] .mm-node-text`)!.getAttribute("font-size"));

		const branch = model.root.children[0];
		const a = branch.children[0];
		const a1 = a.children[0];
		const nodes = [model.root, branch, a, a1];
		const sizes = nodes.map((n) => fontSizeOf(n.id));

		expect(sizes[0]).toBe(DEFAULT_LAYOUT_CONFIG.rootFontSize);
		for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
		nodes.forEach((n, i) => expect(sizes[i]).toBe(fontSizeForDepth(n.depth, DEFAULT_LAYOUT_CONFIG))); // exact depth-based formula, not just "smaller"
	});

	it("wraps long text into multiple tspan lines and grows the rect height to match the layout box", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const model = buildModel(["# Root", `## ${longText}`].join("\n"), { mode: "right-only" });
		const branch = model.root.children[0];
		expect(branch.layout!.h).toBeGreaterThan(DEFAULT_LAYOUT_CONFIG.nodeHeight); // sanity: this node actually wrapped

		const { container } = mountModel(model);
		const textEl = container.querySelector(`[data-node-id="${branch.id}"] .mm-node-text`)!;
		const lineTspans = textEl.querySelectorAll(":scope > tspan");
		expect(lineTspans.length).toBeGreaterThan(1);
		expect(lineTspans[0].getAttribute("dy")).toBeNull(); // first line has no offset
		// depth 1, so scaled by that depth's font size (R15), not the raw baseline lineHeight.
		expect(lineTspans[1].getAttribute("dy")).toBe(String(DEFAULT_LAYOUT_CONFIG.lineHeight * scaleForDepth(1, DEFAULT_LAYOUT_CONFIG)));

		const rect = container.querySelector(`[data-node-id="${branch.id}"] .mm-node-rect`)!;
		expect(rect.getAttribute("height")).toBe(String(branch.layout!.h));
	});

	it("keeps a link clickable (Ctrl/Cmd+click) even when its label is split across two wrapped lines", () => {
		const md = ["# Root", "## start of a long line [[Some Note]] and then it keeps going past the wrap point for sure"].join("\n");
		let linkClicked: [string, string] | null = null;
		const { model, container } = mount(md, { mode: "right-only" }, (r) => r.setLinkClickHandler((kind, target) => (linkClicked = [kind, target])));
		const branch = model.root.children[0];

		const linkSpans = container.querySelectorAll(`[data-node-id="${branch.id}"] .mm-node-link`);
		expect(linkSpans.length).toBeGreaterThan(0);
		linkSpans[0].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
		expect(linkClicked).toEqual(["wikilink", "Some Note"]);
	});

	describe("image embeds (plan item 07)", () => {
		it("creates a placeholder + image element only for a node with an image embed, sets href from the resolver", () => {
			const md = ["# Root", "## Branch A ![[photo.png]]", "## Branch B"].join("\n");
			const { model, container } = mount(md, { mode: "right-only" }, (r) => r.setImageResolver(() => "resource://photo.png"));
			const [a, b] = model.root.children;

			const aImage = container.querySelector(`[data-node-id="${a.id}"] .mm-node-image`);
			expect(aImage).not.toBeNull();
			expect(aImage?.getAttribute("href")).toBe("resource://photo.png");
			expect(container.querySelector(`[data-node-id="${a.id}"] .mm-image-placeholder`)).not.toBeNull();
			// No embed on Branch B -> no image DOM at all, not just an unset href.
			expect(container.querySelector(`[data-node-id="${b.id}"] .mm-node-image`)).toBeNull();
		});

		it("no resolver (or a resolver returning null) leaves href unset — placeholder/missing-glyph still shows via CSS", () => {
			const { model, container } = mount(["# Root", "## Branch A ![[photo.png]]"].join("\n"), { mode: "right-only" });
			const a = model.root.children[0];
			const image = container.querySelector(`[data-node-id="${a.id}"] .mm-node-image`);
			expect(image).not.toBeNull();
			expect(image?.hasAttribute("href")).toBe(false);
		});

		it("clicking the thumbnail fires the image click handler (not the node click handler), with the embed's kind/target", () => {
			const md = ["# Root", "## Branch A ![[photo.png]]"].join("\n");
			let imageClicked: [string, string] | null = null;
			let nodeClicked = false;
			const { model, container } = mount(md, { mode: "right-only" }, (r) => {
				r.setImageResolver(() => "resource://photo.png");
				r.setImageClickHandler((kind, target) => (imageClicked = [kind, target]));
				r.setNodeClickHandler(() => (nodeClicked = true));
			});
			const a = model.root.children[0];

			container.querySelector(`[data-node-id="${a.id}"] .mm-node-image`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(imageClicked).toEqual(["wikilink", "photo.png"]);
			expect(nodeClicked).toBe(false);
		});

		it("removing the embed from a node's text removes its image DOM on the next update", () => {
			const md = ["# Root", "## Branch A ![[photo.png]]"].join("\n");
			const { model, container, renderer } = mount(md, { mode: "right-only" }, (r) => r.setImageResolver(() => "resource://photo.png"));
			const a = model.root.children[0];
			expect(container.querySelector(`[data-node-id="${a.id}"] .mm-node-image`)).not.toBeNull();

			a.text = "Branch A"; // embed removed
			computeLayout(model.root, { ...DEFAULT_LAYOUT_CONFIG, mode: "right-only" });
			renderer.update(model);

			expect(container.querySelector(`[data-node-id="${a.id}"] .mm-node-image`)).toBeNull();
		});
	});

	it("renders each edge as a filled ribbon that tapers continuously from the parent's branch width to the child's, not a constant-width stroke", () => {
		// Higher-fidelity version of R10: a single connector narrows continuously
		// along its own length, not just level-to-level (see DECISIONS.md).
		const { model, container } = mount(["# Root", "## Branch A", "- a"].join("\n"), { mode: "right-only" });
		const branch = model.root.children[0]; // depth 1, parent = root (depth 0)
		const a = branch.children[0]; // depth 2, parent = branch (depth 1)

		// No stroke is used at all — width comes entirely from fill geometry.
		expect(container.querySelectorAll(".mm-edge")[0].getAttribute("stroke-width")).toBeNull();

		const widthsOf = (d: string): { start: number; end: number } => {
			const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
			const points: [number, number][] = [];
			for (let i = 0; i < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
			const dist = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
			const n = (points.length - 2) / 2; // top row length - 1 (== TAPER_SAMPLES)
			return { start: dist(points[0], points[points.length - 1]), end: dist(points[n], points[n + 1]) };
		};

		const branchWidths = widthsOf(container.querySelector(`[data-child-id="${branch.id}"]`)!.getAttribute("d")!);
		const aWidths = widthsOf(container.querySelector(`[data-child-id="${a.id}"]`)!.getAttribute("d")!);

		expect(branchWidths.start).toBeGreaterThan(branchWidths.end); // Root -> Branch A narrows from depth-0 to depth-1 width
		expect(aWidths.start).toBeCloseTo(branchWidths.end, 1); // Branch A -> a continues narrowing, starting where the previous edge left off
		expect(aWidths.end).toBeLessThan(aWidths.start);
	});

	it("ends an edge at the child's near edge (short hop, not stretched across its whole box) and anchors the child's text right next to that tip", () => {
		// A stretched-to-far-edge version made long/wrapped boxes produce a long
		// diagonal edge that crossed other nodes' text; the edge stays short and
		// the text instead grows away from that same tip (see DECISIONS.md).
		const { model, container } = mount(["# Root", "## Branch A"].join("\n"), { mode: "right-only" });
		const branch = model.root.children[0];

		const midpointX = (d: string): number => {
			const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
			const points: [number, number][] = [];
			for (let i = 0; i < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
			const n = (points.length - 2) / 2; // index of the last centerline sample (top row)
			return (points[n][0] + points[n + 1][0]) / 2; // average of the two far-end offset points = the centerline's endpoint x
		};

		const branchEdgeD = container.querySelector(`[data-child-id="${branch.id}"]`)!.getAttribute("d")!;
		expect(midpointX(branchEdgeD)).toBeCloseTo(branch.layout!.x, 1); // ends at the near edge, not the far edge

		const textEl = container.querySelector(`[data-node-id="${branch.id}"] .mm-node-text`)!;
		expect(textEl.getAttribute("text-anchor")).toBe("start"); // right-side node: text grows away from that near-edge tip
		expect(Number(textEl.getAttribute("x"))).toBeLessThan(branch.layout!.w / 2);
	});

	it("anchors a left-side node's text at its near (right) edge, growing leftward away from it", () => {
		const { model, container } = mount(["# Root", "## Branch A"].join("\n"), { mode: "left-only" });
		const branch = model.root.children[0];
		const textEl = container.querySelector(`[data-node-id="${branch.id}"] .mm-node-text`)!;
		expect(textEl.getAttribute("text-anchor")).toBe("end");
		expect(Number(textEl.getAttribute("x"))).toBeGreaterThan(branch.layout!.w / 2);
	});

	it("keeps the root's text centered in its own (visible) box, unlike sub-topics", () => {
		const { model, container } = mount(["# Root", "## Branch A"].join("\n"));
		const rootText = container.querySelector(`[data-node-id="${model.root.id}"] .mm-node-text`)!;
		expect(rootText.getAttribute("text-anchor")).toBe("middle");
		expect(Number(rootText.getAttribute("x"))).toBeCloseTo(model.root.layout!.w / 2, 1);
	});

	it("excludes folded subtrees from the rendered DOM", () => {
		const model = parseMindMap(["# Root", "## Branch A", "- a", "  - a1"].join("\n"), "fallback");
		model.root.children[0].folded = true;
		computeLayout(model.root);
		const { container } = mountModel(model);
		expect(container.querySelectorAll(".mm-node").length).toBe(2); // Root + Branch A only; "a"/"a1" hidden by folding
	});

	it("selectNode toggles the mm-selected class without touching other nodes", () => {
		const { model, container, renderer } = mount(["# Root", "## Branch A"].join("\n"));
		const branchId = model.root.children[0].id;

		renderer.selectNode(branchId);
		expect(container.querySelector(`[data-node-id="${branchId}"]`)?.classList.contains("mm-selected")).toBe(true);

		renderer.selectNode(null);
		expect(container.querySelector(`[data-node-id="${branchId}"]`)?.classList.contains("mm-selected")).toBe(false);
	});

	it("setSelection (R-multi-select) restyles only the symmetric difference between the old and new selection", () => {
		const { model, container, renderer } = mount(["# Root", "## A", "## B", "## C"].join("\n"));
		const [a, b, c] = model.root.children;
		const classesOf = (id: string) => Array.from(container.querySelector(`[data-node-id="${id}"]`)?.classList ?? []);

		renderer.setSelection(new Set([a.id, b.id]), b.id);
		expect(classesOf(a.id)).toContain("mm-selected");
		expect(classesOf(a.id)).not.toContain("mm-selected-primary");
		expect(classesOf(b.id)).toContain("mm-selected");
		expect(classesOf(b.id)).toContain("mm-selected-primary");
		expect(classesOf(c.id)).not.toContain("mm-selected");

		// A now moving out, C now moving in, B staying selected but losing primary to C.
		renderer.setSelection(new Set([b.id, c.id]), c.id);
		expect(classesOf(a.id)).not.toContain("mm-selected");
		expect(classesOf(b.id)).toContain("mm-selected");
		expect(classesOf(b.id)).not.toContain("mm-selected-primary");
		expect(classesOf(c.id)).toContain("mm-selected");
		expect(classesOf(c.id)).toContain("mm-selected-primary");
	});

	it("update() adds new nodes and edges without recreating unchanged ones", () => {
		const { model, container, renderer } = mount(["# Root", "## Branch A"].join("\n"));
		const branchGBefore = container.querySelector(`[data-node-id="${model.root.children[0].id}"]`);

		// Simulate a Tab: add a new child under Branch A, relayout, update.
		const branch = model.root.children[0];
		branch.children.push({ id: "new1", text: "New child", children: [], parent: branch, depth: 2, folded: false, subtreeCount: 0 });
		model.byId.set("new1", branch.children[0]);
		branch.subtreeCount += 1;
		model.root.subtreeCount += 1;
		computeLayout(model.root);
		renderer.update(model);

		expect(container.querySelectorAll(".mm-node").length).toBe(3);
		expect(container.querySelectorAll(".mm-edge").length).toBe(2);
		const branchGAfter = container.querySelector(`[data-node-id="${model.root.children[0].id}"]`);
		expect(branchGAfter).toBe(branchGBefore); // Branch A's own DOM element identity is preserved across the update
	});

	it("update() removes DOM for nodes that are deleted from the model", () => {
		const { model, container, renderer } = mount(["# Root", "## Branch A", "- a"].join("\n"));
		expect(container.querySelectorAll(".mm-node").length).toBe(3);

		const branch = model.root.children[0];
		branch.children = [];
		model.byId.delete(branch.children[0]?.id ?? "");
		branch.subtreeCount = 0;
		model.root.subtreeCount = 1;
		computeLayout(model.root);
		renderer.update(model);

		expect(container.querySelectorAll(".mm-node").length).toBe(2);
		expect(container.querySelectorAll(".mm-edge").length).toBe(1);
	});

	describe("fold badge", () => {
		function badgeTranslateX(container: HTMLElement, nodeId: string): number {
			const g = container.querySelector(`[data-node-id="${nodeId}"] .mm-fold-badge`)!;
			const match = /translate\(\s*(-?[\d.]+)/.exec(g.getAttribute("transform") ?? "");
			return match ? Number(match[1]) : NaN;
		}

		it("shows a fold-count badge with the cached subtreeCount when folded, and switches to a plain collapse dot on unfold", () => {
			const model = parseMindMap(["# Root", "## Branch A", "- a", "  - a1", "  - a2"].join("\n"), "fallback");
			const branch = model.root.children[0];
			branch.folded = true;
			computeLayout(model.root);
			const { container, renderer } = mountModel(model);

			const branchG = container.querySelector(`[data-node-id="${branch.id}"]`)!;
			const badge = branchG.querySelector(".mm-fold-badge");
			expect(badge).not.toBeNull();
			expect(badge!.classList.contains("mm-fold-badge-folded")).toBe(true);
			expect(badge!.querySelector("text")!.textContent).toBe(String(branch.subtreeCount)); // 3: a, a1, a2

			branch.folded = false;
			computeLayout(model.root);
			renderer.update(model);
			const collapseDot = branchG.querySelector(".mm-fold-badge"); // affordance stays (still has children), just no count
			expect(collapseDot).not.toBeNull();
			expect(collapseDot!.classList.contains("mm-fold-badge-folded")).toBe(false);
			expect(collapseDot!.querySelector("text")!.textContent).toBe("–");
		});

		it("shows a plain collapse dot (no count) on an unfolded node with children", () => {
			const { model, container } = mount(["# Root", "## Branch A", "- a"].join("\n"));
			const badge = container.querySelector(`[data-node-id="${model.root.children[0].id}"] .mm-fold-badge`);
			expect(badge).not.toBeNull();
			expect(badge!.classList.contains("mm-fold-badge-folded")).toBe(false);
			expect(badge!.querySelector("text")!.textContent).toBe("–");
		});

		it("does not show a fold affordance on a childless node, folded or not", () => {
			const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
			const branch = model.root.children[0];
			branch.folded = true; // folded but childless — nothing to hide, nothing to badge
			computeLayout(model.root);
			const { container } = mountModel(model);
			expect(container.querySelector(`[data-node-id="${branch.id}"] .mm-fold-badge`)).toBeNull();
		});

		it("has an enlarged invisible hit-target circle in front of its visible circle, making the small badge easier to hit precisely", () => {
			const model = parseMindMap(["# Root", "## Branch A", "- a"].join("\n"), "fallback");
			const branch = model.root.children[0];
			branch.folded = true;
			computeLayout(model.root);
			const { container } = mountModel(model);

			const circles = container.querySelectorAll(`[data-node-id="${branch.id}"] .mm-fold-badge circle`);
			expect(circles.length).toBe(2);
			const [hitCircle, visibleCircle] = Array.from(circles);
			expect(Number(hitCircle.getAttribute("r"))).toBeGreaterThan(Number(visibleCircle.getAttribute("r")));
			expect(hitCircle.getAttribute("fill")).toBe("transparent"); // not "none" — "none" isn't hit-testable at all
		});

		it("orientation-aware: sits beside the resize handle (not on top of it), on the outward side matching the branch's L/R side", () => {
			// "balanced" layout puts one first-level branch on each side (R11) —
			// gives both a left- and right-side node from one mount.
			const model = parseMindMap(["# Root", "## Branch A", "- a", "## Branch B", "- b"].join("\n"), "fallback");
			assignMissingSides(model.root);
			computeLayout(model.root, DEFAULT_LAYOUT_CONFIG);
			const left = model.root.children.find((n) => n.layout!.side === "L")!;
			const right = model.root.children.find((n) => n.layout!.side === "R")!;
			expect(left).toBeDefined();
			expect(right).toBeDefined();
			const { container } = mountModel(model);

			// Resize handle occupies local x in [-3, 3] (L side) / [w-3, w+3] (R
			// side). The badge's hit-circle (r=13) must touch that column's outer
			// edge exactly — any gap is unpainted canvas a right-click could land
			// in and miss .mm-node entirely (see DECISIONS.md).
			expect(badgeTranslateX(container, left.id)).toBeLessThanOrEqual(-3 - 13);
			expect(badgeTranslateX(container, right.id)).toBeGreaterThanOrEqual(right.layout!.w + 3 + 13);
		});

		it("regression: no dead-space gap between the resize handle and the fold badge (a gap there is a click that could miss .mm-node)", () => {
			const { model, container } = mount(["# Root", "## Branch A", "- a"].join("\n"), { mode: "right-only" });
			const branch = model.root.children[0];

			const handle = container.querySelector(`[data-node-id="${branch.id}"] .mm-resize-handle`)!;
			const handleOuterEdge = Number(handle.getAttribute("x")) + Number(handle.getAttribute("width")); // right-side node: handle's far edge from the box

			const badgeX = badgeTranslateX(container, branch.id);
			const hitCircle = container.querySelector(`[data-node-id="${branch.id}"] .mm-fold-badge circle`)!;
			const hitCircleNearEdge = badgeX - Number(hitCircle.getAttribute("r"));

			expect(hitCircleNearEdge).toBeCloseTo(handleOuterEdge, 6); // touching exactly (modulo float noise), not overlapping or gapped
		});

		it("clicking a fold badge invokes the badge click handler with that node's id, not the node click handler", () => {
			const model = parseMindMap(["# Root", "## Branch A", "- a"].join("\n"), "fallback");
			const branch = model.root.children[0];
			branch.folded = true;
			computeLayout(model.root);
			let badgeClickedId: string | null = null;
			let nodeClickedId: string | null = null;
			const { container } = mountModel(model, (r) => {
				r.setBadgeClickHandler((id) => (badgeClickedId = id));
				r.setNodeClickHandler((id) => (nodeClickedId = id));
			});

			container.querySelector(`[data-node-id="${branch.id}"] .mm-fold-badge circle`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(badgeClickedId).toBe(branch.id);
			expect(nodeClickedId).toBeNull();
		});

		it("a real pointerdown/move/up/click sequence (with a few px of hand jitter) still toggles fold, not a reorder-drag", () => {
			// Regression: unlike the resize handle, onPointerDown had no special
			// case for the fold badge, so a few px of jitter between down/up got
			// misread as a drag/reorder attempt, silently swallowing the toggle.
			// A bare "click" event (see test above) can't catch this — this
			// drives the real pointerdown -> move -> up -> click sequence.
			const model = parseMindMap(["# Root", "## Branch A", "- a", "## Branch B"].join("\n"), "fallback");
			const branch = model.root.children[0];
			branch.folded = true;
			computeLayout(model.root);
			let badgeClickedId: string | null = null;
			let reordered = false;
			const { container } = mountModel(model, (r) => {
				r.setBadgeClickHandler((id) => (badgeClickedId = id));
				r.setReorderHandler(() => (reordered = true));
			});

			const badge = container.querySelector(`[data-node-id="${branch.id}"] .mm-fold-badge circle`)!;
			const svg = container.querySelector(".mm-svg")!;
			badge.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 106, clientY: 104, pointerId: 1 })); // >3px jitter
			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 106, clientY: 104, pointerId: 1 }));
			badge.dispatchEvent(new MouseEvent("click", { bubbles: true })); // the native click a real pointerdown/up pair still fires

			expect(reordered).toBe(false);
			expect(badgeClickedId).toBe(branch.id);
		});
	});

	it("the node's context menu opens on the node body (box/text) but NOT on its fold badge or resize handle — those are separate controls", () => {
		const { model, container } = mount(["# Root", "## Branch A", "- a"].join("\n"), { mode: "right-only" }, (r) => r.setNodeContextMenuHandler((id) => (menuNodeId = id)));
		let menuNodeId: string | null = null;
		const branch = model.root.children[0];

		container.querySelector(`[data-node-id="${branch.id}"] .mm-fold-badge circle`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		expect(menuNodeId).toBeNull();

		container.querySelector(`[data-node-id="${branch.id}"] .mm-resize-handle`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		expect(menuNodeId).toBeNull();

		container.querySelector(`[data-node-id="${branch.id}"] rect:not(.mm-resize-handle)`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		expect(menuNodeId).toBe(branch.id);
	});

	describe("clicks vs. double-clicks", () => {
		it("two quick clicks on the same node trigger the dblclick handler, not a second single-click", () => {
			// dblclick is detected from plain `click` events, not the native
			// browser dblclick — pointer capture during drag can retarget the
			// native event to the capturing <svg>, breaking closest(".mm-node").
			const clickIds: string[] = [];
			const dblClickIds: string[] = [];
			const { model, container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) => {
				r.setNodeClickHandler((id) => clickIds.push(id));
				r.setNodeDblClickHandler((id) => dblClickIds.push(id));
			});
			const branch = model.root.children[0];
			const nodeG = container.querySelector(`[data-node-id="${branch.id}"]`)!;
			nodeG.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			nodeG.dispatchEvent(new MouseEvent("click", { bubbles: true }));

			expect(clickIds).toEqual([branch.id]); // first click only
			expect(dblClickIds).toEqual([branch.id]); // second click promoted to dblclick
		});

		it("two clicks on different nodes do not trigger dblclick", () => {
			const dblClickIds: string[] = [];
			const { model, container } = mount(["# Root", "## Branch A", "## Branch B"].join("\n"), undefined, (r) => {
				r.setNodeClickHandler(() => {});
				r.setNodeDblClickHandler((id) => dblClickIds.push(id));
			});
			const [a, b] = model.root.children;
			container.querySelector(`[data-node-id="${a.id}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			container.querySelector(`[data-node-id="${b.id}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(dblClickIds).toEqual([]);
		});

		it("a third click after a double-click starts fresh instead of firing dblclick again", () => {
			const dblClickIds: string[] = [];
			const { model, container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) => {
				r.setNodeClickHandler(() => {});
				r.setNodeDblClickHandler((id) => dblClickIds.push(id));
			});
			const branch = model.root.children[0];
			const nodeG = container.querySelector(`[data-node-id="${branch.id}"]`)!;
			nodeG.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			nodeG.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			nodeG.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(dblClickIds).toEqual([branch.id]); // only once, not on every subsequent click
		});
	});

	it("toggles the mm-animated class based on the visible-node-count threshold", () => {
		const { container } = mount(["# Root", "## Branch A"].join("\n"));
		expect(container.querySelector(".mm-svg")!.classList.contains("mm-animated")).toBe(true);
	});

	describe("node text links", () => {
		it("renders a link as a separate clickable tspan; Ctrl/Cmd+click routes to the link handler, not node select", () => {
			let linkClicked: [string, string] | null = null;
			let nodeClicked: string | null = null;
			const { model, container } = mount(["# Root", "## Check [[Some Note]] please"].join("\n"), undefined, (r) => {
				r.setLinkClickHandler((kind, target) => (linkClicked = [kind, target]));
				r.setNodeClickHandler((id) => (nodeClicked = id));
			});
			const branch = model.root.children[0];
			const linkSpan = container.querySelector(`[data-node-id="${branch.id}"] .mm-node-link`)!;
			expect(linkSpan.textContent).toBe("Some Note");

			linkSpan.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
			expect(linkClicked).toEqual(["wikilink", "Some Note"]);
			expect(nodeClicked).toBeNull();
		});

		it("a plain (non-modifier) click on link text selects the node instead of navigating — a link-text node must stay selectable", () => {
			let linkClicked: [string, string] | null = null;
			let nodeClicked: string | null = null;
			const { model, container } = mount(["# Root", "## Check [[Some Note]] please"].join("\n"), undefined, (r) => {
				r.setLinkClickHandler((kind, target) => (linkClicked = [kind, target]));
				r.setNodeClickHandler((id) => (nodeClicked = id));
			});
			const branch = model.root.children[0];
			container.querySelector(`[data-node-id="${branch.id}"] .mm-node-link`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(nodeClicked).toBe(branch.id);
			expect(linkClicked).toBeNull();
		});

		it("renders plain node text without any tspan wrapper when there is no link", () => {
			const { model, container } = mount(["# Root", "## Plain branch"].join("\n"));
			const textEl = container.querySelector(`[data-node-id="${model.root.children[0].id}"] .mm-node-text`)!;
			expect(textEl.querySelector("tspan")).toBeNull();
			expect(textEl.textContent).toBe("Plain branch");
		});
	});

	it("regression: a right-click (button 2) pointerdown never starts a drag/resize/pan gesture, even with real movement before pointerup", () => {
		// Previously every pointerdown was treated like a left-click (no button
		// check), so capturePointer could retarget the synthesized contextmenu
		// event and break the node context menu.
		let moved = false;
		let resized = false;
		let reordered = false;
		const { model, container } = mount(["# Root", "## Branch A"].join("\n"), { mode: "right-only" }, (r) => {
			r.setManualMoveHandler(() => (moved = true));
			r.setManualWidthHandler(() => (resized = true));
			r.setReorderHandler(() => (reordered = true));
		});
		const branch = model.root.children[0];
		const nodeG = container.querySelector(`[data-node-id="${branch.id}"]`)!;
		nodeG.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2, altKey: true, clientX: 100, clientY: 100, pointerId: 1 }));
		const svg = container.querySelector(".mm-svg")!;
		svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 2, altKey: true, clientX: 200, clientY: 200, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 2, altKey: true, clientX: 200, clientY: 200, pointerId: 1 }));

		expect(moved).toBe(false);
		expect(resized).toBe(false);
		expect(reordered).toBe(false);
	});

	describe("drag interactions", () => {
		it("Alt+drag reports a manual-move with the position offset by the drag delta (scaled)", () => {
			const model = buildModel(["# Root", "## Branch A"].join("\n"));
			const branch = model.root.children[0];
			const startX = branch.layout!.x;
			const startY = branch.layout!.y;

			let moved: { nodeId: string; pos: { x: number; y: number } } | null = null;
			const { container } = mountModel(model, (r) => r.setManualMoveHandler((nodeId, pos) => (moved = { nodeId, pos })));

			const nodeG = container.querySelector(`[data-node-id="${branch.id}"]`)!;
			nodeG.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, altKey: true, clientX: 100, clientY: 100, pointerId: 1 }));
			const svg = container.querySelector(".mm-svg")!;
			svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, altKey: true, clientX: 140, clientY: 130, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, altKey: true, clientX: 140, clientY: 130, pointerId: 1 }));

			expect(moved).not.toBeNull();
			expect(moved!.nodeId).toBe(branch.id);
			// scale is 1 at mount time, so the offset is the raw client delta.
			expect(moved!.pos.x).toBeCloseTo(startX + 40);
			expect(moved!.pos.y).toBeCloseTo(startY + 30);
		});

		it("dragging a node's resize handle reports the final width, growing outward from the parent (right side)", () => {
			const model = buildModel(["# Root", "## Branch A"].join("\n"), { mode: "right-only" });
			const branch = model.root.children[0];
			const startWidth = branch.layout!.w;

			let resized: { nodeId: string; width: number } | null = null;
			const { container } = mountModel(model, (r) => r.setManualWidthHandler((nodeId, width) => (resized = { nodeId, width })));

			const handle = container.querySelector(`[data-node-id="${branch.id}"] .mm-resize-handle`)!;
			handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }));
			const svg = container.querySelector(".mm-svg")!;
			svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 140, clientY: 100, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 140, clientY: 100, pointerId: 1 }));

			expect(resized).not.toBeNull();
			expect(resized!.nodeId).toBe(branch.id);
			expect(resized!.width).toBeCloseTo(startWidth + 40);
		});

		it("a resize-handle drag below the movement threshold does not report a width change", () => {
			let resized = false;
			const { model, container } = mount(["# Root", "## Branch A"].join("\n"), { mode: "right-only" }, (r) => r.setManualWidthHandler(() => (resized = true)));
			const branch = model.root.children[0];
			const handle = container.querySelector(`[data-node-id="${branch.id}"] .mm-resize-handle`)!;
			handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }));
			container.querySelector(".mm-svg")!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 101, clientY: 100, pointerId: 1 }));
			expect(resized).toBe(false);
		});

		it("a small pointer movement below the drag threshold does not trigger a manual move", () => {
			let moved = false;
			const { model, container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) => r.setManualMoveHandler(() => (moved = true)));
			const branch = model.root.children[0];
			const nodeG = container.querySelector(`[data-node-id="${branch.id}"]`)!;
			nodeG.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, altKey: true, clientX: 100, clientY: 100, pointerId: 1 }));
			container.querySelector(".mm-svg")!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, altKey: true, clientX: 101, clientY: 101, pointerId: 1 }));
			expect(moved).toBe(false);
		});

		it("a plain (non-Alt) drag that ends over no hit-testable target does not throw or call the reorder handler", () => {
			// jsdom has no real layout, so elementsFromPoint can't resolve a drop
			// target — this only confirms the code path is safe; real drop
			// behavior needs a manual check in the dev vault (see CLAUDE.md).
			let reordered = false;
			const { model, container } = mount(["# Root", "## Branch A", "## Branch B"].join("\n"), undefined, (r) => r.setReorderHandler(() => (reordered = true)));
			const branch = model.root.children[0];
			const nodeG = container.querySelector(`[data-node-id="${branch.id}"]`)!;
			expect(() => {
				nodeG.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }));
				const svg = container.querySelector(".mm-svg")!;
				svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 150, clientY: 150, pointerId: 1 }));
				svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 150, clientY: 150, pointerId: 1 }));
			}).not.toThrow();
			expect(reordered).toBe(false);
		});
	});

	describe("background click (deselect)", () => {
		it("clicking empty canvas fires the background-click handler", () => {
			let backgroundClicked = false;
			const { container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) => r.setBackgroundClickHandler(() => (backgroundClicked = true)));
			container.querySelector(".mm-svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(backgroundClicked).toBe(true);
		});

		it("clicking a node does not fire the background-click handler", () => {
			let backgroundClicked = false;
			const { model, container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) => r.setBackgroundClickHandler(() => (backgroundClicked = true)));
			const branch = model.root.children[0];
			container.querySelector(`[data-node-id="${branch.id}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(backgroundClicked).toBe(false);
		});

		it("does not fire for the click that follows a real pan drag, but does fire on a genuine follow-up click", () => {
			// The native `click` event still fires after a pointerdown/up pair on
			// empty canvas even when the pointer moved a lot in between (a pan,
			// not a click) — without suppression this would clear the selection
			// on every pan. Suppression is one-shot.
			let backgroundClicked = false;
			const { container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) => r.setBackgroundClickHandler(() => (backgroundClicked = true)));
			const svg = container.querySelector(".mm-svg")!;
			svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 250, clientY: 250, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 250, clientY: 250, pointerId: 1 }));
			svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(backgroundClicked).toBe(false);

			svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(backgroundClicked).toBe(true);
		});

		it("a small pointer movement below the pan threshold still counts as a click, not a suppressed pan", () => {
			let backgroundClicked = false;
			const { container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) => r.setBackgroundClickHandler(() => (backgroundClicked = true)));
			const svg = container.querySelector(".mm-svg")!;
			svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 101, clientY: 100, pointerId: 1 }));
			svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(backgroundClicked).toBe(true);
		});
	});

	describe("same-level drag-reorder (before/after vs. nest-inside)", () => {
		// jsdom doesn't lay elements out, so elementsFromPoint/getBoundingClientRect
		// normally report nothing useful — stub both, scoped to one target node,
		// to drive the renderer's hit-testing and quarter-vs-middle math.
		function mockDropTarget(container: HTMLElement, targetId: string, box: { top: number; height: number }): void {
			const nodeG = container.querySelector(`[data-node-id="${targetId}"]`) as SVGGElement;
			const rectEl = container.querySelector(`[data-node-id="${targetId}"] .mm-node-rect`) as SVGRectElement;
			rectEl.getBoundingClientRect = () =>
				({ left: 0, right: 100, width: 100, top: box.top, bottom: box.top + box.height, height: box.height, x: 0, y: box.top, toJSON() {} }) as DOMRect;
			(document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [nodeG];
		}

		afterEach(() => {
			delete (document as Partial<Document>).elementsFromPoint;
		});

		function dragAcross(container: HTMLElement, sourceId: string, dropY: number): void {
			const nodeG = container.querySelector(`[data-node-id="${sourceId}"]`)!;
			const svg = container.querySelector(".mm-svg")!;
			nodeG.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 50, clientY: dropY, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 50, clientY: dropY, pointerId: 1 }));
		}

		it.each([
			["top quarter", 105, "before"],
			["bottom quarter", 135, "after"],
			["middle half", 120, "inside"],
		] as const)("dropping in a sibling's %s reorders %s it", (_label, dropY, expected) => {
			const calls: Array<[string, string, string]> = [];
			const { model, container } = mount(["# Root", "## Branch A", "## Branch B"].join("\n"), undefined, (r) =>
				r.setReorderHandler((id, targetId, position) => calls.push([id, targetId, position])),
			);
			const [branchA, branchB] = model.root.children;
			mockDropTarget(container, branchB.id, { top: 100, height: 40 });

			dragAcross(container, branchA.id, dropY);
			expect(calls).toEqual([[branchA.id, branchB.id, expected]]);
		});

		it("shows the insertion-line indicator while hovering a before/after zone, and hides it (and the drop-target highlight) once the drag ends", () => {
			const { model, container } = mount(["# Root", "## Branch A", "## Branch B"].join("\n"), undefined, (r) => r.setReorderHandler(() => {}));
			const [branchA, branchB] = model.root.children;
			mockDropTarget(container, branchB.id, { top: 100, height: 40 });

			const nodeG = container.querySelector(`[data-node-id="${branchA.id}"]`)!;
			const svg = container.querySelector(".mm-svg")!;
			const indicator = container.querySelector(".mm-drop-indicator") as SVGLineElement;
			expect(indicator.style.display).toBe("none");

			nodeG.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 50, clientY: 105, pointerId: 1 }));
			expect(indicator.style.display).not.toBe("none");
			expect(indicator.getAttribute("y1")).toBe(indicator.getAttribute("y2"));
			const branchBNode = container.querySelector(`[data-node-id="${branchB.id}"]`)!;
			expect(branchBNode.classList.contains("mm-drop-target")).toBe(false); // "before" is a sibling reorder, not a nest — no nest highlight

			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 50, clientY: 105, pointerId: 1 }));
			expect(indicator.style.display).toBe("none");
			expect(branchBNode.classList.contains("mm-drop-target")).toBe(false);
		});

		it("falls back to nest-inside when the drop target is the root, regardless of vertical position", () => {
			const calls: Array<[string, string, string]> = [];
			const { model, container } = mount(["# Root", "## Branch A"].join("\n"), undefined, (r) =>
				r.setReorderHandler((id, targetId, position) => calls.push([id, targetId, position])),
			);
			const branchA = model.root.children[0];
			mockDropTarget(container, model.root.id, { top: 100, height: 40 });

			dragAcross(container, branchA.id, 105);
			expect(calls).toEqual([[branchA.id, model.root.id, "inside"]]);
		});
	});

	it("getNodeScreenRect is relative to the container, not the viewport (regression: inline editor landed in the wrong place when the container wasn't at the page origin)", () => {
		const model = buildModel(["# Root", "## Branch A"].join("\n"));
		const branch = model.root.children[0];

		const container = document.createElement("div");
		// Simulate the container sitting far from the page/viewport origin, e.g.
		// inside an Obsidian pane that isn't flush with (0,0).
		container.getBoundingClientRect = () => ({ left: 300, top: 500, right: 1100, bottom: 1100, width: 800, height: 600, x: 300, y: 500, toJSON() {} });
		const renderer = new SvgRenderer(container);
		renderer.mount(model);
		const svg = container.querySelector(".mm-svg") as SVGSVGElement;
		svg.getBoundingClientRect = () => container.getBoundingClientRect(); // svg fills the container exactly, so it reports the same rect

		const rect = renderer.getNodeScreenRect(branch.id)!;
		expect(rect).not.toBeNull();
		// Must NOT include the container's page offset (300, 500) — meant for
		// `position: absolute` inside the container, not `position: fixed`.
		expect(rect.left).toBeLessThan(300);
		expect(rect.top).toBeLessThan(500);
		renderer.destroy();
	});

	describe("wheel: pan vs. zoom", () => {
		it("ctrlKey (trackpad pinch) zooms around the cursor instead of panning", async () => {
			const { container } = mount(["# Root", "## Branch A"].join("\n"));
			const svg = container.querySelector(".mm-svg")!;
			const viewport = container.querySelector(".mm-viewport")!;

			svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 50, bubbles: true, cancelable: true }));
			await new Promise((r) => requestAnimationFrame(r));

			expect(viewport.getAttribute("transform")).toContain("scale(1.1"); // deltaY < 0 zooms in: scale grows from the initial 1
		});

		it("no ctrlKey (two-finger swipe) pans and never changes scale", async () => {
			const { container } = mount(["# Root", "## Branch A"].join("\n"));
			const svg = container.querySelector(".mm-svg")!;
			const viewport = container.querySelector(".mm-viewport")!;
			const before = viewport.getAttribute("transform")!;

			svg.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 40, ctrlKey: false, clientX: 50, clientY: 50, bubbles: true, cancelable: true }));
			await new Promise((r) => requestAnimationFrame(r));

			const after = viewport.getAttribute("transform")!;
			expect(after).not.toBe(before);
			expect(after).toContain("scale(1)"); // unchanged — panned, not zoomed
			// tx/ty shift by -deltaX/-deltaY: container defaults to 0-width in jsdom, so tx/ty start at 0.
			expect(after).toContain("translate(-30, -40)");
		});
	});

	// F3: SvgRenderer's viewport-change hook is what MindMapView subscribes to
	// so an open inline editor can track its node during pan/zoom. MindMapView
	// itself needs the real Obsidian API and isn't unit-instantiable, so these
	// mirror its wiring directly against SvgRenderer + InlineEditor instead.
	describe("viewport-change hook (F3)", () => {
		it("repositions an open inline editor to the recomputed rect on each applied frame", async () => {
			const { model, container, renderer } = mount(["# Root", "## Branch A"].join("\n"));
			const branch = model.root.children[0];
			const svg = container.querySelector(".mm-svg")!;

			const initialRect = renderer.getNodeScreenRect(branch.id)!;
			const editor = new InlineEditor(container, { initialText: branch.text, rect: initialRect, onCommit: () => {}, onCancel: () => {}, onCommitAndCreateChild: () => {} });
			const input = container.querySelector("textarea") as HTMLTextAreaElement;
			expect(input.style.left).toBe(`${initialRect.left}px`);

			// Stand in for "the transform changed underneath the node" without
			// needing the wheel deltas to land on an exact recomputed value.
			const movedRect = { left: initialRect.left + 123, top: initialRect.top + 45, width: initialRect.width, height: initialRect.height };
			const getNodeScreenRectSpy = vi.spyOn(renderer, "getNodeScreenRect").mockReturnValue(movedRect);

			// Mirrors MindMapView.repositionInlineEditorForViewport.
			const editingNodeId: string | null = branch.id;
			renderer.setViewportChangeHandler(() => {
				if (!editingNodeId) return;
				const rect = renderer.getNodeScreenRect(editingNodeId);
				if (!rect) return;
				editor.reposition(rect);
			});

			svg.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 40, ctrlKey: false, bubbles: true, cancelable: true }));
			expect(getNodeScreenRectSpy).not.toHaveBeenCalled(); // not yet applied — scheduleApplyViewport batches to the next rAF

			await new Promise((r) => requestAnimationFrame(r));

			expect(getNodeScreenRectSpy).toHaveBeenCalledWith(branch.id);
			expect(input.style.left).toBe(`${movedRect.left}px`);
			expect(input.style.top).toBe(`${movedRect.top}px`);

			editor.destroy();
		});

		it("no inline editor open -> firing the hook never calls getNodeScreenRect", async () => {
			const { container, renderer } = mount(["# Root", "## Branch A"].join("\n"));
			const svg = container.querySelector(".mm-svg")!;
			const getNodeScreenRectSpy = vi.spyOn(renderer, "getNodeScreenRect");

			// Mirrors MindMapView's guard: `editingNodeId` null means the callback
			// returns before touching getNodeScreenRect at all — the cheap no-op
			// that keeps F3 at zero cost outside an active edit session.
			const editingNodeId: string | null = null;
			renderer.setViewportChangeHandler(() => {
				if (!editingNodeId) return;
				renderer.getNodeScreenRect(editingNodeId);
			});

			svg.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 40, ctrlKey: false, bubbles: true, cancelable: true }));
			await new Promise((r) => requestAnimationFrame(r));

			expect(getNodeScreenRectSpy).not.toHaveBeenCalled();
		});
	});
});
