import { MindMapModel, MindNode } from "../model/types";
import { parseMindMap } from "./parser";
import { serializeMindMap } from "./serializer";
import { forcePersistentId, isSyntheticId } from "./metadata";
import { findEquivalentNode } from "./reconcile";

/**
 * Sentinel `DocumentOption`/`RelationTarget` id meaning "the file currently
 * open in this mind map view" (R4) — never a real vault path, so it can't
 * collide with one (a path always contains a `/` or a `.md` extension).
 */
export const CURRENT_DOCUMENT_ID = "current";

/**
 * Structural subset of Obsidian's `TFile` this module actually needs, kept
 * narrow so tests can pass a plain object instead of a real `TFile` — the
 * real `obsidian` package is types-only (no runtime JS, see
 * `node_modules/obsidian/package.json`'s empty `"main"`), so nothing in
 * `sync/`/`model/` imports it, matching every other file in these two
 * directories.
 */
export interface MinimalFile {
	path: string;
	basename: string;
}

export interface ForeignVaultReader {
	cachedRead(file: MinimalFile): Promise<string>;
}

export interface ForeignVaultWriter {
	modify(file: MinimalFile, data: string): Promise<void>;
}

export interface RelationTargetOptionLike {
	id: string;
	label: string;
}

function collectTargetOptions(model: MindMapModel, labelFor: (node: MindNode) => string): RelationTargetOptionLike[] {
	const targets: RelationTargetOptionLike[] = [];
	const collect = (n: MindNode) => {
		targets.push({ id: n.id, label: labelFor(n) });
		n.children.forEach(collect);
	};
	collect(model.root);
	return targets;
}

/**
 * R4 combobox-2 data source: resolves the node-picker options for whichever
 * document is selected in combobox 1. `CURRENT_DOCUMENT_ID` resolves
 * instantly from `currentDocTargets` (the same in-memory
 * `relationTargets`/`collectTargets` walk `MindMapView.openLinkEditor` has
 * always done for the current document) with **no vault call at all** —
 * this is the "must stay instant" path for the common case of relating
 * within the open document, and is what makes it possible to assert (in a
 * test) that `vault.cachedRead` is never invoked for this id.
 *
 * Any other `docId` is treated as a vault path: read once via
 * `ctx.vault.cachedRead` and parsed with `parseMindMap`, then cached in
 * `ctx.models` (keyed by path — owned by the caller, one map per
 * `LinkModal` session, garbage-collected when the modal closes) so
 * re-selecting the same document later in the same session — or
 * re-filtering combobox 1's search query, which re-renders but doesn't
 * change the selection — never re-reads or re-parses it. Not on the
 * layout/render hot path: this only runs when the user opens the relation
 * modal and picks a document, at most once per distinct file per session.
 */
export async function resolveRelationTargetsForDocument(
	docId: string,
	currentDocTargets: RelationTargetOptionLike[],
	ctx: {
		vault: ForeignVaultReader;
		resolveFile: (path: string) => MinimalFile | null;
		models: Map<string, MindMapModel>;
		labelFor: (node: MindNode) => string;
	}
): Promise<RelationTargetOptionLike[]> {
	if (docId === CURRENT_DOCUMENT_ID) return currentDocTargets;

	const cached = ctx.models.get(docId);
	if (cached) return collectTargetOptions(cached, ctx.labelFor);

	const file = ctx.resolveFile(docId);
	if (!file) return [];
	const text = await ctx.vault.cachedRead(file);
	const model = parseMindMap(text, file.basename);
	ctx.models.set(docId, model);
	return collectTargetOptions(model, ctx.labelFor);
}

export interface ForeignRelationCommitResult {
	/** The target node's final, non-synthetic block id — always safe to embed in a `[[basename#^id]]` link, whether or not a write happened this call. */
	targetId: string;
	/** True if the foreign file was actually modified (a new id had to be minted). False means the node already had a persistent id and the file was never touched — relating to it again, or to a node someone else already related to, is a zero-write no-op. */
	wrote: boolean;
}

/**
 * R4 commit step: re-reads `file` fresh (not the modal-open-time parse used
 * to populate the picker — the file could have changed since), locates the
 * exact node the user picked, forces it to have a persistent id, and writes
 * back only if a new id was actually minted.
 *
 * `pickerTimeTargetNode` is the `MindNode` object from whichever parse
 * populated the picker (the entry the user actually clicked). Its `id` is
 * *not* trustworthy for finding "the same node" in a freshly re-parsed
 * model: synthetic ids (`nNN`, `model/id.ts`) are minted from a single
 * shared monotonic counter that is never reset between `parseMindMap`
 * calls, so two separate parses of the *same* text mint two *different*
 * sets of synthetic ids for the same nodes. Structural position is the
 * only thing stable across both parses, so this reuses `findEquivalentNode`
 * (`sync/reconcile.ts`) — the same reconciliation primitive already used to
 * carry selection across an external-edit reparse of the *current* file —
 * to walk `pickerTimeTargetNode`'s child-index path from its root and
 * replay it against `freshModel`. Returns null (caller should no-op rather
 * than crash or write) if the file changed shape enough that the path no
 * longer resolves (e.g. the node or an ancestor was deleted between
 * picker-open and Add) — a rare edge the plan explicitly scopes out of
 * conflict resolution.
 *
 * `forcePersistentId` (`sync/metadata.ts`) is a no-op that returns the
 * existing id unchanged when the node already has a non-synthetic one —
 * checked here via `isSyntheticId` *before* calling it, so relating to an
 * already-referenced node, or to the same node a second time, calls
 * `vault.modify` zero times.
 *
 * **Durability fix for the cross-doc case (was a known limitation, now
 * closed — see DECISIONS.md 2026-07-18 for the full writeup):** a same-doc
 * relation's target keeps its `^blockid` suffix across every future
 * serialize because `resolveRelations` re-derives `isRelationTarget = true`
 * from that *same file's own* link text every time it's parsed
 * (`model/relations.ts`). A cross-doc target has no such self-justifying
 * link in *its own* file — the reference lives in the other document's node
 * text — so `isRelationTarget` alone isn't durable for it: a later,
 * independent resave of this same foreign file (e.g. the user opens it as
 * its own mind map next week and edits something unrelated) reparses from
 * scratch and has no way to derive that flag from the file's own content,
 * so it would come back `false` and the `^blockid` suffix would be dropped
 * on that next save. Fixed by setting `targetNode.externalRelationTarget =
 * true` here instead: that field is persisted into (and restored from) this
 * file's own `mindmap:` frontmatter (`sync/metadata.ts`'s `NodeMeta.externalRef`,
 * `nodeHasPersistableMeta`) — the same durability mechanism already used
 * for fold/pos/width — so it survives every future independent parse of
 * this file, not just this one write. `isRelationTarget` is not also set
 * here: nothing else in this function's own serialize pass depends on it
 * (`resolveRelations` is never invoked in this flow), so it would be dead
 * weight — `externalRelationTarget` alone is what makes
 * `nodeHasPersistableMeta` true for this call.
 */
export async function commitForeignRelationTarget(
	vault: ForeignVaultReader & ForeignVaultWriter,
	file: MinimalFile,
	pickerTimeTargetNode: MindNode,
	mintBlockId?: () => string
): Promise<ForeignRelationCommitResult | null> {
	const freshText = await vault.cachedRead(file);
	const freshModel = parseMindMap(freshText, file.basename);
	const targetNode = findEquivalentNode(freshModel.root, pickerTimeTargetNode);
	if (!targetNode) return null;

	const wasSynthetic = isSyntheticId(targetNode.id);
	const targetId = forcePersistentId(targetNode, freshModel.byId, mintBlockId);
	if (!wasSynthetic) return { targetId, wrote: false };

	// Make this write durable across every future independent parse of this
	// file, not just this one save — see the doc comment above.
	targetNode.externalRelationTarget = true;
	await vault.modify(file, serializeMindMap(freshModel));
	return { targetId, wrote: true };
}
