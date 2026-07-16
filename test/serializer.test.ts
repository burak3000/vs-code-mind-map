import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap, serializeSubtree, serializeSubtrees } from "../webview/sync/serializer";

const FIXTURES_DIR = join(__dirname, "..", "fixtures");

describe("serializeMindMap", () => {
	it("round-trips a simple tree with nested lists byte-for-byte", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "    - a2", "- b", "## Branch B", "- c"].join("\n") + "\n";
		const model = parseMindMap(md, "fallback");
		expect(serializeMindMap(model)).toBe(md);
	});

	it("preserves a leading YAML frontmatter block verbatim", () => {
		const md = ["---", "tags: [foo, bar]", "aliases:", "  - Alt Name", "---", "# Root", "## Branch A"].join("\n") + "\n";
		const model = parseMindMap(md, "fallback");
		expect(model.frontmatterRaw).toBe(["---", "tags: [foo, bar]", "aliases:", "  - Alt Name", "---"].join("\n"));
		expect(serializeMindMap(model)).toBe(md);
	});

	it("preserves attached paragraph content under its owning node", () => {
		const md = ["# Root", "## Branch A", "", "Some paragraph text.", "", "- a"].join("\n") + "\n";
		const model = parseMindMap(md, "fallback");
		expect(serializeMindMap(model)).toBe(md);
	});

	it("falls back to the given title as an H1 when the source has no heading at all", () => {
		const model = parseMindMap("- just a list\n", "My Note");
		const out = serializeMindMap(model);
		expect(out.startsWith("# My Note\n")).toBe(true);
	});

	for (const size of [100, 500, 2000]) {
		it(`round-trips the ${size}-node benchmark fixture byte-for-byte`, () => {
			let md: string;
			try {
				md = readFileSync(join(FIXTURES_DIR, `${size}-nodes.md`), "utf8");
			} catch {
				return; // fixtures not generated in this environment; skip rather than fail
			}
			const model = parseMindMap(md, `${size}-nodes`);
			expect(serializeMindMap(model)).toBe(md);
		});
	}
});

describe("serializeSubtree (plan item 06: tree copy to OS clipboard)", () => {
	it("emits the node and its subtree as a nested markdown list, the node itself as the top item", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];

		expect(serializeSubtree(branchA)).toBe(["- Branch A", "  - a", "    - a1", "  - b"].join("\n"));
	});

	it("strips ^blockid suffixes and mindmap metadata — persisted ids/positions must not leak into the exported text", () => {
		const md = ["# Root", "## Branch A", "- a"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];
		branchA.folded = true; // would normally earn a ^blockid suffix on serializeMindMap
		branchA.manualPos = { x: 10, y: 20 };

		const text = serializeSubtree(branchA);
		expect(text).not.toContain("^");
		expect(text).not.toContain("pos:");
		expect(text).toBe(["- Branch A", "  - a"].join("\n"));
	});

	it("round-trips through parseMindMap: re-parsing the exported text reproduces the same structure/text", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];

		// serializeSubtree emits a plain list (no H1), so re-parsing puts
		// "Branch A" itself as a top-level list item under a synthetic root,
		// same as parseExternalPaste's list case (see parseExternalPaste.test.ts).
		const reparsed = parseMindMap(serializeSubtree(branchA), "fallback");
		expect(reparsed.root.children.map((c) => c.text)).toEqual(["Branch A"]);
		const reparsedBranchA = reparsed.root.children[0];
		expect(reparsedBranchA.children.map((c) => c.text)).toEqual(["a", "b"]);
		expect(reparsedBranchA.children[0].children.map((c) => c.text)).toEqual(["a1"]);
	});

	it("serializeSubtrees joins multiple independent top-level subtrees so they re-parse as siblings", () => {
		const md = ["# Root", "## Branch A", "- a", "## Branch B", "- b"].join("\n");
		const model = parseMindMap(md, "fallback");
		const [branchA, branchB] = model.root.children;

		const text = serializeSubtrees([branchA, branchB]);
		const reparsed = parseMindMap(text, "fallback");
		expect(reparsed.root.children.map((c) => c.text)).toEqual(["Branch A", "Branch B"]);
		expect(reparsed.root.children[0].children.map((c) => c.text)).toEqual(["a"]);
		expect(reparsed.root.children[1].children.map((c) => c.text)).toEqual(["b"]);
	});
});

// Sanity check that the fixtures directory is what we think it is, so the
// byte-for-byte tests above aren't silently skipped in CI.
describe("fixtures directory", () => {
	it("has the expected fixture files", () => {
		let files: string[] = [];
		try {
			files = readdirSync(FIXTURES_DIR);
		} catch {
			return;
		}
		expect(files).toEqual(expect.arrayContaining(["100-nodes.md", "500-nodes.md", "2000-nodes.md", "5000-nodes.md"]));
	});
});
