#!/usr/bin/env node
// M1 exit-criterion benchmark: parse + layout time per fixture size, run
// against the compiled plugin bundle so it exercises the real code path
// (addendum §6: "keep the 2,000-node fixture loadable and check it after
// each milestone"). Run `npm run build` first if this errors on import.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Bundle the pure-logic modules (no 'obsidian' import) into a temp ESM file
// we can import directly, so this script always reflects current source
// without requiring a separate build step.
const result = await esbuild.build({
	stdin: {
		contents: `
			export { parseMindMap } from ${JSON.stringify(join(ROOT, "webview/sync/parser.ts"))};
			export { computeLayout } from ${JSON.stringify(join(ROOT, "webview/layout/layoutEngine.ts"))};
			export { assignMissingSides } from ${JSON.stringify(join(ROOT, "webview/layout/sides.ts"))};
		`,
		resolveDir: ROOT,
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	write: false,
	target: "es2020",
});

const tmpModuleUrl = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64");
const { parseMindMap, computeLayout, assignMissingSides } = await import(tmpModuleUrl);

const SIZES = [100, 500, 2000, 5000];
const BUDGETS_MS = { 100: 300, 500: 300, 2000: 1000, 5000: 2000 }; // open-map budgets, addendum §3

for (const size of SIZES) {
	const md = readFileSync(join(ROOT, "fixtures", `${size}-nodes.md`), "utf8");

	const t0 = performance.now();
	const model = parseMindMap(md, `${size}-nodes`);
	assignMissingSides(model.root);
	const t1 = performance.now();
	computeLayout(model.root);
	const t2 = performance.now();

	const parseMs = t1 - t0;
	const layoutMs = t2 - t1;
	const totalMs = t2 - t0;
	const budget = BUDGETS_MS[size];
	const status = totalMs <= budget ? "OK" : "OVER BUDGET";

	console.log(
		`${size} nodes: parse=${parseMs.toFixed(1)}ms layout=${layoutMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ` +
			`(budget ${budget}ms) [${status}]`
	);
}
