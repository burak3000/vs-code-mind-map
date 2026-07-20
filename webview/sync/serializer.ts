import { MindMapModel, MindNode } from "../model/types";
import { applyMindmapData, nodeHasPersistableMeta, NodeMeta } from "./metadata";

export interface SerializeConfig {
	/** Nodes at depth <= this become headings (H1..H(headingDepth+1)); deeper nodes become list items. */
	headingDepth: number;
}

export const DEFAULT_SERIALIZE_CONFIG: SerializeConfig = { headingDepth: 1 };

/**
 * Serializes a MindMapModel back to markdown — the inverse of `parseMindMap`.
 * Single-pass O(n) string-builder output (addendum §4.2); frontmatter and
 * each node's `attachedContent` are re-emitted verbatim for round-trip
 * fidelity (N2/N3). Nodes with persistable metadata (fold state R13,
 * manual position R12) get a ` ^blockid` suffix and an entry in the
 * frontmatter `mindmap:` block.
 *
 * Precondition: call `ensurePersistentIds(model.root, model.byId)` first —
 * this function does not mint ids itself, so it stays pure/deterministic.
 */
export function serializeMindMap(model: MindMapModel, cfg: SerializeConfig = DEFAULT_SERIALIZE_CONFIG): string {
	const nodesMeta: Record<string, NodeMeta> = {};
	collectMeta(model.root, nodesMeta);
	const frontmatter = applyMindmapData(model.frontmatterRaw, { nodes: nodesMeta });

	const lines: string[] = [];
	if (frontmatter) lines.push(frontmatter);

	lines.push(`# ${model.root.text}`);
	if (model.root.attachedContent) lines.push(...model.root.attachedContent);

	for (const child of model.root.children) {
		serializeNode(child, cfg, lines);
	}

	return lines.join("\n") + "\n";
}

/** Exported for `goToSection.ts`'s line-number fallback, which needs the exact same frontmatter-line-count this function's caller (`serializeMindMap`) produces, without re-running the whole serialize pass. */
export function collectMeta(node: MindNode, out: Record<string, NodeMeta>): void {
	if (nodeHasPersistableMeta(node)) {
		out[node.id] = {
			folded: node.folded || undefined,
			pos: node.manualPos ? [node.manualPos.x, node.manualPos.y] : undefined,
			width: node.manualWidth,
			externalRef: node.externalRelationTarget || undefined,
			badge: node.statusBadge,
		};
	}
	for (const child of node.children) collectMeta(child, out);
}

/**
 * Serializes a single node and its subtree as a plain nested markdown list
 * (`- text`, 2-space indent per depth level, the node itself as the top
 * item) — the OS-clipboard export format for "tree copy" (plan item 06).
 * Lists (not headings) are the right target here: they paste cleanly into
 * other Obsidian notes, other apps, and plain-text editors, and round-trip
 * through our own parser on the way back in. No ` ^blockid` suffixes or
 * mindmap frontmatter metadata — those are internal identity/persistence
 * details that must not leak into (or collide once pasted back into)
 * another document. `attachedContent` (paragraphs) is intentionally
 * dropped too — it doesn't fit the list-bullet format unambiguously, and
 * the internal `MindNode[]` clipboard (unaffected by this) stays the
 * fidelity source for paste-back within the same plugin.
 */
export function serializeSubtree(node: MindNode): string {
	const lines: string[] = [];
	const walk = (n: MindNode, depth: number) => {
		lines.push(`${"  ".repeat(depth)}- ${n.text}`);
		for (const child of n.children) walk(child, depth + 1);
	};
	walk(node, 0);
	return lines.join("\n");
}

/** Multiple independent subtrees (a multi-selection copy) — each is its own top-level list, joined by blank-line-free newlines so the whole thing parses back as one flat sequence of top-level list items. */
export function serializeSubtrees(nodes: MindNode[]): string {
	return nodes.map(serializeSubtree).join("\n");
}

function serializeNode(node: MindNode, cfg: SerializeConfig, lines: string[]): void {
	const suffix = nodeHasPersistableMeta(node) ? ` ^${node.id}` : "";
	if (node.depth <= cfg.headingDepth) {
		const headingLevel = node.depth + 1; // root is depth 0 -> H1, so depth d -> H(d+1)
		lines.push(`${"#".repeat(headingLevel)} ${node.text}${suffix}`);
	} else {
		const indent = "  ".repeat(node.depth - cfg.headingDepth - 1);
		lines.push(`${indent}- ${node.text}${suffix}`);
	}
	if (node.attachedContent) lines.push(...node.attachedContent);

	for (const child of node.children) {
		serializeNode(child, cfg, lines);
	}
}
