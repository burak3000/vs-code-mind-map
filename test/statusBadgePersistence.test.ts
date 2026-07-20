import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap } from "../webview/sync/serializer";
import { ensurePersistentIds } from "../webview/sync/metadata";

describe("status badge persistence (end-to-end, plans/09)", () => {
	it("persists a status badge across a full serialize -> reparse cycle, minting a real block id", () => {
		const model = parseMindMap(["# Root", "## Branch A", "- a"].join("\n"), "fallback");
		const branch = model.root.children[0];
		expect(branch.id).toMatch(/^n\d+$/); // synthetic, not yet persisted

		branch.statusBadge = "done";
		ensurePersistentIds(model.root, model.byId, () => "abc123");
		expect(branch.id).toBe("abc123");

		const md = serializeMindMap(model);
		expect(md).toContain("## Branch A ^abc123");
		expect(md).toContain("mindmap:");
		expect(md).toContain("^abc123: { badge: done }");

		const reparsed = parseMindMap(md, "fallback");
		const reparsedBranch = reparsed.root.children[0];
		expect(reparsedBranch.id).toBe("abc123");
		expect(reparsedBranch.statusBadge).toBe("done");
	});

	it("removes the block id and frontmatter entry once a status badge is cleared", () => {
		const model = parseMindMap(["# Root", "## Branch A ^abc123"].join("\n"), "fallback");
		const branch = model.root.children[0];
		expect(branch.id).toBe("abc123");
		expect(branch.statusBadge).toBeUndefined();

		branch.statusBadge = "red-flag";
		let md = serializeMindMap(model);
		expect(md).toContain("^abc123: { badge: red-flag }");

		branch.statusBadge = undefined;
		md = serializeMindMap(model);
		expect(md).not.toContain("^abc123");
		expect(md).not.toContain("mindmap:");
		expect(md).toBe("# Root\n## Branch A\n");
	});

	it("combines with fold state in the same frontmatter entry", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.folded = true;
		branch.statusBadge = "blocked";
		ensurePersistentIds(model.root, model.byId, () => "combo1");

		const md = serializeMindMap(model);
		expect(md).toContain("^combo1: { folded: true, badge: blocked }");

		const reparsed = parseMindMap(md, "fallback");
		const reparsedBranch = reparsed.root.children[0];
		expect(reparsedBranch.folded).toBe(true);
		expect(reparsedBranch.statusBadge).toBe("blocked");
	});

	it("round-trips a badge value this version's BADGE_DEFS doesn't recognize, instead of dropping it", () => {
		const source = [
			"---",
			"mindmap:",
			"  nodes:",
			"    ^future1: { badge: from-the-future }",
			"---",
			"# Root",
			"## Branch A ^future1",
		].join("\n");
		const model = parseMindMap(source, "fallback");
		const branch = model.root.children[0];
		expect(branch.statusBadge).toBe("from-the-future");

		const md = serializeMindMap(model);
		expect(md).toContain("^future1: { badge: from-the-future }");
	});

	it("preserves unrelated frontmatter keys across a badge set/clear cycle", () => {
		const source = ["---", "tags: [project]", "---", "# Root", "## Branch A"].join("\n") + "\n";
		const model = parseMindMap(source, "fallback");
		const branch = model.root.children[0];

		branch.statusBadge = "ready";
		ensurePersistentIds(model.root, model.byId, () => "xyz789");
		const md = serializeMindMap(model);
		expect(md).toContain("tags: [project]");
		expect(md).toContain("^xyz789: { badge: ready }");

		const reparsed = parseMindMap(md, "fallback");
		expect(reparsed.frontmatterRaw).toContain("tags: [project]");
		expect(reparsed.root.children[0].statusBadge).toBe("ready");
	});
});
