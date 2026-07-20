import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap } from "../webview/sync/serializer";
import { ensurePersistentIds, nodeHasPersistableMeta } from "../webview/sync/metadata";
import { listNodeLinkItems, resolveRelations } from "../webview/model/relations";
import { appendLinkText, buildLinkText, removeLinkOccurrence } from "../webview/model/links";
import { MindNode } from "../webview/model/types";

function findByTextOrNull(root: MindNode, text: string): MindNode | null {
	if (root.text === text) return root;
	for (const child of root.children) {
		const found = findByTextOrNull(child, text);
		if (found) return found;
	}
	return null;
}

function findByText(root: MindNode, text: string): MindNode {
	const found = findByTextOrNull(root, text);
	if (!found) throw new Error(`node not found: ${text}`);
	return found;
}

/** parseMindMap + resolveRelations in one call, for the common case with no mutation in between. */
function parseAndResolve(md: string, filename = "fallback") {
	const model = parseMindMap(md, filename);
	const active = resolveRelations(model, filename);
	return { model, active };
}

describe("resolveRelations: classification", () => {
	it("resolves a bare same-file block ref [[#^id]] to the matching node as a same-doc relation", () => {
		const { model, active } = parseAndResolve(["# Root", "## Source [[#^tgt1]]", "## Target ^tgt1"].join("\n"));
		const source = findByText(model.root, "Source [[#^tgt1]]");
		const target = findByText(model.root, "Target");
		expect(source.resolvedRelations).toEqual([{ kind: "same-doc", linkKind: "wikilink", rawTarget: "#^tgt1", targetId: target.id }]);
		expect(active).toEqual([{ sourceId: source.id, targetId: target.id }]);
	});

	it("resolves [[<basename>#^id]] (case-insensitive) to the matching node when it names the current file", () => {
		const { model } = parseAndResolve(["# Root", "## Source [[MyFile#^tgt1]]", "## Target ^tgt1"].join("\n"), "myfile");
		expect(findByText(model.root, "Source [[MyFile#^tgt1]]").resolvedRelations?.[0].kind).toBe("same-doc");
	});

	it("does not resolve [[<basename>#^id]] when the basename doesn't match the current file", () => {
		const { model } = parseAndResolve(["# Root", "## Source [[OtherFile#^tgt1]]", "## Target ^tgt1"].join("\n"), "myfile");
		expect(findByText(model.root, "Source [[OtherFile#^tgt1]]").resolvedRelations).toEqual([{ kind: "cross-doc", linkKind: "wikilink", rawTarget: "OtherFile#^tgt1" }]);
	});

	it("ignores a dangling same-file block ref instead of treating it as cross-doc or crashing", () => {
		const md = ["# Root", "## Source [[#^nonexistent]]"].join("\n");
		const model = parseMindMap(md, "fallback");
		expect(() => resolveRelations(model, "fallback")).not.toThrow();
		expect(findByText(model.root, "Source [[#^nonexistent]]").resolvedRelations).toEqual([]);
	});

	it.each([
		["a same-file non-block link (plain heading link) — not a relation, not a cross-doc badge", "## Source [[#Some Heading]]", "Source [[#Some Heading]]"],
		["a node with no link at all", "## Plain node", "Plain node"],
	])("%s resolves to an empty relation list", (_label, line, nodeText) => {
		const { model } = parseAndResolve(["# Root", line].join("\n"));
		expect(findByText(model.root, nodeText).resolvedRelations).toEqual([]);
	});

	it("ignores a self-referencing block link rather than drawing a self-loop", () => {
		const model = parseMindMap(["# Root", "## Self ^selfid"].join("\n"), "fallback");
		const node = findByText(model.root, "Self");
		node.text = `Self [[#^${node.id}]]`;
		resolveRelations(model, "fallback");
		expect(node.resolvedRelations).toEqual([]);
	});

	it.each([
		["a wikilink to a different note", "## Source [[Other Note]]", "Source [[Other Note]]", { kind: "cross-doc", linkKind: "wikilink", rawTarget: "Other Note" }],
		[
			"an mdlink (URL or vault path)",
			"## Source [ref](https://example.com)",
			"Source [ref](https://example.com)",
			{ kind: "cross-doc", linkKind: "mdlink", rawTarget: "https://example.com" },
		],
	])("classifies %s as cross-doc", (_label, line, nodeText, expected) => {
		const { model } = parseAndResolve(["# Root", line].join("\n"));
		expect(findByText(model.root, nodeText).resolvedRelations).toEqual([expected]);
	});

	it("re-resolving after a target's block id changes correctly drops the stale relation and marks the new target instead", () => {
		const { model } = parseAndResolve(["# Root", "## Source [[#^t1]]", "## Target ^t1"].join("\n"));
		const target = findByText(model.root, "Target");
		expect(target.isRelationTarget).toBe(true);

		findByText(model.root, "Source [[#^t1]]").text = "Source, no relation anymore";
		resolveRelations(model, "fallback");
		expect(target.isRelationTarget).toBe(false);
	});
});

describe("resolveRelations: block-id forcing for round-trip (R1a item 2)", () => {
	it("marks a relation's target as needing a persistent id even though it has no fold/pos/width of its own", () => {
		const { model } = parseAndResolve(["# Root", "## Source [[#^t1]]", "## Target ^t1"].join("\n"));
		expect(nodeHasPersistableMeta(findByText(model.root, "Target"))).toBe(true);
	});

	it("a plain node with no relation pointing at it is not considered to have persistable meta", () => {
		const { model } = parseAndResolve(["# Root", "## Plain"].join("\n"));
		expect(nodeHasPersistableMeta(findByText(model.root, "Plain"))).toBe(false);
	});

	it("round-trips a relation through parse -> resolve -> ensurePersistentIds -> serialize -> parse without losing it", () => {
		// Author a relation the way the link editor would: target gets a
		// forced persistent id (simulated with a real, deterministic mint), and
		// the source's text embeds it directly rather than a synthetic id.
		let counter = 0;
		const mint = () => `mint${counter++}`;

		const model = parseMindMap(["# Root", "## Source", "## Target"].join("\n"), "fallback");
		const target = findByText(model.root, "Target");
		const source = findByText(model.root, "Source");

		// Simulate authoring: force the target's id, then write the relation link.
		target.id = mint();
		model.byId.set(target.id, target);
		source.text = `Source [[#^${target.id}]]`;

		resolveRelations(model, "fallback");
		ensurePersistentIds(model.root, model.byId, mint);
		const serialized = serializeMindMap(model);

		// The target's line must carry the block-id suffix so the reference resolves again on the next parse.
		expect(serialized).toContain(`^${target.id}`);
		expect(serialized).toContain(`[[#^${target.id}]]`);

		const reparsed = parseMindMap(serialized, "fallback");
		resolveRelations(reparsed, "fallback");
		const reSource = findByText(reparsed.root, `Source [[#^${target.id}]]`);
		expect(reSource.resolvedRelations).toEqual([{ kind: "same-doc", linkKind: "wikilink", rawTarget: `#^${target.id}`, targetId: target.id }]);
	});

	it("a relation's target does NOT get a spurious empty frontmatter entry (only the block-id line suffix)", () => {
		const model = parseMindMap(["# Root", "## Source [[#^t1]]", "## Target ^t1"].join("\n"), "fallback");
		resolveRelations(model, "fallback");
		ensurePersistentIds(model.root, model.byId);
		const serialized = serializeMindMap(model);

		expect(serialized).toContain("^t1");
		expect(serialized).not.toContain("mindmap:"); // no frontmatter needed for a relation-only target
	});
});

describe("resolveRelations: multiple relations from one node (R5 regression, authoring-UI gap, not a model gap)", () => {
	it("a node with two same-doc relation links resolves to two activeRelations entries", () => {
		const { model, active } = parseAndResolve(["# Root", "## Source [[#^t1]] [[#^t2]]", "## Target 1 ^t1", "## Target 2 ^t2"].join("\n"));
		const source = findByText(model.root, "Source [[#^t1]] [[#^t2]]");
		const target1 = findByText(model.root, "Target 1");
		const target2 = findByText(model.root, "Target 2");
		expect(source.resolvedRelations).toEqual([
			{ kind: "same-doc", linkKind: "wikilink", rawTarget: "#^t1", targetId: target1.id },
			{ kind: "same-doc", linkKind: "wikilink", rawTarget: "#^t2", targetId: target2.id },
		]);
		expect(active).toEqual([
			{ sourceId: source.id, targetId: target1.id },
			{ sourceId: source.id, targetId: target2.id },
		]);
	});

	it("appendLinkText-built multi-relation text round-trips through resolveRelations the same way", () => {
		const model = parseMindMap(["# Root", "## Source", "## Target 1 ^t1", "## Target 2 ^t2"].join("\n"), "fallback");
		const source = findByText(model.root, "Source");
		source.text = appendLinkText(source.text, buildLinkText({ label: "Target 1", kind: "wikilink", target: "#^t1" }));
		source.text = appendLinkText(source.text, buildLinkText({ label: "Target 2", kind: "wikilink", target: "#^t2" }));
		expect(source.text).toBe("Source → [[#^t1|Target 1]] → [[#^t2|Target 2]]");

		const active = resolveRelations(model, "fallback");
		expect(active.map((r) => r.sourceId)).toEqual([source.id, source.id]);
		expect(source.resolvedRelations?.map((r) => r.kind)).toEqual(["same-doc", "same-doc"]);
	});
});

describe("listNodeLinkItems (R3/R5 relation/link modal item list)", () => {
	it("returns N rows for N existing links, in text order, with a correct occurrenceIndex each", () => {
		const { model } = parseAndResolve(["# Root", "## Source [[#^t1]] [[#^t2]] [ref](https://example.com)", "## Target 1 ^t1", "## Target 2 ^t2"].join("\n"));
		const source = findByText(model.root, "Source [[#^t1]] [[#^t2]] [ref](https://example.com)");

		const items = listNodeLinkItems(source, model, "fallback");
		expect(items).toHaveLength(3);
		expect(items.map((i) => i.occurrenceIndex)).toEqual([0, 1, 2]);
	});

	it("correctly identifies each item's badge/occurrence when same-doc, cross-doc, and plain/unresolved links are mixed (no off-by-one)", () => {
		const { model } = parseAndResolve(["# Root", "## Source [[#^t1]] [[Other Note]] [[#Some Heading]] [ref](https://example.com)", "## Target 1 ^t1"].join("\n"));
		const source = findByText(model.root, "Source [[#^t1]] [[Other Note]] [[#Some Heading]] [ref](https://example.com)");
		const target1 = findByText(model.root, "Target 1");

		const items = listNodeLinkItems(source, model, "fallback");
		expect(items).toHaveLength(4);

		expect(items[0]).toMatchObject({ occurrenceIndex: 0, badge: "same-doc", rawTarget: "#^t1" });
		expect(items[0].relation).toEqual({ kind: "same-doc", linkKind: "wikilink", rawTarget: "#^t1", targetId: target1.id });

		expect(items[1]).toMatchObject({ occurrenceIndex: 1, badge: "cross-doc", rawTarget: "Other Note" });

		expect(items[2]).toMatchObject({ occurrenceIndex: 2, badge: "unresolved", rawTarget: "#Some Heading" });
		expect(items[2].relation).toBeNull();

		expect(items[3]).toMatchObject({ occurrenceIndex: 3, badge: "external", rawTarget: "https://example.com" });
	});

	it("removing item at a given occurrenceIndex via removeLinkOccurrence leaves the remaining items correct after re-listing", () => {
		const { model } = parseAndResolve(["# Root", "## Source [[#^t1]] [[Other Note]]", "## Target 1 ^t1"].join("\n"));
		const source = findByText(model.root, "Source [[#^t1]] [[Other Note]]");

		expect(listNodeLinkItems(source, model, "fallback")).toHaveLength(2);

		source.text = removeLinkOccurrence(source.text, 0);
		resolveRelations(model, "fallback");

		const after = listNodeLinkItems(source, model, "fallback");
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ occurrenceIndex: 0, badge: "cross-doc", rawTarget: "Other Note" });
	});

	it("returns an empty list for a node with no links", () => {
		const { model } = parseAndResolve(["# Root", "## Plain node"].join("\n"));
		expect(listNodeLinkItems(findByText(model.root, "Plain node"), model, "fallback")).toEqual([]);
	});
});
