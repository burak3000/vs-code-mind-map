import { MindMapModel, MindNode } from "../model/types";
import { applyMindmapData, nodeHasPersistableMeta } from "./metadata";
import { collectMeta, DEFAULT_SERIALIZE_CONFIG, SerializeConfig } from "./serializer";

export type GoToTarget =
	| { kind: "blockid"; ref: string }
	| { kind: "heading"; ref: string }
	| { kind: "line"; line: number }
	/** Root with no real H1 yet (see `hasExplicitRootHeading`) — nothing to jump to. */
	| { kind: "unavailable" };

/** How many heading-depth nodes (any node written as a `#`..`######` line, per `cfg.headingDepth`) share the given text — a heading-text link target is only unambiguous when this is 1. */
function countHeadingTextMatches(root: MindNode, text: string, cfg: SerializeConfig): number {
	let count = 0;
	const walk = (node: MindNode) => {
		if (node.depth <= cfg.headingDepth && node.text === text) count++;
		for (const child of node.children) walk(child);
	};
	walk(root);
	return count;
}

/**
 * Mirrors `serializeMindMap`'s exact line-emission order (frontmatter,
 * then the root's own heading + attachedContent, then each node's own
 * line + attachedContent, depth-first) to find the 0-based line number
 * `node` ends up on in that output — used as the line-number fallback
 * target when neither a block id nor an unambiguous heading-text link is
 * available. Structural (tree-position-based), not text search, so
 * duplicate node text elsewhere in the file can't confuse it.
 */
export function findNodeLine(model: MindMapModel, nodeId: string, cfg: SerializeConfig = DEFAULT_SERIALIZE_CONFIG): number | null {
	const nodesMeta: Record<string, { folded?: boolean; pos?: [number, number]; width?: number }> = {};
	collectMeta(model.root, nodesMeta);
	const frontmatter = applyMindmapData(model.frontmatterRaw, { nodes: nodesMeta });
	let line = frontmatter ? frontmatter.split("\n").length : 0;

	if (model.root.id === nodeId) return line;
	line += 1 + (model.root.attachedContent?.length ?? 0);

	let found: number | null = null;
	const walk = (node: MindNode): boolean => {
		if (node.id === nodeId) {
			found = line;
			return true;
		}
		line += 1 + (node.attachedContent?.length ?? 0);
		for (const child of node.children) {
			if (walk(child)) return true;
		}
		return false;
	};
	for (const child of model.root.children) {
		if (walk(child)) break;
	}
	return found;
}

/**
 * Three-tier "Go to note section" target resolution (plan item 04):
 * 1. The node already has a persisted ` ^blockid` suffix in the file
 *    (`nodeHasPersistableMeta` is exactly the condition under which
 *    `serializeMindMap` writes that suffix) — Obsidian's native block
 *    reference is the most robust jump.
 * 2. The node is a heading (depth <= `cfg.headingDepth`) with unique text
 *    in the file — a heading-text link resolves the same way
 *    `[[note#Heading]]` would.
 * 3. Otherwise (a list node without a persisted id, or duplicate heading
 *    text): fall back to the exact line number via `findNodeLine`.
 *
 * The root is a special case of (1)/(2)/(3) like any other node, *except*
 * when it's still a synthetic stand-in for a file with no real H1 yet
 * (`model.hasExplicitRootHeading === false`) — there is no heading line to
 * jump to at all, so callers should treat `"unavailable"` as "disable the
 * menu item".
 */
export function resolveGoToTarget(model: MindMapModel, node: MindNode, cfg: SerializeConfig = DEFAULT_SERIALIZE_CONFIG): GoToTarget {
	if (node === model.root && !model.hasExplicitRootHeading) return { kind: "unavailable" };

	if (nodeHasPersistableMeta(node)) return { kind: "blockid", ref: node.id };

	if (node.depth <= cfg.headingDepth && countHeadingTextMatches(model.root, node.text, cfg) === 1) {
		return { kind: "heading", ref: node.text };
	}

	const line = findNodeLine(model, node.id, cfg);
	return line !== null ? { kind: "line", line } : { kind: "unavailable" };
}
