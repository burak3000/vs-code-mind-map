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

/**
 * CustomTextEditorProvider for `*.md` files (registered with priority
 * "option" so it never steals the default text editor — users opt in via
 * "Open as Mind Map" / "Reopen Editor With..."; the latter also gives the
 * md <-> map toggle described in the plan (R20) essentially for free).
 *
 * M1 scope: the host -> webview half of the document bridge. On the
 * webview's "ready" handshake the full document text is posted (typed
 * "setDocument", carrying TextDocument.version so the webview can drop
 * stale messages); afterwards every onDidChangeTextDocument for this
 * document is forwarded the same way, debounced (see above). All of these
 * are external edits by definition in M1 — the webview cannot write yet.
 * The reverse direction (webview -> WorkspaceEdit write-back with
 * self-write suppression) is M2 and absent here.
 */
export class MindMapEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = "mindmapView.editor";

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new MindMapEditorProvider(context);
		return vscode.window.registerCustomEditorProvider(MindMapEditorProvider.viewType, provider, {
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
			if (forwardTimer !== undefined) clearTimeout(forwardTimer);
			forwardTimer = setTimeout(postDocument, EXTERNAL_EDIT_FORWARD_DEBOUNCE_MS);
		});

		const messageSubscription = webview.onDidReceiveMessage((msg: { type?: string }) => {
			// Ready-handshake: the webview script posts "ready" once its
			// message listener is registered (both on first load and on every
			// reload after being hidden/revealed) — posting before that risks
			// the message arriving into a page with no listener yet.
			if (msg?.type === "ready") postDocument();
		});

		webviewPanel.onDidDispose(() => {
			if (forwardTimer !== undefined) clearTimeout(forwardTimer);
			changeSubscription.dispose();
			messageSubscription.dispose();
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
