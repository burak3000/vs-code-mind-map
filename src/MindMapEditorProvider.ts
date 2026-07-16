import * as vscode from "vscode";

/**
 * CustomTextEditorProvider for `*.md` files (registered with priority
 * "option" so it never steals the default text editor — users opt in via
 * "Open as Mind Map" / "Reopen Editor With..."; the latter also gives the
 * md <-> map toggle described in the plan (R20) essentially for free).
 *
 * M0 scope only: resolve a webview and show a placeholder. The real
 * TextDocument <-> webview message bridge (send document text on resolve,
 * apply debounced WorkspaceEdits on write-back, forward
 * onDidChangeTextDocument, resolve image URIs) is M1/M2 work per the
 * roadmap (plan §9) and is NOT implemented here.
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
				// 11) — not decided here; revisit explicitly before M1 ships
				// a real interaction loop worth preserving.
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
		webview.html = this.getHtmlForWebview(webview, document);
	}

	private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "mindmap.css"));
		const nonce = getNonce();

		// CSP from the start (task requirement): only the nonce-tagged script
		// may run, styles/images are restricted to the webview's own
		// resource origin (plus data: for future inline image thumbs, R18),
		// and everything else defaults closed. No inline scripts/styles
		// anywhere in this document.
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
		<div class="mindmap-placeholder">
			Mind Map View — M0 placeholder. Parsing/layout/render for
			"${escapeHtml(document.fileName)}" arrives in M1.
		</div>
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

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
