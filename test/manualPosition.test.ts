import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { computeLayout, DEFAULT_LAYOUT_CONFIG, scaleForDepth } from "../webview/layout/layoutEngine";
import { assignMissingSides } from "../webview/layout/sides";

/** Single-line box height at a given depth (R15: depth-scaled visual hierarchy) — mirrors what `computeNodeBox` derives internally. */
function heightAtDepth(depth: number): number {
	return DEFAULT_LAYOUT_CONFIG.nodeHeight * scaleForDepth(depth, DEFAULT_LAYOUT_CONFIG);
}

describe("computeLayout with manualPos (R12)", () => {
	it("places a manually-positioned node exactly at its pin, ignoring auto-balance", () => {
		const model = parseMindMap(["# Root", "## A", "## B", "## C"].join("\n"), "fallback");
		assignMissingSides(model.root);
		const pinned = model.root.children[1]; // depth 1
		pinned.manualPos = { x: 500, y: -300 };

		computeLayout(model.root);
		expect(pinned.layout).toEqual({ x: 500, y: -300, w: pinned.layout!.w, h: heightAtDepth(1), side: "R" });
	});

	it("infers side from the pin's position relative to its parent", () => {
		const model = parseMindMap(["# Root", "## A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.manualPos = { x: -200, y: 0 }; // to the left of root (x=0)
		computeLayout(model.root);
		expect(branch.layout!.side).toBe("L");

		branch.manualPos = { x: 200, y: 0 }; // to the right of root
		computeLayout(model.root);
		expect(branch.layout!.side).toBe("R");
	});

	it("excludes a pinned node from the auto-balance weight calculation, so it doesn't consume space among auto siblings", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		assignMissingSides(model.root);
		const [a, b] = model.root.children;
		a.manualPos = { x: 999, y: 999 };

		computeLayout(model.root);
		// B is the only auto-managed child now; it should land exactly at the
		// root's own depth-axis offset (no other sibling to share space with).
		expect(b.layout!.y).toBe(0);
	});

	it("lays out a pinned node's own auto children relative to its pin, not the true root", () => {
		const model = parseMindMap(["# Root", "## A", "- a1", "  - a2"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.manualPos = { x: 400, y: 100 };

		computeLayout(model.root);
		const a1 = branch.children[0];
		const a2 = a1.children[0];
		expect(a1.layout!.x).toBeGreaterThan(branch.layout!.x); // still grows away from the pin
		expect(a2.layout!.x).toBeGreaterThan(a1.layout!.x);
	});

	it("supports a manually-positioned node nested under an auto-laid-out branch", () => {
		const model = parseMindMap(["# Root", "## A", "- a1", "- a2"].join("\n"), "fallback");
		const branch = model.root.children[0];
		const a1 = branch.children[0];
		a1.manualPos = { x: 700, y: -50 };

		computeLayout(model.root);
		expect(a1.layout).toEqual({ x: 700, y: -50, w: a1.layout!.w, h: heightAtDepth(2), side: a1.layout!.side });
		// its auto sibling a2 is unaffected and still gets a normal position.
		expect(branch.children[1].layout).toBeDefined();
	});

	it("handles a chain of manually-positioned nodes (pinned child of a pinned node)", () => {
		const model = parseMindMap(["# Root", "## A", "- a1"].join("\n"), "fallback");
		const branch = model.root.children[0];
		const a1 = branch.children[0];
		branch.manualPos = { x: 300, y: 0 };
		a1.manualPos = { x: 900, y: 200 };

		computeLayout(model.root);
		expect(branch.layout).toEqual({ x: 300, y: 0, w: branch.layout!.w, h: heightAtDepth(1), side: "R" });
		expect(a1.layout).toEqual({ x: 900, y: 200, w: a1.layout!.w, h: heightAtDepth(2), side: "R" });
	});
});
