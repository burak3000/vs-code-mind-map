// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { computeLayout, DEFAULT_LAYOUT_CONFIG } from "../webview/layout/layoutEngine";
import { addChild } from "../webview/model/mutations";
import { SvgRenderer } from "../webview/render/SvgRenderer";
import { buildModel } from "./helpers/render";
import type { MindMapModel, MindNode } from "../webview/model/types";

/**
 * F2 (D4 — minimal-pan ensure-visible, resolved decision, see
 * plans/PLAN-relations-and-ux-fixes.md and DECISIONS.md): a newly created
 * node's editor must be brought on screen before `MindMapView.openInlineEditor`
 * reads `getNodeScreenRect`, panning only the minimum distance needed (never
 * recentering), and doing nothing at all when the node is already visible.
 * These tests exercise `SvgRenderer.ensureWorldRectVisible` — the primitive
 * `MindMapView.onEditRequest` calls ahead of `openInlineEditor` — directly,
 * the same level `culling.test.ts` already tests panning/culling at, since
 * `MindMapView` itself needs the real Obsidian API to instantiate.
 */

// Same trick culling.test.ts uses: force everything onto one side with a
// huge level gap so a deep node's world x is far outside a normal viewport.
const WIDE_CFG = { mode: "right-only" as const, levelGap: 1000 };

function makeChain(depth: number): string {
	const lines = ["# Root"];
	for (let i = 1; i <= depth; i++) lines.push(`${"  ".repeat(Math.max(0, i - 2))}${i === 1 ? "##" : "-"} Node ${i}`);
	return lines.join("\n");
}

function deepestNode(model: MindMapModel): MindNode {
	let n = model.root;
	while (n.children.length) n = n.children[0];
	return n;
}

function makeContainer(width = 800, height = 600): HTMLDivElement {
	const container = document.createElement("div");
	Object.defineProperty(container, "clientWidth", { value: width, configurable: true });
	Object.defineProperty(container, "clientHeight", { value: height, configurable: true });
	return container;
}

function expectRectWithinViewport(rect: { left: number; top: number; width: number; height: number } | null, container: HTMLElement): void {
	expect(rect).not.toBeNull();
	expect(rect!.left).toBeGreaterThanOrEqual(0);
	expect(rect!.top).toBeGreaterThanOrEqual(0);
	expect(rect!.left + rect!.width).toBeLessThanOrEqual(container.clientWidth);
	expect(rect!.top + rect!.height).toBeLessThanOrEqual(container.clientHeight);
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("SvgRenderer.ensureWorldRectVisible (F2: new node brought into view)", () => {
	it("pans (synchronously, no rAF wait needed) so an off-screen, culled-out node's screen rect lands within the viewport", () => {
		const model = buildModel(makeChain(400), WIDE_CFG);
		const container = makeContainer();
		const renderer = new SvgRenderer(container, undefined, { ...DEFAULT_LAYOUT_CONFIG, ...WIDE_CFG });
		renderer.mount(model);

		const deepest = deepestNode(model);
		// Precondition: far enough out to be culled, matching culling.test.ts.
		expect(container.querySelector(`[data-node-id="${deepest.id}"]`)).toBeNull();
		expect(renderer.getNodeScreenRect(deepest.id)).toBeNull();

		expect(renderer.ensureWorldRectVisible(deepest.layout!)).toBe(true);

		// No `await nextFrame()` — ensureWorldRectVisible must apply the pan
		// and re-cull synchronously so the node's DOM element (and thus a
		// valid screen rect) exists the instant this call returns; a caller
		// positioning the inline editor can't wait a frame for it.
		expect(container.querySelector(`[data-node-id="${deepest.id}"]`)).not.toBeNull();
		expectRectWithinViewport(renderer.getNodeScreenRect(deepest.id), container);

		renderer.destroy();
	});

	it("brings a freshly addChild()-ed node (off-screen, like a Tab off a deep/off-screen selection) into view the same way", () => {
		const model = buildModel(makeChain(400), WIDE_CFG);
		const container = makeContainer();
		const renderer = new SvgRenderer(container, undefined, { ...DEFAULT_LAYOUT_CONFIG, ...WIDE_CFG });
		renderer.mount(model);

		const deepest = deepestNode(model);
		const created = addChild(model, deepest.id, "");
		computeLayout(model.root, { ...DEFAULT_LAYOUT_CONFIG, ...WIDE_CFG }); // MindMapView.onChange's relayout, before onEditRequest fires
		renderer.update(model);

		expect(renderer.getNodeScreenRect(created.id)).toBeNull(); // culled out, same as its off-screen parent

		expect(renderer.ensureWorldRectVisible(created.layout!)).toBe(true);
		expectRectWithinViewport(renderer.getNodeScreenRect(created.id), container);

		renderer.destroy();
	});

	it("D4 minimal-pan: a node already comfortably visible triggers no viewport transform change", async () => {
		const model = buildModel(["# Root", "## Branch A", "## Branch B"].join("\n"));
		const container = makeContainer();
		const renderer = new SvgRenderer(container);
		renderer.mount(model);
		await nextFrame(); // let the initial center-on-construction pan settle first

		const viewportG = container.querySelector(".mm-viewport")!;
		const before = viewportG.getAttribute("transform");

		expect(renderer.ensureWorldRectVisible(model.root.children[0].layout!)).toBe(false);
		expect(viewportG.getAttribute("transform")).toBe(before); // no pan, no extra re-render

		renderer.destroy();
	});
});
