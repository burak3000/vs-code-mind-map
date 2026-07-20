#!/usr/bin/env node
// R1a exit-criterion benchmark (mandatory checkpoint between M-R1a and
// M-R2, CLAUDE.md rule 5 / plan's "Benchmark checkpoint"): open, Tab-edit,
// and pan-with-culling cost on the 2,000- and 5,000-node fixtures with a
// few hundred same-document relations injected — the worst case R1a's own
// perf section calls out. jsdom doesn't paint, so this measures JS/DOM-API
// time only, same caveat already logged for bench-m1/bench-m2/bench-images.

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
global.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;

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
			export { resolveRelations } from ${JSON.stringify(join(ROOT, "webview/model/relations.ts"))};
			export { ensurePersistentIds } from ${JSON.stringify(join(ROOT, "webview/sync/metadata.ts"))};
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
const { parseMindMap, serializeMindMap, computeLayout, SvgRenderer, addChild, renameNode, deleteNode, assignMissingSides, resolveRelations, ensurePersistentIds } =
	await import(tmpModuleUrl);

const SIZES = [2000, 5000];
const RELATION_DENSITY = 1 / 10; // ~1 in 10 nodes gets a same-doc relation link -> a "few hundred" at these sizes
const OPEN_BUDGET_MS = { 2000: 1000, 5000: 2000 }; // CLAUDE.md open budgets
const EDIT_BUDGET_MS = 50; // Tab/Enter target; hard ceiling 100ms

function flatten(root) {
	const out = [];
	const walk = (n) => {
		out.push(n);
		n.children.forEach(walk);
	};
	walk(root);
	return out;
}

/** Mutates `model` in place, adding `count` same-doc relations: node i links to node i+7 (wrapping), each target forced to a real (non-synthetic-looking, but here just deterministic) persistent id up front — the way `forcePersistentId` would leave things after real authoring, so `resolveRelations` has real block ids to resolve against from the start. */
function injectRelations(model, count) {
	const nodes = flatten(model.root).filter((n) => n.parent !== null); // skip root as a target for a cleaner count
	const step = Math.max(1, Math.floor(nodes.length / count));
	let injected = 0;
	for (let i = 0; i < nodes.length && injected < count; i += step) {
		const source = nodes[i];
		const target = nodes[(i + 7) % nodes.length];
		if (source === target) continue;
		if (!/\^rel\d+$/.test(target.id)) {
			const newId = `rel${injected}`;
			model.byId.delete(target.id);
			target.id = newId;
			model.byId.set(newId, target);
		}
		source.text = `${source.text} [[#^${target.id}]]`;
		injected++;
	}
	return injected;
}

const fmt = (ms, budget) => `${ms.toFixed(1)}ms${ms <= budget ? " OK" : " OVER BUDGET"}`;

for (const size of SIZES) {
	const md = readFileSync(join(ROOT, "fixtures", `${size}-nodes.md`), "utf8");

	// --- Open: parse + inject relations (one-time authoring cost, not
	// timed) + sides/layout + resolveRelations + mount, against the
	// existing open-time budgets. ---
	const t0 = performance.now();
	const model = parseMindMap(md, `${size}-nodes`);
	const relationCount = injectRelations(model, Math.round(size * RELATION_DENSITY));
	assignMissingSides(model.root);
	computeLayout(model.root);
	const t1 = performance.now();
	const activeRelations = resolveRelations(model, `${size}-nodes`);
	const t2 = performance.now();

	const container = document.createElement("div");
	Object.defineProperty(container, "clientWidth", { value: 1200, configurable: true });
	Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
	document.body.appendChild(container);
	const renderer = new SvgRenderer(container);
	const t3 = performance.now();
	renderer.mount(model, activeRelations);
	const t4 = performance.now();

	const layoutMs = t1 - t0;
	const resolveMs = t2 - t1;
	const mountMs = t4 - t3;
	const openMs = t4 - t0;
	const budget = OPEN_BUDGET_MS[size];

	// --- Tab: add a child, relayout, re-resolve relations, dirty-update
	// render — against the Tab/Enter budget (50ms target/100ms ceiling). ---
	const parent = model.root.children[Math.floor(model.root.children.length / 2)];
	let te0 = performance.now();
	const created = addChild(model, parent.id, "");
	assignMissingSides(model.root);
	computeLayout(model.root);
	const editRelations = resolveRelations(model, `${size}-nodes`);
	renderer.update(model, editRelations);
	renderer.selectNode(created.id);
	const tabMs = performance.now() - te0;

	// --- Rename a relation *source* node (the extra link-parsing/
	// re-resolution work is source-node-shaped, so exercise it directly). ---
	const relationSource = flatten(model.root).find((n) => n.text.includes("[[#^"));
	let tr0 = performance.now();
	renameNode(model, relationSource.id, `${relationSource.text} renamed`);
	computeLayout(model.root);
	const renameRelations = resolveRelations(model, `${size}-nodes`);
	renderer.update(model, renameRelations);
	const renameMs = performance.now() - tr0;

	// --- Pan-with-culling proxy: drag the viewport (only meaningful above
	// the 300-node culling threshold, true for both sizes here) — measures
	// the recull + relation re-cull pass a real pan triggers, never a full
	// re-resolution (resolveRelations is NOT called in this block). ---
	const svg = container.querySelector(".mm-svg");
	const tp0 = performance.now();
	svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
	svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: -400, clientY: -300, pointerId: 1 }));
	svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: -400, clientY: -300, pointerId: 1 }));
	const panMs = performance.now() - tp0;

	// --- Round-trip sanity: serialize must still carry every relation's
	// block-id suffix (R1a item 2) even at this scale. ---
	ensurePersistentIds(model.root, model.byId);
	const ts0 = performance.now();
	const serialized = serializeMindMap(model);
	const serializeMs = performance.now() - ts0;
	deleteNode(model, created.id); // cleanup, not timed

	console.log(
		`${size} nodes, ${relationCount} relations: ` +
			`open(parse+layout=${layoutMs.toFixed(1)}ms resolve=${resolveMs.toFixed(1)}ms mount=${mountMs.toFixed(1)}ms total=${fmt(openMs, budget)}) ` +
			`Tab=${fmt(tabMs, EDIT_BUDGET_MS)} rename(relation source)=${fmt(renameMs, EDIT_BUDGET_MS)} pan-dispatch=${panMs.toFixed(1)}ms serialize=${serializeMs.toFixed(1)}ms`
	);
	console.log(`  round-trip check: serialized text contains all ${relationCount} relation links: ${(serialized.match(/\[\[#\^/g) ?? []).length === relationCount}`);

	renderer.destroy();
}
