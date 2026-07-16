#!/usr/bin/env node
// M1 exit-criterion benchmark (headless proxy): the full webview open path —
// parse -> assignMissingColors -> assignMissingSides -> computeLayout ->
// SvgRenderer mount — exactly the sequence webview/main.ts's
// buildFromScratch() runs when the host posts the document, measured per
// fixture size against the "open a map" budgets (500 nodes < 300ms,
// 2,000 nodes < 1s). jsdom doesn't paint, so this measures JS/DOM-API cost,
// not real paint/layout time; the authoritative check is a real VS Code
// window (Extension Development Host) — same caveat as bench-m2.

import { readFileSync } from "fs";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const result = await esbuild.build({
	stdin: {
		contents: `
			export { parseMindMap } from ${JSON.stringify(join(ROOT, "webview/sync/parser.ts"))};
			export { computeLayout, DEFAULT_LAYOUT_CONFIG } from ${JSON.stringify(join(ROOT, "webview/layout/layoutEngine.ts"))};
			export { SvgRenderer } from ${JSON.stringify(join(ROOT, "webview/render/SvgRenderer.ts"))};
			export { assignMissingSides } from ${JSON.stringify(join(ROOT, "webview/layout/sides.ts"))};
			export { assignMissingColors } from ${JSON.stringify(join(ROOT, "webview/render/colors.ts"))};
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
const { parseMindMap, computeLayout, DEFAULT_LAYOUT_CONFIG, SvgRenderer, assignMissingSides, assignMissingColors } =
	await import(tmpModuleUrl);

const SIZES = [100, 500, 2000, 5000];
const BUDGETS_MS = { 100: 300, 500: 300, 2000: 1000, 5000: 2000 }; // open-map budgets (5,000 = stress: graceful, never a freeze)

for (const size of SIZES) {
	const md = readFileSync(join(ROOT, "fixtures", `${size}-nodes.md`), "utf8");

	const container = document.createElement("div");
	Object.defineProperty(container, "clientWidth", { value: 1200, configurable: true });
	Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
	document.body.appendChild(container);

	const t0 = performance.now();
	const model = parseMindMap(md, `${size}-nodes`);
	assignMissingColors(model.root);
	assignMissingSides(model.root);
	computeLayout(model.root, DEFAULT_LAYOUT_CONFIG);
	const t1 = performance.now();
	const renderer = new SvgRenderer(container);
	renderer.mount(model);
	const t2 = performance.now();

	const parseLayoutMs = t1 - t0;
	const mountMs = t2 - t1;
	const totalMs = t2 - t0;
	const budget = BUDGETS_MS[size];
	const status = totalMs <= budget ? "OK" : "OVER BUDGET";

	console.log(
		`${size} nodes: parse+colors+sides+layout=${parseLayoutMs.toFixed(1)}ms mount=${mountMs.toFixed(1)}ms ` +
			`total=${totalMs.toFixed(1)}ms (budget ${budget}ms) [${status}]`
	);

	renderer.destroy();
	document.body.removeChild(container);
}
