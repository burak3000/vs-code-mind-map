// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { computeLayout, DEFAULT_LAYOUT_CONFIG } from "../webview/layout/layoutEngine";
import { SvgRenderer } from "../webview/render/SvgRenderer";

// Force everything onto one side with a small level gap so many nodes land
// at predictably large depth-axis (x) offsets — makes it easy to construct
// a small tree where most nodes are clearly outside a narrow viewport.
const WIDE_CFG = { ...DEFAULT_LAYOUT_CONFIG, mode: "right-only" as const, levelGap: 1000 };

function makeChain(depth: number): string {
	const lines = ["# Root"];
	for (let i = 1; i <= depth; i++) {
		lines.push(`${"  ".repeat(Math.max(0, i - 2))}${i === 1 ? "##" : "-"} Node ${i}`);
	}
	return lines.join("\n");
}

describe("viewport culling", () => {
	it("below the culling threshold, every node renders regardless of position", () => {
		const model = parseMindMap(makeChain(10), "fallback");
		computeLayout(model.root, WIDE_CFG);

		const container = document.createElement("div");
		Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
		Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
		const renderer = new SvgRenderer(container);
		renderer.mount(model);

		expect(container.querySelectorAll(".mm-node").length).toBe(11); // root + 10
		renderer.destroy();
	});

	it("above the culling threshold, nodes far outside the viewport are not in the DOM", () => {
		const model = parseMindMap(makeChain(400), "fallback");
		computeLayout(model.root, WIDE_CFG);

		const container = document.createElement("div");
		Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
		Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
		const renderer = new SvgRenderer(container);
		renderer.mount(model);

		const rendered = container.querySelectorAll(".mm-node").length;
		expect(rendered).toBeGreaterThan(0);
		expect(rendered).toBeLessThan(401); // far fewer than the full 401 nodes
		renderer.destroy();
	});

	it("panning toward a previously-culled node brings it back into the DOM", async () => {
		const model = parseMindMap(makeChain(400), "fallback");
		computeLayout(model.root, WIDE_CFG);

		const container = document.createElement("div");
		Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
		Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
		const renderer = new SvgRenderer(container);
		renderer.mount(model);
		await nextFrame(); // let the initial mount's rAF-scheduled transform+recull settle

		const deepest = (() => {
			let n = model.root;
			while (n.children.length) n = n.children[0];
			return n;
		})();
		const deepestX = deepest.layout!.x;
		expect(container.querySelector(`[data-node-id="${deepest.id}"]`)).toBeNull();

		// Pan left by exactly deepestX (in screen px, scale=1) so the deepest
		// node's world position lands back under the viewport's origin.
		const svg = container.querySelector(".mm-svg")!;
		svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: -deepestX, clientY: 0, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: -deepestX, clientY: 0, pointerId: 1 }));
		await nextFrame();

		expect(container.querySelector(`[data-node-id="${deepest.id}"]`)).not.toBeNull();
		renderer.destroy();
	});

	it("centerOnWorldPoint brings a culled-out node back into the DOM (search-jump support)", async () => {
		const model = parseMindMap(makeChain(400), "fallback");
		computeLayout(model.root, WIDE_CFG);

		const container = document.createElement("div");
		Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
		Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
		const renderer = new SvgRenderer(container);
		renderer.mount(model);
		await nextFrame();

		const deepest = (() => {
			let n = model.root;
			while (n.children.length) n = n.children[0];
			return n;
		})();
		expect(container.querySelector(`[data-node-id="${deepest.id}"]`)).toBeNull();

		// Read straight from the model's layout (as MindMapView's search-jump
		// does), not the renderer's own DOM cache — that's the whole point:
		// a culled node's entry there was already pruned by applyVisibleSet.
		renderer.centerOnWorldPoint(deepest.layout!.x + deepest.layout!.w / 2, deepest.layout!.y + deepest.layout!.h / 2);
		await nextFrame();

		expect(container.querySelector(`[data-node-id="${deepest.id}"]`)).not.toBeNull();
		renderer.destroy();
	});

	it("image embed lazy-load (plan item 07) rides along with culling: the resolver isn't called for a culled-out node, and is called once it scrolls into view", async () => {
		const md = makeChain(400).replace("Node 400", "Node 400 ![[photo.png]]");
		const model = parseMindMap(md, "fallback");
		computeLayout(model.root, WIDE_CFG);

		const container = document.createElement("div");
		Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
		Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
		const renderer = new SvgRenderer(container);
		const resolvedIds: string[] = [];
		renderer.setImageResolver((node) => {
			resolvedIds.push(node.id);
			return "resource://photo.png";
		});
		renderer.mount(model);
		await nextFrame();

		const deepest = (() => {
			let n = model.root;
			while (n.children.length) n = n.children[0];
			return n;
		})();
		expect(container.querySelector(`[data-node-id="${deepest.id}"]`)).toBeNull(); // culled out
		expect(resolvedIds).not.toContain(deepest.id); // never resolved while off-screen

		const deepestX = deepest.layout!.x;
		const svg = container.querySelector(".mm-svg")!;
		svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: -deepestX, clientY: 0, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: -deepestX, clientY: 0, pointerId: 1 }));
		await nextFrame();

		expect(container.querySelector(`[data-node-id="${deepest.id}"] .mm-node-image`)).not.toBeNull();
		expect(resolvedIds).toContain(deepest.id); // resolved now that it's visible

		renderer.destroy();
	});
});

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
