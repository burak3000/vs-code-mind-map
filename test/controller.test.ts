import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { Controller } from "../webview/controller/Controller";
import { assignMissingColors, resolveNodeColorKey } from "../webview/render/colors";

function makeController(md = "# Root\n## Branch A\n- a\n## Branch B\n") {
	const model = parseMindMap(md, "fallback");
	return new Controller(model);
}

describe("Controller", () => {
	it("Tab creates a child of the selected node, selects it, and requests an edit", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		controller.select(branchA.id);

		let editRequested: string | null = null;
		controller.addListener({ onChange() {}, onEditRequest: (id) => (editRequested = id) });

		controller.addChildToSelected();

		expect(branchA.children.length).toBe(2); // "a" plus the new child
		const created = branchA.children[1];
		expect(controller.selectedId).toBe(created.id);
		expect(editRequested).toBe(created.id);
	});

	it("Tab with nothing selected adds a child of the root", () => {
		const controller = makeController();
		controller.addChildToSelected();
		expect(controller.model.root.children.length).toBe(3);
	});

	it("Enter adds a sibling after the selected node; Shift+Enter adds one before", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		controller.select(branchA.id);

		controller.addSiblingToSelected("after");
		expect(controller.model.root.children.map((n) => n.id)).toEqual([branchA.id, controller.selectedId, controller.model.root.children[2].id]);

		const afterId = controller.selectedId;
		controller.select(branchA.id);
		controller.addSiblingToSelected("before");
		const ids = controller.model.root.children.map((n) => n.id);
		expect(ids.indexOf(controller.selectedId!)).toBe(0);
		expect(ids.indexOf(branchA.id)).toBe(1);
		expect(ids.indexOf(afterId!)).toBe(2);
	});

	it("addSiblingToSelected is a no-op on the root (no siblings)", () => {
		const controller = makeController();
		controller.select(controller.model.root.id);
		const before = controller.model.root.subtreeCount;
		controller.addSiblingToSelected("after");
		expect(controller.model.root.subtreeCount).toBe(before);
	});

	it("commitRename changes text and is undoable/redoable", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		controller.commitRename(branchA.id, "Renamed");
		expect(branchA.text).toBe("Renamed");

		controller.undo();
		expect(branchA.text).toBe("Branch A");

		controller.redo();
		expect(branchA.text).toBe("Renamed");
	});

	it("deleteSelected removes the node+subtree, selects the parent, and is undoable", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const childA = branchA.children[0];
		controller.select(childA.id);

		controller.deleteSelected();
		expect(branchA.children.length).toBe(0);
		expect(controller.model.byId.has(childA.id)).toBe(false);
		expect(controller.selectedId).toBe(branchA.id);

		controller.undo();
		expect(branchA.children.length).toBe(1);
		expect(branchA.children[0]).toBe(childA);
		expect(controller.model.byId.get(childA.id)).toBe(childA);
	});

	it("delete + undo restores correct subtreeCount along the ancestor chain", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const childA = branchA.children[0];
		const rootCountBefore = controller.model.root.subtreeCount;

		controller.select(childA.id);
		controller.deleteSelected();
		expect(controller.model.root.subtreeCount).toBe(rootCountBefore - 1);

		controller.undo();
		expect(controller.model.root.subtreeCount).toBe(rootCountBefore);
		expect(branchA.subtreeCount).toBe(1);
	});

	it("toggleFold flips folded state and is undoable/redoable", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		expect(branchA.folded).toBe(false);

		controller.toggleFold(branchA.id);
		expect(branchA.folded).toBe(true);

		controller.undo();
		expect(branchA.folded).toBe(false);

		controller.redo();
		expect(branchA.folded).toBe(true);
	});

	it("toggleFold is a no-op on a childless node", () => {
		const controller = makeController();
		const leaf = controller.model.root.children[0].children[0]; // "a", childless
		controller.toggleFold(leaf.id);
		expect(leaf.folded).toBe(false);
	});

	it("setStatusBadge sets and clears a node's status, and is undoable/redoable", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		expect(branchA.statusBadge).toBeUndefined();

		controller.setStatusBadge(branchA.id, "done");
		expect(branchA.statusBadge).toBe("done");

		controller.setStatusBadge(branchA.id, "blocked");
		expect(branchA.statusBadge).toBe("blocked");

		controller.undo();
		expect(branchA.statusBadge).toBe("done");

		controller.undo();
		expect(branchA.statusBadge).toBeUndefined();

		controller.redo();
		expect(branchA.statusBadge).toBe("done");

		controller.setStatusBadge(branchA.id, undefined);
		expect(branchA.statusBadge).toBeUndefined();
	});

	it("setStatusBadge is a no-op on an unknown node id", () => {
		const controller = makeController();
		expect(() => controller.setStatusBadge("nonexistent", "done")).not.toThrow();
	});

	it("toggleStatusBadge sets the badge if unset/different, clears it if already set (Cmd+Shift+D -> \"done\")", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];

		controller.toggleStatusBadge(branchA.id, "done");
		expect(branchA.statusBadge).toBe("done");

		controller.toggleStatusBadge(branchA.id, "done");
		expect(branchA.statusBadge).toBeUndefined();

		controller.setStatusBadge(branchA.id, "blocked");
		controller.toggleStatusBadge(branchA.id, "done");
		expect(branchA.statusBadge).toBe("done"); // overrides an existing different badge rather than toggling it off
	});

	it("revealAndSelect unfolds every folded ancestor of a hidden node and selects it", () => {
		const controller = makeController(["# Root", "## Branch A", "- a1", "  - a2"].join("\n"));
		const branchA = controller.model.root.children[0];
		const a1 = branchA.children[0];
		const a2 = a1.children[0];
		branchA.folded = true;
		a1.folded = true;

		controller.revealAndSelect(a2.id);

		expect(branchA.folded).toBe(false);
		expect(a1.folded).toBe(false);
		expect(controller.selectedId).toBe(a2.id);
	});

	it("revealAndSelect is a no-op unfold (just selects) when the node is already visible", () => {
		const controller = makeController();
		const leaf = controller.model.root.children[0].children[0];
		controller.revealAndSelect(leaf.id);
		expect(controller.selectedId).toBe(leaf.id);
	});

	it("revealAndSelect's unfold is a single undo step that restores every unfolded ancestor together", () => {
		const controller = makeController(["# Root", "## Branch A", "- a1", "  - a2"].join("\n"));
		const branchA = controller.model.root.children[0];
		const a1 = branchA.children[0];
		const a2 = a1.children[0];
		branchA.folded = true;
		a1.folded = true;

		controller.revealAndSelect(a2.id);
		controller.undo();

		expect(branchA.folded).toBe(true);
		expect(a1.folded).toBe(true);
	});

	it("revealAndSelect does nothing for an unknown node id", () => {
		const controller = makeController();
		controller.select(controller.model.root.id);
		controller.revealAndSelect("does-not-exist");
		expect(controller.selectedId).toBe(controller.model.root.id);
	});

	it("copy then paste inserts a cloned subtree (new ids) as the last child of the selected target, leaving the original in place", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const branchB = controller.model.root.children[1];
		controller.select(branchA.id);

		controller.copySelected();
		expect(branchA.children.length).toBe(1); // copy doesn't touch the model

		controller.select(branchB.id);
		controller.pasteToSelected();

		expect(branchB.children.length).toBe(1);
		const pasted = branchB.children[0];
		expect(pasted.text).toBe(branchA.text);
		expect(pasted.id).not.toBe(branchA.id);
		expect(pasted.children.map((c) => c.text)).toEqual(branchA.children.map((c) => c.text));
		expect(pasted.children[0].id).not.toBe(branchA.children[0].id);
		expect(controller.selectedId).toBe(pasted.id);
		// original untouched
		expect(controller.model.byId.has(branchA.id)).toBe(true);
		expect(branchA.parent).toBe(controller.model.root);
	});

	it("copy then paste carries the status badge onto the clone (semantic state, unlike manualPos/colorKey)", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const branchB = controller.model.root.children[1];
		controller.setStatusBadge(branchA.id, "started");
		controller.select(branchA.id);
		controller.copySelected();

		controller.select(branchB.id);
		controller.pasteToSelected();

		const pasted = branchB.children[0];
		expect(pasted.statusBadge).toBe("started");
	});

	it("paste can be repeated, cloning fresh ids each time", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const branchB = controller.model.root.children[1];
		controller.select(branchA.id);
		controller.copySelected();

		controller.select(branchB.id);
		controller.pasteToSelected();
		const first = controller.selectedId;
		controller.select(branchB.id);
		controller.pasteToSelected();
		const second = controller.selectedId;

		expect(first).not.toBe(second);
		expect(branchB.children.length).toBe(2);
	});

	it("cut removes the node+subtree (undoably, like delete) and pasting elsewhere re-inserts a clone", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const childA = branchA.children[0];
		const branchB = controller.model.root.children[1];
		controller.select(childA.id);

		controller.cutSelected();
		expect(branchA.children.length).toBe(0);
		expect(controller.model.byId.has(childA.id)).toBe(false);
		expect(controller.selectedId).toBe(branchA.id);

		controller.select(branchB.id);
		controller.pasteToSelected();

		expect(branchB.children.length).toBe(1);
		expect(branchB.children[0].text).toBe(childA.text);
		expect(branchB.children[0].id).not.toBe(childA.id);
	});

	it("cut is undoable independently of paste", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const childA = branchA.children[0];
		controller.select(childA.id);

		controller.cutSelected();
		expect(branchA.children.length).toBe(0);

		controller.undo();
		expect(branchA.children.length).toBe(1);
		expect(branchA.children[0]).toBe(childA);
	});

	it.each(["deleteSelected", "cutSelected"] as const)("%s cannot act on the root", (method) => {
		const controller = makeController();
		controller.select(controller.model.root.id);
		controller[method]();
		expect(controller.model.byId.has(controller.model.root.id)).toBe(true);
	});

	it("pasteToSelected with nothing selected pastes as a child of the root", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		controller.select(branchA.id);
		controller.copySelected();

		controller.select(null);
		controller.pasteToSelected();

		const pasted = controller.model.root.children[controller.model.root.children.length - 1];
		expect(pasted.text).toBe(branchA.text);
	});

	it("pasteToSelected is a no-op when the clipboard is empty", () => {
		const controller = makeController();
		const before = controller.model.root.subtreeCount;
		controller.pasteToSelected();
		expect(controller.model.root.subtreeCount).toBe(before);
	});

	it("paste is undoable", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const branchB = controller.model.root.children[1];
		controller.select(branchA.id);
		controller.copySelected();
		controller.select(branchB.id);
		controller.pasteToSelected();
		expect(branchB.children.length).toBe(1);

		controller.undo();
		expect(branchB.children.length).toBe(0);
	});
});

/**
 * F1: `assignMissingColors` isn't part of `Controller` itself — it's run by
 * the view's `onChange` handler, alongside `computeLayout`, after every
 * mutation (see `MindMapView.onChange`). These tests call it explicitly
 * right after the Controller mutation, the same way the real pipeline
 * would, to exercise the paste/move color-adoption fix end-to-end rather
 * than unit-testing `assignMissingColors` in isolation (already covered in
 * colors.test.ts).
 */
describe("Controller + assignMissingColors (F1: pasted/moved branch adopts the target branch's color)", () => {
	it("pasting a colored first-level branch inside a differently-colored branch resolves to the target's color", () => {
		const controller = makeController(["# Root", "## Branch A", "- a", "## Branch B", "- b"].join("\n"));
		assignMissingColors(controller.model.root);
		const branchA = controller.model.root.children[0];
		const branchB = controller.model.root.children[1];
		expect(branchA.colorKey).not.toBe(branchB.colorKey);

		controller.select(branchA.id);
		controller.copySelected();
		controller.select(branchB.id);
		controller.pasteToSelected();
		assignMissingColors(controller.model.root); // what MindMapView.onChange would do next

		const pasted = branchB.children[branchB.children.length - 1];
		expect(pasted.colorKey).toBeUndefined(); // not a first-level branch anymore
		expect(resolveNodeColorKey(pasted)).toBe(branchB.colorKey);
		expect(resolveNodeColorKey(pasted)).not.toBe(branchA.colorKey);
	});

	it("pasting a colored first-level branch at root level gets a fresh, distinct color", () => {
		const controller = makeController(["# Root", "## Branch A", "- a", "## Branch B"].join("\n"));
		assignMissingColors(controller.model.root);
		const branchA = controller.model.root.children[0];
		const branchB = controller.model.root.children[1];

		controller.select(branchA.id);
		controller.copySelected();
		controller.select(null); // nothing selected -> pastes as a new child of root
		controller.pasteToSelected();
		assignMissingColors(controller.model.root);

		const pasted = controller.model.root.children[controller.model.root.children.length - 1];
		expect(pasted.colorKey).toBeDefined();
		expect(pasted.colorKey).not.toBe(branchA.colorKey);
		expect(pasted.colorKey).not.toBe(branchB.colorKey);
	});

	it("drag-reordering (moveNode) a first-level branch inside another branch adopts the target's color", () => {
		const controller = makeController(["# Root", "## Branch A", "## Branch B"].join("\n"));
		assignMissingColors(controller.model.root);
		const branchA = controller.model.root.children[0];
		const branchB = controller.model.root.children[1];
		const staleColor = branchA.colorKey;
		expect(staleColor).not.toBe(branchB.colorKey);

		controller.moveNode(branchA.id, branchB.id, "inside");
		assignMissingColors(controller.model.root); // what MindMapView.onChange would do next

		expect(branchA.parent).toBe(branchB);
		expect(branchA.colorKey).toBeUndefined(); // no longer a direct child of root
		expect(resolveNodeColorKey(branchA)).toBe(branchB.colorKey);
		expect(resolveNodeColorKey(branchA)).not.toBe(staleColor);
	});
});

describe("Controller multi-selection", () => {
	it("plain select() always collapses to a single-node selection", () => {
		const controller = makeController();
		const [branchA, branchB] = controller.model.root.children;
		controller.toggleSelection(branchA.id);
		controller.toggleSelection(branchB.id);
		expect(controller.selectedIds.size).toBe(2);

		controller.select(branchA.id);
		expect(controller.selectedIds).toEqual(new Set([branchA.id]));
		expect(controller.selectedId).toBe(branchA.id);
	});

	it("toggleSelection adds/removes membership and moves the primary to the last-toggled-on node", () => {
		const controller = makeController();
		const [branchA, branchB] = controller.model.root.children;

		controller.toggleSelection(branchA.id);
		expect(controller.selectedIds).toEqual(new Set([branchA.id]));
		expect(controller.selectedId).toBe(branchA.id);

		controller.toggleSelection(branchB.id);
		expect(controller.selectedIds).toEqual(new Set([branchA.id, branchB.id]));
		expect(controller.selectedId).toBe(branchB.id);

		controller.toggleSelection(branchB.id); // toggle back off
		expect(controller.selectedIds).toEqual(new Set([branchA.id]));
		expect(controller.selectedId).toBe(branchA.id); // falls back to the remaining member
	});

	it("toggleSelection clears the primary entirely once the last member is toggled off", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		controller.toggleSelection(branchA.id);
		controller.toggleSelection(branchA.id);
		expect(controller.selectedIds.size).toBe(0);
		expect(controller.selectedId).toBeNull();
	});

	it("selectRange selects the contiguous sibling run between the anchor and the target, keeping the anchor as primary", () => {
		const controller = makeController(["# Root", "## A", "## B", "## C", "## D"].join("\n"));
		const [a, b, c, d] = controller.model.root.children;
		controller.select(a.id);

		controller.selectRange(c.id);
		expect(controller.selectedIds).toEqual(new Set([a.id, b.id, c.id]));
		expect(controller.selectedId).toBe(a.id); // anchor unchanged

		// A second shift-click adjusts the far end, not the start.
		controller.selectRange(d.id);
		expect(controller.selectedIds).toEqual(new Set([a.id, b.id, c.id, d.id]));
		expect(controller.selectedId).toBe(a.id);
	});

	it("selectRange falls back to a plain single selection across branches (no shared parent)", () => {
		const controller = makeController();
		const branchA = controller.model.root.children[0];
		const childA = branchA.children[0];
		controller.select(branchA.id);

		controller.selectRange(childA.id); // not a sibling of branchA
		expect(controller.selectedIds).toEqual(new Set([childA.id]));
		expect(controller.selectedId).toBe(childA.id);
	});

	it("collapseSelection returns to just the primary/anchor", () => {
		const controller = makeController(["# Root", "## A", "## B", "## C"].join("\n"));
		const [a, b] = controller.model.root.children;
		controller.select(a.id);
		controller.selectRange(b.id);
		expect(controller.selectedIds.size).toBe(2);

		controller.collapseSelection();
		expect(controller.selectedIds).toEqual(new Set([a.id]));
		expect(controller.selectedId).toBe(a.id);
	});

	it("bulk delete removes every normalized selected node as one undo step, restoring all of them on undo", () => {
		const controller = makeController(["# Root", "## A", "## B", "## C"].join("\n"));
		const [a, , c] = controller.model.root.children;
		controller.toggleSelection(a.id);
		controller.toggleSelection(c.id);

		let changeCount = 0;
		controller.addListener({ onChange: () => changeCount++, onEditRequest: () => {} });

		controller.deleteSelected();
		expect(controller.model.root.children.map((n) => n.id)).toEqual([controller.model.root.children[0].id]); // only B left
		expect(controller.model.root.children[0].text).toBe("B");
		expect(changeCount).toBe(1); // exactly one relayout/render per bulk op

		controller.undo();
		expect(controller.model.root.children.map((n) => n.text)).toEqual(["A", "B", "C"]);
	});

	it("normalizes away a descendant when its ancestor is also selected, so a bulk op doesn't double-delete", () => {
		const controller = makeController(["# Root", "## A", "- a1", "## B"].join("\n"));
		const a = controller.model.root.children[0];
		const a1 = a.children[0];
		controller.toggleSelection(a.id);
		controller.toggleSelection(a1.id); // descendant of A, already covered

		controller.deleteSelected();
		expect(controller.model.root.children.map((n) => n.text)).toEqual(["B"]);
	});

	it("bulk copy snapshots the selection in document order regardless of selection (toggle) order, and bulk paste inserts them in that same order", () => {
		const controller = makeController(["# Root", "## A", "## B", "## C"].join("\n"));
		const [a, b, c] = controller.model.root.children;
		// Toggle in reverse document order.
		controller.toggleSelection(c.id);
		controller.toggleSelection(a.id);
		controller.toggleSelection(b.id);

		controller.copySelected();
		controller.select(null);
		controller.pasteToSelected();

		const pastedTexts = controller.model.root.children.slice(3).map((n) => n.text);
		expect(pastedTexts).toEqual(["A", "B", "C"]);
	});

	it("bulk cut+paste is a single undo step for the delete side", () => {
		const controller = makeController(["# Root", "## A", "## B", "## C"].join("\n"));
		const [a, , c] = controller.model.root.children;
		controller.toggleSelection(a.id);
		controller.toggleSelection(c.id);

		controller.cutSelected();
		expect(controller.model.root.children.map((n) => n.text)).toEqual(["B"]);

		controller.undo();
		expect(controller.model.root.children.map((n) => n.text)).toEqual(["A", "B", "C"]);
	});
});

describe("Controller clipboard export/paste (plan item 06: tree copy to OS clipboard)", () => {
	it("getClipboardMarkdown reflects the internal clipboard as a plain markdown list, null when empty", () => {
		const controller = makeController();
		expect(controller.getClipboardMarkdown()).toBeNull();

		const branchA = controller.model.root.children[0];
		controller.select(branchA.id);
		controller.copySelected();

		expect(controller.getClipboardMarkdown()).toBe(["- Branch A", "  - a"].join("\n"));
	});

	it("pasteSubtrees inserts already-parsed external nodes as one undo step, same as pasteToSelected", () => {
		const controller = makeController();
		const branchB = controller.model.root.children[1];
		controller.select(branchB.id);

		const external = [
			{ id: "ext-1", text: "External A", children: [], parent: null, depth: 0, folded: false, subtreeCount: 0 },
			{ id: "ext-2", text: "External B", children: [], parent: null, depth: 0, folded: false, subtreeCount: 0 },
		];
		controller.pasteSubtrees(external);

		expect(branchB.children.map((n) => n.text)).toEqual(["External A", "External B"]);
		expect(controller.selectedId).toBe(branchB.children[1].id); // last pasted node is primary
		expect(controller.selectedIds).toEqual(new Set(branchB.children.map((n) => n.id)));

		controller.undo();
		expect(branchB.children.length).toBe(0);
	});

	it("pasteSubtrees is a no-op given an empty array", () => {
		const controller = makeController();
		const before = controller.model.root.subtreeCount;
		controller.pasteSubtrees([]);
		expect(controller.model.root.subtreeCount).toBe(before);
	});

	describe("pasteImageAsChild (Ctrl/Cmd+V with an image on the OS clipboard)", () => {
		it("inserts a new child of the selected node with the given embed text, and selects it", () => {
			const controller = makeController();
			const branchA = controller.model.root.children[0];
			controller.select(branchA.id);

			controller.pasteImageAsChild("![[Pasted image 20260707120000.png]]");

			expect(branchA.children.map((n) => n.text)).toEqual(["a", "![[Pasted image 20260707120000.png]]"]);
			const created = branchA.children[1];
			expect(controller.selectedId).toBe(created.id);
		});

		it("with nothing selected, inserts a child of the root", () => {
			const controller = makeController();
			controller.pasteImageAsChild("![[photo.png]]");
			const created = controller.model.root.children[controller.model.root.children.length - 1];
			expect(created.text).toBe("![[photo.png]]");
			expect(created.parent).toBe(controller.model.root);
		});

		it("is undoable", () => {
			const controller = makeController();
			const branchA = controller.model.root.children[0];
			controller.select(branchA.id);
			const before = branchA.children.length;

			controller.pasteImageAsChild("![[photo.png]]");
			expect(branchA.children.length).toBe(before + 1);

			controller.undo();
			expect(branchA.children.length).toBe(before);
		});
	});

	describe("moveSelectedInSiblingOrder (Alt+Up/Down)", () => {
		function makeSiblingsController() {
			return makeController(["# Root", "## A", "- a1", "- a2", "- a3"].join("\n"));
		}

		it.each([
			["up", [1, 0, 2]],
			["down", [0, 2, 1]],
		] as const)("Alt+%s swaps the selected node with its neighbor, selection following the moved node's id", (direction, order) => {
			const controller = makeSiblingsController();
			const a = controller.model.root.children[0];
			const originalIds = a.children.map((n) => n.id);
			const a2 = a.children[1];
			controller.select(a2.id);

			controller.moveSelectedInSiblingOrder(direction);
			expect(a.children.map((n) => n.id)).toEqual(order.map((i) => originalIds[i]));
			expect(controller.selectedId).toBe(a2.id);
		});

		it("is a no-op on the first sibling with Alt+Up, and the last sibling with Alt+Down", () => {
			const controller = makeSiblingsController();
			const a = controller.model.root.children[0];
			const [a1, , a3] = a.children;
			const order = a.children.map((n) => n.id);

			controller.select(a1.id);
			controller.moveSelectedInSiblingOrder("up");
			expect(a.children.map((n) => n.id)).toEqual(order);

			controller.select(a3.id);
			controller.moveSelectedInSiblingOrder("down");
			expect(a.children.map((n) => n.id)).toEqual(order);
		});

		it("is a no-op when nothing is selected, or the selected node is the root", () => {
			const controller = makeSiblingsController();
			controller.moveSelectedInSiblingOrder("up"); // nothing selected

			controller.select(controller.model.root.id);
			expect(() => controller.moveSelectedInSiblingOrder("down")).not.toThrow();
			expect(controller.model.root.parent).toBeNull();
		});

		it("is undoable", () => {
			const controller = makeSiblingsController();
			const a = controller.model.root.children[0];
			const [a1, a2, a3] = a.children;
			controller.select(a2.id);

			controller.moveSelectedInSiblingOrder("up");
			controller.undo();
			expect(a.children.map((n) => n.id)).toEqual([a1.id, a2.id, a3.id]);
		});
	});
});
