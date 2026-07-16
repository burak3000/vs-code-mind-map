#!/usr/bin/env node
// M2 exit-criterion benchmark: mutate + relayout + dirty-render-update time
// per fixture size, simulating Tab/Enter/rename/delete against the budgets
// in CLAUDE.md ("Tab/Enter -> new node visible & editable": target 50ms,
// ceiling 100ms). Uses jsdom for the renderer's DOM calls — jsdom doesn't
// paint, so this measures JS/DOM-API cost, not real paint time; see the
// caveat already logged for M1 in benchmarks.md.

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
			export { serializeMindMap } from ${JSON.stringify(join(ROOT, "webview/sync/serializer.ts"))};
			export { computeLayout } from ${JSON.stringify(join(ROOT, "webview/layout/layoutEngine.ts"))};
			export { SvgRenderer } from ${JSON.stringify(join(ROOT, "webview/render/SvgRenderer.ts"))};
			export { addChild, renameNode, deleteNode } from ${JSON.stringify(join(ROOT, "webview/model/mutations.ts"))};
			export { assignMissingSides } from ${JSON.stringify(join(ROOT, "webview/layout/sides.ts"))};
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
const { parseMindMap, serializeMindMap, computeLayout, SvgRenderer, addChild, renameNode, deleteNode, assignMissingSides } = await import(tmpModuleUrl);

const SIZES = [100, 500, 2000, 5000];
const BUDGET_MS = 50; // target; hard ceiling is 100ms
const CEILING_MS = 100;

for (const size of SIZES) {
	const md = readFileSync(join(ROOT, "fixtures", `${size}-nodes.md`), "utf8");
	const model = parseMindMap(md, `${size}-nodes`);
	assignMissingSides(model.root);
	computeLayout(model.root);

	const container = document.createElement("div");
	const renderer = new SvgRenderer(container);
	renderer.mount(model);

	// --- Tab: add a child under a mid-tree node, relayout, dirty-update render ---
	const parent = model.root.children[Math.floor(model.root.children.length / 2)];
	let t0 = performance.now();
	const created = addChild(model, parent.id, "");
	assignMissingSides(model.root);
	computeLayout(model.root);
	renderer.update(model);
	renderer.selectNode(created.id);
	const tabMs = performance.now() - t0;

	// --- Rename commit: change text on an existing node, relayout, dirty-update render ---
	const renameTarget = model.root.children[0];
	t0 = performance.now();
	renameNode(model, renameTarget.id, "A meaningfully longer renamed label for width change");
	computeLayout(model.root);
	renderer.update(model);
	const renameMs = performance.now() - t0;

	// --- Delete: remove the node we just added, relayout, dirty-update render ---
	t0 = performance.now();
	deleteNode(model, created.id);
	computeLayout(model.root);
	renderer.update(model);
	const deleteMs = performance.now() - t0;

	// --- Fold/unfold: collapse then expand a heavy branch near the root ---
	const heaviest = model.root.children.reduce((a, b) => (b.subtreeCount > a.subtreeCount ? b : a));
	t0 = performance.now();
	heaviest.folded = true;
	computeLayout(model.root);
	renderer.update(model);
	const foldMs = performance.now() - t0;

	t0 = performance.now();
	heaviest.folded = false;
	computeLayout(model.root);
	renderer.update(model);
	const unfoldMs = performance.now() - t0;

	// --- Serialize (write-back cost) ---
	t0 = performance.now();
	serializeMindMap(model);
	const serializeMs = performance.now() - t0;

	const fmt = (ms) => `${ms.toFixed(1)}ms${ms <= BUDGET_MS ? " OK" : ms <= CEILING_MS ? " (over target, within ceiling)" : " OVER CEILING"}`;
	console.log(
		`${size} nodes: Tab=${fmt(tabMs)} rename=${fmt(renameMs)} delete=${fmt(deleteMs)} fold=${fmt(foldMs)} unfold=${fmt(unfoldMs)} serialize=${serializeMs.toFixed(1)}ms`
	);

	renderer.destroy();
}
