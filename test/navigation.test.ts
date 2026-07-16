import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { computeLayout, DEFAULT_LAYOUT_CONFIG } from "../webview/layout/layoutEngine";
import { collectVisibleNodes } from "../webview/model/visibility";
import { findNearestInDirection, navigateFrom } from "../webview/render/navigation";
import { assignMissingSides } from "../webview/layout/sides";

// right-only for most cases below: these tests are about direction-scan
// logic itself, not left/right balancing (covered in layout.test.ts), and
// balanced mode can put siblings on independently-centered sides, which
// would make a single global up/down/left/right ordering ambiguous.
const RIGHT_ONLY = { ...DEFAULT_LAYOUT_CONFIG, mode: "right-only" as const };

describe("findNearestInDirection", () => {
	it("moves right from root to the nearest first-level branch", () => {
		const md = ["# Root", "## Branch A", "## Branch B", "## Branch C"].join("\n");
		const model = parseMindMap(md, "fallback");
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);

		const next = findNearestInDirection(visible, model.root, "right");
		expect(next).not.toBeNull();
		expect(next!.depth).toBe(1);
	});

	it("moves down/up between siblings ordered by their breadth-axis position", () => {
		const md = ["# Root", "## Branch A", "## Branch B", "## Branch C"].join("\n");
		const model = parseMindMap(md, "fallback");
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);
		const [a, b, c] = model.root.children;
		const sortedByY = [a, b, c].slice().sort((x, y) => x.layout!.y - y.layout!.y);

		const down = findNearestInDirection(visible, sortedByY[0], "down");
		expect(down!.id).toBe(sortedByY[1].id);
		const up = findNearestInDirection(visible, sortedByY[1], "up");
		expect(up!.id).toBe(sortedByY[0].id);
	});

	it("returns null when there is nothing further in that direction", () => {
		const md = ["# Root", "## Branch A"].join("\n");
		const model = parseMindMap(md, "fallback");
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);
		const branch = model.root.children[0];
		expect(findNearestInDirection(visible, branch, "right")).toBeNull();
		expect(findNearestInDirection(visible, model.root, "left")).toBeNull();
	});

	it("excludes nodes hidden behind a folded ancestor", () => {
		const md = ["# Root", "## Branch A", "- a", "## Branch B"].join("\n");
		const model = parseMindMap(md, "fallback");
		model.root.children[0].folded = true;
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);
		expect(visible.some((n) => n.text === "a")).toBe(false);
	});
});

describe("navigateFrom", () => {
	it("moves toward the parent and back to the vertically-nearest child on a right-side branch", () => {
		const md = ["# Root", "## Branch A", "- child 1", "- child 2"].join("\n");
		const model = parseMindMap(md, "fallback");
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);
		const branchA = model.root.children[0];
		const [child1, child2] = branchA.children;

		expect(navigateFrom(branchA, "left", visible)?.id).toBe(model.root.id);
		expect(navigateFrom(model.root, "right", visible)?.id).toBe(branchA.id);

		const branchCenter = branchA.layout!.y + branchA.layout!.h / 2;
		const childCenter = (n: typeof child1) => n.layout!.y + n.layout!.h / 2;
		const expectedNearest = Math.abs(childCenter(child1) - branchCenter) <= Math.abs(childCenter(child2) - branchCenter) ? child1 : child2;
		const nearest = navigateFrom(branchA, "right", visible);
		expect(nearest?.id).toBe(expectedNearest.id);
	});

	it("skips folded children when moving away from the root", () => {
		const md = ["# Root", "## Branch A", "- child"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];
		branchA.folded = true;
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);

		expect(navigateFrom(branchA, "right", visible)).toBeNull();
	});

	it("moves up/down between siblings within a branch", () => {
		const md = ["# Root", "## Branch A", "- child 1", "- child 2", "- child 3"].join("\n");
		const model = parseMindMap(md, "fallback");
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);
		const [c1, c2, c3] = model.root.children[0].children;
		const sorted = [c1, c2, c3].slice().sort((a, b) => a.layout!.y - b.layout!.y);

		expect(navigateFrom(sorted[0], "down", visible)?.id).toBe(sorted[1].id);
		expect(navigateFrom(sorted[1], "down", visible)?.id).toBe(sorted[2].id);
		expect(navigateFrom(sorted[1], "up", visible)?.id).toBe(sorted[0].id);
		expect(navigateFrom(sorted[2], "down", visible)).toBeNull(); // last sibling, nothing further below on this side
	});

	it("falls back across branches on up/down without crossing to the other side", () => {
		const md = ["# Root", "## Branch A", "- only child", "## Branch B", "- only child"].join("\n");
		const model = parseMindMap(md, "fallback");
		computeLayout(model.root, RIGHT_ONLY);
		const visible = collectVisibleNodes(model.root);
		const [branchA, branchB] = model.root.children;
		const [lower, upper] = [branchA, branchB].sort((a, b) => a.layout!.y - b.layout!.y);

		const next = navigateFrom(lower.children[0], "down", visible);
		expect(next).not.toBeNull();
		expect(next!.layout!.side).toBe("R");
	});

	it("regression: Up/Down between first-level branches never crosses from one side to the other in balanced mode", () => {
		// Balanced mode centers the left and right branch groups
		// independently (see the RIGHT_ONLY comment at the top of this
		// file), so their `y` values don't share a single consistent order.
		// siblingInDirection used to sort *all* of root's children by that
		// raw `y` regardless of side, so a Down press from a right-side
		// branch could land on a left-side one — a jump clear across the
		// map instead of stopping at the edge of that side's own group.
		const md = ["# Root", "## Branch A", "- a1", "- a2", "## Branch B", "- b1", "- b2", "## Branch C", "- c1", "## Branch D", "- d1", "- d2"].join(
			"\n"
		);
		const model = parseMindMap(md, "fallback");
		assignMissingSides(model.root); // real usage always assigns sides before layout — see MindMapView.onChange
		computeLayout(model.root, DEFAULT_LAYOUT_CONFIG);
		const visible = collectVisibleNodes(model.root);

		for (const branch of model.root.children) {
			const next = navigateFrom(branch, "down", visible);
			if (next) expect(next.layout!.side).toBe(branch.layout!.side);
			const prev = navigateFrom(branch, "up", visible);
			if (prev) expect(prev.layout!.side).toBe(branch.layout!.side);
		}
	});

	it("root left/right lands on the correct side only", () => {
		const md = ["# Root", "## Branch A", "## Branch B"].join("\n");
		const model = parseMindMap(md, "fallback");
		const [a, b] = model.root.children;
		a.branchSide = "L";
		b.branchSide = "R";
		computeLayout(model.root, DEFAULT_LAYOUT_CONFIG);
		const visible = collectVisibleNodes(model.root);

		expect(navigateFrom(model.root, "left", visible)?.id).toBe(a.id);
		expect(navigateFrom(model.root, "right", visible)?.id).toBe(b.id);
	});
});
