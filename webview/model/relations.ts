import { LinkKind, isUrlTarget, parseTextSegments } from "./links";
import { MindMapModel, MindNode, ResolvedRelation } from "./types";

interface RawLink {
	kind: LinkKind;
	target: string;
}

/** Shared empty-array sentinels — every node without links/relations points at the same instance instead of allocating, and `=== EMPTY_*` is a cheap identity check callers can use if they need one. */
const EMPTY_LINKS: RawLink[] = [];
const EMPTY_RELATIONS: ResolvedRelation[] = [];

/**
 * Extracts every link in a node's text, cached on the node keyed by the
 * exact text that produced it — repeated calls with unchanged text skip
 * `parseTextSegments`'s regex entirely. Mirrors `getDisplayText`'s fast
 * path in links.ts (skip the regex whenever there's no `[` at all — the
 * vast majority of node text): that's what keeps `resolveRelations` cheap
 * even though it walks the whole tree every `onChange` (see that
 * function's own doc comment for why the walk itself is fine).
 */
function getCachedLinks(node: MindNode): RawLink[] {
	if (!node.text.includes("[")) {
		node.relationLinksCacheText = node.text;
		node.relationLinksCache = EMPTY_LINKS;
		return EMPTY_LINKS;
	}
	if (node.relationLinksCacheText === node.text && node.relationLinksCache) {
		return node.relationLinksCache;
	}
	const links = parseTextSegments(node.text)
		.filter((s) => s.link !== null)
		.map((s) => ({ kind: s.link!.kind, target: s.link!.target }));
	node.relationLinksCacheText = node.text;
	node.relationLinksCache = links;
	return links;
}

/** True if `filePart` (the text before "#" in a wikilink target, or the whole target when there's no "#") refers to the current file — either empty (bare `[[#...]]`) or a case-insensitive match on the file's basename, matching Obsidian's own same-file link resolution. */
function isSameFileTarget(filePart: string, fileBasename: string | null): boolean {
	if (filePart === "") return true;
	return fileBasename !== null && filePart.toLowerCase() === fileBasename.toLowerCase();
}

/**
 * Classifies one link (D1: only a wikilink can be a same-doc relation —
 * `[[#^id]]` or `[[<basename>#^id]]`, whose id is present in `model.byId`).
 * Returns null for the resolution spec's "(c) neither" case: same-file but
 * not a resolvable block reference (a plain heading link like
 * `[[#Some Heading]]`, a dangling `#^id`, or a self-link) — these are
 * silently ignored rather than shown as either an arrow or a cross-doc
 * badge. Every other link (a wikilink to a different file, or any mdlink —
 * URL or vault path) is a cross-doc relation (R2): the target genuinely
 * isn't on this canvas, matching how `MindMapView.openLink` already treats
 * both kinds identically.
 */
function classifyLink(link: RawLink, model: MindMapModel, node: MindNode, fileBasename: string | null): ResolvedRelation | null {
	if (link.kind === "wikilink") {
		const hashIdx = link.target.indexOf("#");
		const filePart = hashIdx === -1 ? link.target : link.target.slice(0, hashIdx);
		const fragment = hashIdx === -1 ? "" : link.target.slice(hashIdx + 1);
		if (isSameFileTarget(filePart, fileBasename)) {
			if (fragment.startsWith("^")) {
				const targetNode = model.byId.get(fragment.slice(1));
				if (targetNode && targetNode !== node) {
					return { kind: "same-doc", linkKind: link.kind, rawTarget: link.target, targetId: targetNode.id };
				}
			}
			return null; // same-file but not a resolvable block relation -> ignore
		}
	}
	return { kind: "cross-doc", linkKind: link.kind, rawTarget: link.target };
}

/**
 * Resolves and caches every node's relation links against the current tree
 * (R1a: same-map arrow vs. R2: cross-doc badge vs. "neither"/ignored).
 * Returns the active same-doc relation list (source/target id pairs) as a
 * byproduct of the same walk, so the renderer doesn't need a second
 * full-tree pass to collect it.
 *
 * Must run after every mutation that could change block-id availability —
 * wired into `MindMapView.onChange`/`buildFromScratch`/external-reparse,
 * *before* `ensurePersistentIds` and `serializeMindMap` (both depend on the
 * `isRelationTarget` flags this sets, see below). O(n) over the tree
 * (two passes: clear flags, then resolve — see the note on `walk` below for
 * why a single combined pass would be wrong), but real work only touches
 * nodes whose text has link syntax (`getCachedLinks`'s fast path) — the
 * vast majority of nodes bail out in O(1) before any regex runs, same
 * discipline as `getDisplayText`. Not on the keystroke/layout hot path:
 * `onChange` fires at mutation-commit granularity (Tab, rename-commit,
 * delete, fold, ...), never per keystroke inside the inline editor.
 *
 * Also marks each same-doc relation's target with `isRelationTarget = true`
 * (clearing every node's flag first, since a node can stop being a target
 * when the referencing link is edited/removed elsewhere) —
 * `nodeHasPersistableMeta` (sync/metadata.ts) checks this flag so a
 * relation's target keeps its block-id suffix across serialize even when it
 * has no fold/pos/width of its own (R1a item 2: forces the id to survive
 * round-trip).
 */
/** Badge shown next to each row in the R3/R5 relation/link modal's item list. `"unresolved"` covers the narrow classifyLink-returns-null case (dangling same-file block ref, bare heading link, self-link) — still a real link occurrence the user may want to remove, just not one that renders as an arrow or a cross-doc badge on the canvas. `"external"` is a `cross-doc` relation whose target looks like a URL, split out purely for a friendlier badge label than lumping it in with cross-doc note links. */
export type LinkItemBadge = "same-doc" | "cross-doc" | "external" | "unresolved";

export interface LinkItem {
	/** Position among all link occurrences in the node's raw text, 0-based, left to right — the exact identifier `removeLinkOccurrence` (model/links.ts) expects to remove this same item. */
	occurrenceIndex: number;
	label: string;
	linkKind: LinkKind;
	rawTarget: string;
	relation: ResolvedRelation | null;
	badge: LinkItemBadge;
}

function badgeFor(linkKind: LinkKind, rawTarget: string, relation: ResolvedRelation | null): LinkItemBadge {
	if (!relation) return "unresolved";
	if (relation.kind === "same-doc") return "same-doc";
	return linkKind === "mdlink" && isUrlTarget(rawTarget) ? "external" : "cross-doc";
}

/**
 * Every link occurrence in a node's text (R3/R5 relation/link modal's item
 * list), in `parseTextSegments`'s left-to-right order. Reclassifies each
 * occurrence fresh via `classifyLink` rather than reusing
 * `node.resolvedRelations`: that cache silently drops the "ignored" case
 * (same-file but not a resolvable block ref), but the modal still needs to
 * list — and let the user remove — every link actually in the text,
 * resolved or not. Modal-local work over a single node's handful of links,
 * never on the layout/render hot path (see this file's `resolveRelations`
 * doc comment for why the tree-wide walk itself is already cheap) —
 * opening this modal re-does a few `classifyLink` calls `resolveRelations`
 * already did once for the whole tree, which is negligible at modal-open
 * frequency.
 */
export function listNodeLinkItems(node: MindNode, model: MindMapModel, fileBasename: string | null): LinkItem[] {
	return parseTextSegments(node.text)
		.filter((s) => s.link !== null)
		.map((s, i) => {
			const link = s.link!;
			const relation = classifyLink(link, model, node, fileBasename);
			return {
				occurrenceIndex: i,
				label: s.text,
				linkKind: link.kind,
				rawTarget: link.target,
				relation,
				badge: badgeFor(link.kind, link.target, relation),
			};
		});
}

export function resolveRelations(model: MindMapModel, fileBasename: string | null): { sourceId: string; targetId: string }[] {
	// Two passes, not one combined pass: a source can appear *before* its
	// target in this pre-order walk (targets aren't ordered relative to
	// their sources), so clearing a node's flag at the moment we *visit* it
	// would wipe out a `true` an earlier-visited source already set on it.
	const clearFlags = (node: MindNode) => {
		node.isRelationTarget = false;
		node.children.forEach(clearFlags);
	};
	clearFlags(model.root);

	const activeRelations: { sourceId: string; targetId: string }[] = [];

	const walk = (node: MindNode) => {
		const links = getCachedLinks(node);
		if (links.length === 0) {
			node.resolvedRelations = EMPTY_RELATIONS;
		} else {
			const resolved: ResolvedRelation[] = [];
			for (const link of links) {
				const classified = classifyLink(link, model, node, fileBasename);
				if (!classified) continue;
				resolved.push(classified);
				if (classified.kind === "same-doc" && classified.targetId) {
					const target = model.byId.get(classified.targetId);
					if (target) {
						target.isRelationTarget = true;
						activeRelations.push({ sourceId: node.id, targetId: classified.targetId });
					}
				}
			}
			node.resolvedRelations = resolved.length > 0 ? resolved : EMPTY_RELATIONS;
		}
		node.children.forEach(walk);
	};
	walk(model.root);

	return activeRelations;
}
