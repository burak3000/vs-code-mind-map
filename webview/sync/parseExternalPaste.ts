import { MindNode } from "../model/types";
import { createId } from "../model/id";
import { parseMindMap } from "./parser";

/**
 * Turns clipboard text that came from *outside* this plugin (the OS
 * clipboard didn't match what we last wrote — see `MindMapView`'s
 * paste handler) into a flat array of detached, ready-to-insert subtrees,
 * each with fresh ids top to bottom (never reuses whatever id the source
 * text happened to contain, avoiding any collision/staleness once
 * inserted into the live model). Reuses the existing heading/list parser
 * rather than a separate one, so anything that already round-trips through
 * this plugin (including a previous `serializeSubtree` export) parses
 * back identically. Three cases, in order:
 *
 * 1. **Real heading structure, starting with an H1** (`hasExplicitRootHeading`):
 *    the whole pasted block is one subtree — the parsed root itself
 *    (headings become nested levels, e.g. a pasted `# Title` / `## Sub`
 *    document).
 * 2. **List and/or non-H1-heading structure**: the parsed synthetic root's
 *    children are the top-level items to insert (e.g. a pasted markdown
 *    list, possibly nested — exactly what `serializeSubtree` produces).
 * 3. **Plain text with no heading/list markers at all**: one leaf node per
 *    non-blank line, since there's no structure to preserve.
 */
export function parseExternalPaste(text: string): MindNode[] {
	if (text.trim().length === 0) return [];

	const model = parseMindMap(text, "");
	const parsed = model.hasExplicitRootHeading ? [model.root] : model.root.children.length > 0 ? model.root.children : plainLinesToNodes(text);

	return parsed.map(mintFreshIds);
}

function plainLinesToNodes(text: string): MindNode[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => leafNode(line));
}

function leafNode(text: string): MindNode {
	return {
		id: createId(),
		text,
		children: [],
		parent: null,
		depth: 0,
		folded: false,
		subtreeCount: 0,
	};
}

/** Detaches `node` (and its subtree) from whatever parser-internal parent it had, and mints a fresh id top to bottom — mirrors `cloneSubtree`'s id-minting for the same reason (the source id is meaningless/possibly colliding once pasted into a different document). */
function mintFreshIds(node: MindNode): MindNode {
	const fresh: MindNode = { ...node, id: createId(), parent: null, children: [] };
	fresh.children = node.children.map((child) => {
		const clone = mintFreshIds(child);
		clone.parent = fresh;
		return clone;
	});
	return fresh;
}
