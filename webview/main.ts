// Webview bootstrap (bundled to media/webview.js) — M4: images, theming,
// settings, on top of M3's full feature parity.
//
// Per CLAUDE.md rule 7, the entire interaction loop lives here in the
// webview: parse -> colors/sides -> layout -> SvgRenderer, keyboard
// handling, inline editing, undo/redo, folding, manual positioning,
// drag-reorder, links, search, context menu, multi-select clipboard, and
// serialization. The extension host is only the persistence layer plus a
// handful of platform actions (open a link, reveal a note section, swap
// editor kind, resolve an image path, write a pasted image) it is uniquely
// positioned to perform — it posts the document text on resolve/external
// edit, applies a `WorkspaceEdit` when this file posts a "writeDocument"
// message, opens links/reveals text on request, and (M4) resolves a node's
// image embed to a webview-loadable URL. Nothing here ever blocks on a host
// round-trip for the interactive loop itself; image resolution is the one
// new *async* dependency, but per the plan it only ever runs for a node the
// renderer has actually mounted (culled-in), never on the keystroke path —
// see `resolveImageUrl` below. The other exception (flushWrite) is a
// deliberate one-time administrative wait before the Ctrl/Cmd+M toggle or
// "Go to section", exactly like the reference's own `flushPendingWrite`.
//
// Theming (R-theming) needed no code here at all — it's pure CSS
// (`media/mindmap.css`), since VS Code updates `--vscode-*` custom
// properties and the webview body's theme class live on a theme switch.
//
// Clipboard-image paste (moved from M3, see PROGRESS.md/DECISIONS.md) is
// plumbed end-to-end (clipboard read here, `writeImage` round trip, insert
// via the ported `Controller.pasteImageAsChild`) but the host's
// `writeImage` handler is a deliberate stub — the pasted-image save
// location is escalated, not decided (see MindMapEditorProvider.ts's
// `writeImage`), so today this always falls through to the existing
// text-paste path, exactly like before this file changed.

import { parseMindMap } from "./sync/parser";
import { serializeMindMap, serializeSubtree, collectMeta, DEFAULT_SERIALIZE_CONFIG, SerializeConfig } from "./sync/serializer";
import { computeLayout, DEFAULT_LAYOUT_CONFIG, LayoutConfig, LayoutMode } from "./layout/layoutEngine";
import { SvgRenderer } from "./render/SvgRenderer";
import { Controller, ControllerListener } from "./controller/Controller";
import { assignMissingColors } from "./render/colors";
import { assignMissingSides } from "./layout/sides";
import { findEquivalentNode } from "./sync/reconcile";
import { ensurePersistentIds, forcePersistentId, applyMindmapData } from "./sync/metadata";
import { InlineEditor } from "./ui/InlineEditor";
import { SearchPanel } from "./ui/SearchPanel";
import { LinkModal } from "./ui/LinkModal";
import { ContextMenu, ContextMenuItem } from "./ui/ContextMenu";
import { debounce } from "./sync/debounce";
import { navigateFrom, Direction } from "./render/navigation";
import { collectVisibleNodes } from "./model/visibility";
import { searchNodes } from "./model/search";
import { resolveGoToTarget, GoToTarget } from "./sync/goToSection";
import { parseExternalPaste } from "./sync/parseExternalPaste";
import { LinkKind, buildLinkText, getDisplayText, getImageEmbed, appendLinkText, removeLinkOccurrence, isUrlTarget, isAbsoluteFilesystemPath } from "./model/links";
import { MindNode } from "./model/types";
import { BADGE_DEFS } from "./model/statusBadges";
import { resolveRelations, listNodeLinkItems } from "./model/relations";
import { CURRENT_DOCUMENT_ID, RelationTargetOptionLike as RelationTargetOption, resolveRelationTargetsForDocument, commitForeignRelationTarget } from "./sync/foreignRelation";

/** Minimal typing for the API VS Code injects into every webview. Declared here instead of adding a @types/vscode-webview devDependency for one function signature. */
interface VsCodeWebviewApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeWebviewApi;

/** Host -> webview. `version` is the TextDocument.version at send time — the stale-message gate below drops out-of-order deliveries. */
interface SetDocumentMessage {
	type: "setDocument";
	text: string;
	version: number;
	/** Document basename without extension — the parser's fallback root title when the md has no H1 (same role as the reference's `file.basename`). */
	title: string;
}

/**
 * Host -> webview: an intercepted chord (plan §7 — VS Code owns Ctrl/Cmd+Z,
 * Ctrl/Cmd+F, Ctrl/Cmd+K, Ctrl/Cmd+Shift+B, Ctrl/Cmd+/ before they'd ever
 * reach the webview's own keydown handler) forwarded as a command instead,
 * plus "flushWrite" — not an intercepted keystroke, but the same "host asks,
 * webview acts" shape, used by the Ctrl/Cmd+M toggle (and, in the future,
 * "Go to section") to force the pending debounced write out before the host
 * does something that depends on the document being current.
 */
interface CommandMessage {
	type: "command";
	name: "undo" | "redo" | "search" | "rebalance" | "linkEditor" | "toggleFold" | "toggleStatusDone" | "statusQuickPick" | "goToNoteSection" | "flushWrite";
}

/**
 * Host -> webview (M4 settings, plan §9): the four settings that get baked
 * into (or, for `writeDebounceMs`, live-applied to) this webview session —
 * mirrors `MindMapEditorProvider.ts`'s `MindMapWebviewConfig` and the
 * reference's `PluginSettings.ts`. Sent once before the first
 * "setDocument" (so `buildFromScratch` bakes the right values) and again
 * on every `onDidChangeConfiguration` the host observes.
 */
interface SetConfigMessage {
	type: "setConfig";
	config: MindMapWebviewConfig;
}

/** Host -> webview (R18): the resolved webview-loadable URL for a node's image embed (or `null` if resolution failed) — see `resolveImageUrl` below for the request side. */
interface ImageResolvedMessage {
	type: "imageResolved";
	nodeId: string;
	target: string;
	url: string | null;
}

/** Host -> webview: reply to a "writeImage" request (clipboard-image paste plumbing) — `embedText` is `null` until the pasted-image save location is decided (escalated, see this file's header comment and MindMapEditorProvider.ts's `writeImage`). */
interface ImageWrittenMessage {
	type: "imageWritten";
	id: number;
	embedText: string | null;
}

/**
 * Phase C (R4 cross-document relations): four request/response message
 * pairs, each keyed by a monotonic id (same shape as "writeImage"/
 * "imageWritten" above) — the host-side data access + native-UI primitives
 * `webview/sync/foreignRelation.ts`'s `ForeignVaultReader`/
 * `ForeignVaultWriter` contracts and the relation-target picker need, but
 * that this webview cannot do itself (enumerate/read/write arbitrary
 * workspace files, or show a native `vscode.window.showQuickPick`). See
 * `openLinkEditor`/`pickAndAddRelation` below for how the webview drives
 * the whole two-step picker flow using only these four primitives — the
 * host never learns anything about relations, documents, or nodes; it
 * only lists files, reads/writes text, and shows a plain label list.
 */
interface MarkdownFilesListedMessage {
	type: "markdownFilesListed";
	id: number;
	files: { path: string; basename: string }[];
}
interface ForeignDocumentReadMessage {
	type: "foreignDocumentRead";
	id: number;
	text: string | null;
}
interface ForeignDocumentWrittenMessage {
	type: "foreignDocumentWritten";
	id: number;
	ok: boolean;
}
/** Reply to "showQuickPick" — `index` is the picked item's position in the array this webview sent, or `null` if the user dismissed the picker (Escape/click-away) — see `MindMapEditorProvider.showQuickPick`'s own doc comment for why an index, not the item itself, round-trips. */
interface QuickPickResultMessage {
	type: "quickPickResult";
	id: number;
	index: number | null;
}

/**
 * The inverse of "Go to note section": a plain-text-editor context-menu
 * command (`mindmapView.goToMindMapNode`, `package.json`'s
 * `contributes.menus`) sends the cursor's 0-based line number here — never
 * a resolved node id, since the host never parses markdown or holds a
 * model (CLAUDE.md rule 7); only this webview's own live model can turn a
 * line into a node. See `focusNodeAtLine`.
 */
interface FocusAtLineMessage {
	type: "focusAtLine";
	line: number;
}

type HostMessage =
	| SetDocumentMessage
	| CommandMessage
	| SetConfigMessage
	| ImageResolvedMessage
	| ImageWrittenMessage
	| MarkdownFilesListedMessage
	| ForeignDocumentReadMessage
	| ForeignDocumentWrittenMessage
	| QuickPickResultMessage
	| FocusAtLineMessage;

/** Mirrors `MindMapEditorProvider.ts`'s `MindMapWebviewConfig` and `package.json`'s `contributes.configuration` — see DECISIONS.md's dated "M4 settings" entry for which of these four apply live vs. only to the next-opened map, and why. */
interface MindMapWebviewConfig {
	writeDebounceMs: number;
	animationNodeThreshold: number;
	headingDepth: number;
	layoutMode: LayoutMode;
	/** Phase C (R1a item 5): whether `SvgRenderer` resolves/draws relation arrows and cross-doc badges at all — baked into the renderer's constructor at `buildFromScratch` time, like `animationNodeThreshold`, so a mid-session toggle takes effect only on the next open (see DECISIONS.md's dated "Phase C" entry). */
	showRelations: boolean;
}

/** Same values as the reference's `DEFAULT_SETTINGS` / this extension's `package.json` defaults — used until the host's first "setConfig" arrives (always before the first "setDocument", but defensive in case that guarantee is ever broken). */
const DEFAULT_CONFIG: MindMapWebviewConfig = {
	writeDebounceMs: 400,
	animationNodeThreshold: 500,
	headingDepth: DEFAULT_SERIALIZE_CONFIG.headingDepth,
	layoutMode: DEFAULT_LAYOUT_CONFIG.mode,
	showRelations: true,
};

/** A scheme-qualified URL (`https://…`, not a workspace-relative path) — an image embed whose target matches this resolves synchronously to itself (same as a link click's split — see `openLink`/`MindMapEditorProvider.ts`'s identical regex), no host round trip needed. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** How long to wait for more "imageResolved" replies to arrive before remounting to show them — see `refreshResolvedImages`'s own doc comment for why this needs to be a real (macrotask) debounce, not a microtask trick. */
const IMAGE_REFRESH_DEBOUNCE_MS = 50;

/** Escapes a string for safe interpolation into a `RegExp` — used by `resolveTargetLine` to match a block-id/heading target's exact text. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A foreign document's `.md` filename, minus its extension — the webview-side equivalent of Node's `path.parse(p).name` (no `path` module in a browser context), used as a `MinimalFile.basename` (`sync/foreignRelation.ts`) and as the wikilink filename in a cross-doc relation's built link text. Absolute paths from `listMarkdownFiles`/the host are always POSIX-or-native-separated file paths, never a URL, so a plain split on both separators is sufficient. */
function basenameNoExt(filePath: string): string {
	const parts = filePath.replace(/\\/g, "/").split("/");
	const file = parts[parts.length - 1] ?? filePath;
	return file.replace(/\.md$/i, "");
}

/**
 * Picks the Mac vs. other-platform hotkey hint string (`model/statusBadges.ts`'s
 * `BadgeDef.hotkey`, and the fixed `⌘`-prefixed hints `showNodeMenu` builds
 * inline for its other items) — the webview has no `Platform.isMacOS` the
 * way the reference's Obsidian host does, so this reads `navigator.platform`
 * directly. Display-only: the actual keybinding is `package.json`'s
 * `contributes.keybindings` `mac`/`key` pair, resolved by VS Code itself
 * regardless of what this returns.
 */
function isMac(): boolean {
	return /mac/i.test(navigator.platform ?? navigator.userAgent ?? "");
}

/**
 * M5 webview state persistence (plan §11, risk row "Webview reload loses map
 * state"): what gets handed to `vscode.setState`/read back from
 * `vscode.getState` across a hidden→revealed reload (`retainContextWhenHidden:
 * false` means the webview's whole JS context — including every in-memory
 * `MindNode`/`Controller`/id — is torn down and rebuilt from scratch; only
 * whatever was JSON-serialized into `setState` survives).
 *
 * Selection is **not** persisted by id: a plain node with no persisted
 * `^blockid` metadata (see `sync/metadata.ts`'s `ensurePersistentIds`) gets a
 * fresh random id (`model/id.ts`'s `createId()`) on every reparse, so an id
 * saved before the reload almost never matches anything after it. Instead
 * this persists the same **structural sibling-index path** the ported
 * `sync/reconcile.ts`'s `findEquivalentNode` already uses to carry selection
 * across an external-edit reparse (`onVaultModify`'s M1/M2 mechanism) —
 * `pathOf`/`nodeAtPath` below are that same walk-up/walk-down, just replayed
 * against plain persisted data instead of a live `MindNode` object (nothing
 * from before the reload survives to hand `findEquivalentNode` directly).
 */
interface PersistedViewState {
	/** Sibling-index path from root to the primary selection, or null if nothing was selected. */
	selectedPath: number[] | null;
	/** Sibling-index paths for the full multi-selection (R-multi-select) — empty when there's no selection. */
	selectedPaths: number[][];
	/**
	 * Exact pan/zoom at persist time (`SvgRenderer.getViewport`) — restored
	 * verbatim via `setViewport` on reload, so a free pan/zoom with no
	 * selection round-trips too, not just a selection re-center. Optional so
	 * a state object written by an older build (selection only) still loads.
	 * Structurally identical to the renderer's own (non-exported) `Viewport`
	 * interface — declared here rather than imported to keep `SvgRenderer.ts`'s
	 * authorized divergence limited to exactly the two new methods.
	 */
	viewport?: { tx: number; ty: number; scale: number };
}

/** Root -> `node`'s sibling-index path (e.g. `[1, 0]` = root's 2nd child's 1st child) — the persisted, id-independent counterpart of `findEquivalentNode`'s own path walk. */
function pathOf(node: MindNode): number[] {
	const path: number[] = [];
	let cur: MindNode = node;
	while (cur.parent) {
		path.unshift(cur.parent.children.indexOf(cur));
		cur = cur.parent;
	}
	return path;
}

/** Replays a `pathOf` path against a (possibly newly-parsed) root — same walk as `findEquivalentNode`, minus needing an old live node to start from. Returns null if the path no longer resolves (tree shrank). */
function nodeAtPath(root: MindNode, path: number[]): MindNode | null {
	let node = root;
	for (const index of path) {
		const next: MindNode | undefined = node.children[index];
		if (!next) return null;
		node = next;
	}
	return node;
}

class MindMapApp implements ControllerListener {
	private controller: Controller | null = null;
	private renderer: SvgRenderer | null = null;
	private inlineEditor: InlineEditor | null = null;
	private searchPanel: SearchPanel | null = null;
	private linkModal: LinkModal | null = null;
	private contextMenu: ContextMenu | null = null;
	/** Highest TextDocument.version rendered so far. postMessage delivery order isn't contractual, so a message carrying an older version than what's on screen is dropped rather than applied backwards. */
	private lastVersion = -1;
	private title = "Untitled";
	/**
	 * Latest config the host has told us about — updated on every
	 * "setConfig", but only `writeDebounceMs` is *applied* immediately
	 * (`applyConfig` below rebuilds `scheduleWrite`'s debounce delay).
	 * `layoutMode`/`headingDepth`/`animationNodeThreshold` are read only at
	 * `buildFromScratch` time, baking into `layoutConfig`/`serializeConfig`/
	 * the renderer's constructor argument for *this* session — a config
	 * change afterward is cached here for the next full open, never
	 * applied to the already-mounted map. See DECISIONS.md's dated "M4
	 * settings" entry for why (a real technical constraint for the
	 * renderer's threshold, a deliberate UX choice mirroring the reference
	 * for the other two).
	 */
	private config: MindMapWebviewConfig = DEFAULT_CONFIG;
	private layoutConfig: LayoutConfig = { ...DEFAULT_LAYOUT_CONFIG };
	private serializeConfig: SerializeConfig = { ...DEFAULT_SERIALIZE_CONFIG };

	/** Latest serialized text for the current model — the write-back payload. */
	private data = "";
	/** The text as of the last confirmed baseline (initial load, external rebuild, or a write-back we've actually posted) — compared against `data` to tell "there's a real unwritten local edit" apart from "a write is merely scheduled" (e.g. a plain selection change re-serializes to identical text — see the reference's identical `hasPendingWrite` check in MindMapView.onVaultModify). */
	private lastWrittenText = "";
	private scheduleWrite: ReturnType<typeof debounce>;

	/** The last markdown text *we* wrote to the OS clipboard (tree copy) — paste compares against this to tell "internal copy/cut" apart from "user copied something else outside this extension" (plan item 06, R16). */
	private lastWrittenClipboardText: string | null = null;

	/**
	 * R18 image resolution cache/in-flight set, keyed by `${nodeId}\0${target}`
	 * so a node whose embed target changes (edited text) naturally misses
	 * instead of showing a stale image. `imageCache` holds the resolved URL
	 * (or `null` for "asked, host says unresolvable"); `imagePending` guards
	 * against re-requesting the same key on every one of the renderer's own
	 * per-node resolver calls (it calls back on every mount/update pass for
	 * a mounted image node, not just once).
	 */
	private readonly imageCache = new Map<string, string | null>();
	private readonly imagePending = new Set<string>();

	/** Clipboard-image paste (M4): monotonic id for the "writeImage" request/response round trip, and the resolvers waiting on each in-flight one — see `pasteClipboardImage`. */
	private writeImageRequestId = 0;
	private readonly pendingWriteImageResolvers = new Map<number, (embedText: string | null) => void>();

	/**
	 * Phase C (R4): four more request/response round trips, same
	 * monotonic-id-keyed shape as `writeImageRequestId`/
	 * `pendingWriteImageResolvers` above — see `requestListMarkdownFiles`/
	 * `requestReadForeignDocument`/`requestWriteForeignDocument`/
	 * `requestQuickPick` below for the request side.
	 */
	private listMarkdownFilesRequestId = 0;
	private readonly pendingListMarkdownFilesResolvers = new Map<number, (files: { path: string; basename: string }[]) => void>();
	private readForeignDocumentRequestId = 0;
	private readonly pendingReadForeignDocumentResolvers = new Map<number, (text: string | null) => void>();
	private writeForeignDocumentRequestId = 0;
	private readonly pendingWriteForeignDocumentResolvers = new Map<number, () => void>();
	private quickPickRequestId = 0;
	private readonly pendingQuickPickResolvers = new Map<number, (index: number | null) => void>();

	/**
	 * `SvgRenderer.upsertImage` (the ported, unmodified renderer — see its
	 * own doc comment) only re-derives a node's image `href` when that
	 * node's text/size/side actually changed; a plain `update()` call after
	 * an "imageResolved" arrives would *not* re-run the resolver for a node
	 * whose model data hasn't changed, only its resolver's cached answer
	 * has. `mount()` is the one public entry point that unconditionally
	 * re-derives every visible node (it clears the renderer's own dirty-
	 * tracking maps first) — but it is, deliberately, the "whole visible
	 * set" operation, not a single-node one, since there's no narrower
	 * public API to add without editing the protected renderer.
	 *
	 * Debounced (not called directly from `onImageResolved`) because a
	 * freshly-opened map with many visible images (the exact "hundreds of
	 * images all in-viewport" case `bench:images` stress-tests) fires one
	 * "resolveImage" per node up front, and the host's replies arrive as
	 * separate `postMessage` deliveries (separate tasks, not microtasks —
	 * a same-tick `Promise.resolve().then()` batching trick would not
	 * coalesce them, since each message event is its own macrotask).
	 * Coalescing a burst of replies into one trailing `mount()` keeps the
	 * remount count near O(1) per burst instead of O(images) — cheap
	 * insurance, not a rule-3 trade-off (it has no user-visible downside
	 * to weigh against; a per-image thumbnail still "pops in" within
	 * `IMAGE_REFRESH_DEBOUNCE_MS` of resolving, same felt latency as
	 * before batching).
	 */
	private readonly refreshResolvedImages: ReturnType<typeof debounce>;

	constructor(private readonly container: HTMLElement, private readonly vscode: VsCodeWebviewApi) {
		this.scheduleWrite = debounce(() => this.writeNow(), this.config.writeDebounceMs);
		this.refreshResolvedImages = debounce(() => {
			if (this.controller && this.renderer) this.renderer.mount(this.controller.model);
		}, IMAGE_REFRESH_DEBOUNCE_MS);
	}

	onHostMessage(msg: unknown): void {
		const m = msg as HostMessage | undefined;
		if (!m || typeof m.type !== "string") return;

		if (m.type === "command") {
			this.handleCommand(m.name);
			return;
		}
		if (m.type === "setConfig") {
			this.applyConfig(m.config);
			return;
		}
		if (m.type === "imageResolved") {
			this.onImageResolved(m.nodeId, m.target, m.url);
			return;
		}
		if (m.type === "imageWritten") {
			const resolve = this.pendingWriteImageResolvers.get(m.id);
			this.pendingWriteImageResolvers.delete(m.id);
			resolve?.(m.embedText);
			return;
		}
		if (m.type === "markdownFilesListed") {
			const resolve = this.pendingListMarkdownFilesResolvers.get(m.id);
			this.pendingListMarkdownFilesResolvers.delete(m.id);
			resolve?.(m.files);
			return;
		}
		if (m.type === "foreignDocumentRead") {
			const resolve = this.pendingReadForeignDocumentResolvers.get(m.id);
			this.pendingReadForeignDocumentResolvers.delete(m.id);
			resolve?.(m.text);
			return;
		}
		if (m.type === "foreignDocumentWritten") {
			const resolve = this.pendingWriteForeignDocumentResolvers.get(m.id);
			this.pendingWriteForeignDocumentResolvers.delete(m.id);
			resolve?.();
			return;
		}
		if (m.type === "quickPickResult") {
			const resolve = this.pendingQuickPickResolvers.get(m.id);
			this.pendingQuickPickResolvers.delete(m.id);
			resolve?.(m.index);
			return;
		}
		if (m.type === "focusAtLine") {
			this.focusNodeAtLine(m.line);
			return;
		}
		if (m.type !== "setDocument") return;
		if (m.version <= this.lastVersion) return; // stale/out-of-order — drop

		const hasPendingWrite = this.controller !== null && this.data !== this.lastWrittenText;
		if (hasPendingWrite) {
			// N2: never silently drop either side. The host already forwards
			// only genuinely external changes (it suppresses its own
			// write-back echoes by text comparison — see
			// MindMapEditorProvider.ts), so reaching here with a real
			// unwritten diff means a genuine race: keep the in-editor state
			// (it will still be written back on the next debounce tick) and
			// tell the user, rather than rebuilding from text that's about to
			// be overwritten anyway.
			this.vscode.postMessage({
				type: "showWarning",
				text: "Mind map: file changed externally while you had unsaved edits. Kept your in-editor changes.",
			});
			return;
		}

		this.lastVersion = m.version;
		this.title = m.title || "Untitled";
		if (!this.controller) this.buildFromScratch(m.text);
		else this.rebuildFromExternalText(m.text);
	}

	/**
	 * Chords VS Code intercepts before they reach the webview's own keydown
	 * handler (plan §7, DECISIONS.md): Ctrl/Cmd+Z/Shift+Z/Y (M2),
	 * Ctrl/Cmd+F (search), Ctrl/Cmd+Shift+B (rebalance), Ctrl/Cmd+/ (fold),
	 * Ctrl/Cmd+K (link editor), and (Phase B) Ctrl/Cmd+Shift+D (toggle
	 * "Done") / Ctrl/Cmd+Shift+I (status quick-pick) all route here as
	 * `contributes.keybindings` commands instead — the Shift+D/I pair risks
	 * the same VS Code-default-keybinding collision Shift+B already had
	 * (see DECISIONS.md's dated "Phase B" entry), so it's routed the same
	 * conservative way rather than assumed free. "flushWrite" is the odd one
	 * out — not a keystroke at all, just the host asking for the pending
	 * write before it acts on the document (Ctrl/Cmd+M toggle); it's handled
	 * first and unconditionally (even mid-inline-edit) so the host never
	 * hangs waiting for an ack.
	 */
	private handleCommand(name: CommandMessage["name"]): void {
		if (name === "flushWrite") {
			this.flushPendingWrite();
			this.vscode.postMessage({ type: "flushAck" });
			return;
		}
		if (this.inlineEditor || !this.controller) return; // InlineEditor owns keys while editing
		if (name === "undo") this.controller.undo();
		else if (name === "redo") this.controller.redo();
		else if (name === "search") this.toggleSearch();
		else if (name === "rebalance") this.controller.rebalance();
		else if (name === "linkEditor") {
			if (this.controller.selectedId) this.openLinkEditor(this.controller.selectedId);
		} else if (name === "toggleFold") {
			if (this.controller.selectedId) this.controller.toggleFold(this.controller.selectedId);
		} else if (name === "toggleStatusDone") {
			if (this.controller.selectedId) this.controller.toggleStatusBadge(this.controller.selectedId, "done");
		} else if (name === "statusQuickPick") {
			if (this.controller.selectedId) this.showStatusQuickPick(this.controller.selectedId);
		} else if (name === "goToNoteSection") {
			if (this.controller.selectedId) this.goToNoteSection(this.controller.selectedId);
		}
	}

	/**
	 * M4 settings (plan §9): caches every incoming config, but only
	 * `writeDebounceMs` is applied to the *running* session — rebuilding
	 * `scheduleWrite` with the new delay. If a write happens to already be
	 * pending under the old delay, this simply drops it: the debounce
	 * wrapper is a fresh closure with its own timer, so any in-flight
	 * timeout on the old one is orphaned (harmless — it holds no state
	 * `writeNow` needs beyond what's already in `this.data`, and the new
	 * wrapper still fires on the very next mutation) rather than
	 * hand-migrating a live timer for a settings change this rare.
	 * `layoutMode`/`headingDepth`/`animationNodeThreshold` are read only
	 * from `this.config` at `buildFromScratch` time — see that method and
	 * DECISIONS.md's dated "M4 settings" entry.
	 */
	private applyConfig(config: MindMapWebviewConfig): void {
		const writeDebounceChanged = config.writeDebounceMs !== this.config.writeDebounceMs;
		this.config = config;
		if (writeDebounceChanged) this.scheduleWrite = debounce(() => this.writeNow(), this.config.writeDebounceMs);
	}

	/**
	 * R18: the renderer calls this synchronously, once per mounted node
	 * that has an image embed, every time it (re)draws that node's image
	 * (see `SvgRenderer.upsertNodeImage`) — it must never itself block on
	 * the host, so an unresolved target returns `null` (the renderer's own
	 * placeholder/missing-glyph state) while a "resolveImage" round trip
	 * runs in the background; `onImageResolved` below re-runs the
	 * renderer's dirty-tracked `update()` once the answer arrives, which
	 * calls back in here and (this time) hits the now-populated cache.
	 *
	 * A remote URL resolves synchronously to itself — no host round trip,
	 * same reasoning as `openLink`'s scheme split. Only ever called for a
	 * node the renderer has actually culled *in* (plan §8's "resolution
	 * becomes async but only for culled-in nodes, preserving the lazy-load
	 * design" — this file never calls it directly, it's purely reactive to
	 * whatever `SvgRenderer` itself decides to draw).
	 */
	private resolveImageUrl(node: MindNode): string | null {
		const embed = getImageEmbed(node.text);
		if (!embed) return null;
		if (URL_SCHEME_RE.test(embed.target)) return embed.target;

		const key = `${node.id}\0${embed.target}`;
		if (this.imageCache.has(key)) return this.imageCache.get(key) ?? null;
		if (!this.imagePending.has(key)) {
			this.imagePending.add(key);
			this.vscode.postMessage({ type: "resolveImage", nodeId: node.id, target: embed.target });
		}
		return null;
	}

	private onImageResolved(nodeId: string, target: string, url: string | null): void {
		const key = `${nodeId}\0${target}`;
		this.imagePending.delete(key);
		this.imageCache.set(key, url);
		// See `refreshResolvedImages`'s own doc comment: a plain `update()`
		// would not actually re-run the resolver for an unchanged node, so
		// this schedules a debounced `mount()` instead.
		this.refreshResolvedImages();
	}

	/** First document text after (re)load — mirrors the reference's `buildFromScratch()`. Bakes `layoutMode`/`headingDepth`/`animationNodeThreshold` from whatever `this.config` currently holds (see DECISIONS.md's dated "M4 settings" entry for why these three apply only on next open, not live). */
	private buildFromScratch(text: string): void {
		this.layoutConfig = { ...DEFAULT_LAYOUT_CONFIG, mode: this.config.layoutMode };
		this.serializeConfig = { ...DEFAULT_SERIALIZE_CONFIG, headingDepth: this.config.headingDepth };

		const model = parseMindMap(text, this.title);
		assignMissingColors(model.root);
		assignMissingSides(model.root);
		computeLayout(model.root, this.layoutConfig);
		// R1a/R2: classify every node's links before the first mount, so
		// relation arrows and cross-doc badges are present from the very
		// first paint, not just after the first edit — mirrors the
		// reference's MindMapView.buildFromScratch.
		const activeRelations = resolveRelations(model, this.title);

		this.controller = new Controller(model);
		this.controller.addListener(this);
		this.data = text;
		this.lastWrittenText = text;

		this.renderer?.destroy();
		this.renderer = new SvgRenderer(this.container, this.config.animationNodeThreshold, this.layoutConfig, this.config.showRelations);
		this.renderer.setNodeClickHandler((id, evt) => {
			if (evt.ctrlKey || evt.metaKey) this.controller?.toggleSelection(id);
			else if (evt.shiftKey) this.controller?.selectRange(id);
			else this.controller?.select(id);
		});
		this.renderer.setNodeDblClickHandler((id) => this.controller?.requestEdit(id));
		this.renderer.setBackgroundClickHandler(() => this.controller?.select(null));
		this.renderer.setBadgeClickHandler((id) => this.controller?.toggleFold(id));
		this.renderer.setStatusBadgeClickHandler((id) => this.showStatusQuickPick(id));
		this.renderer.setCrossDocBadgeClickHandler((id) => this.openCrossDocRelation(id));
		this.renderer.setNodeContextMenuHandler((id, evt) => this.showNodeMenu(id, evt));
		this.renderer.setLinkClickHandler((kind, target) => this.openLink(kind, target));
		this.renderer.setImageClickHandler((kind, target) => this.openImage(kind, target));
		this.renderer.setImageResolver((node) => this.resolveImageUrl(node));
		this.renderer.setManualMoveHandler((id, pos) => this.controller?.setManualPosition(id, pos));
		this.renderer.setReorderHandler((id, targetId, position) => this.controller?.moveNode(id, targetId, position));
		this.renderer.setManualWidthHandler((id, width) => this.controller?.setManualWidth(id, width));
		this.renderer.mount(model, activeRelations);
		this.restoreViewState();
	}

	/**
	 * Subsequent document text = a genuine external edit (the host already
	 * filters out its own write-back echoes — see MindMapEditorProvider.ts's
	 * `lastAppliedText` comparison). Mirrors the reference's
	 * `onVaultModify()`: full re-parse + fresh mount (explicitly allowed by
	 * the plan as the M2 fallback; incremental re-parse is a later
	 * optimization), carrying over first-level branch colors/sides by
	 * structural position so an external edit doesn't visually reshuffle
	 * branches, and preserving the selection via reconcile's
	 * `findEquivalentNode`.
	 */
	private rebuildFromExternalText(text: string): void {
		if (!this.controller || !this.renderer) return;

		// Any node-scoped overlay from before the rebuild would reference a
		// now-stale controller/model — close them defensively rather than
		// leave a dangling closure (the reference doesn't need this since
		// MindMapView is a single long-lived `this`, but our overlays close
		// over `nodeId`s from the pre-rebuild tree).
		this.linkModal?.destroy();
		this.linkModal = null;
		this.contextMenu?.destroy();
		this.contextMenu = null;

		const oldModel = this.controller.model;
		const oldSelectedId = this.controller.selectedId;
		const newModel = parseMindMap(text, this.title);
		oldModel.root.children.forEach((oldChild, index) => {
			const newChild = newModel.root.children[index];
			if (!newChild) return;
			if (oldChild.colorKey) newChild.colorKey = oldChild.colorKey;
			if (oldChild.branchSide) newChild.branchSide = oldChild.branchSide;
		});
		assignMissingColors(newModel.root);
		assignMissingSides(newModel.root);
		computeLayout(newModel.root, this.layoutConfig);
		const activeRelations = resolveRelations(newModel, this.title);

		let newSelectedId: string | null = null;
		const oldSelectedNode = oldSelectedId ? oldModel.byId.get(oldSelectedId) : undefined;
		if (oldSelectedNode) {
			newSelectedId = findEquivalentNode(newModel.root, oldSelectedNode)?.id ?? null;
		}

		this.data = text;
		this.lastWrittenText = text;
		this.controller.removeListener(this);
		this.controller = new Controller(newModel);
		this.controller.selectedId = newSelectedId;
		this.controller.addListener(this);
		this.renderer.mount(newModel, activeRelations);
		this.renderer.selectNode(newSelectedId);
		this.persistState();
	}

	// --- ControllerListener ---

	/** Selection and/or model changed: relayout, dirty-tracked re-render, re-serialize, schedule the debounced write-back. */
	onChange(): void {
		if (!this.controller || !this.renderer) return;
		assignMissingColors(this.controller.model.root);
		assignMissingSides(this.controller.model.root);
		computeLayout(this.controller.model.root, this.layoutConfig);
		// R1a/R2: re-classify every node's links against the now-current tree
		// (a rename/delete/undo can change which block ids exist) *before*
		// ensurePersistentIds/serialize, since both depend on the
		// `isRelationTarget` flags this sets (R1a item 2 — forces a
		// relation's target to keep its block-id suffix across serialize).
		// See model/relations.ts's own doc comment for why this walk is
		// cheap despite running on every change, not just relation edits —
		// re-confirmed live by `bench:relations` now that this actually runs
		// every onChange (see benchmarks.md).
		const activeRelations = resolveRelations(this.controller.model, this.title);
		// Deliberately reordered vs. the reference's onChange (which calls
		// ensurePersistentIds *after* update()/setSelection()) — see
		// `reconcilePersistentIds`'s own comment for why: doing it first
		// keeps the renderer's DOM-identity keying and the controller's
		// selection in sync with whatever id ensurePersistentIds just minted,
		// instead of a stale id surviving until some later unrelated remount
		// quietly "fixes" it.
		this.reconcilePersistentIds();
		this.renderer.update(this.controller.model, activeRelations);
		this.renderer.setSelection(this.controller.selectedIds, this.controller.selectedId);
		this.data = serializeMindMap(this.controller.model, this.serializeConfig);
		this.scheduleWrite();
		this.persistState();
	}

	/**
	 * Saves selection (as structural paths — see `PersistedViewState`'s doc
	 * comment) via `vscode.setState`, called on every model/selection change
	 * (same frequency `serializeMindMap` already runs at). Cheap: proportional
	 * to selection size via `Array.prototype.indexOf` over each node's own
	 * sibling list, not a tree walk — no rule-3 concern, same order of cost as
	 * the id-reconciliation pass already done every `onChange`.
	 *
	 * Also saves the exact pan/zoom (`SvgRenderer.getViewport` — the additive
	 * getter user-authorized for M5, see DECISIONS.md's dated 2026-07-18
	 * entry) so a free pan/zoom with nothing selected round-trips across a
	 * reload too, not just a selection re-center.
	 */
	private persistState(): void {
		if (!this.controller) return;
		const selectedNode = this.controller.selectedId ? this.controller.model.byId.get(this.controller.selectedId) : undefined;
		const state: PersistedViewState = {
			selectedPath: selectedNode ? pathOf(selectedNode) : null,
			selectedPaths: Array.from(this.controller.selectedIds)
				.map((id) => this.controller!.model.byId.get(id))
				.filter((n): n is MindNode => !!n)
				.map((n) => pathOf(n)),
			viewport: this.renderer ? this.renderer.getViewport() : undefined,
		};
		this.vscode.setState(state);
	}

	/**
	 * Restores whatever `persistState` last saved — called once, at the end
	 * of `buildFromScratch` (the one place a fresh session's first model
	 * exists). A brand-new open (nothing ever persisted, `getState()`
	 * returns `undefined`) is a no-op, unchanged from before this existed.
	 * On a hidden→revealed reload, resolves the saved sibling-index paths
	 * against the freshly re-parsed model (same doc text -> same tree shape,
	 * so the paths still resolve even though every non-persisted node just
	 * got a brand-new random id) and restores the selection, then restores
	 * the exact pan/zoom via `SvgRenderer.setViewport` (the additive setter
	 * user-authorized for M5 — see DECISIONS.md's dated 2026-07-18 entry).
	 * The viewport is restored independently of the selection: a free
	 * pan/zoom with nothing selected round-trips too. A state object written
	 * by an older (selection-only) build has no `viewport`, so it falls back
	 * to re-centering on the primary selection with `centerOnWorldPoint`.
	 */
	private restoreViewState(): void {
		if (!this.controller || !this.renderer) return;
		const state = this.vscode.getState() as PersistedViewState | undefined;
		if (!state) return;
		const root = this.controller.model.root;
		const resolvedIds = (state.selectedPaths ?? [])
			.map((path) => nodeAtPath(root, path))
			.filter((n): n is MindNode => !!n)
			.map((n) => n.id);
		const primary = state.selectedPath ? nodeAtPath(root, state.selectedPath) : null;

		if (resolvedIds.length > 0 || primary) {
			this.controller.selectedIds = new Set(resolvedIds);
			this.controller.selectedId = primary?.id ?? resolvedIds[0] ?? null;
			this.renderer.setSelection(this.controller.selectedIds, this.controller.selectedId);
		}

		if (state.viewport) {
			this.renderer.setViewport(state.viewport);
		} else {
			// Older, selection-only persisted state — approximate the camera
			// by re-centering on the primary selection, the pre-viewport
			// behavior.
			const anchor = primary ?? (this.controller.selectedId ? this.controller.model.byId.get(this.controller.selectedId) : undefined);
			if (anchor?.layout) this.renderer.centerOnWorldPoint(anchor.layout.x + anchor.layout.w / 2, anchor.layout.y + anchor.layout.h / 2);
		}
	}

	/**
	 * `ensurePersistentIds` (ported, `sync/metadata.ts`) mints a fresh,
	 * non-synthetic id for any node that just became "persistable" — the
	 * *first* fold (R13), manual position (R12), or manual-width resize on a
	 * node that until then had a plain synthetic id — and mutates
	 * `node.id`/`model.byId` in place. That's fine for `Controller`'s own
	 * mutation bookkeeping, but two other things key off a node's id string
	 * and are **not** told about the rename: `SvgRenderer`'s internal DOM
	 * maps (keyed by id — a stale key there just means one extra
	 * create/destroy for that node on this render, not a bug) and
	 * `Controller.selectedId`/`selectedIds` (a plain string/Set the
	 * Controller never revisits). Left alone, a node that was selected right
	 * when it first got persisted would keep answering to an id that
	 * `byId` no longer has — invisible until the next interaction with that
	 * exact node (e.g. clicking its own fold badge again to unfold) quietly
	 * no-ops, since `Controller.toggleFold`/`setManualPosition`/etc. all
	 * start with `model.byId.get(nodeId)` and bail out on a miss.
	 *
	 * Captures the actual `MindNode` object (not just its id string) for the
	 * current selection *before* the rename, then re-reads `.id` off that
	 * same object afterward — object identity survives the rename even
	 * though the id string doesn't, so this is a correct fix regardless of
	 * how many ids `ensurePersistentIds` minted this cycle. This mirrors a
	 * real, reproducible bug (not a test artifact) that would affect the
	 * reference Obsidian plugin identically, since its `onChange` orders
	 * the same two calls the same (buggy) way — flagged in DECISIONS.md
	 * rather than silently carried over, since "fold a node, then unfold it
	 * again" is not an edge case.
	 */
	private reconcilePersistentIds(): void {
		if (!this.controller) return;
		const selectedNode = this.controller.selectedId ? this.controller.model.byId.get(this.controller.selectedId) : undefined;
		const selectedNodes = Array.from(this.controller.selectedIds)
			.map((id) => this.controller!.model.byId.get(id))
			.filter((n): n is MindNode => !!n);

		ensurePersistentIds(this.controller.model.root, this.controller.model.byId);

		if (selectedNode) this.controller.selectedId = selectedNode.id;
		this.controller.selectedIds = new Set(selectedNodes.map((n) => n.id));
	}

	onEditRequest(nodeId: string): void {
		this.openInlineEditor(nodeId);
	}

	// --- Inline editing ---

	private openInlineEditor(nodeId: string): void {
		if (!this.controller || !this.renderer) return;
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return;
		const rect = this.renderer.getNodeScreenRect(nodeId);
		if (!rect) return;
		const { minWidth, maxWidth, fontSize } = this.renderer.getNodeEditMetrics(node);

		this.inlineEditor?.destroy();
		this.inlineEditor = new InlineEditor(this.container, {
			initialText: node.text,
			rect,
			minWidth,
			maxWidth,
			fontSize,
			onCommit: (text) => {
				this.inlineEditor = null;
				this.controller?.commitRename(nodeId, text);
				this.controller?.select(nodeId);
				this.container.focus();
			},
			onCancel: () => {
				this.inlineEditor = null;
				this.container.focus();
			},
			onCommitAndCreateChild: (text) => {
				this.inlineEditor = null;
				this.controller?.commitRename(nodeId, text);
				this.controller?.select(nodeId);
				this.controller?.addChildToSelected();
			},
		});
	}

	// --- Links (R5) ---

	/**
	 * Both a plain link click and an image-thumbnail click become the same
	 * host message: unlike the reference (which distinguishes "open in the
	 * current tab" from "open in a new tab" so the mind map itself stays
	 * open), a VS Code custom editor tab is always a *different* tab from
	 * whatever `vscode.open` opens for the link target — the map can never
	 * be replaced by it, so there is no equivalent distinction to make here.
	 */
	private openLink(kind: LinkKind, target: string): void {
		// Bug fix (ToolNotes.md ^3xv1d0): a same-file wikilink — `[[#^id]]`
		// or `[[<this file's own basename>#^id]]`, exactly what a same-doc
		// relation (model/relations.ts) is made of — has an empty/self file
		// part, so there is nothing for the host to open; it isn't a
		// different document at all. Forwarding it to the host anyway (the
		// pre-fix behavior) made it try to open a file literally named
		// "#^id.md", which never exists — "the editor could not be opened
		// because the file was not found." Obsidian's own `openLinkText`
		// resolves this same-file case internally for free; VS Code's
		// `vscode.open` does not, so it has to be handled here instead.
		// Resolving locally and just focusing the node in the already-open
		// map (mirroring the search panel's `focusNode`) is also the more
		// useful behavior for a same-doc relation click, vs. round-tripping
		// to the host to open a second view of the same file.
		if (kind === "wikilink" && this.controller) {
			const targetNode = this.resolveSameFileWikilinkNode(target);
			if (targetNode) {
				this.focusNode(targetNode.id);
				return;
			}
			if (this.isSameFileWikilinkTarget(target)) return; // same-file but unresolvable (bare heading link, dangling ^id, self-link) — no-op, not a broken file-open
		}
		this.vscode.postMessage({ type: "openLink", kind, target });
	}

	/** True if a wikilink `target`'s file part (the text before "#", or the whole target when there's no "#") refers to *this* document — either empty (bare `[[#...]]`) or a case-insensitive match on `this.title`. Mirrors `model/relations.ts`'s private `isSameFileTarget` (protected core, not importable) — kept in sync with it by hand; see that file's doc comment for the exact same-file rule this reimplements. */
	private isSameFileWikilinkTarget(target: string): boolean {
		const hashIdx = target.indexOf("#");
		const filePart = hashIdx === -1 ? target : target.slice(0, hashIdx);
		return filePart === "" || filePart.toLowerCase() === this.title.toLowerCase();
	}

	/** Resolves a same-file wikilink's `^blockid` fragment to the node it references in the *current* model, or `null` if `target` isn't a same-file link, has no `^id` fragment, or the id isn't found (dangling reference). Mirrors `model/relations.ts`'s `classifyLink`'s same-doc branch (protected core) for this one purpose — reused by `openLink`, not duplicated logic drifting from relation-arrow resolution. */
	private resolveSameFileWikilinkNode(target: string): MindNode | null {
		if (!this.controller || !this.isSameFileWikilinkTarget(target)) return null;
		const hashIdx = target.indexOf("#");
		const fragment = hashIdx === -1 ? "" : target.slice(hashIdx + 1);
		if (!fragment.startsWith("^")) return null;
		return this.controller.model.byId.get(fragment.slice(1)) ?? null;
	}

	private openImage(kind: LinkKind, target: string): void {
		this.vscode.postMessage({ type: "openLink", kind, target });
	}

	/**
	 * R2: clicking a node's cross-document badge opens its first cross-doc
	 * relation target via the same host round trip a regular link click
	 * uses (`openLink`) — reused rather than reinvented, mirroring the
	 * reference's `openCrossDocRelation`. A node with several cross-doc
	 * relations (rare) only opens the first — a picker for that case is
	 * outside the minimum badge+click design (D3).
	 */
	private openCrossDocRelation(nodeId: string): void {
		if (!this.controller) return;
		const node = this.controller.model.byId.get(nodeId);
		const relation = node?.resolvedRelations?.find((r) => r.kind === "cross-doc");
		if (!relation) return;
		this.openLink(relation.linkKind, relation.rawTarget);
	}

	/** Display label for a node in the relation-target picker (R1a authoring): its link-stripped text, truncated so long node text doesn't blow out the QuickPick list. Mirrors the reference's `relationOptionLabel`. */
	private relationOptionLabel(node: MindNode): string {
		const text = getDisplayText(node.text).trim() || "(untitled)";
		return text.length > 48 ? `${text.slice(0, 48)}…` : text;
	}

	/**
	 * Ctrl/Cmd+K (R3/R5, extended by R1a item 6 and R4; reference `7578f31`
	 * "Redesign the relation/link modal"): lists every relation/link already
	 * on the node — each individually removable — plus a radio-gated add
	 * flow: *Document relation* (default) or *Link* (the original free-text
	 * wikilink/URL/path form). Adding appends to the node's text
	 * (`appendLinkText`, D7) rather than replacing it, so one node can carry
	 * multiple relations (R5); every add/remove commits immediately via the
	 * same `commitRename` path every other edit already uses — no separate
	 * "Save", just "Close".
	 *
	 * The relation-target picker itself is a **user-decided fork from the
	 * reference**: instead of rebuilding the reference's hand-rolled
	 * searchable plain-DOM combobox (`f58b3c1`), this drives VS Code's
	 * native `showQuickPick` for both the "pick a document" and "pick a
	 * node in it" steps (see `pickAndAddRelation` below) — see DECISIONS.md's
	 * dated entry for the full reasoning.
	 */
	private openLinkEditor(nodeId: string): void {
		if (!this.controller) return;
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return;
		const model = this.controller.model;

		const relationTargets: RelationTargetOption[] = [];
		const collectTargets = (n: MindNode) => {
			if (n !== node) relationTargets.push({ id: n.id, label: this.relationOptionLabel(n) });
			n.children.forEach(collectTargets);
		};
		collectTargets(model.root);

		// R4: parsed foreign-file models, cached for this modal session only
		// (a fresh Map every time the modal opens — same scope/lifetime as
		// the reference's own `foreignModelCache`) so re-picking the same
		// document (or re-adding a second relation into it) doesn't re-read/
		// re-parse it.
		const foreignModelCache = new Map<string, ReturnType<typeof parseMindMap>>();
		const currentItems = () => listNodeLinkItems(node, model, this.title);

		this.linkModal?.destroy();
		this.linkModal = new LinkModal(this.container, {
			items: currentItems(),
			onPickAndAddRelation: (label) => this.pickAndAddRelation(nodeId, label, relationTargets, foreignModelCache, currentItems),
			onAddLink: (kind, target, label) => {
				const finalKind: LinkKind = isUrlTarget(target) || isAbsoluteFilesystemPath(target) ? "mdlink" : kind;
				const linkText = buildLinkText({ label, kind: finalKind, target });
				this.controller?.commitRename(nodeId, appendLinkText(node.text, linkText));
				return currentItems();
			},
			onRemoveItem: (occurrenceIndex) => {
				this.controller?.commitRename(nodeId, removeLinkOccurrence(node.text, occurrenceIndex));
				return currentItems();
			},
			onClose: () => {
				this.linkModal = null;
				this.container.focus();
			},
		});
	}

	/**
	 * The QuickPick-driven two-step relation-target picker (user decision,
	 * see DECISIONS.md): step 1 picks a document (current document first,
	 * per `CURRENT_DOCUMENT_ID`, then every other workspace `.md` file via
	 * `requestListMarkdownFiles`); step 2 picks a node inside it (the
	 * current document's node list is already in memory —
	 * `relationTargets` — with **no host round trip at all**; any other
	 * document is read+parsed once via `resolveRelationTargetsForDocument`,
	 * `sync/foreignRelation.ts`, ported unmodified since Phase A). Returns
	 * `null` — and commits nothing — the instant either QuickPick step
	 * comes back cancelled (`index === null`, Escape/click-away), matching
	 * the task's cancel-safety requirement: no partial insert.
	 *
	 * Mutation on a successful pick is exactly the reference's own
	 * same-doc/foreign-doc logic, verbatim from already-ported core
	 * functions — nothing new invented here: `forcePersistentId`
	 * (sync/metadata.ts) mints the target's persistent block id,
	 * `buildLinkText`/`appendLinkText` (model/links.ts) build the new node
	 * text, `Controller.commitRename` commits it (undo/redo, debounced
	 * write-back all unchanged); the foreign-file case additionally goes
	 * through `commitForeignRelationTarget` (sync/foreignRelation.ts) for
	 * the read-modify-write against the *other* file.
	 */
	private async pickAndAddRelation(
		nodeId: string,
		label: string,
		relationTargets: RelationTargetOption[],
		foreignModelCache: Map<string, ReturnType<typeof parseMindMap>>,
		currentItems: () => ReturnType<typeof listNodeLinkItems>
	): Promise<ReturnType<typeof listNodeLinkItems> | null> {
		if (!this.controller) return null;
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return null;

		const foreignFiles = await this.requestListMarkdownFiles();
		const documents: { id: string; label: string }[] = [
			{ id: CURRENT_DOCUMENT_ID, label: `${this.title} (current)` },
			...foreignFiles.map((f) => ({ id: f.path, label: f.basename })),
		];

		const docIndex = await this.requestQuickPick(
			documents.map((d) => ({ label: d.label })),
			"Pick the document the target node lives in"
		);
		if (docIndex === null) return null; // Escape/click-away — no-op, per the cancel-safety contract
		const selectedDoc = documents[docIndex];

		let nodeTargets: RelationTargetOption[];
		if (selectedDoc.id === CURRENT_DOCUMENT_ID) {
			nodeTargets = relationTargets;
		} else {
			nodeTargets = await resolveRelationTargetsForDocument(selectedDoc.id, relationTargets, {
				vault: { cachedRead: async (f) => (await this.requestReadForeignDocument(f.path)) ?? "" },
				resolveFile: (p) => ({ path: p, basename: basenameNoExt(p) }),
				models: foreignModelCache,
				labelFor: (n) => this.relationOptionLabel(n),
			});
		}

		const nodeIndex = await this.requestQuickPick(
			nodeTargets.map((t) => ({ label: t.label })),
			"Pick the target node"
		);
		if (nodeIndex === null) return null; // Escape/click-away — no-op
		const pickedTarget = nodeTargets[nodeIndex];

		if (selectedDoc.id === CURRENT_DOCUMENT_ID) {
			const targetNode = this.controller.model.byId.get(pickedTarget.id);
			if (!targetNode) return null;
			const id = forcePersistentId(targetNode, this.controller.model.byId);
			const linkText = buildLinkText({ label: label || pickedTarget.label, kind: "wikilink", target: `#^${id}` });
			this.controller.commitRename(nodeId, appendLinkText(node.text, linkText));
			return currentItems();
		}

		// R4: foreign-file target — a one-off read-modify-write outside the
		// current file's live debounced pipeline (see foreignRelation.ts).
		const cachedModel = foreignModelCache.get(selectedDoc.id);
		const pickerNode = cachedModel?.byId.get(pickedTarget.id);
		if (!pickerNode) return null;
		const basename = basenameNoExt(selectedDoc.id);
		const result = await commitForeignRelationTarget(
			{
				cachedRead: async (f) => (await this.requestReadForeignDocument(f.path)) ?? "",
				modify: (f, data) => this.requestWriteForeignDocument(f.path, data),
			},
			{ path: selectedDoc.id, basename },
			pickerNode
		);
		if (!result) return null; // foreign file changed shape since the picker was populated — nothing safe to link to
		const linkText = buildLinkText({ label: label || pickedTarget.label, kind: "wikilink", target: `${basename}#^${result.targetId}` });
		this.controller.commitRename(nodeId, appendLinkText(node.text, linkText));
		return currentItems();
	}

	/** R4: every vault `.md` file (D6 — not frontmatter-filtered), excluding this document itself — see `MindMapEditorProvider.listMarkdownFiles`. */
	private requestListMarkdownFiles(): Promise<{ path: string; basename: string }[]> {
		const id = ++this.listMarkdownFilesRequestId;
		return new Promise((resolve) => {
			this.pendingListMarkdownFilesResolvers.set(id, resolve);
			this.vscode.postMessage({ type: "listMarkdownFiles", id });
		});
	}

	/** One-shot read of a foreign workspace file's text (`ForeignVaultReader.cachedRead`'s host-round-trip implementation) — see `MindMapEditorProvider.readForeignDocument`. */
	private requestReadForeignDocument(path: string): Promise<string | null> {
		const id = ++this.readForeignDocumentRequestId;
		return new Promise((resolve) => {
			this.pendingReadForeignDocumentResolvers.set(id, resolve);
			this.vscode.postMessage({ type: "readForeignDocument", id, path });
		});
	}

	/** Writes a foreign workspace file's text (`ForeignVaultWriter.modify`'s host-round-trip implementation) — see `MindMapEditorProvider.writeForeignDocument`. Resolves once the host acks, regardless of whether the write actually succeeded (a failed write is not this call's problem to surface — `commitForeignRelationTarget`'s caller has no fallback path for it either way, matching the reference's own fire-and-forget `vault.modify`). */
	private requestWriteForeignDocument(path: string, text: string): Promise<void> {
		const id = ++this.writeForeignDocumentRequestId;
		return new Promise((resolve) => {
			this.pendingWriteForeignDocumentResolvers.set(id, () => resolve());
			this.vscode.postMessage({ type: "writeForeignDocument", id, path, text });
		});
	}

	/**
	 * Shows a native `vscode.window.showQuickPick` (user-decided platform
	 * fork, see DECISIONS.md) and resolves with the picked item's index, or
	 * `null` if the user dismissed it (Escape/click-away) — see
	 * `MindMapEditorProvider.showQuickPick`'s own doc comment for why an
	 * index, not the item, round-trips.
	 */
	private requestQuickPick(items: { label: string; description?: string }[], placeholder?: string): Promise<number | null> {
		const id = ++this.quickPickRequestId;
		return new Promise((resolve) => {
			this.pendingQuickPickResolvers.set(id, resolve);
			this.vscode.postMessage({ type: "showQuickPick", id, items, placeholder });
		});
	}

	// --- Context menu (R17) ---

	/**
	 * Right-click on a node: select it first (menu actions operate on the
	 * selection, same as the keyboard shortcuts), then show the plain-DOM
	 * `ContextMenu` with "Go to note section" plus the existing
	 * keyboard-shortcut actions — same item set as the reference's Obsidian
	 * `Menu`, minus icons (no icon font available/needed here). Items that
	 * already had a keyboard shortcut now show it as a `hint` (Phase B,
	 * reference `bfd6997`'s "context-menu hotkey hints"), since none of that
	 * was previously visible anywhere in this UI.
	 */
	private showNodeMenu(nodeId: string, evt: MouseEvent): void {
		if (!this.controller) return;
		this.controller.select(nodeId);
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return;

		const target = resolveGoToTarget(this.controller.model, node, this.serializeConfig);
		const containerRect = this.container.getBoundingClientRect();
		const mac = isMac();

		const items: ContextMenuItem[] = [
			{
				label: "Go to note section",
				disabled: target.kind === "unavailable",
				onClick: () => this.goToNoteSection(nodeId),
			},
			{ label: "Edit", hint: "F2", separatorBefore: true, onClick: () => this.controller?.requestEdit(nodeId) },
			{ label: "Add child", hint: "Tab", onClick: () => this.controller?.addChildToSelected() },
			{ label: "Add sibling", hint: "Enter", onClick: () => this.controller?.addSiblingToSelected("after") },
			{ label: "Edit link", hint: mac ? "⌘K" : "Ctrl+K", onClick: () => this.openLinkEditor(nodeId) },
			{
				label: node.folded ? "Unfold" : "Fold",
				hint: mac ? "⌘/" : "Ctrl+/",
				onClick: () => this.controller?.toggleFold(nodeId),
			},
		];
		items.push(...this.buildStatusMenuItems(node, true));
		items.push(
			{
				label: "Copy",
				hint: mac ? "⌘C" : "Ctrl+C",
				separatorBefore: true,
				onClick: () => {
					this.controller?.copySelected();
					this.writeClipboardText();
				},
			},
			{
				label: "Cut",
				hint: mac ? "⌘X" : "Ctrl+X",
				onClick: () => {
					this.controller?.cutSelected();
					this.writeClipboardText();
				},
			},
			{ label: "Paste", hint: mac ? "⌘V" : "Ctrl+V", onClick: () => void this.handlePaste() },
			{
				label: "Copy subtree as markdown",
				onClick: () => {
					navigator.clipboard?.writeText(serializeSubtree(node)).catch(() => {});
				},
			},
			{
				label: "Delete",
				hint: "Delete",
				separatorBefore: true,
				onClick: () => this.controller?.deleteSelected(),
			}
		);

		this.contextMenu?.destroy();
		this.contextMenu = new ContextMenu(this.container, {
			x: evt.clientX - containerRect.left,
			y: evt.clientY - containerRect.top,
			items,
			onClose: () => {
				this.contextMenu = null;
			},
		});
	}

	/**
	 * "Go to note section": resolves the same node/line the reference's
	 * three-tier `resolveGoToTarget` would, flushes the pending write (so
	 * the text side reflects the current content, not stale disk content),
	 * and asks the host to reveal it. The host opens the document as a text
	 * editor in the column beside the map at that line (user-decided reveal
	 * semantics — see `MindMapEditorProvider.ts`'s `goToSection` and
	 * DECISIONS.md); the map tab itself stays open and untouched.
	 */
	private goToNoteSection(nodeId: string): void {
		if (!this.controller) return;
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return;
		const target = resolveGoToTarget(this.controller.model, node, this.serializeConfig);
		if (target.kind === "unavailable") return;
		const line = this.resolveTargetLine(target);
		if (line === null) return;

		this.flushPendingWrite();
		this.vscode.postMessage({ type: "goToSection", line });
	}

	/** Converts a `GoToTarget` into an actual 0-based line number in `this.data` — `resolveGoToTarget` only returns the ref/kind (mirroring Obsidian's own `openLinkText`, which does resolution elsewhere); there is no vault-wide link index here, but there doesn't need to be one — the target is always a location in *this same* document. */
	private resolveTargetLine(target: GoToTarget): number | null {
		if (target.kind === "line") return target.line;
		const lines = this.data.split("\n");
		if (target.kind === "blockid") {
			const re = new RegExp(`\\^${escapeRegExp(target.ref)}\\s*$`);
			const idx = lines.findIndex((line) => re.test(line));
			return idx >= 0 ? idx : null;
		}
		if (target.kind === "heading") {
			const re = new RegExp(`^#{1,6}\\s+${escapeRegExp(target.ref)}\\s*$`);
			const idx = lines.findIndex((line) => re.test(line));
			return idx >= 0 ? idx : null;
		}
		return null;
	}

	// --- Status badges (Phase B, plans/09 in the reference) ---

	/**
	 * Shared by `showNodeMenu`'s inline section and `showStatusQuickPick` —
	 * the 6 canonical statuses (model/statusBadges.ts) plus "Clear status"
	 * when one is set, each checked to show the node's current status.
	 * `standalone` controls whether this is the *only* content of the menu
	 * (the quick-pick — first item gets no separator) or a section spliced
	 * into the middle of the full node menu (a separator precedes it there).
	 */
	private buildStatusMenuItems(node: MindNode, standalone: boolean): ContextMenuItem[] {
		const mac = isMac();
		const items: ContextMenuItem[] = BADGE_DEFS.map((def, index) => ({
			label: def.label,
			checked: node.statusBadge === def.key,
			hint: def.hotkey ? (mac ? def.hotkey.mac : def.hotkey.other) : undefined,
			separatorBefore: index === 0 && standalone,
			onClick: () => this.controller?.setStatusBadge(node.id, def.key),
		}));
		if (node.statusBadge !== undefined) {
			items.push({ label: "Clear status", onClick: () => this.controller?.setStatusBadge(node.id, undefined) });
		}
		return items;
	}

	/**
	 * Ctrl/Cmd+Shift+I and a status-badge click: opens the same status
	 * quick-pick as the context menu's section, positioned at the node's
	 * current screen location (`SvgRenderer.getNodeScreenRect`, already
	 * container-relative — matching what `ContextMenu`'s `x`/`y` expect,
	 * same coordinate space `showNodeMenu` derives from `evt.clientX/Y` minus
	 * the container's own offset). Reuses the plain-DOM `ContextMenu`
	 * overlay rather than introducing a fourth UI primitive alongside
	 * InlineEditor/SearchPanel/LinkModal/ContextMenu.
	 */
	private showStatusQuickPick(nodeId: string): void {
		if (!this.controller || !this.renderer) return;
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return;
		const rect = this.renderer.getNodeScreenRect(nodeId);
		if (!rect) return;

		this.contextMenu?.destroy();
		this.contextMenu = new ContextMenu(this.container, {
			x: rect.left,
			y: rect.top + rect.height,
			items: this.buildStatusMenuItems(node, false),
			onClose: () => {
				this.contextMenu = null;
			},
		});
	}

	// --- Ctrl/Cmd+M toggle support (R20) ---

	/** Cancels the pending debounced write and flushes it immediately, so a host action that depends on the document being current (Ctrl/Cmd+M toggle, "Go to section") doesn't see stale content. No-op if nothing is actually unwritten. */
	private flushPendingWrite(): void {
		this.scheduleWrite.cancel();
		if (this.data !== this.lastWrittenText) this.writeNow();
	}

	// --- OS clipboard (R16, "tree copy") ---
	//
	// All raw `navigator.clipboard` I/O lives here, not in Controller — its
	// mutation methods (`pasteToSelected`/`pasteSubtrees`) stay fully
	// synchronous and testable without stubbing the clipboard API. Copy/cut
	// write the exported markdown after the fact; paste reads the OS
	// clipboard and decides which of the two paste paths applies before
	// calling into the (synchronous) Controller. Both keydown (below) and
	// the context menu's Copy/Cut/Paste items call these same methods.

	/** After copySelected()/cutSelected(): mirrors the just-copied subtree(s) to the OS clipboard as plain markdown, so it can be pasted into any other app. Fire-and-forget — a denied/unavailable clipboard permission shouldn't block the (already-completed) internal copy. */
	private writeClipboardText(): void {
		if (!this.controller) return;
		const text = this.controller.getClipboardMarkdown();
		if (text === null) return;
		this.lastWrittenClipboardText = text;
		navigator.clipboard?.writeText(text)?.catch(() => {
			/* permission denied or unavailable — internal clipboard still works for paste-within-the-extension */
		});
	}

	/**
	 * Ctrl/Cmd+V: an image on the OS clipboard (screenshot, copied from a
	 * browser, etc.) takes priority, mirroring the reference's own
	 * `handlePaste` — see `pasteClipboardImage` below. Otherwise reads
	 * clipboard text; if it differs from what we last wrote ourselves, the
	 * user copied something from *outside* this extension, so parse it
	 * (`parseExternalPaste`) and insert that instead of the (stale, in that
	 * case) internal clipboard.
	 */
	private async handlePaste(): Promise<void> {
		if (!this.controller) return;

		const embedText = await this.pasteClipboardImage();
		if (embedText !== null) {
			this.controller.pasteImageAsChild(embedText);
			return;
		}

		let osText: string | null = null;
		try {
			osText = (await navigator.clipboard?.readText()) ?? null;
		} catch {
			osText = null; // permission denied / unavailable — fall through to the internal clipboard
		}
		if (osText !== null && osText !== this.lastWrittenClipboardText) {
			const nodes = parseExternalPaste(osText);
			if (nodes.length > 0) {
				this.controller.pasteSubtrees(nodes);
				return;
			}
		}
		this.controller.pasteToSelected();
	}

	/**
	 * Clipboard-image paste plumbing (moved from M3 into M4, shares its
	 * host round trip with R18's image *display* work — see PROGRESS.md/
	 * DECISIONS.md). Mirrors the reference's `pasteClipboardImage`, adapted
	 * for the webview<->host boundary: a `Blob`/`ArrayBuffer` can't cross
	 * `postMessage` to the extension host as-is here (there's no shared
	 * vault object to write through directly, unlike Obsidian's
	 * `app.vault.createBinary`), so the bytes are base64-encoded and sent
	 * as a "writeImage" message; the host is supposed to write the file and
	 * reply with the embed markdown to insert.
	 *
	 * Returns `null` if the clipboard has no image (falls through to the
	 * text-paste path in `handlePaste`, same as the reference), the
	 * read/encode fails, **or** the host doesn't have a save-location
	 * policy yet — today, always the last one (see `MindMapEditorProvider.
	 * ts`'s `writeImage` stub and this file's header comment): the
	 * round-trip plumbing below is real and tested, but the host always
	 * answers `embedText: null` until the pasted-image save location is
	 * decided (escalated, not decided, per the M4 task scope).
	 */
	private async pasteClipboardImage(): Promise<string | null> {
		if (typeof navigator.clipboard?.read !== "function") return null;
		let items: ClipboardItems;
		try {
			items = await navigator.clipboard.read();
		} catch {
			return null;
		}
		for (const item of items) {
			const mime = item.types.find((t) => t.startsWith("image/"));
			if (!mime) continue;
			try {
				const blob = await item.getType(mime);
				const dataBase64 = await MindMapApp.blobToBase64(blob);
				return await this.requestWriteImage(mime, dataBase64);
			} catch {
				return null;
			}
		}
		return null;
	}

	/** Chunked to avoid blowing the call stack on `String.fromCharCode(...bytes)` for a large screenshot — `btoa` only accepts a plain string, not a typed array. */
	private static async blobToBase64(blob: Blob): Promise<string> {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const CHUNK = 0x8000;
		let binary = "";
		for (let i = 0; i < bytes.length; i += CHUNK) {
			binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
		}
		return btoa(binary);
	}

	/** Posts a "writeImage" request and awaits the matching "imageWritten" reply (matched by a monotonic request id, in case more than one were ever in flight) — see `onHostMessage`'s "imageWritten" handling. */
	private requestWriteImage(mimeType: string, dataBase64: string): Promise<string | null> {
		const id = ++this.writeImageRequestId;
		return new Promise((resolve) => {
			this.pendingWriteImageResolvers.set(id, resolve);
			this.vscode.postMessage({ type: "writeImage", id, mimeType, dataBase64 });
		});
	}

	// --- Search (R15) ---

	private toggleSearch(): void {
		if (this.searchPanel) {
			this.searchPanel.focus();
			return;
		}
		this.openSearchPanel();
	}

	private openSearchPanel(): void {
		if (!this.controller) return;
		this.searchPanel = new SearchPanel(this.container, {
			onQuery: (query) => searchNodes(this.controller!.model.root, query),
			onSelect: (nodeId) => this.focusNode(nodeId),
			onClose: () => this.closeSearchPanel(),
		});
	}

	private closeSearchPanel(): void {
		this.searchPanel?.destroy();
		this.searchPanel = null;
		this.container.focus();
	}

	/** Unfolds whatever's hiding a node (if anything), selects it, and pans the view to center it — used for search results (and, structurally, anything else that needs to jump to a possibly off-screen/culled/folded node). */
	private focusNode(nodeId: string): void {
		if (!this.controller || !this.renderer) return;
		this.controller.revealAndSelect(nodeId);
		const node = this.controller.model.byId.get(nodeId);
		if (node?.layout) {
			this.renderer.centerOnWorldPoint(node.layout.x + node.layout.w / 2, node.layout.y + node.layout.h / 2);
		}
	}

	/**
	 * The inverse of "Go to note section" (`goToNoteSection` below): given a
	 * 0-based line number in the *current* document (from the
	 * `mindmapView.goToMindMapNode` text-editor context-menu command,
	 * relayed by the host — see `FocusAtLineMessage`), finds the node
	 * "containing" that line and focuses it, same as a search result.
	 *
	 * Mirrors `sync/goToSection.ts`'s `findNodeLine` — same frontmatter +
	 * depth-first, node-then-attachedContent line accounting — but inverted:
	 * `findNodeLine` starts from a known node id and returns its line;
	 * this starts from a line and needs the node, so it walks once,
	 * tracking the last node whose own line is still `<= line` (document
	 * order + depth-first means that's always the most specific node
	 * "covering" the given line, exactly like a text editor's own
	 * current-section notion). `findNodeLine` itself isn't reused directly
	 * (it doesn't support "search by line", only "look up by id" — reusing
	 * it here would mean an O(n) call per candidate node, O(n²) overall);
	 * this is the one, single-pass walk that same protected function's own
	 * doc comment describes, run backwards. `sync/goToSection.ts` is
	 * protected core (byte-identical to the reference, which has no
	 * equivalent "reverse" feature to diverge from in the first place) —
	 * kept out of it rather than adding an unauthorized export there for a
	 * feature the reference plugin doesn't have at all.
	 */
	private focusNodeAtLine(line: number): void {
		if (!this.controller) return;
		const model = this.controller.model;
		const nodesMeta: Record<string, { folded?: boolean; pos?: [number, number]; width?: number }> = {};
		collectMeta(model.root, nodesMeta);
		const frontmatter = applyMindmapData(model.frontmatterRaw, { nodes: nodesMeta });
		let cursorLine = frontmatter ? frontmatter.split("\n").length : 0;

		let best: MindNode = model.root;
		if (line >= cursorLine) {
			cursorLine += 1 + (model.root.attachedContent?.length ?? 0);
			const walk = (node: MindNode): void => {
				for (const child of node.children) {
					if (cursorLine > line) return; // this child (and everything after, in document order) starts past the target line — stop, `best` is already the closest match
					best = child;
					cursorLine += 1 + (child.attachedContent?.length ?? 0);
					walk(child);
				}
			};
			walk(model.root);
		}
		this.focusNode(best.id);
	}

	// --- Sync: debounced write-back ---

	private writeNow(): void {
		this.lastWrittenText = this.data;
		this.vscode.postMessage({ type: "writeDocument", text: this.data });
	}

	// --- Keyboard shortcuts (plan §8) ---
	//
	// M2 subset (Tab/Enter/F2/Delete/arrows/Escape) plus M3's additions that
	// are *not* on VS Code's intercepted-chord list (Alt+Up/Down reorder,
	// Ctrl/Cmd+Home, Ctrl/Cmd+C/X/V) — the intercepted ones (Ctrl/Cmd+Z et
	// al., Ctrl/Cmd+F, Ctrl/Cmd+Shift+B, Ctrl/Cmd+/, Ctrl/Cmd+K) arrive via
	// handleCommand instead, see above.

	onKeyDown(evt: KeyboardEvent): void {
		if (this.inlineEditor || !this.controller) return; // InlineEditor owns keys while editing
		const mod = evt.ctrlKey || evt.metaKey;

		if (evt.key === "Escape") {
			evt.preventDefault();
			this.controller.collapseSelection();
			return;
		}

		if (evt.key === "Tab") {
			evt.preventDefault();
			this.controller.addChildToSelected();
		} else if (evt.key === "Enter" && !mod) {
			evt.preventDefault();
			this.controller.addSiblingToSelected(evt.shiftKey ? "before" : "after");
		} else if (evt.key === "F2" || (evt.key === " " && !mod)) {
			evt.preventDefault();
			if (this.controller.selectedId) this.controller.requestEdit(this.controller.selectedId);
		} else if (evt.key === "Delete" || evt.key === "Backspace") {
			evt.preventDefault();
			this.controller.deleteSelected();
		} else if (evt.altKey && (evt.key === "ArrowUp" || evt.key === "ArrowDown")) {
			// Keyboard equivalent of the drag-reorder before/after gesture:
			// reorders the selected node among its own siblings rather than
			// changing the selection (checked ahead of the plain-arrow
			// navigation branch below, which this would otherwise fall into).
			evt.preventDefault();
			this.controller.moveSelectedInSiblingOrder(evt.key === "ArrowUp" ? "up" : "down");
		} else if (evt.key === "ArrowUp" || evt.key === "ArrowDown" || evt.key === "ArrowLeft" || evt.key === "ArrowRight") {
			evt.preventDefault();
			this.navigate(evt.key);
		} else if (mod && evt.key === "Home") {
			evt.preventDefault();
			this.renderer?.centerOnRoot();
		} else if (mod && evt.key.toLowerCase() === "c") {
			evt.preventDefault();
			this.controller.copySelected();
			this.writeClipboardText();
		} else if (mod && evt.key.toLowerCase() === "x") {
			evt.preventDefault();
			this.controller.cutSelected();
			this.writeClipboardText();
		} else if (mod && evt.key.toLowerCase() === "v") {
			evt.preventDefault();
			void this.handlePaste();
		}
	}

	/**
	 * A pan/zoom gesture (background drag, wheel/pinch) changed the renderer's
	 * viewport — persist it so a free pan/zoom with nothing selected also
	 * round-trips across a hidden→revealed reload. Pan/zoom is handled
	 * entirely inside the (protected) `SvgRenderer`'s own pointer/wheel
	 * handlers and never emits a controller `onChange`, so without this hook
	 * `persistState` would only ever capture the viewport as a side effect of
	 * a selection/model change. `persistState` (which reads the now-current
	 * viewport via the additive `SvgRenderer.getViewport`) is cheap — a small
	 * object write to `vscode.setState`, no serialization — so it runs
	 * directly per gesture-end event rather than being debounced.
	 */
	onViewportGesture(): void {
		this.persistState();
	}

	private navigate(key: string): void {
		if (!this.controller) return;
		if (!this.controller.selectedId) {
			// First arrow press with nothing selected: select the root as
			// visible feedback instead of silently navigating from it.
			this.controller.select(this.controller.model.root.id);
			return;
		}
		const node = this.controller.model.byId.get(this.controller.selectedId);
		if (!node) return;
		const direction: Direction = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : "right";
		const visible = collectVisibleNodes(this.controller.model.root);
		const next = navigateFrom(node, direction, visible);
		if (next) this.controller.select(next.id);
	}
}

const vscode = acquireVsCodeApi();
const container = document.querySelector<HTMLElement>(".mindmap-view-container");
if (container) {
	container.tabIndex = 0;
	const app = new MindMapApp(container, vscode);
	window.addEventListener("message", (evt: MessageEvent) => app.onHostMessage(evt.data));
	container.addEventListener("keydown", (evt) => app.onKeyDown(evt));
	// Persist the viewport after a pan/zoom gesture (both bubble up from the
	// renderer's SVG to the container). The renderer updates its own `view`
	// synchronously in its pointer/wheel handlers, so by the time these fire
	// `getViewport()` already reflects the new pan/zoom.
	container.addEventListener("pointerup", () => app.onViewportGesture());
	container.addEventListener("wheel", () => app.onViewportGesture(), { passive: true });
	container.addEventListener("mousedown", (evt) => {
		// Don't steal focus from any of the overlay UIs — a click there is
		// the user placing the caret / typing a query / picking a menu item,
		// not a request to refocus the mind map canvas (same reasoning as
		// the reference's identical guard in MindMapView.onOpen).
		if ((evt.target as HTMLElement).closest(".mm-inline-editor, .mm-search-panel, .mm-link-modal-backdrop, .mm-context-menu")) return;
		container.focus();
	});
	// Ready-handshake: the host waits for this instead of posting into a
	// page that may not have registered its listener yet (also what re-syncs
	// us for free after a hidden/revealed webview reload, since this script
	// re-runs from scratch and the host's message subscription survives).
	vscode.postMessage({ type: "ready" });
}
