// @vitest-environment jsdom
//
// M4 tests for webview/main.ts's settings (`contributes.configuration`) and
// image-resolution (R18) plumbing — kept in their own file (rather than
// appended to webviewBootstrap.test.ts's single shared-singleton module)
// because several of these specifically need a *fresh* `MindMapApp`
// instance per test: proving "layoutMode/headingDepth/animationNodeThreshold
// bake in at buildFromScratch and don't change later" requires controlling
// exactly what config has arrived *before* the first "setDocument", which
// webviewBootstrap.test.ts's single continuously-running instance can't
// give us (its first setDocument happened once, in its own M1 describe
// block, before this file's concerns existed). jsdom doesn't paint — these
// assert DOM/attribute wiring, not visuals (see CLAUDE.md).
import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshApp(): Promise<{ postMessage: ReturnType<typeof vi.fn> }> {
	vi.resetModules();
	const postMessage = vi.fn();
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage,
		getState: () => undefined,
		setState: () => {},
	});
	document.body.innerHTML = '<div class="mindmap-view-container"><div class="mindmap-placeholder">Loading…</div></div>';
	await import("../webview/main");
	return { postMessage };
}

function sendFromHost(data: unknown): void {
	window.dispatchEvent(new MessageEvent("message", { data }));
}

function container(): HTMLElement {
	return document.querySelector<HTMLElement>(".mindmap-view-container")!;
}

function keydown(key: string, opts: KeyboardEventInit = {}): void {
	container().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
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

/** Reads the x half of a `.mm-node`'s own `transform="translate(x, y)"` — layout-mode assertions compare this against the root's (always 0,0). */
function nodeX(el: SVGGElement): number {
	const m = /translate\(\s*(-?[\d.]+)/.exec(el.getAttribute("transform") ?? "");
	return m ? Number(m[1]) : NaN;
}

function flushedWriteText(postMessage: ReturnType<typeof vi.fn>): string {
	postMessage.mockClear();
	sendFromHost({ type: "command", name: "flushWrite" });
	const call = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "writeDocument");
	return call ? (call[0] as { text: string }).text : "";
}

describe("webview main.ts — M4 settings (contributes.configuration)", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("bakes headingDepth from the most recently received setConfig at buildFromScratch time", async () => {
		const { postMessage } = await freshApp();
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 0, layoutMode: "balanced" } });
		sendFromHost({ type: "setDocument", text: "# Root\n## Branch A\n- child one\n", version: 1, title: "fallback" });

		// Any real onChange (Enter creates+selects a sibling) reserializes
		// with whatever serializeConfig was baked at build time.
		selectNodeByText("child one");
		keydown("Enter");
		const text = flushedWriteText(postMessage);

		// headingDepth 0: only the root is a heading; a depth-1 node like
		// "Branch A" (normally "## Branch A" at the default depth 1) must now
		// be a plain list item instead.
		expect(text).toContain("# Root");
		expect(text).not.toMatch(/^##\s+Branch A/m);
		expect(text).toMatch(/^-\s+Branch A/m);
	});

	it("a later setConfig does not retroactively change headingDepth for the already-open map (applies on next open only)", async () => {
		const { postMessage } = await freshApp();
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "balanced" } });
		sendFromHost({ type: "setDocument", text: "# Root\n## Branch A\n- child one\n", version: 1, title: "fallback" });

		// A config change arrives mid-session...
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 0, layoutMode: "balanced" } });

		// ...but the already-mounted map keeps serializing at the depth it
		// was built with (1): "Branch A" is still a heading.
		selectNodeByText("child one");
		keydown("Enter");
		const text = flushedWriteText(postMessage);
		expect(text).toMatch(/^##\s+Branch A/m);
	});

	it("bakes layoutMode 'right-only' from setConfig, placing every first-level branch on the same side as the root", async () => {
		const { postMessage: _postMessage } = await freshApp();
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "right-only" } });
		sendFromHost({
			type: "setDocument",
			text: "# Root\n## Branch A\n- a child\n## Branch B\n- b child\n## Branch C\n- c child\n",
			version: 1,
			title: "fallback",
		});

		const branchXs = ["Branch A", "Branch B", "Branch C"].map((t) => nodeX(findNodeEl(t)));
		// Root sits at x=0 (layoutEngine.computeLayout); "right-only" means
		// every first-level branch lands on the same (positive-x) side
		// instead of being split left/right by weight.
		expect(branchXs.every((x) => x > 0)).toBe(true);
	});

	it("bakes animationNodeThreshold into the renderer's constructor at buildFromScratch time, and a later setConfig does not retroactively change it", async () => {
		const { postMessage } = await freshApp();
		// Threshold 0: even this tiny map has more than 0 visible nodes, so
		// animation must be off from the very first mount.
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 0, headingDepth: 1, layoutMode: "balanced" } });
		sendFromHost({ type: "setDocument", text: "# Root\n## Branch A\n- child one\n", version: 1, title: "fallback" });
		expect(document.querySelector(".mm-svg")!.classList.contains("mm-animated")).toBe(false);

		// A later setConfig raising the threshold arrives mid-session...
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "balanced" } });
		// ...but the already-constructed SvgRenderer's threshold is a
		// `private readonly` constructor argument — an onChange-triggered
		// update() still reflects the old (baked) value, not the new one.
		selectNodeByText("child one");
		keydown("Enter");
		expect(document.querySelector(".mm-svg")!.classList.contains("mm-animated")).toBe(false);
		postMessage.mockClear();
	});

	it("writeDebounceMs applies live: a setConfig after the map is already open changes the running write-back delay", async () => {
		vi.useFakeTimers();
		try {
			const { postMessage } = await freshApp();
			sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "balanced" } });
			sendFromHost({ type: "setDocument", text: "# Root\n## Branch A\n- child one\n", version: 1, title: "fallback" });

			// Shrink the debounce mid-session.
			sendFromHost({ type: "setConfig", config: { writeDebounceMs: 50, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "balanced" } });

			postMessage.mockClear();
			selectNodeByText("child one");
			keydown("Delete");
			vi.advanceTimersByTime(50);
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "writeDocument" }));
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("webview main.ts — M4 image resolution (R18)", () => {
	it("requests resolution for a node's local image embed via a host round trip, and applies the resolved URL once it arrives", async () => {
		const { postMessage } = await freshApp();
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "balanced" } });
		sendFromHost({ type: "setDocument", text: "# Root\n## Branch A ![[diagram.png]]\n", version: 1, title: "fallback" });

		const branchNode = findNodeEl("Branch A");
		const nodeId = branchNode.dataset.nodeId ?? branchNode.getAttribute("data-node-id") ?? "";
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "resolveImage", target: "diagram.png" }));
		const req = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "resolveImage")![0] as { nodeId: string };

		const img = document.querySelector<SVGImageElement>(".mm-node-image")!;
		expect(img.getAttribute("href")).toBeNull(); // unresolved so far — placeholder/missing state

		postMessage.mockClear();
		sendFromHost({ type: "imageResolved", nodeId: req.nodeId, target: "diagram.png", url: "vscode-webview-resource://fake/workspace/diagram.png" });
		// The refresh is debounced (coalesces a burst of replies into one
		// remount — see `refreshResolvedImages`'s doc comment in main.ts), so
		// the href doesn't land until that window elapses.
		await vi.waitFor(() =>
			expect(document.querySelector<SVGImageElement>(".mm-node-image")!.getAttribute("href")).toBe("vscode-webview-resource://fake/workspace/diagram.png")
		);

		// Doesn't ask again once cached — a subsequent unrelated onChange
		// (which re-runs the resolver for every still-mounted image node)
		// must not re-request the same key.
		selectNodeByText("Branch A");
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "resolveImage" }));
		void nodeId;
	});

	it("resolves a remote (scheme-qualified) image embed synchronously, with no host round trip", async () => {
		const { postMessage } = await freshApp();
		sendFromHost({ type: "setConfig", config: { writeDebounceMs: 400, animationNodeThreshold: 500, headingDepth: 1, layoutMode: "balanced" } });
		sendFromHost({ type: "setDocument", text: "# Root\n## Branch A ![pic](https://example.com/pic.png)\n", version: 1, title: "fallback" });

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "resolveImage" }));
		expect(document.querySelector<SVGImageElement>(".mm-node-image")!.getAttribute("href")).toBe("https://example.com/pic.png");
	});
});
