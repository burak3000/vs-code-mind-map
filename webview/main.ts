// Webview bootstrap (bundled to media/webview.js) — M1: read-only map.
//
// Per CLAUDE.md rule 7, the entire interaction loop lives here in the
// webview: parse -> colors/sides -> layout -> SvgRenderer, plus pan/zoom
// (built into SvgRenderer) and selection (Controller). The extension host
// is only the persistence layer: it posts the document text on resolve and
// on (debounced) external edits; nothing here ever blocks on a host
// round-trip.
//
// The build/rebuild paths below deliberately mirror the reference repo's
// `MindMapView.buildFromScratch()` and `MindMapView.onVaultModify()`
// (/Users/burakucbinli/projects/obsidian/src/view/MindMapView.ts) — wiring
// the ported code, not redesigning it. M2+ concerns are omitted, not
// stubbed: no inline editor, no write-back, no keyboard shortcuts, no
// fold/link/image/context-menu/drag handlers yet (each is called out where
// the reference wires it, so the diff against the reference stays legible).

import { parseMindMap } from "./sync/parser";
import { computeLayout, DEFAULT_LAYOUT_CONFIG, LayoutConfig } from "./layout/layoutEngine";
import { SvgRenderer } from "./render/SvgRenderer";
import { Controller, ControllerListener } from "./controller/Controller";
import { assignMissingColors } from "./render/colors";
import { assignMissingSides } from "./layout/sides";
import { findEquivalentNode } from "./sync/reconcile";

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

class MindMapApp implements ControllerListener {
	private controller: Controller | null = null;
	private renderer: SvgRenderer | null = null;
	/** Highest TextDocument.version rendered so far. postMessage delivery order isn't contractual, so a message carrying an older version than what's on screen is dropped rather than applied backwards. */
	private lastVersion = -1;
	private title = "Untitled";
	// Settings (layout mode, animation threshold) are M4; until then the
	// ported defaults apply, same values the reference uses.
	private readonly layoutConfig: LayoutConfig = DEFAULT_LAYOUT_CONFIG;

	constructor(private readonly container: HTMLElement) {}

	onHostMessage(msg: unknown): void {
		const m = msg as SetDocumentMessage;
		if (!m || m.type !== "setDocument") return;
		if (m.version <= this.lastVersion) return; // stale/out-of-order — drop
		this.lastVersion = m.version;
		this.title = m.title || "Untitled";
		if (!this.controller) this.buildFromScratch(m.text);
		else this.rebuildFromExternalText(m.text);
	}

	/** First document text after (re)load — mirrors the reference's `buildFromScratch()`, minus the M2/M3 handler wiring. */
	private buildFromScratch(text: string): void {
		const model = parseMindMap(text, this.title);
		assignMissingColors(model.root);
		assignMissingSides(model.root);
		computeLayout(model.root, this.layoutConfig);

		this.controller = new Controller(model);
		this.controller.addListener(this);

		this.renderer?.destroy();
		// Constructor args 2 (animation threshold) and 3 (text metrics) keep
		// their ported defaults until M4 settings arrive.
		this.renderer = new SvgRenderer(this.container, undefined, this.layoutConfig);
		this.renderer.setNodeClickHandler((id, evt) => {
			if (evt.ctrlKey || evt.metaKey) this.controller?.toggleSelection(id);
			else if (evt.shiftKey) this.controller?.selectRange(id);
			else this.controller?.select(id);
		});
		this.renderer.setBackgroundClickHandler(() => this.controller?.select(null));
		// Not wired yet (vs. the reference's buildFromScratch): dblclick/edit,
		// badge/fold, context menu, link/image click+resolve, manual move,
		// reorder, manual width — M2/M3 scope.
		this.renderer.mount(model);
	}

	/**
	 * Subsequent document text = an edit made outside this webview (the
	 * text editor in a split, another tool, ...). Mirrors the reference's
	 * `onVaultModify()`: full re-parse + fresh mount (explicitly allowed by
	 * the plan as the M2 fallback; incremental re-parse is a later
	 * optimization), carrying over first-level branch colors/sides by
	 * structural position so an external edit doesn't visually reshuffle
	 * branches, and preserving the selection via reconcile's
	 * `findEquivalentNode`. The reference's unsaved-local-edits conflict
	 * branch has no M1 equivalent (this webview cannot have unsaved edits
	 * until M2 adds editing) and is intentionally absent, not forgotten.
	 */
	private rebuildFromExternalText(text: string): void {
		if (!this.controller || !this.renderer) return;

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

		this.controller.removeListener(this);
		this.controller = new Controller(newModel);
		this.controller.selectedId = newSelectedId;
		this.controller.addListener(this);
		this.renderer.mount(newModel);
		this.renderer.selectNode(newSelectedId);
	}

	// --- ControllerListener ---

	/** Selection (and, from M2 on, model) changed. The reference's onChange additionally serializes + schedules the debounced write-back — that entire tail is M2 (write-back) and deliberately absent here. */
	onChange(): void {
		if (!this.controller || !this.renderer) return;
		assignMissingColors(this.controller.model.root);
		assignMissingSides(this.controller.model.root);
		computeLayout(this.controller.model.root, this.layoutConfig);
		this.renderer.update(this.controller.model);
		this.renderer.setSelection(this.controller.selectedIds, this.controller.selectedId);
	}

	/** Inline editing is M2; nothing in M1 can trigger this (the dblclick handler isn't wired), but the interface requires it. */
	onEditRequest(_nodeId: string): void {}
}

const vscode = acquireVsCodeApi();
const container = document.querySelector<HTMLElement>(".mindmap-view-container");
if (container) {
	const app = new MindMapApp(container);
	window.addEventListener("message", (evt: MessageEvent) => app.onHostMessage(evt.data));
	// Ready-handshake: the host waits for this instead of posting into a
	// page that may not have registered its listener yet (also what re-syncs
	// us for free after a hidden/revealed webview reload, since this script
	// re-runs from scratch and the host's message subscription survives).
	vscode.postMessage({ type: "ready" });
}
