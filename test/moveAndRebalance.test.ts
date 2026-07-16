import { describe, expect, it } from "vitest";
import { parseMindMap } from "../webview/sync/parser";
import { moveNode, rebalanceAll, setManualPosition } from "../webview/model/mutations";
import { Controller } from "../webview/controller/Controller";

function makeModel(md = "# Root\n## A\n- a1\n## B\n- b1\n") {
	return parseMindMap(md, "fallback");
}

describe("moveNode", () => {
	it("reparents a node, updating both old and new parent's subtreeCount", () => {
		const model = makeModel();
		const a = model.root.children[0];
		const b = model.root.children[1];
		const a1 = a.children[0];

		moveNode(model, a1.id, b.id);
		expect(a.children).toHaveLength(0);
		expect(b.children.map((n) => n.id)).toContain(a1.id);
		expect(a.subtreeCount).toBe(0);
		expect(b.subtreeCount).toBe(2); // b1, a1
		expect(a1.parent).toBe(b);
	});

	it("updates depth for the moved node and its descendants", () => {
		const model = makeModel(["# Root", "## A", "- a1", "  - a2", "## B"].join("\n"));
		const a = model.root.children[0];
		const b = model.root.children[1];
		const a1 = a.children[0];
		const a2 = a1.children[0];

		moveNode(model, a1.id, b.id);
		expect(a1.depth).toBe(2); // still one below its new parent B (depth 1)
		expect(a2.depth).toBe(3);
	});

	it("is a no-op when moving a node under itself", () => {
		const model = makeModel();
		const a = model.root.children[0];
		moveNode(model, a.id, a.id);
		expect(a.parent).toBe(model.root);
	});

	it("is a no-op when moving a node under its own descendant (would create a cycle)", () => {
		const model = makeModel();
		const a = model.root.children[0];
		const a1 = a.children[0];
		moveNode(model, a.id, a1.id);
		expect(a.parent).toBe(model.root);
		expect(a1.parent).toBe(a);
	});

	it("inserts at a specific index when given one", () => {
		const model = makeModel(["# Root", "## A", "- a1", "- a2", "- a3"].join("\n"));
		const a = model.root.children[0];
		const [a1, a2, a3] = a.children;
		moveNode(model, a3.id, a.id, 0);
		expect(a.children.map((n) => n.id)).toEqual([a3.id, a1.id, a2.id]);
	});
});

describe("rebalanceAll", () => {
	it("clears manual positions and branch sides on every node", () => {
		const model = makeModel();
		const a = model.root.children[0];
		const a1 = a.children[0];
		a.branchSide = "L";
		a1.manualPos = { x: 10, y: 10 };

		rebalanceAll(model);
		expect(a.branchSide).toBeUndefined();
		expect(a1.manualPos).toBeUndefined();
	});
});

describe("Controller manual position / move / rebalance", () => {
	it("setManualPosition is undoable, restoring 'no pin' if there wasn't one before", () => {
		const controller = new Controller(makeModel());
		const a = controller.model.root.children[0];
		controller.setManualPosition(a.id, { x: 100, y: 200 });
		expect(a.manualPos).toEqual({ x: 100, y: 200 });
		controller.undo();
		expect(a.manualPos).toBeUndefined();
		controller.redo();
		expect(a.manualPos).toEqual({ x: 100, y: 200 });
	});

	it("setManualPosition undo restores the previous pin, not just clears it", () => {
		const controller = new Controller(makeModel());
		const a = controller.model.root.children[0];
		controller.setManualPosition(a.id, { x: 1, y: 1 });
		controller.setManualPosition(a.id, { x: 2, y: 2 });
		controller.undo();
		expect(a.manualPos).toEqual({ x: 1, y: 1 });
	});

	it("setManualWidth is undoable, restoring 'no pin' if there wasn't one before", () => {
		const controller = new Controller(makeModel());
		const a = controller.model.root.children[0];
		controller.setManualWidth(a.id, 250);
		expect(a.manualWidth).toBe(250);
		controller.undo();
		expect(a.manualWidth).toBeUndefined();
		controller.redo();
		expect(a.manualWidth).toBe(250);
	});

	it("setManualWidth undo restores the previous width, not just clears it", () => {
		const controller = new Controller(makeModel());
		const a = controller.model.root.children[0];
		controller.setManualWidth(a.id, 200);
		controller.setManualWidth(a.id, 300);
		controller.undo();
		expect(a.manualWidth).toBe(200);
	});

	it("moveNode is undoable back to the exact original index", () => {
		const controller = new Controller(makeModel(["# Root", "## A", "- a1", "- a2", "## B"].join("\n")));
		const a = controller.model.root.children[0];
		const b = controller.model.root.children[1];
		const a2 = a.children[1];

		controller.moveNode(a2.id, b.id);
		expect(a2.parent).toBe(b);

		controller.undo();
		expect(a2.parent).toBe(a);
		expect(a.children.map((n) => n.id)).toEqual([a.children[0].id, a2.id]);
	});

	describe("same-level reorder (before/after)", () => {
		it("moves a node before an earlier sibling within the same parent", () => {
			const controller = new Controller(makeModel(["# Root", "## A", "- a1", "- a2", "- a3"].join("\n")));
			const a = controller.model.root.children[0];
			const [a1, a2, a3] = a.children;

			controller.moveNode(a3.id, a1.id, "before");
			expect(a.children.map((n) => n.id)).toEqual([a3.id, a1.id, a2.id]);
			expect(a3.parent).toBe(a);
		});

		it("moves a node after a later sibling within the same parent", () => {
			const controller = new Controller(makeModel(["# Root", "## A", "- a1", "- a2", "- a3"].join("\n")));
			const a = controller.model.root.children[0];
			const [a1, a2, a3] = a.children;

			controller.moveNode(a1.id, a2.id, "after");
			expect(a.children.map((n) => n.id)).toEqual([a2.id, a1.id, a3.id]);
		});

		it("moves a node after an earlier sibling within the same parent", () => {
			const controller = new Controller(makeModel(["# Root", "## A", "- a1", "- a2", "- a3"].join("\n")));
			const a = controller.model.root.children[0];
			const [a1, a2, a3] = a.children;

			controller.moveNode(a3.id, a1.id, "after");
			expect(a.children.map((n) => n.id)).toEqual([a1.id, a3.id, a2.id]);
		});

		it("reorders across different parents by dropping before/after a node in another branch", () => {
			const controller = new Controller(makeModel(["# Root", "## A", "- a1", "## B", "- b1", "- b2"].join("\n")));
			const a = controller.model.root.children[0];
			const b = controller.model.root.children[1];
			const a1 = a.children[0];
			const [b1, b2] = b.children;

			controller.moveNode(a1.id, b1.id, "before");
			expect(a.children).toHaveLength(0);
			expect(b.children.map((n) => n.id)).toEqual([a1.id, b1.id, b2.id]);
			expect(a1.parent).toBe(b);
		});

		it("is undoable back to the exact original index", () => {
			const controller = new Controller(makeModel(["# Root", "## A", "- a1", "- a2", "- a3"].join("\n")));
			const a = controller.model.root.children[0];
			const [a1, a2, a3] = a.children;

			controller.moveNode(a3.id, a1.id, "before");
			controller.undo();
			expect(a.children.map((n) => n.id)).toEqual([a1.id, a2.id, a3.id]);
		});

		it("falls back to nesting as a child when the target is the root (no parent to become a sibling of)", () => {
			const controller = new Controller(makeModel(["# Root", "## A", "- a1", "## B"].join("\n")));
			const a = controller.model.root.children[0];
			const a1 = a.children[0];
			const root = controller.model.root;

			controller.moveNode(a1.id, root.id, "before");
			expect(a1.parent).toBe(root);
		});
	});

	it("rebalance clears pins/sides and is undoable", () => {
		const controller = new Controller(makeModel());
		const a = controller.model.root.children[0];
		const a1 = a.children[0];
		a.branchSide = "R";
		a1.manualPos = { x: 5, y: 5 };

		controller.rebalance();
		expect(a.branchSide).toBeUndefined();
		expect(a1.manualPos).toBeUndefined();

		controller.undo();
		expect(a.branchSide).toBe("R");
		expect(a1.manualPos).toEqual({ x: 5, y: 5 });
	});
});
