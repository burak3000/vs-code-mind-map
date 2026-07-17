import * as vscode from "vscode";
import * as path from "path";

/**
 * How long to wait after the last onDidChangeTextDocument event before
 * forwarding the document to the webview. Unlike Obsidian's vault "modify"
 * (which fires on save), this event fires per keystroke when the user types
 * in a side-by-side text editor — forwarding each one would trigger a full
 * re-parse + fresh mount in the webview per keystroke, exactly the
 * architectural anti-pattern CLAUDE.md rule 6 forbids. Debouncing here is
 * the plan's own mitigation (§11 risk table: "Large doc edits flood
 * onDidChangeTextDocument -> Debounce + version-gate"). The value is a
 * provisional default (flagged in the M1 report); it becomes a proper
 * setting in M4 alongside the write-back delay.
 */
const EXTERNAL_EDIT_FORWARD_DEBOUNCE_MS = 300;

/** A link/image click target's kind — mirrors `webview/model/links.ts`'s `LinkKind` (not imported directly: that module lives under `webview/`, compiled against the browser-lib tsconfig, and this file is the Node-side host — see DECISIONS.md's two-tsconfig entry). */
type LinkKind = "wikilink" | "mdlink";

/** A scheme-qualified URL (`https://…`, `mailto:…`, etc.) — anything else is treated as a workspace-relative path, same split the reference `MindMapView.openLink` makes. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Every currently-resolved webview panel, one entry per document — used to (a) route the `mindmapView.undo`/`redo`/`search`/`rebalance`/`linkEditor`/`toggleFold` commands to whichever the user is actually looking at (`contributes.keybindings`'s `when` clause only guarantees *a* mind map editor is active, not which document), and (b) let the Ctrl/Cmd+M "toggle to markdown" command find that document's URI and flush its pending write before swapping editor kind. */
interface PanelEntry {
	panel: vscode.WebviewPanel;
	document: vscode.TextDocument;
	/** The most recently kicked-off `applyWriteback` call — awaited by `flush()` after the webview's flushAck arrives, so a caller can be sure the *specific* write that flush provoked (if any) has actually landed in the document, not just that the round-trip message was received. */
	lastWriteback: Promise<void>;
	/** Resolved (and cleared) when this panel's webview posts back "flushAck" — see `flush()`. */
	pendingFlushResolvers: (() => void)[];
}

/**
 * CustomTextEditorProvider for `*.md` files (registered with priority
 * "option" so it never steals the default text editor — users opt in via
 * "Open as Mind Map" / "Reopen Editor With..."; the latter also gives the
 * md <-> map toggle described in the plan (R20) essentially for free).
 *
 * M3 scope added on top of M1/M2's document bridge: platform actions the
 * webview cannot perform itself (open a link/file, swap editor kind) arrive
 * as host messages / VS Code commands; the webview keeps owning the entire
 * interaction loop (CLAUDE.md rule 7) — this class never touches the model.
 */
export class MindMapEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = "mindmapView.editor";

	private static readonly panels = new Set<PanelEntry>();

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new MindMapEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(MindMapEditorProvider.viewType, provider, {
			webviewOptions: {
				// Keeping the webview's DOM/JS state alive while the tab is
				// hidden vs. re-parsing+re-laying-out+re-rendering on every
				// reveal is a memory-vs-latency trade-off (plan §3.3, item
				// 11) — not decided here. With `false`, a hidden->revealed
				// webview reloads from scratch: its script re-runs, re-sends
				// "ready", and the handshake below re-syncs it. Revisit as an
				// explicit user question when M5 hardening measures both
				// sides of the trade-off.
				retainContextWhenHidden: false,
			},
			supportsMultipleEditorsPerDocument: false,
		});

		// Undo/redo (M2) and search/rebalance/link-editor/fold-toggle (M3):
		// VS Code intercepts these chords globally (Ctrl/Cmd+Z, Ctrl/Cmd+F,
		// Ctrl/Cmd+Shift+B, Ctrl/Cmd+/, Ctrl/Cmd+K — see package.json's
		// `contributes.keybindings` and the M3 report's chord enumeration),
		// so `contributes.keybindings` binds one command per chord instead of
		// letting the keystroke reach the webview's own keydown handler.
		// Each just forwards a "command" message to whichever registered
		// panel is currently active.
		const registerRoutedCommand = (id: string, name: "undo" | "redo" | "search" | "rebalance" | "linkEditor" | "toggleFold") =>
			vscode.commands.registerCommand(id, () => MindMapEditorProvider.postCommandToActivePanel(name));

		const undoCommand = registerRoutedCommand("mindmapView.undo", "undo");
		const redoCommand = registerRoutedCommand("mindmapView.redo", "redo");
		const searchCommand = registerRoutedCommand("mindmapView.search", "search");
		const rebalanceCommand = registerRoutedCommand("mindmapView.rebalance", "rebalance");
		const linkEditorCommand = registerRoutedCommand("mindmapView.linkEditor", "linkEditor");
		const toggleFoldCommand = registerRoutedCommand("mindmapView.toggleFold", "toggleFold");

		// Ctrl/Cmd+M toggle (R20): two commands, two keybindings with
		// complementary `when` clauses (package.json) — one fires while a
		// mind map tab is active (goes to markdown), the other while a
		// markdown text editor is active (goes to the mind map). Going *to*
		// markdown flushes the webview's pending debounced write first (via
		// the same flush()/flushAck round trip "Go to section" uses) so the
		// text editor never opens showing stale content.
		const toggleToTextCommand = vscode.commands.registerCommand("mindmapView.toggleToText", async () => {
			const entry = MindMapEditorProvider.activePanelEntry();
			if (!entry) return;
			await MindMapEditorProvider.flush(entry);
			await vscode.commands.executeCommand("vscode.openWith", entry.document.uri, "default");
		});
		const toggleToMindMapCommand = vscode.commands.registerCommand("mindmapView.toggleToMindMap", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== "markdown") return;
			await vscode.commands.executeCommand("vscode.openWith", editor.document.uri, MindMapEditorProvider.viewType);
		});

		return vscode.Disposable.from(
			providerRegistration,
			undoCommand,
			redoCommand,
			searchCommand,
			rebalanceCommand,
			linkEditorCommand,
			toggleFoldCommand,
			toggleToTextCommand,
			toggleToMindMapCommand
		);
	}

	private static postCommandToActivePanel(name: "undo" | "redo" | "search" | "rebalance" | "linkEditor" | "toggleFold"): void {
		for (const entry of MindMapEditorProvider.panels) {
			if (entry.panel.active) void entry.panel.webview.postMessage({ type: "command", name });
		}
	}

	private static activePanelEntry(): PanelEntry | undefined {
		for (const entry of MindMapEditorProvider.panels) {
			if (entry.panel.active) return entry;
		}
		return undefined;
	}

	/**
	 * Asks `entry`'s webview to flush any pending debounced write (Ctrl/Cmd+M
	 * toggle, "Go to section") and waits for it to actually land in the
	 * document — not just for the round-trip message. The webview always
	 * acks ("flushAck") right after synchronously posting a "writeDocument"
	 * message if (and only if) it had one pending; because message delivery
	 * preserves order, `lastWriteback` (updated by the "writeDocument"
	 * handler below) is already set to *that* write's promise by the time
	 * the ack arrives, so awaiting it afterward is correct and not a race —
	 * no arbitrary timeout needed.
	 */
	private static flush(entry: PanelEntry): Promise<void> {
		return new Promise<void>((resolve) => {
			entry.pendingFlushResolvers.push(resolve);
			void entry.panel.webview.postMessage({ type: "command", name: "flushWrite" });
		}).then(() => entry.lastWriteback);
	}

	private constructor(private readonly context: vscode.ExtensionContext) {}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		const webview = webviewPanel.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
		};
		webview.html = this.getHtmlForWebview(webview);

		const entry: PanelEntry = {
			panel: webviewPanel,
			document,
			lastWriteback: Promise.resolve(),
			pendingFlushResolvers: [],
		};
		MindMapEditorProvider.panels.add(entry);

		// The text we most recently applied to `document` ourselves, via
		// `applyEdit` below — compared against `onDidChangeTextDocument`'s
		// resulting text (not a synchronous flag) because `applyEdit`
		// crosses to the renderer process and back, so there's no reliable
		// call-stack window to bracket. A change event whose resulting text
		// matches this is our own write-back's echo, not a genuine external
		// edit, and must not be forwarded back into the webview (that would
		// both waste a full re-parse+mount for nothing and — worse — race
		// the very edit that produced it).
		let lastAppliedText = document.getText();

		const postDocument = () => {
			// getText()/version are read at send time, so a debounced call
			// always ships the newest state — intermediate keystrokes are
			// naturally skipped, never queued.
			void webview.postMessage({
				type: "setDocument",
				text: document.getText(),
				version: document.version,
				title: path.parse(document.fileName).name,
			});
		};

		let forwardTimer: ReturnType<typeof setTimeout> | undefined;
		const changeSubscription = vscode.workspace.onDidChangeTextDocument((evt) => {
			if (evt.document.uri.toString() !== document.uri.toString()) return;
			if (evt.contentChanges.length === 0) return; // metadata-only events (e.g. language change) — no text to forward
			if (evt.document.getText() === lastAppliedText) return; // our own write-back's echo — see lastAppliedText above
			if (forwardTimer !== undefined) clearTimeout(forwardTimer);
			forwardTimer = setTimeout(postDocument, EXTERNAL_EDIT_FORWARD_DEBOUNCE_MS);
		});

		/**
		 * Webview -> host write-back (plan §6, trade-off #10): full-document
		 * replace, not minimal ranges — the plan's own approved starting
		 * point ("start with full replace, measure, ask if it matters").
		 * `lastAppliedText` is set *before* `applyEdit` resolves (indeed
		 * before it's even called) so the self-write-suppression check above
		 * is correct regardless of how the async edit/event ordering plays
		 * out.
		 */
		const applyWriteback = async (text: string) => {
			if (text === document.getText()) return; // no-op — nothing actually changed
			const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, fullRange, text);
			lastAppliedText = text;
			await vscode.workspace.applyEdit(edit);
		};

		const messageSubscription = webview.onDidReceiveMessage((msg: { type?: string; text?: string; kind?: string; target?: string; line?: number }) => {
			// Ready-handshake: the webview script posts "ready" once its
			// message listener is registered (both on first load and on every
			// reload after being hidden/revealed) — posting before that risks
			// the message arriving into a page with no listener yet.
			if (msg?.type === "ready") postDocument();
			else if (msg?.type === "writeDocument" && typeof msg.text === "string") {
				entry.lastWriteback = applyWriteback(msg.text);
			} else if (msg?.type === "showWarning" && typeof msg.text === "string") {
				void vscode.window.showWarningMessage(msg.text);
			} else if (msg?.type === "flushAck") {
				const resolvers = entry.pendingFlushResolvers;
				entry.pendingFlushResolvers = [];
				resolvers.forEach((resolve) => resolve());
			} else if (msg?.type === "openLink" && typeof msg.kind === "string" && typeof msg.target === "string") {
				void this.openLink(msg.kind as LinkKind, msg.target, document);
			} else if (msg?.type === "goToSection" && typeof msg.line === "number") {
				void this.goToSection(document, msg.line);
			}
		});

		webviewPanel.onDidDispose(() => {
			MindMapEditorProvider.panels.delete(entry);
			if (forwardTimer !== undefined) clearTimeout(forwardTimer);
			changeSubscription.dispose();
			messageSubscription.dispose();
		});
	}

	/**
	 * Links (R5): a scheme-qualified target (`https://…`) opens in the
	 * system browser; anything else is a workspace-relative path (a
	 * wikilink note title, or an `mdlink`'s relative file/attachment path) —
	 * resolved against the *document's own* directory (there is no
	 * vault-wide link index to consult, unlike Obsidian's
	 * `openLinkText`/`getFirstLinkpathDest`) and opened via the built-in
	 * `vscode.open` command, which picks a sensible editor for whatever it
	 * resolves to (text, image, binary) on its own.
	 */
	private async openLink(kind: LinkKind, target: string, document: vscode.TextDocument): Promise<void> {
		if (URL_SCHEME_RE.test(target)) {
			await vscode.env.openExternal(vscode.Uri.parse(target));
			return;
		}
		const docDir = path.dirname(document.uri.fsPath);
		let relTarget = target;
		// A wikilink target is normally just a note title with no extension
		// (Obsidian's own convention) — an `mdlink` target already carries
		// whatever extension it needs (or none, for a bare file/folder path).
		if (kind === "wikilink" && !path.extname(relTarget)) relTarget += ".md";
		const fileUri = vscode.Uri.file(path.resolve(docDir, relTarget));
		await vscode.commands.executeCommand("vscode.open", fileUri);
	}

	/**
	 * "Go to note section" (R17): the webview has already resolved the exact
	 * target line (`resolveGoToTarget` + its own line-number lookup) and
	 * flushed the pending write (flushWrite/flushAck round trip) before
	 * sending this message, so `document` is current, not stale.
	 *
	 * Open semantics (user-decided 2026-07-17, see DECISIONS.md): open the
	 * document as a plain text editor in the column **beside** the map and
	 * reveal the target line, leaving the mind map tab itself open and
	 * untouched — the least-destructive of the three options (new column /
	 * replace tab / Reopen With), and the closest match to the reference
	 * plugin's own "always opens in a new tab" behavior.
	 *
	 * This custom-editor-plus-text-editor coexistence on one document is the
	 * exact same arrangement M2's split-view sync already relies on;
	 * `supportsMultipleEditorsPerDocument: false` only forbids two *custom*
	 * (mind map) editors on one document, not a custom editor alongside a
	 * text editor, so the two do not conflict.
	 */
	private async goToSection(document: vscode.TextDocument, line: number): Promise<void> {
		// Clamp to the document's actual line range — the webview resolves the
		// line against its own just-flushed serialization, which is the same
		// text now in `document`, but guarding costs nothing and avoids an
		// out-of-range selection if the two ever drift by a line.
		const safeLine = Math.max(0, Math.min(line, Math.max(0, document.lineCount - 1)));
		const pos = new vscode.Position(safeLine, 0);
		await vscode.window.showTextDocument(document, {
			viewColumn: vscode.ViewColumn.Beside,
			selection: new vscode.Range(pos, pos),
		});
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "mindmap.css"));
		const nonce = getNonce();

		// CSP: only the nonce-tagged script may run, styles/images are
		// restricted to the webview's own resource origin (plus data: for
		// future inline image thumbs, R18), everything else defaults closed.
		// No inline scripts or style attributes anywhere in this document
		// (the renderer styles elements via CSSOM property assignment, which
		// CSP does not block).
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>Mind Map</title>
</head>
<body>
	<div class="mindmap-view-container">
		<div class="mindmap-placeholder">Loading mind map…</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let text = "";
	for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
	return text;
}
