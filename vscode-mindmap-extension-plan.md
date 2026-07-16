# VS Code Mind Map Extension — Implementation Plan

**Goal:** Build a VS Code extension that provides an XMind-like mind mapping
experience directly on `.md` files — a port of the working Obsidian plugin at
`/Users/burakucbinli/projects/obsidian` to VS Code's extension platform, with
identical functionality. **Performance is a first-class, non-negotiable
requirement throughout**, exactly as it was for the Obsidian plugin.

The Obsidian repo is the reference implementation. Its `src/model`,
`src/layout`, `src/render`, and `src/sync` directories are platform-agnostic
TypeScript (plain DOM/SVG + `d3-flextree`) and are to be **ported nearly
verbatim**; only the platform integration layers (`src/view`, `src/settings`,
`src/main.ts`) are rewritten for VS Code. Its `test/` suite (297 tests) and
benchmark scripts port with the code.

---

## 1. Vision & Goals

- An interactive mind map custom editor inside VS Code that **works like
  XMind**: fast keyboard-driven node creation, organic curved branches,
  per-subtopic coloring, folding with child-count indicators, auto-balance,
  and custom positioning.
- The map **operates directly on `.md` files**: the markdown hierarchy
  reflects the mind map and vice versa (true bidirectional sync). The file
  remains a normal, readable markdown document.
- Links (web URLs, file/folder links, wikilinks) are first-class node content.
- The extension must feel **instant, like a native app**, even on large maps.

### Non-goals (v1)
- Rich per-node styling (fonts, shapes, themes) beyond what the Obsidian
  version has.
- Multi-sheet workbooks, presentation mode, real-time collaboration.

---

## 2. Functional Requirements

Full parity with the Obsidian plugin as shipped (see its README.md):

| # | Requirement |
|---|---|
| R1 | XMind-like UX: shortcuts, visual language, interaction model |
| R2 | `Tab` creates a child; immediately editable |
| R3 | `Enter` creates a sibling after; `Shift+Enter` before |
| R4 | Full shortcut map (§8): navigate, rename, delete, fold, zoom, undo/redo |
| R5 | Links: web URLs, file/folder paths, `[[wikilinks]]`; clickable; `Ctrl/Cmd+K` editor |
| R6 | Works on plain `.md` files; no proprietary format |
| R7 | True bidirectional sync (map ⇄ markdown text, including edits made in the normal text editor side-by-side) |
| R8 | Organic (Bezier) branches |
| R9 | Per-first-level-branch colors, inherited by descendants |
| R10 | Branch width tapers with depth |
| R11 | Balanced auto-layout (left/right of root, anticlockwise document order) |
| R12 | Manual positioning via `Alt`+drag; Rebalance command resets |
| R13 | Folding excludes descendants from layout/render; persisted |
| R14 | Fold badge with hidden-descendant count |
| R15 | Search panel with results list, reveal + focus |
| R16 | Multiple selection; bulk copy/cut/paste; tree copy to OS clipboard as markdown |
| R17 | Node context menu (right-click), incl. "Go to section" in the text editor |
| R18 | Image embeds rendered as fixed-size thumbnails, lazy-loaded via culling |
| R19 | Depth-scaled visual hierarchy (font/box size by depth) |
| R20 | Toggle markdown ⇄ mind map on the same editor tab (`Ctrl/Cmd+M` equivalent, re-using VS Code's "Reopen Editor With…" mechanism) |

### Non-functional
- **N1 Performance** — §3 budgets, identical to the Obsidian plugin.
- **N2 Data safety** — the md file is source of truth; content the extension
  doesn't understand round-trips untouched.
- **N3 Markdown friendliness** — metadata unobtrusive (frontmatter block,
  block-ids only where needed).
- **N4 VS Code citizenship** — CustomTextEditorProvider API, respect the
  document's undo stack, webview CSP, theme kind (light/dark/high-contrast),
  workspace trust, virtual workspaces where feasible.
- **N5 Extensibility** — styling/layout/rendering behind clean interfaces.

---

## 3. Performance — First-Class Requirement (MANDATORY)

All rules, budgets, and the decision protocol from the Obsidian project carry
over verbatim — see `CLAUDE.md` in this repo. Summary of what's binding:

1. Performance is a hard constraint equal to correctness.
2. Prefer incremental/O(changed) over full recomputation; think about
   1,000+ node maps before implementing anything.
3. **Decision protocol:** any performance-vs-anything trade-off must be
   surfaced as an explicit question to the user — never decided silently.
4. No new dependency without a bundle-size/runtime-cost statement and
   approval if non-trivial (> ~50 KB min+gzip or any per-frame overhead).
5. Run benchmarks after every milestone; report against budgets before
   moving on.
6. No architectural choices that block later optimization.

### 3.1 Budgets (identical to Obsidian plugin)

| Metric | Target | Hard ceiling |
|---|---|---|
| Keystroke → node text update | < 16 ms (1 frame) | 33 ms |
| Tab/Enter → new node visible & editable | < 50 ms | 100 ms |
| Fold/unfold + rebalance start | < 50 ms | 100 ms |
| Pan/zoom frame rate | 60 fps | 30 fps |
| Open 500-node map | < 300 ms | 700 ms |
| Open 2,000-node map | < 1 s | 2 s |
| Full relayout of 2,000 nodes (compute) | < 100 ms | 250 ms |
| Md write-back after node edit | < 50 ms, debounced | — |
| Idle CPU (map open, no interaction) | ~0% | — |
| Memory, 2,000-node map (above baseline) | < 150 MB | 300 MB |
| Extension bundle size | < 500 KB | 1 MB |

Fixtures: 100 / 500 / 2,000 / 5,000 nodes (5,000 = stress test — graceful
degradation, never a freeze). Port `scripts/generate-fixtures.mjs` from the
Obsidian repo.

### 3.2 VS Code–specific performance constraint (NEW — critical)

The webview and the extension host are **separate processes** communicating
via async `postMessage`. This creates one hard architectural rule:

> **The entire interaction loop — model, layout, render, keyboard handling —
> lives inside the webview.** The extension host is only the persistence
> layer (TextDocument reads/writes). No interaction may block on a
> host round-trip. Keystroke → screen must never cross the process boundary.

Document write-back is debounced `WorkspaceEdit`s from batched serialized
text; external-edit reconciliation flows host → webview as (ideally) diffs.

### 3.3 Known trade-off points to expect (ask the user when reached)

The eight from the Obsidian plan (SVG vs Canvas, animation richness, sync
granularity, taper fidelity, round-trip fidelity, libraries, undo depth,
watch frequency) **plus** VS Code-specific ones:

9. **Undo/redo integration** — VS Code's document undo stack vs the webview's
   own command stack (they can fight; a keybinding-scoped webview stack is
   the likely answer, but surface it).
10. **Full-document `WorkspaceEdit` vs minimal range edits** on write-back —
    dirty-diff cost vs edit granularity (affects the text editor's viewport
    and decorations when both views are open).
11. **Webview retainContextWhenHidden** — memory cost vs re-open latency.

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Extension host (Node)                                        │
│  extension.ts — activation, commands, configuration          │
│  MindMapEditorProvider (CustomTextEditorProvider for *.md)   │
│   - owns TextDocument ⇄ webview message bridge               │
│   - applies debounced WorkspaceEdits (map → md)              │
│   - forwards onDidChangeTextDocument (md → map), suppressing │
│     self-writes via content comparison                       │
│   - resolves image URIs to webview-safe URIs                 │
└───────────────▲──────────────────────────────────────────────┘
                │ postMessage (async, batched)
┌───────────────▼──────────────────────────────────────────────┐
│ Webview (browser context) — the ENTIRE interaction loop      │
│  Controller — selection, dispatch, undo/redo, clipboard      │
│  Model — MindNode tree, byId index, subtree counts           │
│  LayoutEngine — d3-flextree, partial relayout, L/R balance   │
│  SvgRenderer — dirty-tracked, viewport-culled, rAF-batched   │
│  Sync (parser/serializer/reconcile/metadata) — runs in the   │
│    webview so serialization never blocks the host            │
│  UI — InlineEditor, SearchPanel, LinkModal, context menu     │
└──────────────────────────────────────────────────────────────┘
```

**Port map from the Obsidian repo (`src/…` → this repo):**

| Obsidian source | Destination | Change required |
|---|---|---|
| `model/*` (types, mutations, commandStack, visibility, search, links, textWrap, id) | `webview/model/*` | none (platform-free) |
| `layout/*` (layoutEngine, sides) | `webview/layout/*` | none |
| `render/*` (SvgRenderer, colors, navigation) | `webview/render/*` | none except link-click and image-resolve callbacks (already injected interfaces) |
| `sync/*` (parser, serializer, reconcile, metadata, debounce, parseExternalPaste, goToSection) | `webview/sync/*` | none for parse/serialize; goToSection retargets a VS Code text editor via a host message |
| `controller/Controller.ts` | `webview/controller/` | clipboard + link-open calls become host messages |
| `view/MindMapView.ts` (TextFileView) | **rewritten**: `src/MindMapEditorProvider.ts` (host) + `webview/main.ts` (bootstrap) | the real porting work |
| `view/InlineEditor.ts`, `SearchPanel.ts`, `LinkModal.ts` | `webview/ui/*` | minor (no Obsidian Modal class — plain DOM overlay) |
| `settings/*` | `contributes.configuration` + host→webview config message | rewritten (thin) |
| `main.ts` | `src/extension.ts` | rewritten (thin) |
| `test/*` (297 tests) | `test/*` | port with import-path changes; Obsidian-API-touching tests get VS Code-shaped fakes |
| `scripts/*` (fixtures + 3 bench scripts) | `scripts/*` | none |
| `styles.css` | `media/mindmap.css` | swap Obsidian CSS vars for `--vscode-*` theme vars |

**Key principles (unchanged):** model is the runtime source of truth; the md
text is the persistent source of truth; unidirectional update flow; everything
incremental.

---

## 5. Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) | same as reference |
| Build | esbuild — two bundles: `dist/extension.js` (host, CJS) and `media/webview.js` (browser, IIFE) | fast; small; mirrors reference |
| Editor surface | `CustomTextEditorProvider` (`viewType: mindmapView.editor`), registered for `*.md` with `priority: option` | the VS Code-idiomatic equivalent of Obsidian's TextFileView; "Reopen With…" gives the md ⇄ map toggle for free |
| Rendering | SVG (ported hand-rolled renderer) | proven within budgets in the reference |
| Layout | `d3-flextree` (only module) | same as reference; ~10 KB |
| Md parsing | ported custom line-based parser | proven round-trip fidelity |
| Persistence | `TextDocument` + `WorkspaceEdit` (never `fs` directly) | correctness with VS Code's dirty/undo/save model |
| Testing | Vitest (ported suite + benches); `@vscode/test-electron` later for smoke tests | reference suite carries the correctness burden |
| Packaging | `vsce` | standard |

No other runtime dependencies without the rule-4 cost statement.

---

## 6. Markdown ⇄ Mind Map Sync (differences from reference only)

Mapping strategy, metadata frontmatter block (`mindmap:` keyed by `^block-id`),
content preservation, and the debounced write-back design are **identical** to
the reference — port them. Differences:

- **Map → md:** webview serializes (O(n), proven <1 ms at 5k nodes) and posts
  the text; host applies a `WorkspaceEdit`. Default debounce 400 ms
  (configurable). Whether the edit is full-document replace or minimal ranges
  is trade-off #10 — start with full replace, measure, ask if it matters.
- **Md → map:** host listens to `onDidChangeTextDocument`, suppresses
  self-writes by content comparison (same policy as reference — see its
  DECISIONS.md), forwards external changes to the webview, which re-parses
  and reconciles by block-id then structural position (ported code).
- **Save semantics:** VS Code owns dirty state and save; the extension never
  writes the file directly. `revert`/`backup` hooks follow the
  CustomTextEditor contract.
- **Conflict policy:** keep local + notify (same as reference).

---

## 7. Keyboard Shortcuts

Same map as the reference README. Implementation notes:

- Keys are handled **inside the webview** (synchronous, no host round-trip).
- VS Code intercepts some chords before webviews (`Ctrl/Cmd+Z`, `Ctrl/Cmd+K`
  is a chord prefix, `Ctrl/Cmd+M`); these need `contributes.keybindings`
  with `when: activeCustomEditorId == 'mindmapView.editor'` forwarding a
  message to the webview. Enumerate and test each early (M2), not at the end.
- `Ctrl/Cmd+M` toggle ⇒ command that calls `vscode.openWith` to swap between
  the default text editor and the mind map on the same tab.

---

## 8. Rendering & Layout

Identical to the reference (organic Bezier taper, per-branch palette,
anticlockwise document-order balancing, fold badges from cached subtree
counts, viewport culling above 300 nodes, dirty tracking, single root
transform for pan/zoom, animation auto-disable threshold). Two adaptations:

- **Theming:** colors derive from `--vscode-*` CSS variables; listen for
  theme-change messages; palette must pass on light, dark, and high-contrast.
- **Images (R18):** webviews can't load arbitrary `file://` URIs — the host
  must convert to webview URIs (`webview.asWebviewUri`) with
  `localResourceRoots` covering the workspace. The renderer's existing
  injected image-resolver interface absorbs this; resolution becomes async
  (message round-trip) but only for culled-in nodes, preserving the reference
  lazy-load design.

---

## 9. Implementation Roadmap

> After **every** milestone: run ported benchmarks on 100/500/2,000-node
> fixtures, log to `benchmarks.md`, report against budgets before proceeding.
> Surface every §3.3 trade-off as a question — do not decide.

**M0 — Scaffold & port of the platform-free core**
Extension skeleton (`package.json` manifest, esbuild dual-bundle config,
activation, empty CustomTextEditorProvider that shows a webview). Port
`model/`, `layout/`, `render/`, `sync/`, `controller/` and their tests
verbatim; port fixture generator + bench scripts; `npm test` green,
`bench:m1`/`bench:m2` numbers logged as the baseline.
*Exit:* ported suite passes; benches match reference numbers.

**M1 — Read-only map in the webview**
Webview bootstrap (CSP, nonce, theme CSS), host sends document text on
resolve, webview parses + lays out + renders; pan/zoom; selection.
*Exit:* 2k-node file opens within budget inside a real VS Code window.

**M2 — Editing + bidirectional sync + keybinding plumbing**
Inline editor, Tab/Enter/F2/Delete/arrows, undo/redo (trade-off #9 → ask),
debounced write-back via WorkspaceEdit, self-write suppression, external-edit
reconciliation (edit md side-by-side in a split → map updates). All
intercepted chords wired through `contributes.keybindings`.
*Exit:* keystroke/creation latency within budget; round-trip loses nothing;
split-view editing works both directions.

**M3 — Full feature parity**
Folding + badges + persistence, links + `Ctrl/Cmd+K` + click-to-open
(`vscode.env.openExternal` / `vscode.open`), manual positioning + Rebalance,
drag-reorder, search panel, context menu + "Go to section", multi-select +
clipboard (bulk + OS tree copy + external-paste parsing), depth-scaled
visuals, `Ctrl/Cmd+M` toggle.
*Exit:* feature checklist vs reference README all green; benches stable.

**M4 — Images, theming polish, settings**
Image thumbs via asWebviewUri with lazy resolution, `bench:images` ported and
run; light/dark/high-contrast pass; `contributes.configuration` (layout mode,
heading depth, write-back delay, animation cutoff) with live config updates.

**M5 — Hardening & release readiness**
5k stress test in a real window, webview lifecycle (dispose/restore,
retainContextWhenHidden decision → ask), workspace-trust/virtual-workspace
declarations, README, CHANGELOG, `vsce package` (bundle-size check vs budget),
marketplace submission checklist.

---

## 10. Testing Strategy

- Ported Vitest suite is the correctness backbone (297 tests, jsdom).
- New unit tests for: host⇄webview message protocol (fake `vscode` API),
  WorkspaceEdit write-back + self-write suppression, URI resolution.
- Benchmarks per milestone → `benchmarks.md` (same regression rule: >20%
  worsening is flagged and discussed before merging).
- Manual QA: real VS Code window (Extension Development Host, F5) — the
  authoritative check for paint/frame-rate, exactly as the dev-vault was for
  Obsidian. jsdom numbers don't paint; say so when reporting.

---

## 11. Risks & Edge Cases

| Risk | Mitigation |
|---|---|
| VS Code steals keybindings from the webview | Enumerate + wire via `contributes.keybindings` in M2; test each on macOS/Win/Linux keymaps |
| Undo stack fights between document and webview | Trade-off #9 — decided by the user in M2, not improvised |
| Webview reload loses map state (tab hidden) | `getState`/`setState` for viewport + selection; model re-derives from document; retainContextWhenHidden is trade-off #11 |
| Both views (text + map) open on the same doc | This is the primary sync test case, not an edge case — M2 exit criterion |
| CSP blocks images/fonts | asWebviewUri + localResourceRoots from day one; no inline-src exceptions |
| Large doc edits flood onDidChangeTextDocument | Debounce + version-gate reconciliation (ported design already handles this) |
| Marketplace bundle bloat | esbuild, no D3 beyond flextree, budget check in M5 |

---

## 12. Reference Materials

- Reference implementation: `/Users/burakucbinli/projects/obsidian`
  (read its `CLAUDE.md`, `DECISIONS.md`, `benchmarks.md` before porting each
  area — decisions there were user-approved and carry over unless the
  platform forces a difference).
- VS Code API: CustomTextEditorProvider guide, webview guide (CSP, asWebviewUri,
  state persistence), `contributes.keybindings`/`when` clauses.

---

*Performance rules override any conflicting guidance elsewhere in this plan.
When in doubt between performance and anything else: ask the user.*
