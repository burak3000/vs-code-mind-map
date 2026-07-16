import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap } from "../webview/sync/serializer";
import { ensurePersistentIds } from "../webview/sync/metadata";
import { findNodeLine, resolveGoToTarget } from "../webview/sync/goToSection";

describe("findNodeLine", () => {
	it("finds the exact serialized line for a node, matching serializeMindMap's own output", () => {
		const md = ["# Root", "## Branch A", "- a", "  - a1", "## Branch B", "- b"].join("\n") + "\n";
		const model = parseMindMap(md, "fallback");
		const lines = serializeMindMap(model).split("\n");

		const branchB = model.root.children[1];
		const b = branchB.children[0];
		expect(lines[findNodeLine(model, branchB.id)!]).toBe("## Branch B");
		expect(lines[findNodeLine(model, b.id)!]).toBe("- b");
	});

	it("accounts for frontmatter line count", () => {
		const md = ["---", "tags: [x]", "---", "# Root", "## Branch A"].join("\n") + "\n";
		const model = parseMindMap(md, "fallback");
		const lines = serializeMindMap(model).split("\n");
		const branchA = model.root.children[0];
		expect(lines[findNodeLine(model, branchA.id)!]).toBe("## Branch A");
	});

	it("accounts for attachedContent (paragraph) lines pushed before a later node", () => {
		const md = ["# Root", "## Branch A", "", "Some paragraph.", "", "## Branch B"].join("\n") + "\n";
		const model = parseMindMap(md, "fallback");
		const lines = serializeMindMap(model).split("\n");
		const branchB = model.root.children[1];
		expect(lines[findNodeLine(model, branchB.id)!]).toBe("## Branch B");
	});

	it("returns null for an id that isn't in the tree", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		expect(findNodeLine(model, "does-not-exist")).toBeNull();
	});
});

describe("resolveGoToTarget", () => {
	it("prefers the block-id target when the node has persisted metadata", () => {
		const md = ["# Root", "## Branch A"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];
		branchA.folded = true; // gives it persistable meta -> a real ^blockid on serialize
		ensurePersistentIds(model.root, model.byId);

		const target = resolveGoToTarget(model, branchA);
		expect(target).toEqual({ kind: "blockid", ref: branchA.id });
	});

	it("uses a heading-text target for an unpinned heading with unique text", () => {
		const md = ["# Root", "## Branch A", "## Branch B"].join("\n");
		const model = parseMindMap(md, "fallback");
		const branchA = model.root.children[0];

		expect(resolveGoToTarget(model, branchA)).toEqual({ kind: "heading", ref: "Branch A" });
	});

	it("falls back to a line number when heading text is duplicated elsewhere", () => {
		const md = ["# Root", "## Same", "## Same"].join("\n");
		const model = parseMindMap(md, "fallback");
		const [first, second] = model.root.children;

		expect(resolveGoToTarget(model, first).kind).toBe("line");
		expect(resolveGoToTarget(model, second).kind).toBe("line");
	});

	it("falls back to a line number for an unpinned list node (not a heading)", () => {
		const md = ["# Root", "## Branch A", "- a"].join("\n");
		const model = parseMindMap(md, "fallback");
		const a = model.root.children[0].children[0];

		expect(resolveGoToTarget(model, a).kind).toBe("line");
	});

	it("is unavailable for a synthetic root (no real H1 in the file)", () => {
		const model = parseMindMap("- just a list\n", "My Note");
		expect(resolveGoToTarget(model, model.root)).toEqual({ kind: "unavailable" });
	});

	it("resolves the root itself when the file has a real H1", () => {
		const md = ["# Root", "## Branch A"].join("\n");
		const model = parseMindMap(md, "fallback");
		expect(resolveGoToTarget(model, model.root)).toEqual({ kind: "heading", ref: "Root" });
	});
});
