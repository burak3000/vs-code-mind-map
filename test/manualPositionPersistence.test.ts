import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap } from "../webview/sync/serializer";
import { computeLayout } from "../webview/layout/layoutEngine";
import { ensurePersistentIds } from "../webview/sync/metadata";

describe("manual position persistence (end-to-end)", () => {
	it("persists a manual position across a full serialize -> reparse -> layout cycle", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.manualPos = { x: 420, y: -180 };
		ensurePersistentIds(model.root, model.byId, () => "pinned1");

		const md = serializeMindMap(model);
		expect(md).toContain("## Branch A ^pinned1");
		expect(md).toContain("^pinned1: { pos: [420, -180] }");

		const reparsed = parseMindMap(md, "fallback");
		const reparsedBranch = reparsed.root.children[0];
		expect(reparsedBranch.id).toBe("pinned1");
		expect(reparsedBranch.manualPos).toEqual({ x: 420, y: -180 });

		computeLayout(reparsed.root);
		expect(reparsedBranch.layout).toMatchObject({ x: 420, y: -180 });
	});

	it("persists both fold and pos on the same node together", () => {
		const model = parseMindMap(["# Root", "## Branch A", "- a"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.folded = true;
		branch.manualPos = { x: 10, y: 20 };
		ensurePersistentIds(model.root, model.byId, () => "both1");

		const md = serializeMindMap(model);
		expect(md).toContain("folded: true");
		expect(md).toContain("pos: [10, 20]");

		const reparsed = parseMindMap(md, "fallback");
		const b = reparsed.root.children[0];
		expect(b.folded).toBe(true);
		expect(b.manualPos).toEqual({ x: 10, y: 20 });
	});

	it("removes the pos entry once the pin is cleared, keeping other metadata intact", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.folded = true;
		branch.manualPos = { x: 1, y: 2 };
		ensurePersistentIds(model.root, model.byId, () => "clearme");
		let md = serializeMindMap(model);
		expect(md).toContain("pos: [1, 2]");

		branch.manualPos = undefined;
		md = serializeMindMap(model);
		expect(md).not.toContain("pos:");
		expect(md).toContain("folded: true");
	});
});
