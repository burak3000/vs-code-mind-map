import { MindNode } from "../model/types";

export interface NodeMeta {
	folded?: boolean;
	pos?: [number, number];
	width?: number;
	/** Durable twin of `MindNode.externalRelationTarget` — see that field's doc comment (model/types.ts) for why a cross-doc relation target needs frontmatter persistence instead of a recomputed-on-parse flag like `isRelationTarget`. */
	externalRef?: boolean;
	/** Durable twin of `MindNode.statusBadge` — a plain string, not `BadgeKey`, so a value written by a newer plugin version round-trips even if this version's `BADGE_DEFS` (model/statusBadges.ts) doesn't recognize it yet. */
	badge?: string;
}

export interface MindmapFrontmatterData {
	nodes: Record<string, NodeMeta>; // keyed by block id, without the leading '^'
}

function hasMeta(meta: NodeMeta): boolean {
	return meta.folded === true || meta.pos !== undefined || meta.width !== undefined || meta.externalRef === true || meta.badge !== undefined;
}

/**
 * True if a node currently has metadata worth persisting: R13 fold state,
 * R12 manual position, drag-resized width, or one of two relation-target
 * cases that otherwise have no fold/pos/width of their own (so
 * `collectMeta`'s frontmatter entry for them would be empty and get
 * filtered out by `hasMeta` — only the plain ` ^blockid` line suffix,
 * written by `serializeNode` off this same predicate, is what actually
 * needs to survive):
 * - `isRelationTarget` (R1a item 2) — a *same-doc* relation's target,
 *   re-derived from scratch on every parse by `model/relations.ts`'s
 *   `resolveRelations` scanning this file's own link text. Self-justifying
 *   every time, so no frontmatter storage is needed for it.
 * - `externalRelationTarget` (R4 durability fix) — a *cross-doc* relation's
 *   target, authored by another file. Nothing in *this* file's own content
 *   re-derives that fact on parse, so unlike `isRelationTarget` it can't
 *   just be recomputed — it's loaded from/written to this file's own
 *   `mindmap:` frontmatter (`NodeMeta.externalRef`) instead, the same
 *   durability mechanism `folded`/`pos`/`width` already use. This is a
 *   separate field rather than a reuse of `isRelationTarget` specifically
 *   because `resolveRelations` unconditionally resets `isRelationTarget` to
 *   `false` at the start of every walk before re-deriving it — reusing that
 *   field would have a frontmatter-loaded `true` stomped the moment
 *   `resolveRelations` next runs, before anything else could act on it.
 */
export function nodeHasPersistableMeta(node: MindNode): boolean {
	return (
		node.folded === true ||
		node.manualPos !== undefined ||
		node.manualWidth !== undefined ||
		node.isRelationTarget === true ||
		node.externalRelationTarget === true ||
		node.statusBadge !== undefined
	);
}

const SYNTHETIC_ID_RE = /^n\d+$/;

export function isSyntheticId(id: string): boolean {
	return SYNTHETIC_ID_RE.test(id);
}

/**
 * Mints a fresh persistent block id. Injectable so tests can get
 * deterministic output instead of `Math.random()`.
 */
export function defaultMintBlockId(): string {
	return Math.random().toString(36).slice(2, 8);
}

/**
 * Gives every node that needs persisted metadata a stable, non-synthetic
 * id (mutates `node.id` and re-indexes `byId`). Plan §7.2: "block ids are
 * appended to lines only when a node actually has metadata" — nodes
 * without metadata keep whatever id they have (synthetic ids are fine;
 * they're never written to the file).
 */
export function ensurePersistentIds(root: MindNode, byId: Map<string, MindNode>, mintBlockId: () => string = defaultMintBlockId): void {
	const walk = (node: MindNode) => {
		if (nodeHasPersistableMeta(node) && isSyntheticId(node.id)) {
			const oldId = node.id;
			let newId = mintBlockId();
			while (byId.has(newId)) newId = mintBlockId();
			byId.delete(oldId);
			node.id = newId;
			byId.set(newId, node);
		}
		for (const child of node.children) walk(child);
	};
	walk(root);
}

/**
 * Forces `node` to have a persistent (non-synthetic) id *right now*, rather
 * than waiting for the next `ensurePersistentIds` pass — used when
 * authoring a same-doc relation (R1a item 6, `MindMapView.openLinkEditor`):
 * the link text about to be written (`[[#^id]]`) must embed a stable id
 * immediately. `ensurePersistentIds` only upgrades a synthetic id once it
 * can see the node has persistable metadata (`isRelationTarget`), and at
 * authoring time that flag isn't set yet — the link doesn't exist in any
 * node's text until *after* this call's caller builds it. Minting here
 * first, then embedding the final id in the link text, means a synthetic
 * id is never written into markdown in the first place, so there's nothing
 * for a later `ensurePersistentIds` pass to change out from under the
 * reference. No-op (returns the existing id) if the node already has a
 * persistent one.
 */
export function forcePersistentId(node: MindNode, byId: Map<string, MindNode>, mintBlockId: () => string = defaultMintBlockId): string {
	if (!isSyntheticId(node.id)) return node.id;
	const oldId = node.id;
	let newId = mintBlockId();
	while (byId.has(newId)) newId = mintBlockId();
	byId.delete(oldId);
	node.id = newId;
	byId.set(newId, node);
	return newId;
}

const MINDMAP_LINE_RE = /^mindmap:\s*$/;
const NODES_LINE_RE = /^ {2}nodes:\s*$/;
const NODE_ENTRY_RE = /^ {4}\^([A-Za-z0-9_-]+):\s*\{([^}]*)\}\s*$/;
const POS_RE = /\bpos:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/;
const WIDTH_RE = /\bwidth:\s*(-?\d+(?:\.\d+)?)/;
const EXTERNAL_REF_RE = /\bexternalRef:\s*true\b/;
const BADGE_RE = /\bbadge:\s*([A-Za-z0-9_-]+)\b/;

/**
 * Reads our `mindmap:` subtree out of a raw frontmatter block (verbatim
 * text between `---` delimiters, delimiters included) without parsing or
 * touching any other key — see DECISIONS.md ("surgical text patching, not
 * full YAML round-trip") for why.
 */
export function extractMindmapData(frontmatterRaw: string | null): MindmapFrontmatterData {
	const nodes: Record<string, NodeMeta> = {};
	if (!frontmatterRaw) return { nodes };

	const lines = frontmatterRaw.split(/\r?\n/);
	let inMindmap = false;
	let inNodes = false;
	for (const line of lines) {
		if (MINDMAP_LINE_RE.test(line)) {
			inMindmap = true;
			inNodes = false;
			continue;
		}
		if (inMindmap && /^\S/.test(line)) {
			inMindmap = false;
			inNodes = false;
		}
		if (!inMindmap) continue;
		if (NODES_LINE_RE.test(line)) {
			inNodes = true;
			continue;
		}
		if (inNodes) {
			const m = NODE_ENTRY_RE.exec(line);
			if (m) {
				const [, id, body] = m;
				const meta: NodeMeta = {};
				if (/\bfolded:\s*true\b/.test(body)) meta.folded = true;
				const posMatch = POS_RE.exec(body);
				if (posMatch) meta.pos = [parseFloat(posMatch[1]), parseFloat(posMatch[2])];
				const widthMatch = WIDTH_RE.exec(body);
				if (widthMatch) meta.width = parseFloat(widthMatch[1]);
				if (EXTERNAL_REF_RE.test(body)) meta.externalRef = true;
				const badgeMatch = BADGE_RE.exec(body);
				if (badgeMatch) meta.badge = badgeMatch[1];
				if (hasMeta(meta)) nodes[id] = meta;
			}
		}
	}
	return { nodes };
}

/** Applies extracted metadata onto the freshly-parsed tree by block id (nodes without a matching id, e.g. new/unpersisted ones, are untouched). */
export function applyMindmapDataToTree(byId: Map<string, MindNode>, data: MindmapFrontmatterData): void {
	for (const [id, meta] of Object.entries(data.nodes)) {
		const node = byId.get(id);
		if (!node) continue;
		if (meta.folded) node.folded = true;
		if (meta.pos) node.manualPos = { x: meta.pos[0], y: meta.pos[1] };
		if (meta.width !== undefined) node.manualWidth = meta.width;
		if (meta.externalRef) node.externalRelationTarget = true;
		if (meta.badge !== undefined) node.statusBadge = meta.badge;
	}
}

/**
 * Builds new frontmatter text with our `mindmap:` subtree replaced,
 * inserted, or removed — every other key is left byte-identical. Returns
 * null when there's neither metadata to write nor pre-existing frontmatter
 * to preserve.
 */
export function applyMindmapData(existingFrontmatterRaw: string | null, data: MindmapFrontmatterData): string | null {
	const entries = Object.entries(data.nodes).filter(([, meta]) => hasMeta(meta));
	const ourBlockLines: string[] = [];
	if (entries.length > 0) {
		ourBlockLines.push("mindmap:");
		ourBlockLines.push("  nodes:");
		for (const [id, meta] of entries) {
			const parts: string[] = [];
			if (meta.folded) parts.push("folded: true");
			if (meta.pos) parts.push(`pos: [${meta.pos[0]}, ${meta.pos[1]}]`);
			if (meta.width !== undefined) parts.push(`width: ${meta.width}`);
			if (meta.externalRef) parts.push("externalRef: true");
			if (meta.badge !== undefined) parts.push(`badge: ${meta.badge}`);
			ourBlockLines.push(`    ^${id}: { ${parts.join(", ")} }`);
		}
	}

	if (!existingFrontmatterRaw) {
		if (ourBlockLines.length === 0) return null;
		return ["---", ...ourBlockLines, "---"].join("\n");
	}

	const lines = existingFrontmatterRaw.split(/\r?\n/);
	const result: string[] = [];
	let i = 0;
	let replaced = false;
	while (i < lines.length) {
		const line = lines[i];
		if (MINDMAP_LINE_RE.test(line)) {
			i++;
			while (i < lines.length && (lines[i] === "" || /^\s/.test(lines[i]))) i++;
			if (ourBlockLines.length > 0) {
				result.push(...ourBlockLines);
				replaced = true;
			}
			continue;
		}
		result.push(line);
		i++;
	}

	if (!replaced && ourBlockLines.length > 0) {
		// No existing mindmap: key — insert right after the opening delimiter.
		result.splice(1, 0, ...ourBlockLines);
	}

	// Nothing left besides the delimiters -> drop the frontmatter block entirely.
	if (result.every((l) => l === "---")) return null;

	return result.join("\n");
}
