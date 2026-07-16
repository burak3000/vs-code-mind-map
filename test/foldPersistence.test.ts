import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap } from "../webview/sync/serializer";
import { ensurePersistentIds } from "../webview/sync/metadata";

describe("fold state persistence (end-to-end)", () => {
	it("persists a fold across a full serialize -> reparse cycle, minting a real block id", () => {
		const model = parseMindMap(["# Root", "## Branch A", "- a", "  - a1"].join("\n"), "fallback");
		const branch = model.root.children[0];
		expect(branch.id).toMatch(/^n\d+$/); // synthetic, not yet persisted

		branch.folded = true;
		ensurePersistentIds(model.root, model.byId, () => "abc123");
		expect(branch.id).toBe("abc123");

		const md = serializeMindMap(model);
		expect(md).toContain("## Branch A ^abc123");
		expect(md).toContain("mindmap:");
		expect(md).toContain("^abc123: { folded: true }");

		const reparsed = parseMindMap(md, "fallback");
		const reparsedBranch = reparsed.root.children[0];
		expect(reparsedBranch.id).toBe("abc123");
		expect(reparsedBranch.folded).toBe(true);
		// Folded children are hidden from view but the source text (and thus
		// content) must not be lost — the parser still walks past the fold
		// flag to parse "a"/"a1" from the raw markdown.
		expect(reparsedBranch.children.map((n) => n.text)).toEqual(["a"]);
	});

	it("removes the block id and frontmatter entry once a node is unfolded", () => {
		const model = parseMindMap(["# Root", "## Branch A ^abc123"].join("\n"), "fallback");
		const branch = model.root.children[0];
		expect(branch.id).toBe("abc123");
		expect(branch.folded).toBe(false); // no fold in this fixture's frontmatter, so false by default

		// Simulate it having been folded+persisted, then unfolded again.
		branch.folded = true;
		let md = serializeMindMap(model);
		expect(md).toContain("^abc123: { folded: true }");

		branch.folded = false;
		md = serializeMindMap(model);
		expect(md).not.toContain("^abc123");
		expect(md).not.toContain("mindmap:");
		expect(md).toBe("# Root\n## Branch A\n");
	});

	it("preserves unrelated frontmatter keys across a fold/unfold cycle", () => {
		const source = ["---", "tags: [project]", "---", "# Root", "## Branch A"].join("\n") + "\n";
		const model = parseMindMap(source, "fallback");
		const branch = model.root.children[0];

		branch.folded = true;
		ensurePersistentIds(model.root, model.byId, () => "xyz789");
		const md = serializeMindMap(model);
		expect(md).toContain("tags: [project]");
		expect(md).toContain("^xyz789: { folded: true }");

		const reparsed = parseMindMap(md, "fallback");
		expect(reparsed.frontmatterRaw).toContain("tags: [project]");
		expect(reparsed.root.children[0].folded).toBe(true);
	});
});
