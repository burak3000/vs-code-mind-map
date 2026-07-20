import { MindMapModel, MindNode } from "./types";
import { createId } from "./id";

/** Bumps subtreeCount along the ancestor chain only — O(depth), not O(n). */
function bumpSubtreeCount(node: MindNode | null, delta: number): void {
	let cur = node;
	while (cur) {
		cur.subtreeCount += delta;
		cur = cur.parent;
	}
}

function indexSubtree(node: MindNode, byId: Map<string, MindNode>): void {
	byId.set(node.id, node);
	for (const child of node.children) indexSubtree(child, byId);
}

function unindexSubtree(node: MindNode, byId: Map<string, MindNode>): void {
	byId.delete(node.id);
	for (const child of node.children) unindexSubtree(child, byId);
}

/** Inserts a brand-new child node at `index` (default: end) of `parent`. Localized: O(depth) for the count bump, O(1) otherwise. */
export function addChild(model: MindMapModel, parentId: string, text: string, index?: number): MindNode {
	const parent = model.byId.get(parentId);
	if (!parent) throw new Error(`addChild: unknown parent id ${parentId}`);

	const node: MindNode = {
		id: createId(),
		text,
		children: [],
		parent,
		depth: parent.depth + 1,
		folded: false,
		subtreeCount: 0,
	};
	const at = index === undefined ? parent.children.length : index;
	parent.children.splice(at, 0, node);
	model.byId.set(node.id, node);
	bumpSubtreeCount(parent, 1);
	model.version += 1;
	return node;
}

/** Inserts a new sibling of `siblingId`, immediately before or after it. */
export function addSibling(model: MindMapModel, siblingId: string, text: string, position: "before" | "after"): MindNode {
	const sibling = model.byId.get(siblingId);
	if (!sibling) throw new Error(`addSibling: unknown node id ${siblingId}`);
	if (!sibling.parent) throw new Error("addSibling: cannot add a sibling to the root");

	const parent = sibling.parent;
	const idx = parent.children.indexOf(sibling);
	const at = position === "before" ? idx : idx + 1;
	return addChild(model, parent.id, text, at);
}

export function renameNode(model: MindMapModel, nodeId: string, text: string): void {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`renameNode: unknown node id ${nodeId}`);
	node.text = text;
	model.version += 1;
}

export interface RemovedNodeRecord {
	node: MindNode;
	parent: MindNode;
	index: number;
}

/** Removes a node and its whole subtree. Returns enough info to undo (re-insert at the same index). Cannot remove the root. */
export function deleteNode(model: MindMapModel, nodeId: string): RemovedNodeRecord {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`deleteNode: unknown node id ${nodeId}`);
	if (!node.parent) throw new Error("deleteNode: cannot delete the root node");

	const parent = node.parent;
	const index = parent.children.indexOf(node);
	parent.children.splice(index, 1);
	unindexSubtree(node, model.byId);
	bumpSubtreeCount(parent, -(1 + node.subtreeCount));
	model.version += 1;
	return { node, parent, index };
}

/** Inverse of deleteNode — re-inserts a previously-removed subtree at its original position, preserving all descendant ids/state. */
export function restoreNode(model: MindMapModel, record: RemovedNodeRecord): void {
	record.node.parent = record.parent;
	record.parent.children.splice(record.index, 0, record.node);
	indexSubtree(record.node, model.byId);
	bumpSubtreeCount(record.parent, 1 + record.node.subtreeCount);
	model.version += 1;
}

export function setFolded(model: MindMapModel, nodeId: string, folded: boolean): void {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`setFolded: unknown node id ${nodeId}`);
	node.folded = folded;
	model.version += 1;
}

export function setStatusBadge(model: MindMapModel, nodeId: string, badge: string | undefined): void {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`setStatusBadge: unknown node id ${nodeId}`);
	node.statusBadge = badge;
	model.version += 1;
}

/** Pins a node to an absolute position, excluding it from auto-balance layout (R12). */
export function setManualPosition(model: MindMapModel, nodeId: string, pos: { x: number; y: number }): void {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`setManualPosition: unknown node id ${nodeId}`);
	node.manualPos = pos;
	model.version += 1;
}

/** Releases a node's manual pin so it rejoins auto-balance layout. */
export function clearManualPosition(model: MindMapModel, nodeId: string): void {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`clearManualPosition: unknown node id ${nodeId}`);
	node.manualPos = undefined;
	model.version += 1;
}

/** Pins a node's wrap width to a drag-resized value, overriding the default character-count wrap width. */
export function setManualWidth(model: MindMapModel, nodeId: string, width: number): void {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`setManualWidth: unknown node id ${nodeId}`);
	node.manualWidth = width;
	model.version += 1;
}

/** Releases a node's manual width pin so it reverts to the default character-count wrap width. */
export function clearManualWidth(model: MindMapModel, nodeId: string): void {
	const node = model.byId.get(nodeId);
	if (!node) throw new Error(`clearManualWidth: unknown node id ${nodeId}`);
	node.manualWidth = undefined;
	model.version += 1;
}

/**
 * Reparents a node under `newParentId` at `index` (default: end). Rejects
 * moving a node under itself or one of its own descendants (would create a
 * cycle) — silently no-ops rather than throwing, since this is normally
 * called from a live drag gesture where the user might hover an invalid
 * target transiently.
 */
export function moveNode(model: MindMapModel, nodeId: string, newParentId: string, index?: number): void {
	const node = model.byId.get(nodeId);
	const newParent = model.byId.get(newParentId);
	if (!node || !newParent || !node.parent) return;
	if (node === newParent) return;

	let cur: MindNode | null = newParent;
	while (cur) {
		if (cur === node) return; // would create a cycle
		cur = cur.parent;
	}

	const oldParent = node.parent;
	const oldIndex = oldParent.children.indexOf(node);
	oldParent.children.splice(oldIndex, 1);
	bumpSubtreeCount(oldParent, -(1 + node.subtreeCount));

	node.parent = newParent;
	const at = index === undefined ? newParent.children.length : index;
	newParent.children.splice(at, 0, node);
	bumpSubtreeCount(newParent, 1 + node.subtreeCount);

	// Depth changes propagate down the moved subtree only — O(moved size), not O(n).
	const depthDelta = newParent.depth + 1 - node.depth;
	if (depthDelta !== 0) {
		const updateDepth = (n: MindNode) => {
			n.depth += depthDelta;
			n.children.forEach(updateDepth);
		};
		updateDepth(node);
	}

	model.version += 1;
}

/**
 * Deep-clones a node and its subtree with brand-new ids throughout, so the
 * clone can coexist with the original in the same model (copy/paste, R-copy).
 * Detached (`parent: null`) — caller inserts it with `insertSubtree`.
 * Drops `manualPos`/`branchSide`: those are meaningful only at the original's
 * specific position in the tree and would misplace/overlap once pasted
 * elsewhere. Also drops `colorKey` (F1): it's only meaningful on a direct
 * child of root, and the clone's eventual position (root-level vs. nested
 * inside another branch) isn't known yet here — `assignMissingColors` gives
 * it a fresh slot or lets it inherit its new parent branch's color once
 * inserted, instead of carrying a stale copy of the original's color that
 * would shadow the target branch's. Belt-and-suspenders with
 * `assignMissingColors`'s own invariant enforcement: this keeps the clone
 * clean from the instant it's created, before the next `onChange` even runs.
 */
export function cloneSubtree(node: MindNode): MindNode {
	const clone: MindNode = {
		id: createId(),
		text: node.text,
		children: [],
		parent: null,
		depth: node.depth,
		folded: node.folded,
		manualWidth: node.manualWidth,
		statusBadge: node.statusBadge,
		subtreeCount: 0,
		attachedContent: node.attachedContent ? [...node.attachedContent] : undefined,
	};
	for (const child of node.children) {
		const childClone = cloneSubtree(child);
		childClone.parent = clone;
		clone.children.push(childClone);
	}
	clone.subtreeCount = clone.children.reduce((sum, c) => sum + 1 + c.subtreeCount, 0);
	return clone;
}

/**
 * Inserts a detached subtree (from `cloneSubtree`, or previously removed by
 * `deleteNode`) as a child of `parentId` at `index` (default: end). Fixes up
 * depth down the inserted subtree only and re-indexes its ids —
 * O(size of inserted subtree), not O(n).
 */
export function insertSubtree(model: MindMapModel, parentId: string, subtreeRoot: MindNode, index?: number): MindNode {
	const parent = model.byId.get(parentId);
	if (!parent) throw new Error(`insertSubtree: unknown parent id ${parentId}`);

	subtreeRoot.parent = parent;
	const depthDelta = parent.depth + 1 - subtreeRoot.depth;
	if (depthDelta !== 0) {
		const updateDepth = (n: MindNode) => {
			n.depth += depthDelta;
			n.children.forEach(updateDepth);
		};
		updateDepth(subtreeRoot);
	}

	const at = index === undefined ? parent.children.length : index;
	parent.children.splice(at, 0, subtreeRoot);
	indexSubtree(subtreeRoot, model.byId);
	bumpSubtreeCount(parent, 1 + subtreeRoot.subtreeCount);
	model.version += 1;
	return subtreeRoot;
}

/**
 * Clears every manual position pin and every sticky branch-side assignment
 * in the whole tree, so the next layout recomputes a fresh optimal
 * balance from scratch — the "Rebalance" command (plan §9.3).
 */
export function rebalanceAll(model: MindMapModel): void {
	const walk = (node: MindNode) => {
		node.manualPos = undefined;
		node.branchSide = undefined;
		node.children.forEach(walk);
	};
	walk(model.root);
	model.version += 1;
}
