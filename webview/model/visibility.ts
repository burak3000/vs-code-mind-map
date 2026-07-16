import { MindNode } from "./types";

/** Pre-order list of nodes not hidden behind a folded ancestor (R13: folding excludes descendants from layout/render/navigation entirely). */
export function collectVisibleNodes(root: MindNode): MindNode[] {
	const out: MindNode[] = [];
	const walk = (node: MindNode) => {
		out.push(node);
		if (node.folded) return;
		for (const child of node.children) walk(child);
	};
	walk(root);
	return out;
}
