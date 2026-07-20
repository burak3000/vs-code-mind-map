import { describe, expect, it } from "vitest";
import { computeLayout, computeNodeBox, estimateNodeWidth, fontSizeForDepth, scaleForDepth, defaultWrapWidthForDepth, DEFAULT_LAYOUT_CONFIG } from "../webview/layout/layoutEngine";
import { assignMissingSides } from "../webview/layout/sides";
import { buildModel } from "./helpers/render";

describe("fontSizeForDepth (R15: visual hierarchy by size)", () => {
	it("is largest at the root and strictly decreases for a few levels", () => {
		const sizes = [0, 1, 2, 3].map((d) => fontSizeForDepth(d, DEFAULT_LAYOUT_CONFIG));
		expect(sizes[0]).toBe(DEFAULT_LAYOUT_CONFIG.rootFontSize);
		for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
	});

	it("floors at minFontSize instead of shrinking indefinitely for very deep nodes", () => {
		expect(fontSizeForDepth(50, DEFAULT_LAYOUT_CONFIG)).toBe(DEFAULT_LAYOUT_CONFIG.minFontSize);
	});
});

it("estimateNodeWidth clamps to the configured min/max width at a given depth", () => {
	const scale = scaleForDepth(0, DEFAULT_LAYOUT_CONFIG);
	expect(estimateNodeWidth("", DEFAULT_LAYOUT_CONFIG, 0)).toBe(DEFAULT_LAYOUT_CONFIG.minNodeWidth * scale);
	expect(estimateNodeWidth("x".repeat(200), DEFAULT_LAYOUT_CONFIG, 0)).toBe(defaultWrapWidthForDepth(0, DEFAULT_LAYOUT_CONFIG));
});

describe("computeNodeBox (long-text wrapping)", () => {
	it("keeps a short text on one line at that depth's single-row height", () => {
		const box = computeNodeBox("short title", DEFAULT_LAYOUT_CONFIG, 1);
		expect(box.lines.length).toBe(1);
		expect(box.h).toBeCloseTo(DEFAULT_LAYOUT_CONFIG.nodeHeight * scaleForDepth(1, DEFAULT_LAYOUT_CONFIG));
	});

	it("wraps text past the default ~60-char width onto additional lines and grows height accordingly", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const depth = 1;
		const box = computeNodeBox(longText, DEFAULT_LAYOUT_CONFIG, depth);
		const scale = scaleForDepth(depth, DEFAULT_LAYOUT_CONFIG);
		expect(box.lines.length).toBeGreaterThan(1);
		expect(box.h).toBeCloseTo(DEFAULT_LAYOUT_CONFIG.nodeHeight * scale + (box.lines.length - 1) * DEFAULT_LAYOUT_CONFIG.lineHeight * scale);
		expect(box.w).toBeLessThanOrEqual(defaultWrapWidthForDepth(depth, DEFAULT_LAYOUT_CONFIG));
	});

	it("uses manualWidth as the wrap ceiling instead of the depth-scaled default when set", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const narrow = computeNodeBox(longText, DEFAULT_LAYOUT_CONFIG, 1, 120);
		const wide = computeNodeBox(longText, DEFAULT_LAYOUT_CONFIG, 1, 800);
		expect(narrow.w).toBeLessThanOrEqual(120);
		expect(narrow.lines.length).toBeGreaterThan(wide.lines.length);
	});

	it("gives identical text a strictly smaller box the deeper it is (R15)", () => {
		const text = "same text everywhere";
		const shallow = computeNodeBox(text, DEFAULT_LAYOUT_CONFIG, 0);
		const mid = computeNodeBox(text, DEFAULT_LAYOUT_CONFIG, 2);
		const deep = computeNodeBox(text, DEFAULT_LAYOUT_CONFIG, 4);
		expect(shallow.h).toBeGreaterThan(mid.h);
		expect(mid.h).toBeGreaterThan(deep.h);
		expect(shallow.w).toBeGreaterThan(mid.w);
		expect(mid.w).toBeGreaterThan(deep.w);
	});
});

describe("computeNodeBox with image embeds (plan item 07, decision A: fixed-size thumb)", () => {
	it.each([
		["plain text", "text without an embed"],
		["![[note.pdf]]", "a non-image embed"],
	])("has no imageBox for %s", (text) => {
		expect(computeNodeBox(text, DEFAULT_LAYOUT_CONFIG, 1).imageBox).toBeNull();
	});

	it("grows the box height by the depth-scaled thumb height + gap when text has an image embed", () => {
		const depth = 1;
		const scale = scaleForDepth(depth, DEFAULT_LAYOUT_CONFIG);
		const withoutEmbed = computeNodeBox("caption", DEFAULT_LAYOUT_CONFIG, depth);
		const withEmbed = computeNodeBox("caption ![[photo.png]]", DEFAULT_LAYOUT_CONFIG, depth);
		const expectedThumbH = DEFAULT_LAYOUT_CONFIG.imageThumbHeight * scale;
		const expectedGap = DEFAULT_LAYOUT_CONFIG.imageThumbGap * scale;
		expect(withEmbed.h).toBeCloseTo(withoutEmbed.h + expectedGap + expectedThumbH);
	});

	it("widens the box to fit the thumb when the text alone would be narrower", () => {
		const depth = 2;
		const scale = scaleForDepth(depth, DEFAULT_LAYOUT_CONFIG);
		const box = computeNodeBox("hi ![[photo.png]]", DEFAULT_LAYOUT_CONFIG, depth);
		expect(box.w).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_CONFIG.imageThumbWidth * scale);
	});

	it("never lets the thumb make the box narrower than the text alone required", () => {
		const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const box = computeNodeBox(words + " ![[photo.png]]", DEFAULT_LAYOUT_CONFIG, 0);
		const textOnly = computeNodeBox(words, DEFAULT_LAYOUT_CONFIG, 0);
		expect(box.w).toBeGreaterThanOrEqual(textOnly.w);
	});

	it("box geometry never depends on the image's own dimensions (decision A: fixed thumb, no layout-on-load)", () => {
		// Same config/depth/text -> identical imageBox every time, regardless of
		// what the actual image file looks like.
		expect(computeNodeBox("![[photo.png]]", DEFAULT_LAYOUT_CONFIG, 1).imageBox).toEqual(computeNodeBox("![[photo.png]]", DEFAULT_LAYOUT_CONFIG, 1).imageBox);
	});

	it("never overlaps an image-embed node's (much taller) box with its plain-text neighbors' boxes", () => {
		const md = ["# Root", "## caption A", "## caption ![[photo.png]]", "## caption B"].join("\n");
		const model = buildModel(md, { mode: "right-only" });
		expectNoVerticalOverlap(model.root.children);
	});
});

function expectNoVerticalOverlap(siblings: { layout?: { y: number; h: number } }[]): void {
	for (let i = 1; i < siblings.length; i++) {
		const prev = siblings[i - 1].layout!;
		const cur = siblings[i].layout!;
		expect(cur.y).toBeGreaterThanOrEqual(prev.y + prev.h);
	}
}

describe("computeLayout with wrapped nodes", () => {
	it("gives a wrapped (multi-line) node a taller layout box than a single-line sibling", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const model = buildModel(["# Root", `## ${longText}`, "## short"].join("\n"), { mode: "right-only" });
		const [wrapped, short] = model.root.children; // both depth 1
		expect(wrapped.layout!.h).toBeGreaterThan(short.layout!.h);
		expect(short.layout!.h).toBeCloseTo(DEFAULT_LAYOUT_CONFIG.nodeHeight * scaleForDepth(1, DEFAULT_LAYOUT_CONFIG));
	});

	it("never overlaps a tall wrapped sibling's box with its shorter neighbors' boxes (regression: flextree's footprint center was mistaken for the box's top edge)", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const model = buildModel(["# Root", "## short A", `## ${longText}`, "## short B"].join("\n"), { mode: "right-only" });
		expectNoVerticalOverlap(model.root.children); // document order == breadth order here
	});

	it("respects a node's manualWidth as its wrap ceiling instead of the depth-scaled default", () => {
		// Fits on one line at the depth-scaled default width, but a much
		// narrower manual width should force it to wrap.
		const model = buildModel(["# Root", "## one two three four five six"].join("\n"), { mode: "right-only" });
		const baselineHeight = DEFAULT_LAYOUT_CONFIG.nodeHeight * scaleForDepth(1, DEFAULT_LAYOUT_CONFIG);
		expect(model.root.children[0].layout!.h).toBeCloseTo(baselineHeight); // single line by default

		model.root.children[0].manualWidth = 100;
		computeLayout(model.root, { ...DEFAULT_LAYOUT_CONFIG, mode: "right-only" });
		expect(model.root.children[0].layout!.w).toBeLessThanOrEqual(100);
		expect(model.root.children[0].layout!.h).toBeGreaterThan(baselineHeight); // now wraps
	});

	it("gives the root the largest box and each deeper level a strictly smaller one, same text everywhere (R15)", () => {
		const text = "same text everywhere";
		const model = buildModel(["# " + text, "## " + text, "- " + text, "  - " + text].join("\n"), { mode: "right-only" });

		let node = model.root;
		const heights: number[] = [];
		while (node) {
			heights.push(node.layout!.h);
			node = node.children[0];
		}
		expect(heights.length).toBe(4); // root, branch, list item, nested list item
		for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeLessThan(heights[i - 1]);
	});
});

describe("computeLayout (right-only)", () => {
	it("places the root at depth-axis 0 and children strictly increasing in depth-axis x", () => {
		const model = buildModel(["# Root", "## Branch A", "- a", "  - a1"].join("\n"), { mode: "right-only" });
		expect(model.root.layout?.x).toBe(0);
		const branch = model.root.children[0];
		const a = branch.children[0];
		const a1 = a.children[0];
		expect(branch.layout!.x).toBeGreaterThan(model.root.layout!.x);
		expect(a.layout!.x).toBeGreaterThan(branch.layout!.x);
		expect(a1.layout!.x).toBeGreaterThan(a.layout!.x);
		expect(branch.layout!.side).toBe("R");
	});

	it("excludes folded subtrees from layout entirely (no stale/undefined layout leaks visibility)", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "## Branch B", "- b"].join("\n");
		const model = buildModel(md, { mode: "right-only" }, (m) => {
			m.root.children[0].folded = true;
		});
		const branchA = model.root.children[0];
		expect(model.root.layout).toBeDefined();
		expect(branchA.layout).toBeDefined(); // the folded node itself is still visible
		expect(branchA.children[0].layout).toBeUndefined(); // its children are not
	});

	it("gives siblings distinct y (breadth-axis) positions", () => {
		const model = buildModel(["# Root", "## Branch A", "## Branch B", "## Branch C"].join("\n"), { mode: "right-only" });
		const ys = model.root.children.map((n) => n.layout!.y);
		expect(new Set(ys).size).toBe(3);
	});
});

describe("computeLayout (left-only)", () => {
	it("mirrors children to negative depth-axis x", () => {
		const model = buildModel(["# Root", "## Branch A", "- a"].join("\n"), { mode: "left-only" });
		const branch = model.root.children[0];
		expect(branch.layout!.x).toBeLessThan(0);
		expect(branch.layout!.side).toBe("L");
		expect(branch.children[0].layout!.x).toBeLessThan(branch.layout!.x);
	});

	it("grows a long-text box further left (outer edge), keeping its inner edge next to the parent fixed", () => {
		// The box edge nearest the parent (where the connector anchors) must
		// stay put as text length changes — only the far/outer edge moves. A
		// left-side node's box spans [x, x+w], so growing it must decrease x.
		const shortBranch = buildModel(["# Root", "## a"].join("\n"), { mode: "left-only" }).root.children[0];
		const longBranch = buildModel(["# Root", "## " + "a".repeat(100)].join("\n"), { mode: "left-only" }).root.children[0];

		expect(longBranch.layout!.x + longBranch.layout!.w).toBeCloseTo(shortBranch.layout!.x + shortBranch.layout!.w); // inner edge unchanged
		expect(longBranch.layout!.x).toBeLessThan(shortBranch.layout!.x); // outer edge moved further away from the root
	});
});

describe("computeLayout (balanced, the default)", () => {
	function buildBalanced(md: string) {
		return buildModel(md, undefined, (m) => assignMissingSides(m.root));
	}

	it("splits first-level branches across both sides of the root", () => {
		const model = buildBalanced(["# Root", "## A", "## B", "## C", "## D"].join("\n"));
		const sides = new Set(model.root.children.map((c) => c.layout!.side));
		expect(sides.has("L")).toBe(true);
		expect(sides.has("R")).toBe(true);
	});

	it("keeps every node in a subtree consistent with its branch's side", () => {
		const model = buildBalanced(["# Root", "## A", "- a1", "  - a2", "## B", "- b1"].join("\n"));
		for (const branch of model.root.children) {
			const side = branch.layout!.side;
			const walk = (n: typeof branch) => {
				expect(n.layout!.side).toBe(side);
				n.children.forEach(walk);
			};
			walk(branch);
		}
	});

	it("balances heavier subtrees against lighter ones rather than just alternating", () => {
		// A is much heavier than B, C, D combined; a good balance should not put
		// A alone against all three others without regard to weight.
		const model = buildBalanced(["# Root", "## A", "- a1", "  - a2", "  - a3", "  - a4", "## B", "## C", "## D"].join("\n"));
		const [a, b, c, d] = model.root.children;
		const leftWeight = [a, b, c, d].filter((n) => n.layout!.side === "L").reduce((sum, n) => sum + 1 + n.subtreeCount, 0);
		const rightWeight = [a, b, c, d].filter((n) => n.layout!.side === "R").reduce((sum, n) => sum + 1 + n.subtreeCount, 0);
		expect(Math.abs(leftWeight - rightWeight)).toBeLessThanOrEqual(Math.max(a.subtreeCount, 1));
	});

	it("root always resolves to depth-axis 0 regardless of side split", () => {
		const model = buildBalanced(["# Root", "## A", "## B"].join("\n"));
		expect(model.root.layout!.x).toBe(0);
		expect(model.root.layout!.y).toBe(0);
	});

	it("anticlockwise reading order (R-anticlockwise-order, decision (c)): left side top->bottom in document order, right side bottom->top in document order", () => {
		// Four equal-weight branches split evenly: A, B -> left; C, D -> right.
		const model = buildBalanced(["# Root", "## A", "## B", "## C", "## D"].join("\n"));
		const [a, b, c, d] = model.root.children;
		expect(a.layout!.side).toBe("L");
		expect(b.layout!.side).toBe("L");
		expect(c.layout!.side).toBe("R");
		expect(d.layout!.side).toBe("R");

		expect(a.layout!.y).toBeLessThan(b.layout!.y); // left reads top->bottom in document order
		// Right reads bottom->top in document order: C (earlier) sits below D.
		expect(c.layout!.y).toBeGreaterThan(d.layout!.y);
	});
});
