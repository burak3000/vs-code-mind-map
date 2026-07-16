import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";

describe("parseMindMap", () => {
	it("uses the first H1 as the root and does not create a duplicate node for it", () => {
		const model = parseMindMap("# Central Topic\n## Branch A\n- child\n", "fallback");
		expect(model.root.text).toBe("Central Topic");
		expect(model.root.children).toHaveLength(1);
		expect(model.root.children[0].text).toBe("Branch A");
	});

	it("falls back to the provided title when there is no H1", () => {
		const model = parseMindMap("## Branch A\n- child\n", "My Note");
		expect(model.root.text).toBe("My Note");
		expect(model.root.children).toHaveLength(1);
		expect(model.root.children[0].text).toBe("Branch A");
	});

	it("nests list items by indentation depth under their heading", () => {
		const md = ["# Root", "## Branch A", "- level2", "  - level3", "    - level4", "- level2 again"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branch = model.root.children[0];
		expect(branch.children.map((n) => n.text)).toEqual(["level2", "level2 again"]);
		const level2 = branch.children[0];
		expect(level2.children).toHaveLength(1);
		expect(level2.children[0].text).toBe("level3");
		expect(level2.children[0].children[0].text).toBe("level4");
	});

	it("dedents correctly back to a shallower list level", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "  - a2", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branch = model.root.children[0];
		expect(branch.children.map((n) => n.text)).toEqual(["a", "b"]);
		expect(branch.children[0].children.map((n) => n.text)).toEqual(["a1", "a2"]);
	});

	it("starts a fresh branch on each H2, independent of prior list depth", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "## Branch B", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		expect(model.root.children.map((n) => n.text)).toEqual(["Branch A", "Branch B"]);
		expect(model.root.children[1].children.map((n) => n.text)).toEqual(["b"]);
	});

	it("computes subtreeCount incrementally correct (descendant counts, not including self)", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "  - a2", "## Branch B"].join("\n");
		const model = parseMindMap(md, "fallback");
		expect(model.root.subtreeCount).toBe(5); // A, a, a1, a2, B
		expect(model.root.children[0].subtreeCount).toBe(3); // a, a1, a2
		expect(model.root.children[1].subtreeCount).toBe(0);
	});

	it("assigns a unique id to every node and indexes it in byId", () => {
		const md = ["# Root", "## Branch A", "- a", "## Branch B", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		const ids = new Set<string>();
		const walk = (n: typeof model.root) => {
			expect(ids.has(n.id)).toBe(false);
			ids.add(n.id);
			expect(model.byId.get(n.id)).toBe(n);
			n.children.forEach(walk);
		};
		walk(model.root);
		expect(ids.size).toBe(5); // root, A, a, B, b
	});

	it("sets depth correctly at every level", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1"].join("\n");
		const model = parseMindMap(md, "fallback");
		expect(model.root.depth).toBe(0);
		expect(model.root.children[0].depth).toBe(1);
		expect(model.root.children[0].children[0].depth).toBe(2);
		expect(model.root.children[0].children[0].children[0].depth).toBe(3);
	});
});
