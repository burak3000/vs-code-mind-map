import { describe, expect, it } from "vitest";
import { parseExternalPaste } from "../webview/sync/parseExternalPaste";
import { serializeSubtree, serializeSubtrees } from "../webview/sync/serializer";
import { parseMindMap } from "../webview/sync/parser";

describe("parseExternalPaste", () => {
	it("returns nothing for empty/whitespace-only text", () => {
		expect(parseExternalPaste("")).toEqual([]);
		expect(parseExternalPaste("   \n  \n")).toEqual([]);
	});

	it("a single plain line becomes one leaf node", () => {
		const nodes = parseExternalPaste("Hello world");
		expect(nodes.length).toBe(1);
		expect(nodes[0].text).toBe("Hello world");
		expect(nodes[0].children).toEqual([]);
	});

	it("multiple plain lines (no list/heading markers) become one leaf node per non-blank line", () => {
		const nodes = parseExternalPaste("Line one\n\nLine two\nLine three");
		expect(nodes.map((n) => n.text)).toEqual(["Line one", "Line two", "Line three"]);
		expect(nodes.every((n) => n.children.length === 0)).toBe(true);
	});

	it("a markdown list becomes top-level subtrees, preserving nesting", () => {
		const nodes = parseExternalPaste(["- a", "  - a1", "- b"].join("\n"));
		expect(nodes.map((n) => n.text)).toEqual(["a", "b"]);
		expect(nodes[0].children.map((n) => n.text)).toEqual(["a1"]);
	});

	it("a document starting with an H1 becomes a single subtree with nested heading levels", () => {
		const nodes = parseExternalPaste(["# Title", "## Sub A", "## Sub B"].join("\n"));
		expect(nodes.length).toBe(1);
		expect(nodes[0].text).toBe("Title");
		expect(nodes[0].children.map((n) => n.text)).toEqual(["Sub A", "Sub B"]);
	});

	it("round-trips serializeSubtree's own output back into an equivalent structure", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];

		const nodes = parseExternalPaste(serializeSubtree(branchA));
		expect(nodes.length).toBe(1);
		expect(nodes[0].text).toBe("Branch A");
		expect(nodes[0].children.map((n) => n.text)).toEqual(["a", "b"]);
		expect(nodes[0].children[0].children.map((n) => n.text)).toEqual(["a1"]);
	});

	it("round-trips serializeSubtrees' multi-subtree output as separate top-level nodes", () => {
		const md = ["# Root", "## Branch A", "- a", "## Branch B", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		const [branchA, branchB] = model.root.children;

		const nodes = parseExternalPaste(serializeSubtrees([branchA, branchB]));
		expect(nodes.map((n) => n.text)).toEqual(["Branch A", "Branch B"]);
	});

	it("mints fresh ids that never collide with the source parse's ids, all the way down the subtree", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];
		const sourceIds = new Set([branchA.id, ...branchA.children.map((c) => c.id), branchA.children[0].children[0].id]);

		const [pasted] = parseExternalPaste(serializeSubtree(branchA));
		const collect = (n: (typeof pasted)[]): string[] => n.flatMap((x) => [x.id, ...collect(x.children)]);
		const pastedIds = collect([pasted]);

		expect(pastedIds.length).toBe(3); // node + a + a1
		expect(new Set(pastedIds).size).toBe(3); // all unique among themselves
		for (const id of pastedIds) expect(sourceIds.has(id)).toBe(false);
	});

	it("every returned subtree is detached (parent: null) at the top, with parent links fixed up below it", () => {
		const nodes = parseExternalPaste(["- a", "  - a1"].join("\n"));
		expect(nodes[0].parent).toBeNull();
		expect(nodes[0].children[0].parent).toBe(nodes[0]);
	});
});
