import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap } from "../webview/sync/serializer";
import { computeLayout } from "../webview/layout/layoutEngine";
import { ensurePersistentIds } from "../webview/sync/metadata";

describe("manual width persistence (end-to-end)", () => {
	it("persists a drag-resized width across a full serialize -> reparse -> layout cycle", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.manualWidth = 250;
		ensurePersistentIds(model.root, model.byId, () => "widthed1");

		const md = serializeMindMap(model);
		expect(md).toContain("## Branch A ^widthed1");
		expect(md).toContain("^widthed1: { width: 250 }");

		const reparsed = parseMindMap(md, "fallback");
		const reparsedBranch = reparsed.root.children[0];
		expect(reparsedBranch.id).toBe("widthed1");
		expect(reparsedBranch.manualWidth).toBe(250);

		computeLayout(reparsed.root);
		expect(reparsedBranch.layout!.w).toBeLessThanOrEqual(250);
	});

	it("persists width alongside pos and folded on the same node", () => {
		const model = parseMindMap(["# Root", "## Branch A", "- a"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.folded = true;
		branch.manualPos = { x: 10, y: 20 };
		branch.manualWidth = 300;
		ensurePersistentIds(model.root, model.byId, () => "combo1");

		const md = serializeMindMap(model);
		expect(md).toContain("folded: true");
		expect(md).toContain("pos: [10, 20]");
		expect(md).toContain("width: 300");

		const reparsed = parseMindMap(md, "fallback");
		const b = reparsed.root.children[0];
		expect(b.folded).toBe(true);
		expect(b.manualPos).toEqual({ x: 10, y: 20 });
		expect(b.manualWidth).toBe(300);
	});

	it("removes the width entry once the pin is cleared, keeping other metadata intact", () => {
		const model = parseMindMap(["# Root", "## Branch A"].join("\n"), "fallback");
		const branch = model.root.children[0];
		branch.folded = true;
		branch.manualWidth = 200;
		ensurePersistentIds(model.root, model.byId, () => "clearpin1");
		let md = serializeMindMap(model);
		expect(md).toContain("width: 200");

		branch.manualWidth = undefined;
		md = serializeMindMap(model);
		expect(md).not.toContain("width:");
		expect(md).toContain("folded: true");
	});
});
