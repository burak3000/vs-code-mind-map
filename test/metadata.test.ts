import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import {
	applyMindmapData,
	applyMindmapDataToTree,
	extractMindmapData,
	ensurePersistentIds,
	isSyntheticId,
} from "../webview/sync/metadata";

describe("extractMindmapData", () => {
	it("returns empty nodes when there is no frontmatter", () => {
		expect(extractMindmapData(null)).toEqual({ nodes: {} });
	});

	it("returns empty nodes when frontmatter has no mindmap key", () => {
		const fm = ["---", "tags: [a, b]", "---"].join("\n");
		expect(extractMindmapData(fm)).toEqual({ nodes: {} });
	});

	it("parses folded node entries", () => {
		const fm = ["---", "mindmap:", "  nodes:", "    ^abc123: { folded: true }", "    ^def456: { folded: true }", "---"].join("\n");
		expect(extractMindmapData(fm)).toEqual({ nodes: { abc123: { folded: true }, def456: { folded: true } } });
	});

	it("ignores entries without folded:true", () => {
		const fm = ["---", "mindmap:", "  nodes:", "    ^abc123: { }", "---"].join("\n");
		expect(extractMindmapData(fm)).toEqual({ nodes: {} });
	});

	it("stops at the next top-level key (doesn't swallow unrelated frontmatter)", () => {
		const fm = ["---", "mindmap:", "  nodes:", "    ^abc123: { folded: true }", "tags: [x]", "---"].join("\n");
		expect(extractMindmapData(fm)).toEqual({ nodes: { abc123: { folded: true } } });
	});
});

describe("applyMindmapDataToTree", () => {
	it("sets folded=true on matching nodes by block id", () => {
		const model = parseMindMap(["# Root", "## Branch A ^abc123"].join("\n"), "fallback");
		applyMindmapDataToTree(model.byId, { nodes: { abc123: { folded: true } } });
		expect(model.root.children[0].folded).toBe(true);
	});

	it("ignores ids that don't match any node", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		expect(() => applyMindmapDataToTree(model.byId, { nodes: { nonexistent: { folded: true } } })).not.toThrow();
	});
});

describe("applyMindmapData (round-trip on frontmatter text)", () => {
	it("returns null when there is nothing to persist and no existing frontmatter", () => {
		expect(applyMindmapData(null, { nodes: {} })).toBeNull();
	});

	it("creates a new frontmatter block when there is metadata but no existing frontmatter", () => {
		const result = applyMindmapData(null, { nodes: { abc123: { folded: true } } });
		expect(result).toBe(["---", "mindmap:", "  nodes:", "    ^abc123: { folded: true }", "---"].join("\n"));
	});

	it("inserts the mindmap key into existing frontmatter without disturbing other keys", () => {
		const existing = ["---", "tags: [foo]", "aliases:", "  - Bar", "---"].join("\n");
		const result = applyMindmapData(existing, { nodes: { abc123: { folded: true } } });
		expect(result).toBe(["---", "mindmap:", "  nodes:", "    ^abc123: { folded: true }", "tags: [foo]", "aliases:", "  - Bar", "---"].join("\n"));
	});

	it("replaces an existing mindmap block in place, leaving surrounding keys untouched", () => {
		const existing = ["---", "tags: [foo]", "mindmap:", "  nodes:", "    ^old111: { folded: true }", "aliases:", "  - Bar", "---"].join("\n");
		const result = applyMindmapData(existing, { nodes: { new222: { folded: true } } });
		expect(result).toBe(["---", "tags: [foo]", "mindmap:", "  nodes:", "    ^new222: { folded: true }", "aliases:", "  - Bar", "---"].join("\n"));
	});

	it("removes the mindmap block entirely when metadata becomes empty, preserving other keys", () => {
		const existing = ["---", "tags: [foo]", "mindmap:", "  nodes:", "    ^abc123: { folded: true }", "---"].join("\n");
		const result = applyMindmapData(existing, { nodes: {} });
		expect(result).toBe(["---", "tags: [foo]", "---"].join("\n"));
	});

	it("drops the whole frontmatter block if nothing remains after removing our subtree", () => {
		const existing = ["---", "mindmap:", "  nodes:", "    ^abc123: { folded: true }", "---"].join("\n");
		const result = applyMindmapData(existing, { nodes: {} });
		expect(result).toBeNull();
	});

	it("round-trips through extract -> apply -> extract without drift", () => {
		const original = { nodes: { a1: { folded: true }, b2: { folded: true } } };
		const text = applyMindmapData(null, original);
		expect(extractMindmapData(text)).toEqual(original);
	});
});

describe("ensurePersistentIds", () => {
	it("mints a persistent id for a folded node with a synthetic id", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		expect(isSyntheticId(branch.id)).toBe(true);
		branch.folded = true;
		branch.children.push({ id: "child-synthetic", text: "x", children: [], parent: branch, depth: 2, folded: false, subtreeCount: 0 });

		ensurePersistentIds(model.root, model.byId, () => "fixedid1");
		expect(branch.id).toBe("fixedid1");
		expect(model.byId.get("fixedid1")).toBe(branch);
	});

	it("does not touch a node that already has a non-synthetic id", () => {
		const model = parseMindMap(["# Root", "## Branch A ^already1"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.folded = true;
		ensurePersistentIds(model.root, model.byId, () => "shouldnotuse");
		expect(branch.id).toBe("already1");
	});

	it("leaves nodes without metadata alone", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		const originalId = branch.id;
		ensurePersistentIds(model.root, model.byId, () => "shouldnotuse");
		expect(branch.id).toBe(originalId);
	});

	it("avoids id collisions by retrying the generator", () => {
		const model = parseMindMap(["# Root", "## Branch A", "## Branch B"].join("\n"), "fallback");
		model.root.children[0].folded = true;
		model.root.children[1].folded = true;
		let call = 0;
		const ids = ["dup", "dup", "unique2"];
		ensurePersistentIds(model.root, model.byId, () => ids[call++]);
		const [a, b] = model.root.children;
		expect(new Set([a.id, b.id]).size).toBe(2);
	});
});
