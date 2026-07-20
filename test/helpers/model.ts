import type { MindNode } from "../../webview/model/types";

/** Builds a bare MindNode (children: [], folded: false, subtreeCount: 0, depth = parent.depth + 1) for tests that fabricate a node outside the parser, e.g. to push/unshift into an existing tree. Override any field via `overrides`. */
export function makeNode(overrides: Partial<MindNode> & { id: string; text: string; parent: MindNode | null }): MindNode {
	return { children: [], depth: (overrides.parent?.depth ?? -1) + 1, folded: false, subtreeCount: 0, ...overrides };
}
