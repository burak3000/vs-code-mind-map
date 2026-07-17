# Progress — VS Code Mind Map Extension

Working status of the port from the Obsidian plugin
(`/Users/burakucbinli/projects/obsidian`) to a VS Code extension.
The full plan is [vscode-mindmap-extension-plan.md](vscode-mindmap-extension-plan.md);
mandatory performance rules and budgets are in [CLAUDE.md](CLAUDE.md).
Implementation is done by a Sonnet 5 agent, milestone by milestone, with a
review gate after each milestone; performance trade-offs are decided by the
user, never by the agent (rule 3).

_Last updated: 2026-07-17 (M3 completed — both design forks resolved by the user; benchmarks re-run clean on an idle window, all within budget)._

## Milestone status

| Milestone | Scope (plan §9) | Status |
|---|---|---|
| M0 | Scaffold + verbatim port of platform-free core, tests, fixtures, benches | **Done** |
| M1 | Read-only map in the webview (bootstrap, document bridge, pan/zoom, selection) | **Done** |
| M2 | Editing + bidirectional sync + keybinding plumbing | **Done** |
| M3 | Full feature parity (folding, links, manual positioning, search, context menu, multi-select/clipboard, Ctrl/Cmd+M toggle) | **Done** (both escalations resolved; benchmarks re-run clean on an idle window, all within budget) |
| M4 | Images (display **+ clipboard image paste, moved from M3**), VS Code theming (`--vscode-*` vars), settings (`contributes.configuration`) | Pending |
| M5 | Hardening (5k stress, webview lifecycle, workspace trust), packaging (`vsce`), release readiness | Pending |

## M0 — done

- Platform-free core (`model/`, `layout/`, `render/`, `sync/`, `Controller`)
  ported **byte-identical** (verified with `diff -r`); only import paths and
  script path strings changed elsewhere.
- Tests: 276 passed / 2 skipped (InlineEditor, SearchPanel — resolved in M1)
  / 0 failed.
- Benchmarks (`bench:m1`, `bench:m2`): all fixtures within budget; numbers
  ~1.5–2× the reference repo's for byte-identical code — attributed to
  machine/JIT variance, not a regression.
- Bundles: `dist/extension.js` 2.8 KB; webview placeholder 154 B.
- Commits `b95c72d`…`76f052d`.

## M1 — done

- Webview bootstrap (CSP + nonce), host→webview document flow with
  version-gating; external edits forwarded behind a 300 ms trailing-edge
  debounce (provisional default; becomes a setting in M4).
- Pan/zoom + click/Ctrl/Shift selection wired from the ported
  renderer/controller, untouched.
- `InlineEditor`/`SearchPanel` ported to `webview/ui/`; suite fully green:
  **302 passed / 0 skipped / 0 failed**. `LinkModal` is genuinely
  Obsidian-coupled (extends `Modal`) → plain-DOM rewrite deferred to M3 as
  planned.
- New `bench:open` (jsdom): 2,000 nodes build in **17.1 ms** (budget
  1,000 ms); 5,000 nodes 32.5 ms, no freeze. Mount cost drops above the
  300-node culling threshold — the ported design working as intended.
- Bundles: extension 3.0 KB; webview **45.6 KB raw / 14.4 KB gzip**
  (full core + d3-flextree) — ~10% of the 500 KB budget.
- Commits `457ae6f`, `6026ca3`, `872fb0a`.

## M2 — done

Resumed (2026-07-16) after the paused session referenced in the previous
revision of this file — the undo/redo trade-off recorded there was
user-reconfirmed at the start of this session (see DECISIONS.md's M2
undo/redo entry) since it had never been written to the authoritative
decision log, only summarized here.

Delivered, in `webview/main.ts` + `src/MindMapEditorProvider.ts`:
- Inline editing: F2/double-click open the ported `InlineEditor`;
  Tab/Enter/Shift+Enter create + immediately edit; Escape while editing
  cancels (InlineEditor's own key handling, untouched).
- Keyboard (M2 subset only — Mod+F/K/C/X/V, fold, manual-position keys are
  M3): Tab, Enter/Shift+Enter, F2/Space, Delete/Backspace, Escape
  (collapse selection), arrow navigation.
- Undo/redo: webview-local `CommandStack` (ported, unchanged); Ctrl/Cmd+Z,
  Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y captured via new `contributes.keybindings`
  (`when: activeCustomEditorId == 'mindmapView.editor'`), routed through
  two new commands (`mindmapView.undo`/`redo`) that post a `command`
  message to whichever registered webview panel is currently active.
- Write-back: 400 ms debounce **in the webview** (not the host), full-
  document-replace `WorkspaceEdit` (trade-off #10 — kept at "start with
  full replace," not revisited; `bench:m2` serialize numbers are <1.1 ms
  even at 5,000 nodes, nowhere near making minimal ranges necessary yet).
- Self-write suppression: host compares `onDidChangeTextDocument`'s
  resulting text against the text it just applied itself, not a
  synchronous flag (rejected — `applyEdit` crosses the extension-host/
  renderer boundary, so there's no reliable call-stack window to bracket).
- External-edit-vs-pending-local-write conflict: ported N2 policy
  ("never silently drop either side") — keeps local state, lets the
  already-scheduled write proceed, and surfaces a `showWarning` message
  the host turns into `vscode.window.showWarningMessage`.
- Tests: **313 passed / 0 skipped** (26 files) — 11 new in
  `webviewBootstrap.test.ts`, 5 new in `mindMapEditorProvider.test.ts`
  (a fake `vscode` module via `vi.mock`, since `vscode` isn't an
  installed package — per the plan's own testing-strategy note).
- Benchmarks: `bench:m1`/`bench:m2`/`bench:open` unchanged from M1 within
  noise (no ported core file touched — verified). Bundles: extension
  3.7 KB, webview **53.2 KB raw / 16.7 KB gzip** (~11.6% of the 500 KB
  budget) — see `benchmarks.md`'s M2 section for the full numbers and the
  real-VS-Code-window checklist (unverified in this headless environment,
  as always).
- A known, documented (not silently accepted) data-safety limitation: an
  external edit landing *inside* the webview's own 400 ms debounce window,
  before its `pendingWrite` diff becomes observable, still loses to the
  next local write-back (last-local-write-wins) — same race the reference
  plugin accepts, not a new gap; see DECISIONS.md's write-back entry.

## M3 — done, with 2 escalations

Delivered, in `webview/main.ts`, new `webview/ui/{LinkModal,ContextMenu}.ts`,
`src/MindMapEditorProvider.ts`, `src/extension.ts` (unchanged — all new
commands register inside `MindMapEditorProvider.register()`), `package.json`,
`media/mindmap.css`, and (new) `.vscode/{launch.json,tasks.json}`:

- **Folding (R13/R14):** fold badge click and Ctrl/Cmd+/ (routed as a
  `toggleFold` command, since VS Code intercepts that chord) both call
  `Controller.toggleFold`; fold state persists via the ported
  serializer/metadata, unchanged.
- **Manual positioning (R12):** Alt+drag -> `setManualPosition`; resize-handle
  drag -> `setManualWidth`; both persist as frontmatter `pos:`/`width:`
  metadata. "Rebalance" (Ctrl/Cmd+Shift+B, routed as a command) ->
  `Controller.rebalance()`.
- **Drag-reorder + Alt+Up/Down:** plain drag-drop -> `Controller.moveNode`
  (nest or same-level reorder, banded by drop position); Alt+Up/Down ->
  `moveSelectedInSiblingOrder` — both handled directly in the webview's own
  keydown/pointer handlers (VS Code doesn't intercept these chords).
- **Depth-scaled visuals (R19):** verified as already active, no-op to add —
  it's baked into the ported `SvgRenderer`'s `upsertNode`/`renderNodeText`,
  independent of M3's wiring.
- **Links (R5):** link/image clicks post `{type:"openLink", kind, target}`;
  the host opens a scheme-qualified URL via `vscode.env.openExternal`,
  anything else via `vscode.open` resolved relative to the document's own
  directory (see DECISIONS.md — no vault-wide link index exists here, a
  known parity gap vs. Obsidian's `openLinkText`). Ctrl/Cmd+K (routed as a
  command) opens the link editor.
- **LinkModal (the one genuine rewrite):** `webview/ui/LinkModal.ts`, a
  plain centered DOM overlay (display text / link type / target / Remove
  + Save), using the ported `getSoleLink`/`buildLinkText`. New test file
  `test/linkModal.test.ts` (8 tests).
- **Search (R15):** `SearchPanel` (already ported) wired via Ctrl/Cmd+F
  (routed as a command); `onSelect` -> `revealAndSelect` +
  `centerOnWorldPoint` (both ported, unchanged).
- **Context menu (R17):** new `webview/ui/ContextMenu.ts` (plain DOM overlay,
  since there's no VS Code webview equivalent of Obsidian's native `Menu`
  for custom items) with the full reference item set (Go to note section,
  Edit, Add child/sibling, Edit link, Fold/Unfold, Copy/Cut/Paste, Copy
  subtree as markdown, Delete). New test file `test/contextMenu.test.ts`
  (6 tests).
- **Multi-select clipboard (R16):** Ctrl/Cmd+C/X (`copySelected`/
  `cutSelected` + OS-clipboard markdown export) and Ctrl/Cmd+V (OS-clipboard
  text vs. internal-clipboard disambiguation, `parseExternalPaste` for
  external content) — **text-only**; clipboard *image* paste is deferred to
  M4 (user-decided — see below).
- **"Go to note section" (R17):** the webview resolves the target
  (three-tier `resolveGoToTarget` + a line-number lookup for the blockid/
  heading cases), flushes the pending write, and posts `{type:"goToSection",
  line}`; the host opens the document as a text editor **in the column
  beside** the map at that line (user-decided reveal semantics — see below
  and DECISIONS.md), leaving the map tab open and untouched.
- **Ctrl/Cmd+M toggle (R20):** two commands/keybindings with complementary
  `when` clauses (`activeCustomEditorId == 'mindmapView.editor'` vs.
  `editorTextFocus && editorLangId == 'markdown'`). Going to markdown
  flushes the webview's pending debounced write first via a
  `flushWrite`/`flushAck` message round trip (no arbitrary timeout — see
  DECISIONS.md) before `vscode.commands.executeCommand('vscode.openWith', …)`.
- **A real bug found and fixed** (webview/main.ts only, ported core
  untouched): folding/manually-positioning/resizing a node for the first
  time mints it a fresh persistent id (`ensurePersistentIds`), which could
  silently desync the renderer's DOM and the controller's own selection —
  concretely, folding a node and then immediately clicking its own badge
  again to unfold could silently no-op. Fixed via a new
  `reconcilePersistentIds()` in `onChange()` — see DECISIONS.md's dated
  entry for the full root-cause writeup and why it wasn't a ported-core
  change. Regression-tested (the new fold-toggle-twice tests fail without
  the fix, confirmed before applying it).
- **`.vscode/launch.json`/`tasks.json` added** (previously missing — F5 was
  not possible at all). No automatic pre-launch build task wired
  (DECISIONS.md explains why); run `npm run build` or `npm run dev` first.
- **Keybinding enumeration:** six chords total route through
  `contributes.keybindings` -> command -> `postMessage` (Ctrl/Cmd+Z/
  Shift+Z/Y from M2, plus M3's Ctrl/Cmd+F, K, Shift+B, /, and the two-
  direction M chord) — full list and reasoning in DECISIONS.md and the M3
  completion report.
- **Both design forks resolved by the user (see below):** "Go to note
  section" opens beside; clipboard-image paste is deferred to M4.
- Tests: **348 passed / 0 skipped** (28 files) — 313 carried over
  unchanged, 35 new (12 in `webviewBootstrap.test.ts`'s new M3 describe
  block, 9 in `mindMapEditorProvider.test.ts` incl. the goToSection
  beside-column reveal + out-of-range clamp, 8 in `test/linkModal.test.ts`,
  6 in `test/contextMenu.test.ts`). `npm run build` clean (both tsconfigs).
  Ported core (`webview/{model,layout,render,sync,controller}`) reconfirmed
  byte-identical to the reference via `diff -rq` — zero diffs.
- Bundles: extension 5.4 KB / 2.5 KB gzip; webview 66.6 KB / 20.0 KB gzip —
  combined ~14.8% of the 500 KB budget, no new dependency.
- Benchmarks: the first run was contaminated by heavy machine load
  (load average ~1.7–6.5; the test suite ran ~33s vs. a normal ~2.5s) and
  produced inflated numbers that were NOT recorded as authoritative. A
  **clean re-run on an idle window (2026-07-17; suite back to 2.24s)**
  confirms no regression — every figure is within noise of the M2
  baseline and inside budget (e.g. `bench:m2` Tab 4.0/4.1/10.1/28.1 ms
  across 100/500/2,000/5,000 nodes vs. M2's 4.2/4.2/9.5/28.8; serialize
  ≤0.6 ms at 5k). **M3 budget sign-off: DONE.** Full tables in
  `benchmarks.md`'s M3 section.

## Both escalations — resolved by the user (2026-07-17)

1. **"Go to note section" open semantics → open in a NEW COLUMN BESIDE.**
   `MindMapEditorProvider.goToSection(document, line)` now calls
   `vscode.window.showTextDocument(document, { viewColumn:
   vscode.ViewColumn.Beside, selection: <range at the target line> })`
   (replacing the earlier info-message stub). The map tab stays open and
   untouched. Coexists cleanly with `supportsMultipleEditorsPerDocument:
   false` (that only forbids two *custom* editors on one doc, not a custom
   editor + a text editor — the same coexistence M2's split-view sync
   already uses). Host-side tested (beside-column + target-line reveal,
   plus an out-of-range clamp). See DECISIONS.md.
2. **Clipboard image paste scope → DEFERRED TO M4.** Text-only paste
   ships in M3 as-is; the reference's `pasteClipboardImage` (write an
   OS-clipboard image into the workspace, insert an embed) is not
   implemented and moves to M4, where it shares its plumbing (attachment
   path resolution, `asWebviewUri`) with M4's image-*display* work — so
   it isn't built twice. No image-save path was added in M3. See
   DECISIONS.md; tracked in M4's row above.

## Decisions taken so far

| Decision | Outcome | Where |
|---|---|---|
| Undo/redo integration (plan trade-off #9) | **User decided:** webview-local command stack (ported reference `commandStack`, 100-edit cap); Ctrl/Cmd+Z routed via scoped keybindings; document undo stack left alone | M2; DECISIONS.md |
| Write-back edit granularity (plan trade-off #10) | Plan's own default followed, not re-litigated: full-document replace; measured (`bench:m2` serialize <1.1 ms at 5k nodes) — nowhere near mattering yet | M2; DECISIONS.md |
| InlineEditor/SearchPanel port timing | Coordinator decided (not a perf trade-off): port in M1, re-enable tests | M1 |
| External-edit forward debounce 300 ms | Provisional default, kept; becomes a setting in M4 | M1 |
| `retainContextWhenHidden` (trade-off #11) | Stays `false`; ready-handshake makes hidden→reveal self-healing; memory-vs-latency question parked for M5 | M1 |
| Reference-repo decisions (rendering, layout, parser, culling, image thumbs, anticlockwise ordering, conflict policy, …) | Carry over without re-litigating (user approved them there) | CLAUDE.md |
| LinkModal / node context menu | Rewritten as plain DOM overlays (no VS Code equivalent of Obsidian's `Modal`/`Menu`) — same conventions as `InlineEditor`/`SearchPanel` | M3; DECISIONS.md |
| Links (R5) open path | Host message -> scheme match -> `openExternal`, else workspace-relative -> `vscode.open`; no vault-wide link index (parity gap vs. Obsidian, noted not silently matched) | M3; DECISIONS.md |
| Ctrl/Cmd+M flush mechanism | `flushWrite`/`flushAck` message pair + awaiting the specific write's promise — no arbitrary timeout | M3; DECISIONS.md |
| `ensurePersistentIds` id-mint bug | Found + fixed in `webview/main.ts` only (`reconcilePersistentIds`); not escalated (plain correctness fix, no perf trade-off) but flagged as its own dated entry since it's a bug in previously "verified" ported-adjacent behavior | M3; DECISIONS.md |
| `.vscode/launch.json`/`tasks.json` | Added; no auto pre-launch build task (risk of a broken F5 outweighed the convenience — see DECISIONS.md) | M3; DECISIONS.md |
| "Go to note section" open semantics | **User decided:** open the document as a text editor in the column beside the map at the target line; map tab stays open | M3; DECISIONS.md |
| Clipboard image paste scope (M3 vs. M4) | **User decided:** defer to M4 (shares plumbing with M4 image display); M3 ships text-only paste | M3→M4; DECISIONS.md |

## Open decisions expected ahead

- Write-back edit granularity (full replace vs minimal ranges, trade-off
  #10) — measured in M2, not budget-relevant; only revisit if a real
  split-view window (M2/M5 human check) shows the text editor's
  viewport/decorations misbehaving on every map edit.
- `retainContextWhenHidden` final call (M5).
- Any SVG-limit / animation-threshold questions if the 5k stress test in a
  real window (M5) surfaces them.
- (M3's two escalations are now resolved — see the resolved-escalations
  section above; the idle-machine benchmark re-run is done and M3's budget
  sign-off is complete.)
- Clipboard image paste (moved from M3 into M4 by user decision).

## Remaining for human (accumulating)

Everything measured so far is jsdom/headless/vi.mock — no pixels painted,
no real process-boundary `postMessage`, no real Extension Development
Host keybinding interception. `benchmarks.md` keeps the authoritative F5
checklist, now including M2's: open `fixtures/2000-nodes.md` via Reopen
With → Mind Map in an Extension Development Host, check open latency,
60 fps pan/zoom, Tab/Enter/F2/Delete/arrows/Escape feel instant, Ctrl/
Cmd+Z/Shift+Z/Y actually reach the mind map (not VS Code's own no-op
undo), split-view edit propagation both directions, the external-edit-
during-pending-write warning notice, 5k graceful degradation. The map
renders unthemed until M4's `--vscode-*` variable swap (functional, not
pretty, by design). M3 adds its own checklist in `benchmarks.md`'s M3
section (folding-twice, drag interactions, links, search, context menu,
clipboard, Ctrl/Cmd+M both directions). The headless benchmark sign-off
is complete (clean idle-window re-run, all within budget — see
`benchmarks.md`); the F5 real-window pass remains the one
paint/frame-rate check no headless run can substitute for.
