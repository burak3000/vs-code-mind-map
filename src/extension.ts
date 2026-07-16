import * as vscode from "vscode";
import { MindMapEditorProvider } from "./MindMapEditorProvider";

// Extension host entry point. Per CLAUDE.md rule 7, this file (and everything
// under src/) is deliberately thin: activation, command/provider
// registration, and (in later milestones) the TextDocument <-> webview
// persistence bridge. The interaction loop itself lives entirely in the
// webview bundle (webview/main.ts / media/webview.js).
export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(MindMapEditorProvider.register(context));

	context.subscriptions.push(
		vscode.commands.registerCommand("mindmapView.openAsMindMap", async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!target) {
				vscode.window.showWarningMessage("Open as Mind Map: no markdown file is active.");
				return;
			}
			await vscode.commands.executeCommand("vscode.openWith", target, MindMapEditorProvider.viewType);
		})
	);
}

export function deactivate(): void {
	// No teardown needed yet; the provider's own dispose paths (registered
	// via context.subscriptions above) handle webview panel cleanup.
}
