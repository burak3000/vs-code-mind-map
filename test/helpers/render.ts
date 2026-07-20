// Shared test scaffolding for parse -> layout -> SvgRenderer.mount, used
// across renderer/layout/navigation/culling specs to cut setup boilerplate.
import { parseMindMap } from "../../webview/sync/parser";
import { computeLayout, DEFAULT_LAYOUT_CONFIG, type LayoutConfig } from "../../webview/layout/layoutEngine";
import { SvgRenderer } from "../../webview/render/SvgRenderer";
import type { MindMapModel } from "../../webview/model/types";

let liveRenderers: SvgRenderer[] = [];

/** Parse + layout a doc. `beforeLayout` runs after parsing but before computeLayout — use it for folding/side-assignment that must happen pre-layout. */
export function buildModel(md: string, config?: Partial<LayoutConfig>, beforeLayout?: (model: MindMapModel) => void): MindMapModel {
	const model = parseMindMap(md, "fallback");
	beforeLayout?.(model);
	computeLayout(model.root, config ? { ...DEFAULT_LAYOUT_CONFIG, ...config } : undefined);
	return model;
}

/** Wrap an already-built model in a fresh container + renderer and mount it. `setup` runs after renderer creation but before mount() — use it for handlers/resolvers that affect the initial render (e.g. setImageResolver). Call cleanupRenderers() in afterEach. */
export function mountModel(model: MindMapModel, setup?: (renderer: SvgRenderer, model: MindMapModel) => void) {
	const container = document.createElement("div");
	const renderer = new SvgRenderer(container);
	liveRenderers.push(renderer);
	setup?.(renderer, model);
	renderer.mount(model);
	return { model, container, renderer };
}

/** buildModel + mountModel in one call, for the common case with no staged mutation in between. */
export function mount(md: string, config?: Partial<LayoutConfig>, setup?: (renderer: SvgRenderer, model: MindMapModel) => void) {
	return mountModel(buildModel(md, config), setup);
}

export function cleanupRenderers(): void {
	for (const r of liveRenderers) r.destroy();
	liveRenderers = [];
}
