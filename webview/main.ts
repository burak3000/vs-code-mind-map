// Webview bootstrap (bundled to media/webview.js) — M3: full feature parity.
//
// Per CLAUDE.md rule 7, the entire interaction loop lives here in the
// webview: parse -> colors/sides -> layout -> SvgRenderer, keyboard
// handling, inline editing, undo/redo, folding, manual positioning,
// drag-reorder, links, search, context menu, multi-select clipboard, and
// serialization. The extension host is only the persistence layer plus a
// handful of platform actions (open a link, reveal a note section, swap
// editor kind) it is uniquely positioned to perform — it posts the
// document text on resolve/external edit, applies a `WorkspaceEdit` when
// this file posts a "writeDocument" message, and opens links/reveals text
// on request. Nothing here ever blocks on a host round-trip for the
// interactive loop itself; the one exception (flushWrite, below) is a
// deliberate one-time administrative wait before the Ctrl/Cmd+M toggle or
// "Go to section", exactly like the reference's own `flushPendingWrite`.
//
// M4+ concerns are omitted, not stubbed: no image thumbnail resolution
// (asWebviewUri), no live theme/config messages, no clipboard-image paste
// (scope question — see the M3 report) — each is called out where the
// reference wires it, so the diff against the reference stays legible.

import { parseMindMap } from "./sync/parser";
import { serializeMindMap, serializeSubtree, DEFAULT_SERIALIZE_CONFIG, SerializeConfig } from "./sync/serializer";
import { computeLayout, DEFAULT_LAYOUT_CONFIG, LayoutConfig } from "./layout/layoutEngine";
import { SvgRenderer } from "./render/SvgRenderer";
import { Controller, ControllerListener } from "./controller/Controller";
import { assignMissingColors } from "./render/colors";
import { assignMissingSides } from "./layout/sides";
import { findEquivalentNode } from "./sync/reconcile";
import { ensurePersistentIds } from "./sync/metadata";
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
import { LinkKind, getSoleLink, buildLinkText } from "./model/links";
import { MindNode } from "./model/types";

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
	name: "undo" | "redo" | "search" | "rebalance" | "linkEditor" | "toggleFold" | "flushWrite";
}

type HostMessage = SetDocumentMessage | CommandMessage;

/**
 * Write-back debounce (plan §6): 400 ms after the last mutation, same
 * provisional-default treatment as the M1 external-edit forward debounce
 * (300 ms, in `MindMapEditorProvider.ts`) — becomes a setting in M4.
 * Living in the webview (not the host) means every keystroke-driven
 * mutation batches locally before a single `postMessage` crosses the
 * process boundary, not just before the host's `WorkspaceEdit` fires.
 */
const WRITE_DEBOUNCE_MS = 400;

/** Escapes a string for safe interpolation into a `RegExp` — used by `resolveTargetLine` to match a block-id/heading target's exact text. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
	// Settings (layout mode, animation threshold, heading depth) are M4;
	// until then the ported defaults apply, same values the reference uses.
	private readonly layoutConfig: LayoutConfig = DEFAULT_LAYOUT_CONFIG;
	private readonly serializeConfig: SerializeConfig = DEFAULT_SERIALIZE_CONFIG;

	/** Latest serialized text for the current model — the write-back payload. */
	private data = "";
	/** The text as of the last confirmed baseline (initial load, external rebuild, or a write-back we've actually posted) — compared against `data` to tell "there's a real unwritten local edit" apart from "a write is merely scheduled" (e.g. a plain selection change re-serializes to identical text — see the reference's identical `hasPendingWrite` check in MindMapView.onVaultModify). */
	private lastWrittenText = "";
	private readonly scheduleWrite: ReturnType<typeof debounce>;

	/** The last markdown text *we* wrote to the OS clipboard (tree copy) — paste compares against this to tell "internal copy/cut" apart from "user copied something else outside this extension" (plan item 06, R16). */
	private lastWrittenClipboardText: string | null = null;

	constructor(private readonly container: HTMLElement, private readonly vscode: VsCodeWebviewApi) {
		this.scheduleWrite = debounce(() => this.writeNow(), WRITE_DEBOUNCE_MS);
	}

	onHostMessage(msg: unknown): void {
		const m = msg as HostMessage | undefined;
		if (!m || typeof m.type !== "string") return;

		if (m.type === "command") {
			this.handleCommand(m.name);
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
	 * Ctrl/Cmd+K (link editor) all route here as `contributes.keybindings`
	 * commands instead. "flushWrite" is the odd one out — not a keystroke at
	 * all, just the host asking for the pending write before it acts on the
	 * document (Ctrl/Cmd+M toggle); it's handled first and unconditionally
	 * (even mid-inline-edit) so the host never hangs waiting for an ack.
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
		}
	}

	/** First document text after (re)load — mirrors the reference's `buildFromScratch()`. */
	private buildFromScratch(text: string): void {
		const model = parseMindMap(text, this.title);
		assignMissingColors(model.root);
		assignMissingSides(model.root);
		computeLayout(model.root, this.layoutConfig);

		this.controller = new Controller(model);
		this.controller.addListener(this);
		this.data = text;
		this.lastWrittenText = text;

		this.renderer?.destroy();
		// Constructor args 2 (animation threshold) keeps its ported default
		// until M4 settings arrive.
		this.renderer = new SvgRenderer(this.container, undefined, this.layoutConfig);
		this.renderer.setNodeClickHandler((id, evt) => {
			if (evt.ctrlKey || evt.metaKey) this.controller?.toggleSelection(id);
			else if (evt.shiftKey) this.controller?.selectRange(id);
			else this.controller?.select(id);
		});
		this.renderer.setNodeDblClickHandler((id) => this.controller?.requestEdit(id));
		this.renderer.setBackgroundClickHandler(() => this.controller?.select(null));
		this.renderer.setBadgeClickHandler((id) => this.controller?.toggleFold(id));
		this.renderer.setNodeContextMenuHandler((id, evt) => this.showNodeMenu(id, evt));
		this.renderer.setLinkClickHandler((kind, target) => this.openLink(kind, target));
		this.renderer.setImageClickHandler((kind, target) => this.openImage(kind, target));
		this.renderer.setManualMoveHandler((id, pos) => this.controller?.setManualPosition(id, pos));
		this.renderer.setReorderHandler((id, targetId, position) => this.controller?.moveNode(id, targetId, position));
		this.renderer.setManualWidthHandler((id, width) => this.controller?.setManualWidth(id, width));
		// Not wired yet (vs. the reference's buildFromScratch): image
		// resolution (setImageResolver) — M4 (asWebviewUri round trip).
		this.renderer.mount(model);
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
		this.renderer.mount(newModel);
		this.renderer.selectNode(newSelectedId);
	}

	// --- ControllerListener ---

	/** Selection and/or model changed: relayout, dirty-tracked re-render, re-serialize, schedule the debounced write-back. */
	onChange(): void {
		if (!this.controller || !this.renderer) return;
		assignMissingColors(this.controller.model.root);
		assignMissingSides(this.controller.model.root);
		computeLayout(this.controller.model.root, this.layoutConfig);
		// Deliberately reordered vs. the reference's onChange (which calls
		// ensurePersistentIds *after* update()/setSelection()) — see
		// `reconcilePersistentIds`'s own comment for why: doing it first
		// keeps the renderer's DOM-identity keying and the controller's
		// selection in sync with whatever id ensurePersistentIds just minted,
		// instead of a stale id surviving until some later unrelated remount
		// quietly "fixes" it.
		this.reconcilePersistentIds();
		this.renderer.update(this.controller.model);
		this.renderer.setSelection(this.controller.selectedIds, this.controller.selectedId);
		this.data = serializeMindMap(this.controller.model, this.serializeConfig);
		this.scheduleWrite();
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
		this.vscode.postMessage({ type: "openLink", kind, target });
	}

	private openImage(kind: LinkKind, target: string): void {
		this.vscode.postMessage({ type: "openLink", kind, target });
	}

	private openLinkEditor(nodeId: string): void {
		if (!this.controller) return;
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return;
		const existing = getSoleLink(node.text);

		this.linkModal?.destroy();
		this.linkModal = new LinkModal(this.container, {
			initialLabel: existing?.label ?? node.text,
			initialKind: existing?.kind ?? "wikilink",
			initialTarget: existing?.target ?? "",
			hasExistingLink: existing !== null,
			onSave: (result) => this.controller?.commitRename(nodeId, buildLinkText(result)),
			onRemove: () => {
				if (existing) this.controller?.commitRename(nodeId, existing.label);
			},
			onClose: () => {
				this.linkModal = null;
				this.container.focus();
			},
		});
	}

	// --- Context menu (R17) ---

	/**
	 * Right-click on a node: select it first (menu actions operate on the
	 * selection, same as the keyboard shortcuts), then show the plain-DOM
	 * `ContextMenu` with "Go to note section" plus the existing
	 * keyboard-shortcut actions — same item set as the reference's Obsidian
	 * `Menu`, minus icons (no icon font available/needed here).
	 */
	private showNodeMenu(nodeId: string, evt: MouseEvent): void {
		if (!this.controller) return;
		this.controller.select(nodeId);
		const node = this.controller.model.byId.get(nodeId);
		if (!node) return;

		const target = resolveGoToTarget(this.controller.model, node, this.serializeConfig);
		const containerRect = this.container.getBoundingClientRect();

		const items: ContextMenuItem[] = [
			{
				label: "Go to note section",
				disabled: target.kind === "unavailable",
				onClick: () => this.goToNoteSection(nodeId),
			},
			{ label: "Edit", separatorBefore: true, onClick: () => this.controller?.requestEdit(nodeId) },
			{ label: "Add child", onClick: () => this.controller?.addChildToSelected() },
			{ label: "Add sibling", onClick: () => this.controller?.addSiblingToSelected("after") },
			{ label: "Edit link", onClick: () => this.openLinkEditor(nodeId) },
			{ label: node.folded ? "Unfold" : "Fold", onClick: () => this.controller?.toggleFold(nodeId) },
			{
				label: "Copy",
				separatorBefore: true,
				onClick: () => {
					this.controller?.copySelected();
					this.writeClipboardText();
				},
			},
			{
				label: "Cut",
				onClick: () => {
					this.controller?.cutSelected();
					this.writeClipboardText();
				},
			},
			{ label: "Paste", onClick: () => void this.handlePaste() },
			{
				label: "Copy subtree as markdown",
				onClick: () => {
					navigator.clipboard?.writeText(serializeSubtree(node)).catch(() => {});
				},
			},
			{ label: "Delete", separatorBefore: true, onClick: () => this.controller?.deleteSelected() },
		];

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
	 * Ctrl/Cmd+V: reads clipboard text; if it differs from what we last
	 * wrote ourselves, the user copied something from *outside* this
	 * extension, so parse it (`parseExternalPaste`) and insert that instead
	 * of the (stale, in that case) internal clipboard. Text-only for M3 —
	 * an OS-clipboard *image* (screenshot, browser copy) would need the host
	 * to write a file into the workspace, which is scoped to M4 alongside
	 * image display (R18); see the M3 report's scope-escalation.
	 */
	private async handlePaste(): Promise<void> {
		if (!this.controller) return;

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
