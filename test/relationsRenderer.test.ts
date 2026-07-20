// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { computeLayout, DEFAULT_LAYOUT_CONFIG, type LayoutConfig } from "../webview/layout/layoutEngine";
import { SvgRenderer } from "../webview/render/SvgRenderer";
import { resolveRelations } from "../webview/model/relations";
import type { MindMapModel } from "../webview/model/types";

type ActiveRelation = { sourceId: string; targetId: string };

const WIDE_CFG = { ...DEFAULT_LAYOUT_CONFIG, mode: "right-only" as const, levelGap: 1000 };

function makeContainer(width = 800, height = 600): HTMLDivElement {
	const container = document.createElement("div");
	Object.defineProperty(container, "clientWidth", { value: width, configurable: true });
	Object.defineProperty(container, "clientHeight", { value: height, configurable: true });
	return container;
}

let liveRenderers: SvgRenderer[] = [];
afterEach(() => {
	for (const r of liveRenderers) r.destroy();
	liveRenderers = [];
});

/** Parse + layout + resolveRelations + mount in one call. Pass `relationsForMount` to override what's handed to mount() (default: the resolved active list). */
function mountWithRelations(md: string, opts: { cfg?: LayoutConfig; showRelations?: boolean; relationsForMount?: ActiveRelation[]; setup?: (r: SvgRenderer) => void } = {}) {
	const model = parseMindMap(md, "fallback");
	computeLayout(model.root, opts.cfg);
	const active = resolveRelations(model, "fallback");
	const container = makeContainer();
	const renderer = new SvgRenderer(container, undefined, DEFAULT_LAYOUT_CONFIG, opts.showRelations ?? true);
	liveRenderers.push(renderer);
	opts.setup?.(renderer);
	renderer.mount(model, opts.relationsForMount ?? active);
	return { model, container, renderer, active };
}

function relationCount(container: HTMLElement): number {
	return container.querySelectorAll(".mm-relation").length;
}

describe("SvgRenderer: R1a relation arrows", () => {
	it("mount() with activeRelations draws one .mm-relation path per relation, in the relationsG layer between edges and nodes", () => {
		const { container, active } = mountWithRelations(["# Root", "## Source [[#^t1]]", "## Target ^t1"].join("\n"));
		expect(active.length).toBe(1);

		const relations = container.querySelectorAll(".mm-relation");
		expect(relations.length).toBe(1);
		expect(relations[0].getAttribute("marker-end")).toBe("url(#mm-relation-arrowhead)");

		// Layer order: relations sit between edges and nodes.
		const viewport = container.querySelector(".mm-viewport")!;
		const layers = Array.from(viewport.children).map((el) => el.className.baseVal ?? (el as Element).getAttribute("class"));
		expect(layers.indexOf("mm-edges")).toBeLessThan(layers.indexOf("mm-relations"));
		expect(layers.indexOf("mm-relations")).toBeLessThan(layers.indexOf("mm-nodes"));
	});

	it("draws no relation arrow when there are no same-doc relations", () => {
		const { container } = mountWithRelations(["# Root", "## Branch A"].join("\n"));
		expect(relationCount(container)).toBe(0);
	});

	it("showRelations=false (the setting's off position) draws no arrows and does no relation work even when relations are resolved and passed in", () => {
		const { container } = mountWithRelations(["# Root", "## Source [[#^t1]]", "## Target ^t1"].join("\n"), { showRelations: false });
		expect(relationCount(container)).toBe(0);
	});

	it("removes a relation's arrow once it's no longer in the active list (e.g. the link was edited away), on the next update()", () => {
		const { model, container, renderer } = mountWithRelations(["# Root", "## Source [[#^t1]]", "## Target ^t1"].join("\n"));
		expect(relationCount(container)).toBe(1);

		model.root.children[0].text = "Source";
		computeLayout(model.root);
		renderer.update(model, resolveRelations(model, "fallback"));

		expect(relationCount(container)).toBe(0);
	});

	it("skips a relation whose target is currently folded away, without crashing", () => {
		const md = ["# Root", "## Branch", "- Source [[#^t1]]", "## Target ^t1"].join("\n");
		const model = parseMindMap(md, "fallback");
		model.root.children[0].folded = true; // hides "Source" (and thus the relation) — Target is a separate, unaffected branch
		computeLayout(model.root);
		const container = makeContainer();
		const renderer = new SvgRenderer(container);
		liveRenderers.push(renderer);
		expect(() => renderer.mount(model, resolveRelations(model, "fallback"))).not.toThrow();
		expect(relationCount(container)).toBe(0);
	});

	it("skips (and does not crash on) a relation pair with a stale/unknown id", () => {
		const { container, renderer, model } = mountWithRelations(["# Root", "## Branch A"].join("\n"), { relationsForMount: [] });
		expect(() => renderer.mount(model, [{ sourceId: "nope", targetId: "also-nope" }])).not.toThrow();
		expect(relationCount(container)).toBe(0);
	});

	function buildFarChain(): MindMapModel {
		// A 350-node chain with a relation between the two farthest-out nodes,
		// so both endpoints land well outside an 800x600 viewport.
		const lines = ["# Root"];
		for (let i = 1; i <= 350; i++) lines.push(`${"  ".repeat(Math.max(0, i - 2))}${i === 1 ? "##" : "-"} Node ${i}`);
		const model = parseMindMap(lines.join("\n"), "fallback");
		let deepest = model.root;
		let secondDeepest = model.root;
		while (deepest.children.length) {
			secondDeepest = deepest;
			deepest = deepest.children[0];
		}
		deepest.text = `${deepest.text} [[#^far1]]`;
		secondDeepest.id = "far1";
		model.byId.set("far1", secondDeepest);
		return model;
	}

	it("culling: a relation whose source and target are both far outside the viewport is not in the DOM above the culling threshold", () => {
		const model = buildFarChain();
		computeLayout(model.root, WIDE_CFG);
		const container = makeContainer();
		const renderer = new SvgRenderer(container);
		liveRenderers.push(renderer);
		const active = resolveRelations(model, "fallback");
		expect(active.length).toBe(1);
		renderer.mount(model, active);

		// Both endpoints are far outside the 800x600 (+margin) viewport at mount time.
		expect(relationCount(container)).toBe(0);
	});

	it("panning a relation's endpoints into view brings its arrow back into the DOM", async () => {
		// Relation between the two farthest-out nodes (not root, which sits at
		// the pan pivot and is always near-center regardless of chain depth) —
		// both endpoints start off-screen, then pan together into view.
		const model = buildFarChain();
		computeLayout(model.root, WIDE_CFG);
		const container = makeContainer();
		const renderer = new SvgRenderer(container);
		liveRenderers.push(renderer);
		const active = resolveRelations(model, "fallback");
		renderer.mount(model, active);
		await nextFrame();
		expect(relationCount(container)).toBe(0);

		let deepest = model.root;
		while (deepest.children.length) deepest = deepest.children[0];
		const deepestX = deepest.layout!.x;
		const svg = container.querySelector(".mm-svg")!;
		svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: -deepestX, clientY: 0, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: -deepestX, clientY: 0, pointerId: 1 }));
		await nextFrame();

		expect(relationCount(container)).toBe(1);
	});
});

describe("SvgRenderer: R2 cross-document relation badge", () => {
	function badgeOf(container: HTMLElement, nodeId: string) {
		return container.querySelector(`[data-node-id="${nodeId}"] .mm-cross-doc-badge`);
	}

	it("a node linking to a different document gets the cross-doc badge", () => {
		const { model, container } = mountWithRelations(["# Root", "## Source [[Other Note]]"].join("\n"), { relationsForMount: [] });
		expect(badgeOf(container, model.root.children[0].id)).not.toBeNull();
	});

	it("a node with a same-map relation gets an arrow, not the cross-doc badge", () => {
		const { model, container } = mountWithRelations(["# Root", "## Source [[#^t1]]", "## Target ^t1"].join("\n"));
		expect(badgeOf(container, model.root.children[0].id)).toBeNull();
		expect(relationCount(container)).toBe(1);
	});

	it("a node with no link gets neither the badge nor an arrow", () => {
		const { model, container } = mountWithRelations(["# Root", "## Plain"].join("\n"), { relationsForMount: [] });
		expect(badgeOf(container, model.root.children[0].id)).toBeNull();
	});

	it("clicking the cross-doc badge fires the badge click handler with that node's id, not the node click handler", () => {
		let badgeClickedId: string | null = null;
		let nodeClickedId: string | null = null;
		const { model, container } = mountWithRelations(["# Root", "## Source [[Other Note]]"].join("\n"), {
			relationsForMount: [],
			setup: (r) => {
				r.setCrossDocBadgeClickHandler((id) => (badgeClickedId = id));
				r.setNodeClickHandler((id) => (nodeClickedId = id));
			},
		});
		const branch = model.root.children[0];
		badgeOf(container, branch.id)!.querySelector("circle")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(badgeClickedId).toBe(branch.id);
		expect(nodeClickedId).toBeNull();
	});

	it("removing the link from a node's text removes its cross-doc badge on the next update()", () => {
		const { model, container, renderer } = mountWithRelations(["# Root", "## Source [[Other Note]]"].join("\n"), { relationsForMount: [] });
		const branch = model.root.children[0];
		expect(badgeOf(container, branch.id)).not.toBeNull();

		branch.text = "Source";
		computeLayout(model.root);
		resolveRelations(model, "fallback");
		renderer.update(model, []);

		expect(badgeOf(container, branch.id)).toBeNull();
	});
});

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
