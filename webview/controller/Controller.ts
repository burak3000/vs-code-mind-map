import { DropPosition, MindMapModel, MindNode } from "../model/types";
import {
	addChild,
	addSibling,
	deleteNode,
	renameNode,
	restoreNode,
	setFolded,
	setManualPosition,
	clearManualPosition,
	setManualWidth,
	clearManualWidth,
	moveNode,
	rebalanceAll,
	cloneSubtree,
	insertSubtree,
	RemovedNodeRecord,
} from "../model/mutations";
import { CommandStack } from "../model/commandStack";
import { serializeSubtrees } from "../sync/serializer";

export interface ControllerListener {
	/** Model and/or selection changed — relayout, re-render, schedule debounced save. */
	onChange(): void;
	/** A node was just created (or F2/dblclick fired) and should open the inline editor. */
	onEditRequest(nodeId: string): void;
}

/**
 * Document-order comparator for `normalizedSelection`'s sort: walks each
 * node's ancestor path up to the root, finds where the two paths diverge,
 * and compares child indices at that shared parent — O(depth) per
 * comparison via `indexOf` on that one level's (typically small) sibling
 * array, not an O(whole tree) traversal to build a global order index.
 */
function compareDocumentOrder(a: MindNode, b: MindNode): number {
	const pathA: MindNode[] = [];
	for (let n: MindNode | null = a; n; n = n.parent) pathA.unshift(n);
	const pathB: MindNode[] = [];
	for (let n: MindNode | null = b; n; n = n.parent) pathB.unshift(n);

	let i = 0;
	while (i < pathA.length && i < pathB.length && pathA[i] === pathB[i]) i++;
	if (i >= pathA.length) return -1; // a is an ancestor of b (or the same node)
	if (i >= pathB.length) return 1;

	const parent = pathA[i - 1];
	return parent.children.indexOf(pathA[i]) - parent.children.indexOf(pathB[i]);
}

/**
 * Mediates all model mutations through the undo/redo command stack and
 * fans out change notifications. Keyboard handlers (View) stay thin:
 * translate a keypress into one Controller call.
 */
export class Controller {
	private readonly stack = new CommandStack(100);
	private listeners: ControllerListener[] = [];
	/** Primary/anchor selection — keyboard nav target, inline-editor target, Shift+click range anchor. Always a member of `selectedIds` when non-null. */
	selectedId: string | null = null;
	/** Full multi-selection (R-multi-select). Plain `select()` collapses this to `{id}` (or empty); `toggleSelection`/`selectRange` grow it. */
	selectedIds: Set<string> = new Set();
	/** In-memory clipboard (Ctrl/Cmd+C/X/V) — detached, ready-to-clone subtrees, document-ordered. Not persisted; cleared on plugin reload. */
	private clipboard: MindNode[] | null = null;

	constructor(public model: MindMapModel) {}

	/** Sets both the primary selection and the full selection set to just that one node (or clears both) — the invariant every single-target operation (Tab, Enter, delete, etc.) keeps. */
	private setPrimarySelection(id: string | null): void {
		this.selectedId = id;
		this.selectedIds = id ? new Set([id]) : new Set();
	}

	/**
	 * Drops any selected node whose ancestor is also selected — operating on
	 * the ancestor already covers its descendants, so keeping both would
	 * double-clone/double-delete — and excludes the root (never a valid
	 * bulk-op target). Returns the survivors in document order, not
	 * selection/Set-insertion order, so clipboard/delete/paste order matches
	 * what the user sees in the file.
	 */
	private normalizedSelection(): MindNode[] {
		const ids = this.selectedIds.size > 0 ? this.selectedIds : this.selectedId ? new Set([this.selectedId]) : new Set<string>();
		const nodes = Array.from(ids)
			.map((id) => this.model.byId.get(id))
			.filter((n): n is MindNode => !!n && n.parent !== null);
		const idSet = new Set(nodes.map((n) => n.id));
		const kept = nodes.filter((n) => {
			for (let cur = n.parent; cur; cur = cur.parent) {
				if (idSet.has(cur.id)) return false;
			}
			return true;
		});
		kept.sort(compareDocumentOrder);
		return kept;
	}

	/**
	 * Compound delete of `nodes` as a single undo step (do: delete each;
	 * undo: restore each from its `RemovedNodeRecord` in reverse deletion
	 * order — restoring later-recorded indices first is what makes each
	 * recorded index valid again as the array is walked backward). Selects
	 * the last node's former parent afterward, same as a single delete.
	 * Shared by `deleteSelected`/`cutSelected`; callers still own
	 * `emitChange()` so it fires exactly once per bulk op.
	 */
	private bulkDelete(nodes: MindNode[]): void {
		const nodeIds = nodes.map((n) => n.id);
		const parentId = nodes[nodes.length - 1].parent!.id;
		let records: RemovedNodeRecord[] = [];
		this.stack.execute({
			do: () => {
				records = nodeIds.map((id) => deleteNode(this.model, id));
			},
			undo: () => {
				for (let i = records.length - 1; i >= 0; i--) restoreNode(this.model, records[i]);
			},
		});
		this.setPrimarySelection(parentId);
	}

	addListener(listener: ControllerListener): void {
		this.listeners.push(listener);
	}

	removeListener(listener: ControllerListener): void {
		this.listeners = this.listeners.filter((l) => l !== listener);
	}

	private emitChange(): void {
		for (const l of this.listeners) l.onChange();
	}

	private emitEditRequest(nodeId: string): void {
		for (const l of this.listeners) l.onEditRequest(nodeId);
	}

	/** Plain click / arrow nav (R-multi-select): always collapses to a single selection, even if a multi-selection is currently active. */
	select(id: string | null): void {
		if (this.selectedId === id && this.selectedIds.size <= 1) return;
		this.setPrimarySelection(id);
		this.emitChange();
	}

	/** Ctrl/Cmd+click (R-multi-select): toggles `id`'s membership without disturbing the rest of the selection. Primary follows the last node toggled on; toggling the primary off falls back to another selected node (arbitrary) or clears it entirely. */
	toggleSelection(id: string): void {
		const ids = new Set(this.selectedIds);
		if (ids.has(id)) {
			ids.delete(id);
			this.selectedIds = ids;
			if (this.selectedId === id) this.selectedId = ids.size > 0 ? ids.values().next().value! : null;
		} else {
			ids.add(id);
			this.selectedIds = ids;
			this.selectedId = id;
		}
		this.emitChange();
	}

	/**
	 * Shift+click (R-multi-select): selects the contiguous run of siblings
	 * between the current primary/anchor and `id`, inclusive. Cross-branch
	 * shift-select (no shared parent, or nothing selected yet) is out of
	 * scope — falls back to a plain single selection of `id`. The anchor
	 * itself is left unchanged so repeated shift-clicks adjust the range's
	 * far end, not its start.
	 */
	selectRange(id: string): void {
		const anchor = this.selectedId ? this.model.byId.get(this.selectedId) : undefined;
		const target = this.model.byId.get(id);
		if (!anchor || !target || !anchor.parent || anchor.parent !== target.parent) {
			this.select(id);
			return;
		}
		const siblings = anchor.parent.children;
		const i = siblings.indexOf(anchor);
		const j = siblings.indexOf(target);
		const [lo, hi] = i < j ? [i, j] : [j, i];
		this.selectedIds = new Set(siblings.slice(lo, hi + 1).map((n) => n.id));
		this.emitChange();
	}

	/** Esc (R-multi-select): collapses an active multi-selection back to just the primary/anchor. */
	collapseSelection(): void {
		if (this.selectedIds.size <= 1) return;
		this.setPrimarySelection(this.selectedId);
		this.emitChange();
	}

	/**
	 * Search-jump support: unfolds every folded ancestor of a node (if any)
	 * — as a single undo step, same as any other structural mutation — then
	 * selects it. Used when a search result might be hidden behind a
	 * folded branch and needs to become visible before it can be selected
	 * and focused in the view. Selection itself isn't part of undo/redo,
	 * matching `select`.
	 */
	revealAndSelect(nodeId: string): void {
		const node = this.model.byId.get(nodeId);
		if (!node) return;
		const foldedAncestors: MindNode[] = [];
		let cur = node.parent;
		while (cur) {
			if (cur.folded) foldedAncestors.push(cur);
			cur = cur.parent;
		}
		if (foldedAncestors.length > 0) {
			this.stack.execute({
				do: () => foldedAncestors.forEach((a) => setFolded(this.model, a.id, false)),
				undo: () => foldedAncestors.forEach((a) => setFolded(this.model, a.id, true)),
			});
		}
		this.setPrimarySelection(nodeId);
		this.emitChange();
	}

	/** Tab (R2): new child of the selected node (or root if nothing selected), immediately editable. */
	addChildToSelected(): void {
		const parentId = this.selectedId ?? this.model.root.id;
		let createdId = "";
		this.stack.execute({
			do: () => {
				createdId = addChild(this.model, parentId, "").id;
			},
			undo: () => {
				if (createdId) deleteNode(this.model, createdId);
			},
		});
		this.setPrimarySelection(createdId);
		this.emitChange();
		this.emitEditRequest(createdId);
	}

	/**
	 * Ctrl/Cmd+V when the OS clipboard holds image data (not text): inserts
	 * a new child of the selected node (or the root) whose text is the
	 * given image-embed markdown (e.g. `![[Pasted image ...png]]`) — same
	 * "child of selection" convention as `addChildToSelected`/
	 * `pasteToSelected`. Writing the image file into the vault and building
	 * the embed text both happen in the view layer (needs `app.vault`); this
	 * is just the synchronous, testable tree insert.
	 */
	pasteImageAsChild(embedText: string): void {
		const parentId = this.selectedId ?? this.model.root.id;
		let createdId = "";
		this.stack.execute({
			do: () => {
				createdId = addChild(this.model, parentId, embedText).id;
			},
			undo: () => {
				if (createdId) deleteNode(this.model, createdId);
			},
		});
		this.setPrimarySelection(createdId);
		this.emitChange();
	}

	/** Enter / Shift+Enter (R3/R4): new sibling after/before the selected node. No-op on the root (it has no siblings). */
	addSiblingToSelected(position: "before" | "after"): void {
		if (!this.selectedId) return;
		const node = this.model.byId.get(this.selectedId);
		if (!node || !node.parent) return;
		const anchorId = this.selectedId;
		let createdId = "";
		this.stack.execute({
			do: () => {
				createdId = addSibling(this.model, anchorId, "", position).id;
			},
			undo: () => {
				if (createdId) deleteNode(this.model, createdId);
			},
		});
		this.setPrimarySelection(createdId);
		this.emitChange();
		this.emitEditRequest(createdId);
	}

	requestEdit(nodeId: string): void {
		this.emitEditRequest(nodeId);
	}

	/** Commit text from the inline editor (blur / Esc / Enter-while-editing). */
	commitRename(nodeId: string, text: string): void {
		const node = this.model.byId.get(nodeId);
		if (!node) return;
		const before = node.text;
		if (before === text) return;
		this.stack.execute({
			do: () => renameNode(this.model, nodeId, text),
			undo: () => renameNode(this.model, nodeId, before),
		});
		this.emitChange();
	}

	/** Delete/Backspace (R4/R-multi-select): remove the (normalized) selection as one undo step, select the last node's former parent. No-op on the root, or when nothing survives normalization. */
	deleteSelected(): void {
		const nodes = this.normalizedSelection();
		if (nodes.length === 0) return;
		this.bulkDelete(nodes);
		this.emitChange();
	}

	/** Ctrl/Cmd+C (R-multi-select): snapshots the (normalized) selection's subtrees into the clipboard, document-ordered. Leaves the model untouched (not undoable — there's nothing to undo). Single-selection is just the length-1 case. */
	copySelected(): void {
		const nodes = this.normalizedSelection();
		if (nodes.length === 0) return;
		this.clipboard = nodes.map((n) => cloneSubtree(n));
	}

	/** Ctrl/Cmd+X (R-multi-select): like deleteSelected, but stashes clones of the (normalized) selection in the clipboard first so a later paste can restore them elsewhere. No-op on the root, or when nothing survives normalization. */
	cutSelected(): void {
		const nodes = this.normalizedSelection();
		if (nodes.length === 0) return;
		this.clipboard = nodes.map((n) => cloneSubtree(n));
		this.bulkDelete(nodes);
		this.emitChange();
	}

	/**
	 * Shared insert-multiple-as-one-undo-step logic for `pasteToSelected`/
	 * `pasteSubtrees`: inserts each of `subtrees` (already detached,
	 * fresh-id'd, and in the order they should appear) as the last children
	 * of `parentId`. Selects every inserted node, with the last one as
	 * primary — same as a single paste generalized to N nodes.
	 */
	private bulkInsert(subtrees: MindNode[], parentId: string): void {
		let insertedIds: string[] = [];
		this.stack.execute({
			do: () => {
				insertedIds = subtrees.map((subtree) => insertSubtree(this.model, parentId, subtree).id);
			},
			undo: () => {
				insertedIds.forEach((id) => deleteNode(this.model, id));
			},
		});
		this.selectedId = insertedIds.length > 0 ? insertedIds[insertedIds.length - 1] : null;
		this.selectedIds = new Set(insertedIds);
	}

	/**
	 * Ctrl/Cmd+V (R-multi-select): inserts a fresh clone of every clipboard
	 * subtree, in clipboard order, as the last children of the selected node
	 * (or the root, if nothing is selected) — one undo step. Paste can be
	 * repeated — each call re-clones the clipboard with new ids, so pasting
	 * the same cut/copy into multiple targets works.
	 */
	pasteToSelected(): void {
		if (!this.clipboard || this.clipboard.length === 0) return;
		const parentId = this.selectedId ?? this.model.root.id;
		if (!this.model.byId.has(parentId)) return;
		this.bulkInsert(
			this.clipboard.map((n) => cloneSubtree(n)),
			parentId
		);
		this.emitChange();
	}

	/**
	 * Ctrl/Cmd+V when the OS clipboard holds text that didn't come from this
	 * plugin's own last copy/cut (plan item 06): inserts already-parsed
	 * external subtrees (see `parseExternalPaste`) the same way
	 * `pasteToSelected` inserts the internal clipboard — one undo step,
	 * selects every inserted node with the last as primary. The view layer
	 * decides which of the two paste paths applies and owns the actual OS
	 * clipboard read, keeping this method (like every other Controller
	 * mutation) synchronous and testable without stubbing `navigator.clipboard`.
	 */
	pasteSubtrees(subtrees: MindNode[]): void {
		if (subtrees.length === 0) return;
		const parentId = this.selectedId ?? this.model.root.id;
		if (!this.model.byId.has(parentId)) return;
		this.bulkInsert(subtrees, parentId);
		this.emitChange();
	}

	/** The subtree(s) currently on the internal clipboard, serialized as plain markdown (plan item 06) — the view layer writes this to the OS clipboard right after `copySelected`/`cutSelected`. Null when there's nothing to copy. */
	getClipboardMarkdown(): string | null {
		return this.clipboard ? serializeSubtrees(this.clipboard) : null;
	}

	/** Ctrl/Cmd+/ (R13): fold/unfold — wired up starting M4, but the primitive lives here since it's a plain mutation. */
	toggleFold(nodeId: string): void {
		const node = this.model.byId.get(nodeId);
		if (!node || node.children.length === 0) return;
		const before = node.folded;
		this.stack.execute({
			do: () => setFolded(this.model, nodeId, !before),
			undo: () => setFolded(this.model, nodeId, before),
		});
		this.emitChange();
	}

	/** Alt+drag (R12): pins a node to an absolute position, excluding it from auto-balance. */
	setManualPosition(nodeId: string, pos: { x: number; y: number }): void {
		const node = this.model.byId.get(nodeId);
		if (!node) return;
		const before = node.manualPos;
		this.stack.execute({
			do: () => setManualPosition(this.model, nodeId, pos),
			undo: () => {
				if (before) setManualPosition(this.model, nodeId, before);
				else clearManualPosition(this.model, nodeId);
			},
		});
		this.emitChange();
	}

	/** Drag-resize: pins a node's wrap width, overriding the default character-count wrap width. */
	setManualWidth(nodeId: string, width: number): void {
		const node = this.model.byId.get(nodeId);
		if (!node) return;
		const before = node.manualWidth;
		this.stack.execute({
			do: () => setManualWidth(this.model, nodeId, width),
			undo: () => {
				if (before !== undefined) setManualWidth(this.model, nodeId, before);
				else clearManualWidth(this.model, nodeId);
			},
		});
		this.emitChange();
	}

	/**
	 * Plain drag (R4 drag-reorder): drops `nodeId` on `targetId`. `"inside"`
	 * (default, back-compat with the original nest-only behavior) reparents
	 * it as the last child of `targetId`. `"before"`/`"after"` instead
	 * reorders it as `targetId`'s sibling — same-level reorder, no
	 * reparenting — by resolving to `targetId`'s parent and its index
	 * (adjusted for the removal shift when moving within that same parent).
	 * Falls back to `"inside"` if `targetId` is the root (no parent to become
	 * a sibling under). Silently no-ops on an invalid target (self/
	 * descendant) — see mutations.moveNode.
	 */
	moveNode(nodeId: string, targetId: string, position: DropPosition = "inside"): void {
		const node = this.model.byId.get(nodeId);
		const target = this.model.byId.get(targetId);
		if (!node || !node.parent || !target) return;
		const oldParentId = node.parent.id;
		const oldIndex = node.parent.children.indexOf(node);

		let newParentId = targetId;
		let newIndex: number | undefined;
		if (position !== "inside" && target.parent) {
			newParentId = target.parent.id;
			const targetIndex = target.parent.children.indexOf(target);
			newIndex = position === "before" ? targetIndex : targetIndex + 1;
			// Removing the node from its old spot first (see mutations.moveNode)
			// shifts every later index down by one — only relevant when the
			// reorder stays within the same parent.
			if (newParentId === oldParentId && oldIndex < targetIndex) newIndex -= 1;
		}

		this.stack.execute({
			do: () => moveNode(this.model, nodeId, newParentId, newIndex),
			undo: () => moveNode(this.model, nodeId, oldParentId, oldIndex),
		});
		this.emitChange();
	}

	/**
	 * Alt+Up/Down: moves the selected node one position earlier/later among
	 * its own siblings ("the same topic") — a keyboard equivalent of the
	 * drag-and-drop before/after reorder gesture, for when a real mouse drag
	 * doesn't land in the right drop band. No-ops if nothing is selected,
	 * the node has no parent (root), or it's already first/last among its
	 * siblings.
	 */
	moveSelectedInSiblingOrder(direction: "up" | "down"): void {
		if (!this.selectedId) return;
		const node = this.model.byId.get(this.selectedId);
		if (!node || !node.parent) return;
		const siblings = node.parent.children;
		const index = siblings.indexOf(node);
		const swapWith = direction === "up" ? siblings[index - 1] : siblings[index + 1];
		if (!swapWith) return;
		this.moveNode(node.id, swapWith.id, direction === "up" ? "before" : "after");
	}

	/** "Rebalance" command (plan §9.3): clears every manual-position pin and sticky side assignment, undoably. */
	rebalance(): void {
		interface Snapshot {
			manualPos?: { x: number; y: number };
			branchSide?: "L" | "R";
		}
		const before = new Map<string, Snapshot>();
		const snapshot = (node: MindNode) => {
			before.set(node.id, { manualPos: node.manualPos, branchSide: node.branchSide });
			node.children.forEach(snapshot);
		};
		snapshot(this.model.root);

		this.stack.execute({
			do: () => rebalanceAll(this.model),
			undo: () => {
				const restore = (node: MindNode) => {
					const snap = before.get(node.id);
					if (snap) {
						node.manualPos = snap.manualPos;
						node.branchSide = snap.branchSide;
					}
					node.children.forEach(restore);
				};
				restore(this.model.root);
				this.model.version += 1;
			},
		});
		this.emitChange();
	}

	undo(): void {
		if (this.stack.undo()) this.emitChange();
	}

	redo(): void {
		if (this.stack.redo()) this.emitChange();
	}

	canUndo(): boolean {
		return this.stack.canUndo();
	}

	canRedo(): boolean {
		return this.stack.canRedo();
	}
}
