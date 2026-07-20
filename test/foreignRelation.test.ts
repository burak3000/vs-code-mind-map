import { describe, expect, it, vi } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { serializeMindMap } from "../webview/sync/serializer";
import { resolveRelations } from "../webview/model/relations";
import { isSyntheticId } from "../webview/sync/metadata";
import { MindNode, MindMapModel } from "../webview/model/types";
import {
	CURRENT_DOCUMENT_ID,
	MinimalFile,
	commitForeignRelationTarget,
	resolveRelationTargetsForDocument,
} from "../webview/sync/foreignRelation";

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

/** In-memory vault double: `files` is the source of truth `cachedRead`/`modify` operate on, so a test can assert what actually got written back. */
function makeMockVault(files: Record<string, string>) {
	const cachedRead = vi.fn(async (file: MinimalFile) => {
		if (!(file.path in files)) throw new Error(`no such file: ${file.path}`);
		return files[file.path];
	});
	const modify = vi.fn(async (file: MinimalFile, data: string) => {
		files[file.path] = data;
	});
	return { cachedRead, modify, files };
}

describe("resolveRelationTargetsForDocument (R4 combobox-2 data source)", () => {
	it("resolves the current document instantly from currentDocTargets, never calling vault.cachedRead", async () => {
		const vault = makeMockVault({});
		const currentDocTargets = [{ id: "n1", label: "Node A" }];

		const result = await resolveRelationTargetsForDocument(CURRENT_DOCUMENT_ID, currentDocTargets, {
			vault,
			resolveFile: () => null,
			models: new Map(),
			labelFor: () => "",
		});

		expect(result).toBe(currentDocTargets);
		expect(vault.cachedRead).not.toHaveBeenCalled();
	});

	it("reads and parses a foreign file's content into node options, in document order", async () => {
		const text = ["# Other", "## Alpha", "## Beta"].join("\n");
		const vault = makeMockVault({ "Other.md": text });
		const resolveFile = (path: string) => (path === "Other.md" ? { path: "Other.md", basename: "Other" } : null);

		const result = await resolveRelationTargetsForDocument("Other.md", [], {
			vault,
			resolveFile,
			models: new Map(),
			labelFor: (n) => n.text,
		});

		expect(result.map((t) => t.label)).toEqual(["Other", "Alpha", "Beta"]);
		expect(vault.cachedRead).toHaveBeenCalledTimes(1);
	});

	it("caches the parsed model per path for the caller-supplied map's lifetime — a second call for the same path does not re-read or re-parse", async () => {
		const text = ["# Other", "## Alpha", "## Beta"].join("\n");
		const vault = makeMockVault({ "Other.md": text });
		const resolveFile = (path: string) => (path === "Other.md" ? { path: "Other.md", basename: "Other" } : null);
		const models = new Map<string, MindMapModel>();

		await resolveRelationTargetsForDocument("Other.md", [], { vault, resolveFile, models, labelFor: (n) => n.text });
		const second = await resolveRelationTargetsForDocument("Other.md", [], { vault, resolveFile, models, labelFor: (n) => n.text });

		expect(second.map((t) => t.label)).toEqual(["Other", "Alpha", "Beta"]);
		expect(vault.cachedRead).toHaveBeenCalledTimes(1);
	});

	it("returns an empty list when the document id can't be resolved to a file", async () => {
		const vault = makeMockVault({});
		const result = await resolveRelationTargetsForDocument("Missing.md", [], {
			vault,
			resolveFile: () => null,
			models: new Map(),
			labelFor: (n) => n.text,
		});
		expect(result).toEqual([]);
		expect(vault.cachedRead).not.toHaveBeenCalled();
	});
});

describe("commitForeignRelationTarget (R4 add-relation commit step)", () => {
	it("mints a persistent id and writes the foreign file exactly once when the picked node has no id yet", async () => {
		const text = ["# Other", "## Alpha", "## Beta"].join("\n");
		const vault = makeMockVault({ "Other.md": text });
		const file: MinimalFile = { path: "Other.md", basename: "Other" };

		// Simulate the picker-time parse the modal used to populate combobox 2.
		const pickerModel = parseMindMap(text, "Other");
		const betaAtPickerTime = findByText(pickerModel.root, "Beta");
		expect(isSyntheticId(betaAtPickerTime.id)).toBe(true);

		let counter = 0;
		const mint = () => `mint${counter++}`;
		const result = await commitForeignRelationTarget(vault, file, betaAtPickerTime, mint);

		expect(result).not.toBeNull();
		expect(result!.wrote).toBe(true);
		expect(isSyntheticId(result!.targetId)).toBe(false);
		expect(vault.cachedRead).toHaveBeenCalledTimes(1); // re-read fresh at commit time
		expect(vault.modify).toHaveBeenCalledTimes(1);
		expect(vault.files["Other.md"]).toContain(`^${result!.targetId}`);

		// The link a caller would build now (`[[Other#^<id>]]`) resolves as
		// cross-doc from the CURRENT node's own resolution pass, exactly the
		// same classification R2 already gives any other-file wikilink.
		const sourceMd = ["# Source doc", `## Node A → [[Other#^${result!.targetId}]]`].join("\n");
		const sourceModel = parseMindMap(sourceMd, "Source doc");
		resolveRelations(sourceModel, "source doc");
		const sourceNode = sourceModel.root.children[0];
		expect(sourceNode.resolvedRelations).toEqual([{ kind: "cross-doc", linkKind: "wikilink", rawTarget: `Other#^${result!.targetId}` }]);

		// Durability regression check (the actual R4 gap this fix targets):
		// re-parse the written-back foreign file as a brand-new, independent
		// session (fresh model, no `isRelationTarget` carried over from
		// anything), then re-serialize it as if the user opened "Other.md" on
		// its own and the plugin wrote it back for an unrelated reason (fold
		// toggle, rename, etc.) — confirm the ^blockid suffix (and thus the
		// relation) survives this *second*, fully independent cycle.
		const rereadText = vault.files["Other.md"];
		const reparsedModel = parseMindMap(rereadText, "Other");
		const reparsedBeta = findByText(reparsedModel.root, "Beta");
		expect(reparsedBeta.id).toBe(result!.targetId);
		expect(reparsedBeta.externalRelationTarget).toBe(true);
		expect(reparsedBeta.isRelationTarget).toBeUndefined(); // never set by this file's own content — externalRelationTarget carries the durable fact

		const rewritten = serializeMindMap(reparsedModel);
		expect(rewritten).toContain(`^${result!.targetId}`);

		// And a *third* independent parse of that second write still holds.
		const thirdParseModel = parseMindMap(rewritten, "Other");
		const thirdBeta = findByText(thirdParseModel.root, "Beta");
		expect(thirdBeta.id).toBe(result!.targetId);
	});

	it("does not touch the foreign file when the picked node already has a persistent id", async () => {
		const text = ["# Other", "## Alpha ^existing", "## Beta"].join("\n");
		const vault = makeMockVault({ "Other.md": text });
		const file: MinimalFile = { path: "Other.md", basename: "Other" };

		const pickerModel = parseMindMap(text, "Other");
		const alphaAtPickerTime = findByText(pickerModel.root, "Alpha");
		expect(alphaAtPickerTime.id).toBe("existing");

		const result = await commitForeignRelationTarget(vault, file, alphaAtPickerTime);

		expect(result).toEqual({ targetId: "existing", wrote: false });
		expect(vault.cachedRead).toHaveBeenCalledTimes(1); // still re-reads fresh...
		expect(vault.modify).not.toHaveBeenCalled(); // ...but never writes when nothing changed
	});

	it("relating to the same already-referenced foreign node a second time still writes zero times", async () => {
		const text = ["# Other", "## Alpha ^existing"].join("\n");
		const vault = makeMockVault({ "Other.md": text });
		const file: MinimalFile = { path: "Other.md", basename: "Other" };
		const pickerModel = parseMindMap(text, "Other");
		const alpha = findByText(pickerModel.root, "Alpha");

		await commitForeignRelationTarget(vault, file, alpha);
		await commitForeignRelationTarget(vault, file, alpha);

		expect(vault.modify).not.toHaveBeenCalled();
	});

	it("returns null (and never writes) when the picked node no longer exists in a freshly re-read version of the file", async () => {
		const original = ["# Other", "## Alpha", "## Beta"].join("\n");
		const pickerModel = parseMindMap(original, "Other");
		const betaAtPickerTime = findByText(pickerModel.root, "Beta");

		const changedSinceThen = ["# Other", "## Alpha"].join("\n"); // Beta removed before commit
		const vault = makeMockVault({ "Other.md": changedSinceThen });
		const file: MinimalFile = { path: "Other.md", basename: "Other" };

		const result = await commitForeignRelationTarget(vault, file, betaAtPickerTime);

		expect(result).toBeNull();
		expect(vault.modify).not.toHaveBeenCalled();
	});
});
