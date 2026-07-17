// @vitest-environment jsdom
//
// M5 tests for webview/main.ts's viewport-state persistence (plan §11's risk
// row "Webview reload loses map state" / DECISIONS.md's dated M5 entry):
// selection survives a hidden→revealed reload via `vscode.setState`/
// `getState`, restored by structural sibling-index path (not id — a reload
// mints a fresh random id for every node without persisted `^blockid`
// metadata, so persisting by id would almost never resolve). Needs its own
// file (same reasoning as webviewConfig.test.ts's header comment): several
// cases need a *fresh* `MindMapApp` module instance to simulate a real
// reload (the whole JS context is torn down), while sharing one state
// object across "sessions" the way VS Code's own webview-state store
// survives the reload that destroys everything else. jsdom doesn't paint —
// these assert DOM/attribute wiring, not visuals (see CLAUDE.md).
import { describe, expect, it, vi } from "vitest";

function sendFromHost(data: unknown): void {
	window.dispatchEvent(new MessageEvent("message", { data }));
}

function nodeEls(): SVGGElement[] {
	return Array.from(document.querySelectorAll<SVGGElement>(".mm-node"));
}

function findNodeEl(text: string): SVGGElement {
	document.querySelector(".mm-svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); // reset double-click tracking
	const el = nodeEls().find((n) => n.textContent?.includes(text));
	expect(el).toBeTruthy();
	return el!;
}

function selectNodeByText(text: string): SVGGElement {
	const el = findNodeEl(text);
	el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	return el;
}

function viewportTransform(): string {
	return document.querySelector(".mm-viewport")!.getAttribute("transform") ?? "";
}

async function nextFrame(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Simulates VS Code's own webview-state store: `store.value` survives across
 * `vi.resetModules()` + a fresh `import("../webview/main")`, exactly like the
 * real store survives a hidden→revealed reload even though every other bit
 * of JS state (the whole module, `MindMapApp`, `Controller`, every node id)
 * is destroyed and rebuilt from scratch.
 */
async function freshApp(store: { value: unknown }): Promise<{ postMessage: ReturnType<typeof vi.fn> }> {
	vi.resetModules();
	const postMessage = vi.fn();
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage,
		getState: () => store.value,
		setState: (s: unknown) => {
			store.value = s;
		},
	});
	document.body.innerHTML = '<div class="mindmap-view-container"><div class="mindmap-placeholder">Loading…</div></div>';
	const container = document.querySelector<HTMLElement>(".mindmap-view-container")!;
	// jsdom defaults every element's clientWidth/clientHeight to 0 — fixed
	// non-zero values make the centering math (and this file's assertions
	// about it) meaningful, same as culling.test.ts's identical setup.
	Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
	Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
	await import("../webview/main");
	return { postMessage };
}

const DOC_TEXT = "# Root\n## Branch A\n- child one\n- child two\n## Branch B\n- child three\n";

describe("webview state persistence (getState/setState across a reload)", () => {
	it("does not call setState on a plain open with nothing selected (buildFromScratch doesn't persist by itself)", async () => {
		const store: { value: unknown } = { value: undefined };
		await freshApp(store);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });
		expect(store.value).toBeUndefined();
	});

	it("persists the primary (and multi-)selection as structural sibling-index paths on every selection change", async () => {
		const store: { value: unknown } = { value: undefined };
		await freshApp(store);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });

		selectNodeByText("child one"); // root -> Branch A (index 0) -> child one (index 0)
		// toMatchObject (not toEqual) so the always-present `viewport` field —
		// asserted in its own dedicated round-trip test below — doesn't have to
		// be spelled out in every selection assertion.
		expect(store.value).toMatchObject({ selectedPath: [0, 0], selectedPaths: [[0, 0]] });

		// Ctrl/Cmd+click adds "child three" (root -> Branch B (index 1) -> child
		// three (index 0)) to the selection — found via a direct query rather
		// than `findNodeEl`'s helper, since that helper's own background click
		// (to reset SvgRenderer's double-click tracking) would clear the
		// multi-selection this is trying to build on.
		const childThree = nodeEls().find((n) => n.textContent?.includes("child three"))!;
		childThree.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
		expect(store.value).toMatchObject({
			selectedPath: [1, 0],
			selectedPaths: expect.arrayContaining([
				[0, 0],
				[1, 0],
			]),
		});
	});

	it("restores the selection across a simulated hidden→revealed reload", async () => {
		const store: { value: unknown } = { value: undefined };
		await freshApp(store);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });
		selectNodeByText("child one");
		await nextFrame();
		// No pan/zoom gesture happened, so the persisted viewport is still the
		// renderer's default (container 800×600 -> tx=400, ty=300, scale=1).
		expect(store.value).toMatchObject({
			selectedPath: [0, 0],
			selectedPaths: [[0, 0]],
			viewport: { tx: 400, ty: 300, scale: 1 },
		});

		// The reload: a brand-new module/DOM/MindMapApp (retainContextWhenHidden:
		// false — see DECISIONS.md), sharing only `store` (what VS Code's own
		// state store would actually preserve). No selection exists yet in the
		// fresh DOM until the host's first "setDocument" triggers buildFromScratch.
		await freshApp(store);
		expect(document.querySelectorAll(".mm-selected").length).toBe(0);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });
		await nextFrame();

		const selected = document.querySelectorAll(".mm-selected");
		expect(selected.length).toBe(1);
		expect(selected[0].textContent).toContain("child one");
		// Nothing was panned, so the restored viewport is the default — the
		// exact-round-trip of a *changed* viewport is the next test's job.
		expect(viewportTransform()).toBe("translate(400, 300) scale(1)");
	});

	it("round-trips an exact pan/zoom with NOTHING selected across a reload (getViewport/setViewport)", async () => {
		const store: { value: unknown } = { value: undefined };
		await freshApp(store);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });
		await nextFrame();
		expect(viewportTransform()).toBe("translate(400, 300) scale(1)"); // default

		// A ctrl+wheel (pinch-zoom) gesture on the canvas — dispatched on the
		// SVG so the renderer's own wheel handler updates its `view`
		// synchronously; the container-level wheel listener then persists the
		// new viewport (no selection involved). getBoundingClientRect is all
		// zeros in jsdom, so the wheel's client point maps straight through.
		const svg = document.querySelector(".mm-svg")!;
		svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1, clientX: 200, clientY: 150 }));
		await nextFrame();

		const transformBefore = viewportTransform();
		expect(transformBefore).not.toBe("translate(400, 300) scale(1)"); // the zoom actually moved the camera
		const persisted = store.value as { selectedPath: number[] | null; viewport?: { scale: number } };
		expect(persisted.selectedPath).toBeNull(); // nothing selected — this is a pure pan/zoom persist
		expect(persisted.viewport).toBeDefined();
		expect(persisted.viewport!.scale).not.toBe(1); // zoom captured

		// Reload and confirm the exact same transform comes back — same stored
		// numbers -> same float representation -> byte-identical transform
		// string, so this is exact even though the zoom math produces ugly
		// floats.
		await freshApp(store);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });
		await nextFrame();
		expect(document.querySelectorAll(".mm-selected").length).toBe(0); // still nothing selected
		expect(viewportTransform()).toBe(transformBefore); // exact pan/zoom restored
	});

	it("restores selection AND an exact changed viewport together", async () => {
		const store: { value: unknown } = { value: undefined };
		await freshApp(store);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });
		selectNodeByText("child one");
		// Zoom after selecting — persistState fires again (from the container
		// wheel listener) capturing both the selection and the new viewport.
		const svg = document.querySelector(".mm-svg")!;
		svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1, clientX: 250, clientY: 175 }));
		await nextFrame();
		const transformBefore = viewportTransform();
		expect(transformBefore).not.toBe("translate(400, 300) scale(1)");

		await freshApp(store);
		sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" });
		await nextFrame();
		const selected = document.querySelectorAll(".mm-selected");
		expect(selected.length).toBe(1);
		expect(selected[0].textContent).toContain("child one");
		expect(viewportTransform()).toBe(transformBefore);
	});

	it("ignores a persisted path that no longer resolves (tree shrank across the reload) without throwing", async () => {
		const store: { value: unknown } = { value: { selectedPath: [5, 0], selectedPaths: [[5, 0]] } };
		await freshApp(store);
		expect(() => sendFromHost({ type: "setDocument", text: DOC_TEXT, version: 1, title: "fallback" })).not.toThrow();
		await nextFrame();
		expect(document.querySelectorAll(".mm-selected").length).toBe(0);
		// No `viewport` in this hand-written (old-format) state, and no valid
		// selection anchor, so it falls back to the default view untouched.
		expect(viewportTransform()).toBe("translate(400, 300) scale(1)");
	});
});
