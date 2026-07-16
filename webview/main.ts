// Webview bootstrap entry point (bundled to media/webview.js).
//
// M0 scope only: this is intentionally a no-op placeholder. The real
// bootstrap — parse the document text the host posts on resolve, run
// layout, mount SvgRenderer, wire pan/zoom/selection — is M1 work (plan
// §9). Per CLAUDE.md rule 7, once that lands, the entire interaction loop
// (model/layout/render/keyboard handling) lives here in the webview; the
// host only ever sends/receives document text over postMessage.
//
// This file exists now (rather than starting empty) so the M0 exit
// criterion — a real two-bundle esbuild build producing both
// dist/extension.js and media/webview.js — has a genuine entry point on the
// webview side to bundle, instead of an empty stub esbuild would need
// special-casing for.
(function bootstrapPlaceholder() {
	// No-op: the CSP-restricted placeholder markup in
	// MindMapEditorProvider's getHtmlForWebview() already communicates the
	// M0 state without any DOM manipulation from here. Left as a named
	// function (not a bare top-level statement) so M1 has an obvious spot
	// to replace with real bootstrap logic.
})();
