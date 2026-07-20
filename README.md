# Mind Map View

A mind mapping editor, in the style of a traditional desktop mind-mapper, for `.md` files, built directly into VS
Code. It reads and writes plain markdown — headings and nested lists — with
true bidirectional sync: edit the map, the file updates; edit the file (in a
split view, another editor, git, whatever), the map updates. There is no
proprietary format and no lock-in: every file this extension opens is a
normal markdown file before, during, and after.

This extension is a port of an existing Obsidian community plugin with the
same name and feature set, rebuilt for VS Code's custom-editor and webview
model.

## Features

| # | Feature |
|---|---|
| R1 | Familiar desktop-mind-mapper interaction model: click/drag to select and pan, keyboard-first editing |
| R2 | `Tab` creates a child of the selected node, immediately editable |
| R3 | `Enter` creates a sibling after the selected node; `Shift+Enter` creates one before it |
| R4 | Full keyboard map — navigate, rename, delete, fold, zoom, undo/redo (see table below) |
| R5 | Clickable links: web URLs, relative file/folder paths, and `[[wikilinks]]`; `Ctrl/Cmd+K` opens the link editor |
| R6 | Works on plain `.md` files — no proprietary format, nothing to export |
| R7 | True bidirectional sync: edits in the map write back to the file; edits to the file (e.g. in a side-by-side text editor) refresh the map |
| R8 | Organic (Bezier curve) branch lines |
| R9 | Each first-level branch gets its own color, inherited by its descendants — mapped to your VS Code theme's own chart colors, so it stays legible in light, dark, and both high-contrast themes |
| R10 | Branch width tapers with depth |
| R11 | Balanced auto-layout: first-level branches split left/right of the root in document order |
| R12 | Manual positioning via `Alt`+drag and resize handles; "Rebalance" resets to the auto-layout |
| R13 | Folding hides a branch's descendants from layout and rendering; persisted to the file |
| R14 | Fold badge shows the hidden-descendant count |
| R15 | Search panel (`Ctrl/Cmd+F`) with a results list; selecting a result unfolds and centers it |
| R16 | Multi-selection (`Ctrl/Cmd`+click, `Shift`+click); bulk copy/cut/paste; copying puts real markdown on your OS clipboard |
| R17 | Right-click context menu, including "Go to note section" (opens the underlying line in a text editor beside the map) |
| R18 | Image embeds (`![](path)`) render as thumbnails, lazily resolved as they scroll into view |
| R19 | Depth-scaled visual hierarchy — font and box size shrink with depth |
| R20 | Toggle between the mind map and the plain markdown editor on the same tab with `Ctrl/Cmd+M` |
| — | Paste an image from the clipboard directly into the map — it's saved next to your file (or wherever `mindmapView.pastedImageFolder` points) and embedded automatically |
| R21 | Node relations: same-document relations render as arrows between nodes; cross-document relations render as a clickable badge that opens the target file. `Ctrl/Cmd+K` (the link editor) also lets you add a "Document relation" — pick a file, then a node in it, via VS Code's native Quick Pick — alongside plain links. Toggle the whole layer with `mindmapView.showRelations` |
| R22 | Status badges: mark a node Done, Started, Blocked, Red Flag, Green Flag, or Ready to work on. `Ctrl/Cmd+Shift+D` toggles Done directly; `Ctrl/Cmd+Shift+I` opens a quick-pick of all six (plus Clear status) anchored to the node; the same six also appear in the right-click context menu |

## Getting started

1. Open a workspace containing a `.md` file (or create one).
2. Right-click its tab (or the file in the Explorer) → **Reopen Editor
   With…** → **Mind Map**. Or run **Open as Mind Map** from the Command
   Palette while the file is active.
3. Click a node to select it, `Tab`/`Enter` to grow the tree, and start
   typing.

An empty or new `.md` file opens as a single root node named after the file.
The map is just the file's headings and list items — `## `-level headings
become first-level branches by default (`mindmapView.headingDepth`), deeper
items become nested list items.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Tab` | Add a child to the selected node and edit it |
| `Enter` | Add a sibling after the selected node and edit it |
| `Shift+Enter` | Add a sibling before the selected node and edit it |
| `F2` / `Space` | Edit the selected node |
| `Delete` / `Backspace` | Delete the selected node(s) |
| `Escape` | While editing: cancel. Otherwise: collapse a multi-selection to the primary node |
| Arrow keys | Navigate to the nearest node in that direction |
| `Alt`+`↑`/`↓` | Reorder the selected node among its siblings |
| `Alt`+drag a node | Move it to a manual position |
| Drag a node onto another | Nest it as a child, or drop near a sibling's edge to reorder |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`) | Redo |
| `Ctrl/Cmd+F` | Open the search panel |
| `Ctrl/Cmd+K` | Edit the selected node's link |
| `Ctrl/Cmd+/` | Toggle fold on the selected node |
| `Ctrl/Cmd+Shift+B` | Rebalance (clear manual positions, reflow) |
| `Ctrl/Cmd+Shift+D` | Toggle the selected node's "Done" status |
| `Ctrl/Cmd+Shift+I` | Open a quick-pick to set (or clear) the selected node's status |
| `Ctrl/Cmd+C` / `X` / `V` | Copy / cut / paste (single or multi-selection; also accepts pasted external markdown/plain text, or a pasted clipboard image) |
| `Ctrl/Cmd+Home` | Center the view on the root |
| `Ctrl/Cmd+M` | Toggle this tab between the mind map and the plain markdown editor |
| Mouse wheel | Zoom |
| Click‑drag empty canvas | Pan |
| Right‑click a node | Open its context menu |

`Ctrl/Cmd+Z/Shift+Z/Y/F/K/Shift+B/M/Shift+D/Shift+I` are chords VS Code
would otherwise intercept before they reach the webview, so they're wired
through `contributes.keybindings` scoped to the mind map editor — they
only fire while a mind map tab is focused (or, for the markdown-ward
direction of `Ctrl/Cmd+M`, while a markdown text editor is focused).

## How the sync works

The markdown file is always the source of truth on disk. Opening it as a
mind map parses the same headings/list-item structure the file already has —
nothing is rewritten just by opening it. Every edit in the map (rename, add,
delete, fold, move, etc.) re-serializes the in-memory model and writes it
back to the file through VS Code's own edit/undo/save machinery
(`WorkspaceEdit`), debounced (`mindmapView.writeDebounceMs`, default 400 ms)
so a burst of keystrokes doesn't turn into a burst of edits.

If you edit the same file as plain text — in a split view, another editor,
an external tool, git checkout, anything — the map notices
(`onDidChangeTextDocument`, debounced by
`mindmapView.externalEditForwardDebounceMs`, default 300 ms) and rebuilds
itself from the new text, preserving your selection and first-level branch
colors/sides where the structure still matches. If you have an unsaved edit
in the map when an external change arrives, the map's own edit wins (a
warning is shown) rather than silently discarding either side.

Node identity (used for folding, manual position, and links) is stored as an
invisible trailing `^blockid` on the relevant line, minted only the first
time a node needs one — most nodes never get one at all.

## Settings

All under `mindmapView.*`:

| Setting | Default | Effect |
|---|---|---|
| `writeDebounceMs` | `400` | Delay after your last edit in the map before writing it back to the file. Applies immediately to already-open maps. |
| `externalEditForwardDebounceMs` | `300` | Delay after an external file change before refreshing an open map. Applies immediately. |
| `animationNodeThreshold` | `500` | Above this many visible nodes, fold/unfold animations turn off and apply instantly. Takes effect the next time a map is opened. |
| `headingDepth` | `1` | Nodes at or above this depth are written as headings; deeper nodes become list items. Takes effect on next open. |
| `layoutMode` | `"balanced"` | `balanced` / `right-only` / `left-only` — how first-level branches are arranged around the root. Takes effect on next open. |
| `pastedImageFolder` | `""` (alongside the file) | Folder, relative to the file's own folder, where clipboard-pasted images are saved. Applies to the next paste immediately. |
| `showRelations` | `true` | Show same-document relation arrows and cross-document relation badges. Takes effect the next time a map is opened. |

## Requirements

VS Code `^1.85.0`. No other runtime dependencies are installed alongside the
extension — everything (including the `d3-flextree` layout library) is
bundled into the two shipped scripts.

## Known limitations

- Wikilinks and "Go to note section" resolve relative to the current file's
  own folder, not a workspace-wide index — unlike Obsidian, there's no
  vault-wide link graph to consult.
- Link-opening, image display, and clipboard-image paste assume a real
  filesystem path; they may not work over a virtual workspace (e.g.
  `github.dev`, a remote virtual filesystem provider). Reading and editing
  the map itself works normally in that case — see `capabilities` in
  `package.json`.
- Write-back always replaces the full document text (not a minimal range
  edit) — negligible cost even at 5,000 nodes (see `benchmarks.md`), but
  worth knowing if you're watching the file's own edit history.

## Development

```sh
npm install
npm run build       # type-check + esbuild both bundles
npm run dev         # esbuild in watch mode (run this or `build` before F5)
npm test            # vitest, ~370 tests, ~2.5s
npm run bench:m1    # parse + layout
npm run bench:m2    # mutate + relayout + serialize
npm run bench:open  # full webview open path
npm run bench:images
npm run package     # build + vsce package -> mindmap-view-<version>.vsix
```

Press `F5` in VS Code (uses `.vscode/launch.json`) to launch an Extension
Development Host, then open any file under `fixtures/` (generated by `npm
run fixtures`) and **Reopen Editor With… → Mind Map**.

See `DECISIONS.md` for the architectural record, `benchmarks.md` for
per-milestone performance numbers against budget, and `PROGRESS.md` for
milestone status. `RELEASING.md` covers publishing to the Marketplace.

## License

MIT — see `LICENSE`.
