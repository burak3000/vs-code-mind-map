import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { searchNodes } from "../webview/model/search";

describe("searchNodes", () => {
	it("matches case-insensitively against node text", () => {
		const model = parseMindMap(["# Root", "## Launch Roadmap", "- pricing experiment"].join("\n"), "fallback");
		const { results, totalMatches } = searchNodes(model.root, "ROADMAP");
		expect(totalMatches).toBe(1);
		expect(results.map((r) => r.text)).toEqual(["Launch Roadmap"]);
	});

	it("finds nodes inside a folded subtree (search isn't limited to visible nodes)", () => {
		const model = parseMindMap(["# Root", "## Branch A", "- hidden gem"].join("\n"), "fallback");
		model.root.children[0].folded = true;
		const { results } = searchNodes(model.root, "hidden gem");
		expect(results.map((r) => r.text)).toEqual(["hidden gem"]);
	});

	it("matches against a link's display label, not its raw markdown syntax", () => {
		const model = parseMindMap(["# Root", "## Check [[Project Plan]] please"].join("\n"), "fallback");
		const { results } = searchNodes(model.root, "Project Plan");
		expect(results.map((r) => r.text)).toEqual(["Check Project Plan please"]);
	});

	it("returns no results and zero matches for a blank/whitespace-only query", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		expect(searchNodes(model.root, "")).toEqual({ results: [], totalMatches: 0 });
		expect(searchNodes(model.root, "   ")).toEqual({ results: [], totalMatches: 0 });
	});

	it("caps the materialized result list at 50 but still reports the true total match count", () => {
		const lines = ["# Root"];
		for (let i = 0; i < 80; i++) lines.push(`## widget ${i}`);
		const model = parseMindMap(lines.join("\n"), "fallback");
		const { results, totalMatches } = searchNodes(model.root, "widget");
		expect(totalMatches).toBe(80);
		expect(results.length).toBe(50);
	});

	it("includes the root itself as a searchable node", () => {
		const model = parseMindMap(["# Central Topic", "## Branch A"].join("\n"), "fallback");
		const { results } = searchNodes(model.root, "Central");
		expect(results.map((r) => r.id)).toEqual([model.root.id]);
	});
});
