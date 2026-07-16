import { MindNode } from "./types";
import { getDisplayText } from "./links";

export interface SearchResult {
	id: string;
	text: string;
}

export interface SearchOutcome {
	results: SearchResult[];
	totalMatches: number;
}

/** Results past this many are still counted (see `totalMatches`) but not materialized into the list — a broad query on a large map shouldn't force rendering thousands of list rows. */
const MAX_RESULTS = 50;

/**
 * Case-insensitive substring search over every node's display text (link
 * syntax stripped, matching what's actually shown on the node), including
 * folded/hidden subtrees — search should find anything in the document,
 * not just what's currently on screen. A plain O(n) string scan; even at
 * the 5,000-node stress fixture this is a sub-millisecond cost per
 * keystroke, nowhere near a budget worth debouncing or indexing for.
 */
export function searchNodes(root: MindNode, query: string): SearchOutcome {
	const needle = query.trim().toLowerCase();
	if (!needle) return { results: [], totalMatches: 0 };

	const results: SearchResult[] = [];
	let totalMatches = 0;
	const walk = (node: MindNode) => {
		const display = getDisplayText(node.text);
		if (display.toLowerCase().includes(needle)) {
			totalMatches++;
			if (results.length < MAX_RESULTS) results.push({ id: node.id, text: display });
		}
		for (const child of node.children) walk(child);
	};
	walk(root);
	return { results, totalMatches };
}
