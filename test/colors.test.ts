import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { assignMissingColors, resolveNodeColorKey, strokeWidthForDepth } from "../webview/render/colors";
import { makeNode } from "./helpers/model";

describe("assignMissingColors", () => {
	it("gives every first-level branch a distinct colorKey", () => {
		const model = parseMindMap(["# Root", "## A", "## B", "## C"].join("\n"), "fallback");
		assignMissingColors(model.root);
		const keys = model.root.children.map((c) => c.colorKey);
		expect(keys.every(Boolean)).toBe(true);
		expect(new Set(keys).size).toBe(3);
	});

	it("does not reassign an existing colorKey", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		model.root.children[0].colorKey = "c5";
		assignMissingColors(model.root);
		expect(model.root.children[0].colorKey).toBe("c5");
	});

	it("keeps other branches' colors stable when a new branch is added", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		assignMissingColors(model.root);
		const aColor = model.root.children[0].colorKey;
		const bColor = model.root.children[1].colorKey;

		model.root.children.push(makeNode({ id: "new", text: "C", parent: model.root }));
		assignMissingColors(model.root);

		expect(model.root.children[0].colorKey).toBe(aColor);
		expect(model.root.children[1].colorKey).toBe(bColor);
		expect(model.root.children[2].colorKey).toBeDefined();
		expect(model.root.children[2].colorKey).not.toBe(aColor);
		expect(model.root.children[2].colorKey).not.toBe(bColor);
	});

	it("F1: clears a stale colorKey on any node whose parent is not the root", () => {
		const model = parseMindMap(["# Root", "## A", "- a", "## B"].join("\n"), "fallback");
		assignMissingColors(model.root);
		const branchA = model.root.children[0];
		const a = branchA.children[0];
		// Simulate a stale copy of a first-level colorKey landing on a
		// non-first-level node (e.g. a pre-fix cloneSubtree, or a moveNode
		// that reparented a former first-level branch deeper into the tree).
		a.colorKey = "c7";

		assignMissingColors(model.root);

		expect(a.colorKey).toBeUndefined();
		expect(resolveNodeColorKey(a)).toBe(branchA.colorKey);
	});

	it("F1: a first-level branch's own colorKey is untouched by the invariant clear", () => {
		const model = parseMindMap(["# Root", "## A", "## B"].join("\n"), "fallback");
		assignMissingColors(model.root);
		const before = model.root.children.map((c) => c.colorKey);
		assignMissingColors(model.root);
		expect(model.root.children.map((c) => c.colorKey)).toEqual(before);
	});
});

describe("resolveNodeColorKey", () => {
	it("descendants inherit their first-level ancestor's color", () => {
		const model = parseMindMap(["# Root", "## A", "- a", "  - a1"].join("\n"), "fallback");
		assignMissingColors(model.root);
		const branch = model.root.children[0];
		const a = branch.children[0];
		const a1 = a.children[0];
		expect(resolveNodeColorKey(a)).toBe(branch.colorKey);
		expect(resolveNodeColorKey(a1)).toBe(branch.colorKey);
	});

	it("root resolves to null (no branch color)", () => {
		const model = parseMindMap(["# Root", "## A"].join("\n"), "fallback");
		assignMissingColors(model.root);
		expect(resolveNodeColorKey(model.root)).toBeNull();
	});
});

describe("strokeWidthForDepth", () => {
	it("decreases with depth and floors at a minimum", () => {
		const w0 = strokeWidthForDepth(0);
		const w1 = strokeWidthForDepth(1);
		const w10 = strokeWidthForDepth(10);
		expect(w0).toBeGreaterThan(w1);
		expect(w1).toBeGreaterThan(w10);
		expect(w10).toBeGreaterThanOrEqual(1.5);
	});
});
