#!/usr/bin/env node
// Plan item 07 (image display) exit-criterion benchmark: open time and a
// pan-cost proxy for a map where every node carries an image embed — the
// worst case the perf section calls out ("hundreds of images all
// in-viewport at low zoom"). Budgets: 2,000-node map < 1s open (addendum
// §3); pan/zoom target 60fps (< 16ms/frame), ceiling 30fps (< 33ms/frame) —
// jsdom doesn't paint, so "pan cost" here is JS/DOM-API time only (the
// recull pass a real pan triggers), not a real frame time; see the M2
// bench's already-logged caveat for the same limitation.

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
global.document = dom.window.document;
global.window = dom.window;
global.HTMLElement = dom.window.HTMLElement;
global.SVGElement = dom.window.SVGElement;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const result = await esbuild.build({
	stdin: {
		contents: `
			export { parseMindMap } from ${JSON.stringify(join(ROOT, "webview/sync/parser.ts"))};
			export { computeLayout, DEFAULT_LAYOUT_CONFIG } from ${JSON.stringify(join(ROOT, "webview/layout/layoutEngine.ts"))};
			export { SvgRenderer } from ${JSON.stringify(join(ROOT, "webview/render/SvgRenderer.ts"))};
		`,
		resolveDir: ROOT,
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	write: false,
	target: "es2020",
	platform: "browser",
});

const tmpModuleUrl = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64");
const { parseMindMap, computeLayout, DEFAULT_LAYOUT_CONFIG, SvgRenderer } = await import(tmpModuleUrl);

const N = 200;
const lines = ["# Root"];
for (let i = 1; i <= N; i++) {
	lines.push(`## Branch ${i} ![[image-${i}.png]]`);
}
const md = lines.join("\n");

const cfg = { ...DEFAULT_LAYOUT_CONFIG, mode: "right-only" };

const t0 = performance.now();
const model = parseMindMap(md, "images-bench");
computeLayout(model.root, cfg);
const t1 = performance.now();

const container = document.createElement("div");
Object.defineProperty(container, "clientWidth", { value: 1200, configurable: true });
Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
document.body.appendChild(container);

const renderer = new SvgRenderer(container);
renderer.setImageResolver(() => "resource://placeholder.png"); // every node resolves -> worst-case concurrent load count
const t2 = performance.now();
renderer.mount(model);
const t3 = performance.now();

const parseLayoutMs = t1 - t0;
const mountMs = t3 - t2;
const openMs = t3 - t0;
const OPEN_BUDGET_MS = 1000; // 2,000-node budget, addendum §3 — 200 nodes here is well inside it, so this is a headroom check, not a ceiling test

// Pan-cost proxy: drag the viewport and measure the resulting recull pass.
// This exercises exactly the "existing culling" lazy-load path the design
// relies on (only re-entering nodes get upsertNode'd, i.e. only they'd get
// a fresh href assignment) — below the 300-node culling threshold (as here,
// at 201 nodes) every node's DOM already exists, so this specifically
// measures the pan-transform + per-node reposition cost, not image loading.
const svg = container.querySelector(".mm-svg");
const t4 = performance.now();
svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: -300, clientY: -200, pointerId: 1 }));
svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: -300, clientY: -200, pointerId: 1 }));
const panMs = performance.now() - t4;

const openStatus = openMs <= OPEN_BUDGET_MS ? "OK" : "OVER BUDGET";
console.log(
	`${N + 1} nodes (${N} with an image embed): parse+layout=${parseLayoutMs.toFixed(1)}ms mount=${mountMs.toFixed(1)}ms ` +
		`open=${openMs.toFixed(1)}ms (budget ${OPEN_BUDGET_MS}ms) [${openStatus}] pan-dispatch=${panMs.toFixed(1)}ms`
);
console.log(`.mm-node-image elements created: ${container.querySelectorAll(".mm-node-image").length}`);

renderer.destroy();
