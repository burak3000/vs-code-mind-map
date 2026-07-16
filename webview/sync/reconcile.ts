import { MindNode } from "../model/types";

/**
 * Best-effort structural-position match: walks the child-index path from
 * `oldTarget` up to its root, then replays that path from `newRoot`. Used
 * to carry selection continuity across an external-edit reparse.
 *
 * This is a positional heuristic, not identity — it will misfire if nodes
 * were inserted/removed earlier in the same sibling list. Real identity
 * (matching by persistent block-id) becomes available once metadata-bearing
 * nodes get ids in M3+; revisit then. See DECISIONS.md.
 */
export function findEquivalentNode(newRoot: MindNode, oldTarget: MindNode): MindNode | null {
	const path: number[] = [];
	let cur: MindNode = oldTarget;
	while (cur.parent) {
		path.unshift(cur.parent.children.indexOf(cur));
		cur = cur.parent;
	}

	let node = newRoot;
	for (const index of path) {
		const next: MindNode | undefined = node.children[index];
		if (!next) return null;
		node = next;
	}
	return node;
}
