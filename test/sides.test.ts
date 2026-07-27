import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { assignMissingSides, clearAllSides } from "../webview/layout/sides";
import { DEFAULT_LAYOUT_CONFIG, estimateSubtreeHeight } from "../webview/layout/layoutEngine";

describe("assignMissingSides", () => {
	it("gives every first-level branch a side", () => {
		const model = parseMindMap(["# Root", "## A", "## B", "## C"].join("\n"), "fallback");
		assignMissingSides(model.root);
		expect(model.root.children.every((c) => c.branchSide === "L" || c.branchSide === "R")).toBe(true);
	});

	it("never reassigns an existing branchSide", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		model.root.children[0].branchSide = "R";
		assignMissingSides(model.root);
		expect(model.root.children[0].branchSide).toBe("R");
	});

	it("does not move existing branches when a new one is added (the sticky-sides fix)", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		assignMissingSides(model.root);
		const aSide = model.root.children[0].branchSide;
		const bSide = model.root.children[1].branchSide;

		model.root.children.push({
			id: "new",
			text: "C",
			children: [],
			parent: model.root,
			depth: 1,
			folded: false,
			subtreeCount: 0,
		});
		assignMissingSides(model.root);

		expect(model.root.children[0].branchSide).toBe(aSide);
		expect(model.root.children[1].branchSide).toBe(bSide);
		expect(model.root.children[2].branchSide).toBeDefined();
	});

	it("a new branch inherits the side of its nearest already-assigned neighbor, not whichever side is lighter (R-anticlockwise-order: split only recomputes on Rebalance)", () => {
		const model = parseMindMap(["# Root", "## Heavy", "- h1", "  - h2", "  - h3", "## Light"].join("\n"), "fallback");
		model.root.children[0].branchSide = "L"; // Heavy, much more weight
		model.root.children[1].branchSide = "L"; // Light, pinned to the *same* side as Heavy
		model.root.children.push({
			id: "new",
			text: "New",
			children: [],
			parent: model.root,
			depth: 1,
			folded: false,
			subtreeCount: 0,
		});
		assignMissingSides(model.root);
		// A weight-greedy policy would put "New" on the (empty, lighter) right
		// side; adjacency-inherit instead extends the existing left run so the
		// left/right split stays a contiguous document-order prefix/suffix.
		expect(model.root.children[2].branchSide).toBe("L");
	});

	it("a branch inserted at the front inherits from the next sibling when there's no previous one", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		assignMissingSides(model.root);
		const [a, b] = model.root.children;
		const front: import("../webview/model/types").MindNode = {
			id: "front",
			text: "Front",
			children: [],
			parent: model.root,
			depth: 1,
			folded: false,
			subtreeCount: 0,
		};
		model.root.children.unshift(front);
		assignMissingSides(model.root);
		expect(front.branchSide).toBe(a.branchSide);
		expect(b.branchSide).toBeDefined();
	});

	it("computes a contiguous (non-interleaved) document-order split when assigning from scratch", () => {
		const md = ["# Root", "## A", "## B", "## C", "## D", "## E"].join("\n");
		const model = parseMindMap(md, "fallback");
		assignMissingSides(model.root);
		const sides = model.root.children.map((c) => c.branchSide);
		// Contiguous means at most one L->R transition across the whole run.
		let transitions = 0;
		for (let i = 1; i < sides.length; i++) if (sides[i] !== sides[i - 1]) transitions++;
		expect(transitions).toBeLessThanOrEqual(1);
	});

	it("Rebalance (clearAllSides + reassign) recomputes the split from scratch instead of reusing the old one", () => {
		const md = ["# Root", "## A", "- a1", "  - a2", "  - a3", "## B", "## C"].join("\n");
		const model = parseMindMap(md, "fallback");
		assignMissingSides(model.root);
		clearAllSides(model.root);
		assignMissingSides(model.root);
		expect(model.root.children.every((c) => c.branchSide === "L" || c.branchSide === "R")).toBe(true);
	});

	it("balances by estimated rendered height, not node count, when the two disagree", () => {
		// "Long" has a single child but its text wraps to dozens of lines —
		// far taller than "Short1"/"Short2" combined despite having the
		// fewest descendants. A node-count split (old `1 + subtreeCount`
		// weight) would pair "Long" (weight 2) with "Short1" (weight 4) on
		// one side against "Short2" (weight 4) alone on the other (k=2,
		// diff=2) — this asserts the height-aware split instead isolates
		// "Long" by itself (k=1), since its rendered height alone dwarfs
		// "Short1" + "Short2" combined.
		const longText = "word ".repeat(400).trim(); // many short tokens so the greedy wrapper actually breaks lines (a single unbroken token is never split, see textWrap.ts)
		const md = [
			"# Root",
			"## Long",
			`- ${longText}`,
			"## Short1",
			"- a",
			"- b",
			"- c",
			"## Short2",
			"- d",
			"- e",
			"- f",
		].join("\n");
		const model = parseMindMap(md, "fallback");
		const [long, short1, short2] = model.root.children;

		assignMissingSides(model.root, DEFAULT_LAYOUT_CONFIG);

		expect(long.branchSide).not.toBe(short1.branchSide);
		expect(short1.branchSide).toBe(short2.branchSide);
	});
});

describe("estimateSubtreeHeight", () => {
	it("grows with wrapped text length, not just descendant count", () => {
		const shortMd = ["# Root", "## A", "- a", "- b", "- c"].join("\n");
		const longMd = ["# Root", "## A", `- ${"word ".repeat(400).trim()}`].join("\n");
		const shortBranch = parseMindMap(shortMd, "fallback").root.children[0]; // 3 descendants
		const longBranch = parseMindMap(longMd, "fallback").root.children[0]; // 1 descendant, many wrapped lines

		expect(1 + shortBranch.subtreeCount).toBeGreaterThan(1 + longBranch.subtreeCount); // node-count says shortBranch is "heavier"
		expect(estimateSubtreeHeight(longBranch, DEFAULT_LAYOUT_CONFIG)).toBeGreaterThan(
			estimateSubtreeHeight(shortBranch, DEFAULT_LAYOUT_CONFIG)
		); // rendered height says the opposite
	});

	it("excludes a folded node's children (matches layoutSide's own visibility rule)", () => {
		const md = ["# Root", "## A", "- a1", "  - a2", "  - a3"].join("\n");
		const model = parseMindMap(md, "fallback");
		const a = model.root.children[0];
		const collapsed = estimateSubtreeHeight(a, DEFAULT_LAYOUT_CONFIG);
		a.folded = true;
		const folded = estimateSubtreeHeight(a, DEFAULT_LAYOUT_CONFIG);
		expect(folded).toBeLessThan(collapsed);
	});
});

describe("clearAllSides", () => {
	it("removes branchSide from every first-level branch so it can be recomputed", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		assignMissingSides(model.root);
		clearAllSides(model.root);
		expect(model.root.children.every((c) => c.branchSide === undefined)).toBe(true);
	});
});
