# Changelog

All notable changes to the Mind Map View extension. This covers milestones
M0–M5 of the initial port from the Obsidian reference plugin, plus a
post-M5 catch-up bringing over feature work the reference plugin gained
afterward; there has been no public release yet (`version` in
`package.json` is still `0.0.1`).

## Unreleased — Fixes, and "Go to Mind Map Node"

- **New:** "Go to Mind Map Node" — the inverse of "Go to note section."
  Right-click anywhere in a markdown file's plain text editor for a context
  menu item that opens (or reveals) that file's mind map and selects the
  node nearest your cursor.
- **New:** "Center" — a context-menu item (hint: `Home`) and a plain
  `Home` keyboard shortcut that re-centers the view on the currently
  selected node, keeping the current zoom level. `Ctrl/Cmd+Home` still
  centers on the root.
- **Fix:** clicking a same-document relation link (e.g. `[[#^blockid]]`)
  tried to open a file literally named `#^blockid.md` and failed. It now
  focuses the target node in the already-open map instead.
- **Fix:** the packaged `.vsix` could pick up stray scratch notes left in
  the repo root (e.g. a manual-testing `.md` file); only `README.md`/
  `CHANGELOG.md` ship now, by default rather than by name.

## Unreleased — Post-M5 catch-up: node relations & status badges

Catch-up work bringing this extension in line with feature additions made
to the reference Obsidian plugin after this repo's M0 port point. Not part
of the original M0–M5 milestone plan.

- **Node relations:** a relation between two nodes — same-document or
  cross-document — can now be authored and viewed. Same-document relations
  render as an arrow between the two nodes; cross-document relations render
  as a clickable badge that opens the target file. `Ctrl/Cmd+K` (the link
  editor, redesigned into a combined "Links & relations" modal) adds a
  "Document relation" via a two-step VS Code Quick Pick (pick the file,
  then pick a node in it), alongside the existing free-text link form. New
  `mindmapView.showRelations` setting (default on) toggles the whole layer.
- **Status badges:** a node can be marked Done, Started, Blocked, Red Flag,
  Green Flag, or Ready to work on. `Ctrl/Cmd+Shift+D` toggles Done directly;
  `Ctrl/Cmd+Shift+I` opens a quick-pick (anchored to the node) listing all
  six plus "Clear status"; the same options are also in the right-click
  context menu.

## Unreleased — M5: hardening & release readiness

- Webview state persistence: the selection and the exact pan/zoom now
  survive a hidden→revealed webview reload, via `vscode.getState`/`setState`.
  Selection is restored by structural sibling-index path rather than node id
  (a reload re-parses the document from scratch and mints fresh ids for any
  node without persisted metadata); the viewport is restored exactly, so a
  free pan/zoom with nothing selected round-trips too.
- Workspace trust and virtual-workspace capability declarations added
  (`package.json`'s `capabilities`): untrusted workspaces are fully
  supported (with `mindmapView.pastedImageFolder` restricted, since an
  untrusted workspace's own settings could otherwise redirect where pasted
  images get written); virtual workspaces are declared `limited` — opening
  and editing the map works, but link-opening, image display, and
  clipboard-image paste assume a real filesystem path and may misbehave
  over a genuinely virtual one.
- Packaging: added `.vscodeignore` (ships only `dist/`, `media/`,
  `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`) and an `npm run
  package` script (`vsce package`).
- Added `README.md`, `CHANGELOG.md`, `LICENSE`, and `RELEASING.md`.

## M4 — Images, theming, settings

- Image embeds (`![](path)`) render as lazily-resolved thumbnails
  (`webview.asWebviewUri`, viewport-bounded resolution — only nodes actually
  scrolled into view request a URL).
- Full VS Code theming: the map's CSS now references only `--vscode-*`
  variables, so it repaints for free on every theme switch, including both
  high-contrast variants (the 8 branch colors map to
  `--vscode-charts-*`/`--vscode-terminal-ansi*`, so contrast is guaranteed
  by the active theme itself rather than a fixed hex palette).
- Settings (`contributes.configuration`): `writeDebounceMs`,
  `externalEditForwardDebounceMs`, `animationNodeThreshold`, `headingDepth`,
  `layoutMode`, `pastedImageFolder`.
- Clipboard image paste: copy an image, paste it into the map — it's
  written to disk (default: alongside the file) and embedded automatically.

## M3 — Full feature parity

- Folding with a persisted fold state and hidden-descendant-count badges.
- Manual positioning (`Alt`+drag, resize handles) and "Rebalance".
- Drag-reorder and `Alt`+`↑`/`↓` keyboard reordering.
- Links: click to open (web URL via the system browser, relative
  path/wikilink via VS Code's own opener), `Ctrl/Cmd+K` link editor.
- Search panel (`Ctrl/Cmd+F`).
- Right-click context menu, including "Go to note section" (opens the
  underlying line in a text editor beside the map).
- Multi-selection with bulk copy/cut/paste, including OS-clipboard markdown
  export and parsing pasted external markdown/plain text.
- `Ctrl/Cmd+M` toggles the same tab between the mind map and the plain
  markdown editor, flushing any pending write first so nothing is lost.

## M2 — Editing + bidirectional sync

- Inline editing (`F2`/double-click to edit; `Tab`/`Enter`/`Shift+Enter` to
  create and immediately edit).
- Undo/redo via a webview-local command stack, scoped to the mind map tab
  (`Ctrl/Cmd+Z`/`Shift+Z`/`Y`) so it doesn't fight VS Code's own document
  undo stack.
- Debounced write-back (`WorkspaceEdit`, full-document replace) with
  self-write suppression, so the extension's own writes are never
  re-forwarded to the webview as if they were external edits.
- External-edit reconciliation: editing the file in a split text editor
  refreshes the map, preserving selection and first-level branch
  colors/sides.

## M1 — Read-only map in the webview

- Webview bootstrap (CSP, nonce), a ready-handshake + version-gated
  host→webview document bridge, debounced forwarding of external text
  changes.
- Pan/zoom and click/`Ctrl`/`Shift` selection.

## M0 — Scaffold and core port

- Extension skeleton, esbuild dual-bundle build (`dist/extension.js` for the
  extension host, `media/webview.js` for the webview).
- The platform-free core (`model/`, `layout/`, `render/`, `sync/`,
  `controller/`) ported byte-for-byte from the Obsidian reference plugin.
- Ported test suite and benchmark scripts; fixture generator for 100 / 500 /
  2,000 / 5,000-node stress fixtures.
