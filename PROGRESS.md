# Progress — VS Code Mind Map Extension

Working status of the port from the Obsidian plugin
(`/Users/burakucbinli/projects/obsidian`) to a VS Code extension.
The full plan is [vscode-mindmap-extension-plan.md](vscode-mindmap-extension-plan.md);
mandatory performance rules and budgets are in [CLAUDE.md](CLAUDE.md).
Implementation is done by a Sonnet 5 agent, milestone by milestone, with a
review gate after each milestone; performance trade-offs are decided by the
user, never by the agent (rule 3).

_Last updated: 2026-07-20 (Phase C of the post-M5 catch-up completed — node relations fully wired to VS Code UI/host, including the redesigned relation/link modal with a native-QuickPick-driven target picker, the one piece the user steered on; see PROGRESS.md's dated Phase C section and DECISIONS.md's two dated Phase C entries)._

## Milestone status

| Milestone | Scope (plan §9) | Status |
|---|---|---|
| M0 | Scaffold + verbatim port of platform-free core, tests, fixtures, benches | **Done** |
| M1 | Read-only map in the webview (bootstrap, document bridge, pan/zoom, selection) | **Done** |
| M2 | Editing + bidirectional sync + keybinding plumbing | **Done** |
| M3 | Full feature parity (folding, links, manual positioning, search, context menu, multi-select/clipboard, Ctrl/Cmd+M toggle) | **Done** (both escalations resolved; benchmarks re-run clean on an idle window, all within budget) |
| M4 | Images (display **+ clipboard image paste, moved from M3**), VS Code theming (`--vscode-*` vars), settings (`contributes.configuration`) | **Done** (one escalation — pasted-image save location — resolved by the user; benchmarks clean on an idle window, all within budget) |
| M5 | Hardening (5k stress, webview lifecycle, workspace trust), packaging (`vsce`), release readiness | **Done** — both escalations decided by the user (`retainContextWhenHidden` `false`; authorized additive `SvgRenderer` viewport pair); real-window F5 pass remains the human gate (consolidated in `benchmarks.md`) |

## Post-M5: catching up to reference-plugin feature work

After M5, the user reported adding substantial new features to the
reference Obsidian plugin (node relations, status badges) plus several bug
fixes, all after this repo's M0 port point. This is a new, unplanned body
of work (not in the original plan's §9 roadmap), broken into phases the
same way the milestones were:

| Phase | Scope | Status |
|---|---|---|
| A | Re-sync the platform-free core (`model/layout/render/sync/controller` + `webview/ui/InlineEditor.ts`) to the reference's current state; port new/updated tests; keep the build green with new features dormant | **Done** |
| B | Status badges: VS Code wiring (keyboard shortcuts, context-menu items, click handlers) | **Done** |
| C | Node relations: VS Code wiring (redesigned relation modal/combobox, cross-document host-side file reader, `showRelations` setting, styles, external-link-opening fix, center-into-view UX fixes) | **Done** — the one escalation (QuickPick vs. plain-DOM combobox) was resolved by the user (QuickPick) and built; see below |
| D | Docs (XMind-trademark scrub, README/CHANGELOG updates), re-benchmark with features live, re-package | Pending |

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

## M4 — done

Built by the M4 Sonnet agent, which completed the bulk (theming, settings,
image display, clipboard-paste plumbing) then hit the account session limit
mid-writeup; the coordinator finished the remaining piece (the pasted-image
write path, once the user decided the save location), the doc updates, and
the clean-window benchmark run.

- **Theming (R-theming):** `media/mindmap.css` now references only
  `--vscode-*` theme variables (VS Code injects them + a theme body class
  and live-updates both on a theme switch, so no code/message channel was
  needed). The 8 per-branch color slots map to `--vscode-charts-*` /
  `--vscode-terminal-ansi*` — **high-contrast passes by construction**
  (see DECISIONS.md); the one human-eyeball item left is per-theme hue
  *identity*, which now varies with each theme's chart colors.
- **Settings (`contributes.configuration`):** five settings —
  `writeDebounceMs`, `externalEditForwardDebounceMs` (both live),
  `animationNodeThreshold`/`headingDepth`/`layoutMode` (next-open, a
  deliberate per-setting split, see DECISIONS.md), and the new
  `pastedImageFolder`. Host reads resource-scoped config, posts on resolve
  and on `onDidChangeConfiguration`.
- **Images (R18):** `setImageResolver` wired as an async host round trip
  (webview posts `resolveImage` for a culled-in node → host resolves
  relative to the doc dir, `asWebviewUri`, posts back) — viewport-bounded,
  off the keystroke path, preserving the lazy-load design.
  `localResourceRoots` widened beyond `media/` to the workspace folder(s)
  + the document's dir (noted in DECISIONS.md).
- **Clipboard image paste (moved from M3):** end-to-end. The one open
  escalation — where pasted images are saved — was **resolved by the
  user**: a `mindmapView.pastedImageFolder` setting, default `""` =
  alongside the document. Host `writeImage` decodes the base64 bytes,
  writes `pasted-image-<timestamp>.<ext>` (hyphenated for clean CommonMark,
  collision-suffixed), creates the folder if needed, and returns a
  `![](relative/path)` embed that round-trips through the same resolver as
  display. Failures fall through to text-paste — never a crash. See
  DECISIONS.md.
- **Tests: 368 passed / 0 skipped** (30 files) — new `theming.test.ts`,
  `webviewConfig.test.ts`, and image-resolve + clipboard-image-write cases
  (default folder, `pastedImageFolder` subfolder, write-failure fallthrough)
  in `mindMapEditorProvider.test.ts`.
- **Benchmarks (clean idle window):** `bench:images` open 51.4ms (budget
  1000ms); `bench:m2`/`bench:open` match the M2/M3 baseline within noise —
  no regression (ported core still byte-identical, `diff -rq` clean).
  Bundle ~15.6% of the 500KB budget, no new dependency. See benchmarks.md.
- **Not committed** — left for the user.

## M5 — done, one escalation

Delivered, in `webview/main.ts`, `package.json`, and new top-level files
(`README.md`, `CHANGELOG.md`, `LICENSE`, `RELEASING.md`, `.vscodeignore`):

- **Webview state persistence (plan §11):** `persistState()`/
  `restoreViewState()` in `webview/main.ts` use `vscode.setState`/
  `getState` to survive a hidden→revealed reload. Selection is persisted as
  a structural sibling-index path (`pathOf`/`nodeAtPath`, the same walk
  `sync/reconcile.ts`'s `findEquivalentNode` already uses for external-edit
  reconciliation) rather than by node id, since a reload re-parses the
  document and mints a fresh random id for any node without persisted
  `^blockid` metadata. The **exact pan/zoom** is persisted and restored via
  a new additive `SvgRenderer.getViewport`/`setViewport` pair (user-
  authorized — see below), independently of selection, so a free pan/zoom
  with nothing selected round-trips too; a new `onViewportGesture()` wired
  to container `pointerup`/`wheel` captures pan/zoom that never emits a
  controller `onChange`. A brand-new open (nothing ever persisted) is
  unaffected.
- **Full pan/zoom fidelity → `SvgRenderer` additive change (USER-AUTHORIZED,
  the one intentional core divergence):** the coordinator/user chose exact
  viewport restore over the byte-identical-port invariant for this one file.
  Two public methods (`getViewport(): Viewport` returning a copy of the
  private `view`; `setViewport(v)` writing the three fields and calling the
  renderer's **own existing** `scheduleApplyViewport`) were added to
  `webview/render/SvgRenderer.ts` — **additive-only, zero deletions**
  (`git diff` = one hunk, no `-` lines; no existing method's behavior
  changes). See the core-integrity note below and DECISIONS.md's dated
  entry (with the exact added code and a maintenance note for future
  reference-repo re-syncs).
- **`retainContextWhenHidden` → stays `false` (user-decided):** no code
  change; the state-persistence work above makes the `false` path
  selection-and-viewport-correct on reveal, turning this into a pure
  bounded-one-time-latency vs. continuous-memory choice, which `false`
  wins. See DECISIONS.md.
- **Workspace trust / virtual workspaces (N4):** `package.json`'s new
  `capabilities` block — `untrustedWorkspaces.supported: true` (nothing
  here executes workspace-sourced code; link clicks are user-initiated and
  read-only, the same trust level VS Code's own Markdown preview already
  operates at) with `mindmapView.pastedImageFolder` listed in
  `restrictedConfigurations` (a malicious untrusted repo's own
  `.vscode/settings.json` could otherwise redirect a user's own paste
  action to write outside the expected folder via path traversal).
  `virtualWorkspaces.supported: "limited"` — opening/editing the map is
  scheme-agnostic and works over any workspace filesystem, but link-opening,
  image display, and clipboard-image paste all resolve paths via Node's
  `path` module against `document.uri.fsPath` (a real-OS-path assumption)
  and may misbehave over a genuinely virtual filesystem. See DECISIONS.md
  for the full reasoning and the considered (and rejected, as out of scope
  for this milestone) alternative of rewriting those three call sites to be
  URI-aware instead of declaring the honest gap.
- **Packaging:** new `.vscodeignore` (ships only `dist/`, `media/`,
  `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE` — excludes
  `src/`/`webview/` TS sources, `test/`/`scripts/`/`fixtures/`,
  `node_modules/` — esbuild already bundles the one dependency,
  `d3-flextree` — tsconfigs, the lockfile, and every internal design doc
  including `CLAUDE.md`), a new `npm run package` script (`vsce package
  --no-rewrite-relative-links` — the flag works around a `vsce` hard
  failure that occurs with no `repository` field/git remote configured yet,
  see DECISIONS.md). **Packaged successfully** despite the still-placeholder
  publisher id (`vsce package`, unlike `publish`, doesn't validate it) —
  `mindmap-view-0.0.1.vsix` is **~39.7 KB, ~8% of the 500 KB target**.
- **README.md/CHANGELOG.md/LICENSE/RELEASING.md** — new. README covers
  R1–R20 + the clipboard-image-paste feature, the full keyboard shortcut
  table, all six settings, how the sync works, dev/F5 instructions, and
  known limitations (no vault-wide link index, virtual-workspace caveats,
  full-document write-back). CHANGELOG covers M0–M5. RELEASING.md is the
  marketplace submission checklist (publisher id, PAT, `repository`, icon,
  `vsce publish`) — steps for the user to run, none executed here (no `git`
  commit/push/tag or `vsce publish` was run, per the hard rules).
- **Tests: 374 passed / 0 skipped** (31 files) — new
  `test/webviewStatePersistence.test.ts` (6 tests: no persist with nothing
  selected; persist primary+multi-selection as structural paths; restore
  selection across a simulated reload; **round-trip an exact pan/zoom with
  nothing selected** via getViewport/setViewport; restore selection AND a
  changed viewport together; gracefully ignore a path that no longer
  resolves).
- **Benchmarks:** `bench:m1`/`bench:m2`/`bench:open`/`bench:images` all
  re-run, matching the M4 baseline within noise (no regression — the
  additions are O(selection size)/O(1), not O(map size), and the new
  `SvgRenderer` methods aren't on any bench path). Bundle: `dist/
  extension.js` unchanged (7.7 KB, `src/` untouched this milestone);
  `media/webview.js` 72.2 KB (+3.3 KB over M4 for `persistState`/
  `restoreViewState`/`onViewportGesture`/`pathOf`/`nodeAtPath` + the
  `SvgRenderer` pair) — combined still ~16% of the 500 KB budget.
- **Core-integrity check — now ONE known intentional exception (render/):**
  `model/`, `layout/`, `sync/`, `controller/` remain fully byte-identical
  to the reference (`diff -rq`, zero diffs — reconfirmed). `render/` now
  differs by exactly `SvgRenderer.ts`'s additive `getViewport`/`setViewport`
  pair (`diff -u`/`git diff` = additions only, no `-` lines) — the
  user-authorized divergence. The verification going forward is "render/
  differs *only* by that pair," not "clean" (documented in DECISIONS.md's
  dated maintenance note). See `benchmarks.md`'s M5 section for full tables
  and the consolidated real-window F5 checklist (the single human gate).
- **Both M5 escalations resolved by the user** (`retainContextWhenHidden`
  → `false`; full pan/zoom fidelity → additive `SvgRenderer` change,
  implemented). Everything in M5's scope is done; nothing is pending.

## Phase A — done (post-M5 catch-up: core re-sync)

Re-synced the platform-free core to the reference plugin's current state
(it gained node relations, status badges, and bug fixes after this repo's
M0 port point at `0a66f7c`). Full reasoning in DECISIONS.md's dated
"Phase A" entry; summary:

- **Re-synced verbatim:** `model/{types,links,mutations}.ts` + two new
  files `model/{relations,statusBadges}.ts`; `layout/layoutEngine.ts`
  (includes the tall-node-overlap fix); `render/{colors,navigation}.ts`;
  `sync/{metadata,serializer}.ts` + new `sync/foreignRelation.ts`;
  `controller/Controller.ts`. All confirmed `diff -rq` byte-identical to
  reference HEAD, same discipline as every prior milestone. New
  `ForeignVaultReader`/`ForeignVaultWriter` interfaces in
  `foreignRelation.ts` are injected (not Obsidian-coupled) as the plan
  anticipated — no `"obsidian"` import anywhere in the re-synced set.
- **`render/SvgRenderer.ts`:** re-copied from reference HEAD, then the
  authorized `getViewport`/`setViewport` pair re-applied — still additive
  only (26 added, 0 removed vs. reference HEAD). `webview/ui/
  InlineEditor.ts` (ported outside the protected core at M1) went back to
  fully byte-identical — the reference's new `reposition()` method came
  along for free, dormant until wired.
- **Tests:** 479 passed / 0 skipped (36 files, up from 374/30) — new
  `relations.test.ts`, `relationsRenderer.test.ts`, `foreignRelation.test.ts`,
  `statusBadgePersistence.test.ts`, `ensureVisible.test.ts`,
  `test/helpers/{model,render}.ts`; several existing test files updated to
  match upstream changes. No `describe.skip`s needed — every ported test
  is genuinely platform-free.
- **One legitimate upstream behavior change absorbed, not silently
  papered over:** a plain click on a node's link text used to navigate
  immediately; now it selects the node, and Ctrl/Cmd+click is the
  dedicated "open this link" gesture (an intentional upstream fix — the
  old behavior made linked nodes unselectable by clicking). Our own
  `webviewBootstrap.test.ts` asserted the old semantics; fixed to assert
  the new, correct ones, plus a cascading double-click test-timing bug the
  fix surfaced (see DECISIONS.md).
- **New features are dormant by design:** `showRelations` defaults `true`
  in `SvgRenderer`'s constructor, but `webview/main.ts` never calls
  `resolveRelations` or sets a `statusBadge` — no code path in this
  extension creates one yet, so the relations layer stays empty and no
  node shows a status badge regardless of that default. No edits to
  `webview/main.ts`/`src/MindMapEditorProvider.ts` were needed to keep
  compiling — every new parameter these files introduced defaults to the
  value that preserves current behavior.
- **`bench:relations`** ported and added as an npm script; both fixture
  sizes (2,000/200 relations, 5,000/500 relations) comfortably inside the
  open budget. This is a ported-core baseline, not real-usage measurement
  — relations aren't wired to run on every edit until Phase B/C, at which
  point it's flagged for re-measurement, not silently assumed fine.
- Not committed — left for the user, same as every phase so far.

## Phase B — done (post-M5 catch-up: status badges VS Code wiring)

Wired the platform-free status-badge model/renderer support Phase A ported
dormant (no UI set or clicked a badge) to actual VS Code UI — reference
commit `bfd6997`. Full reasoning in DECISIONS.md's dated "Phase B" entry;
summary:

- **Keyboard shortcuts:** Ctrl/Cmd+Shift+D (toggle "Done" directly) and
  Ctrl/Cmd+Shift+I (open the status quick-pick) both routed through
  `contributes.keybindings` + a `command` message (`toggleStatusDone`/
  `statusQuickPick`), the same conservative pattern as every other chord
  VS Code might intercept (Ctrl/Cmd+Z/F/K/Shift+B/`/`) — Shift+D collides
  with VS Code's own "Show Run and Debug" default binding, so this wasn't
  assumed safe as a plain webview keydown. `src/MindMapEditorProvider.ts`
  registers and routes both commands to the active panel, identically to
  `undo`/`redo`/`search`/`rebalance`/`linkEditor`/`toggleFold`.
- **Context menu:** the 6 canonical badges (plus "Clear status" once one is
  set) spliced into `webview/main.ts`'s existing flat item list, each
  checked against the node's current status. Every item that already had a
  keyboard shortcut (Edit, Add child/sibling, Edit link, Fold, Copy/Cut/
  Paste, Delete) now shows it as a muted right-aligned hint — reference
  `bfd6997`'s "context-menu hotkey hints," previously invisible anywhere in
  this UI. `webview/ui/ContextMenu.ts` gained two new optional
  `ContextMenuItem` fields (`checked`, `hint`) to support this — the plain-
  DOM analog of Obsidian's `MenuItem.setChecked()`/`menuItemTitle`.
- **Quick-pick + badge click:** both reuse the same plain-DOM `ContextMenu`
  overlay (positioned at the node's screen rect via the already-additive
  `SvgRenderer.getNodeScreenRect`, not the mouse) rather than a fourth UI
  primitive alongside InlineEditor/SearchPanel/LinkModal/ContextMenu.
  `SvgRenderer.setStatusBadgeClickHandler` (already exposed since Phase A,
  dormant) now opens it.
- **Styling:** `.mm-status-badge*` CSS — never actually ported in Phase A
  (it lived in the reference's `styles.css`, not a re-synced `src/` file)
  — added to `media/mindmap.css`, translated from Obsidian's variables to
  this repo's established `--vscode-*` mapping (green/red/blue -> the same
  `--vscode-charts-*` colors the branch palette already uses; "ready"'s
  cyan reuses the branch palette's `--vscode-terminal-ansiCyan` fallback).
- **No core files touched:** `webview/{model,layout,render,sync,
  controller}` re-confirmed byte-identical to reference HEAD (`SvgRenderer.ts`
  still differs only by the pre-existing, unrelated M5
  `getViewport`/`setViewport` pair — 0 lines changed by this phase).
- **Tests:** 484 passed / 0 skipped (36 files, up from 479) — new "Phase B:
  status badges" describe block in `webviewBootstrap.test.ts` (shortcut ->
  badge set, quick-pick open/checked/select, context-menu item -> badge
  set, click-on-existing-badge -> quick-pick) plus a new
  `mindMapEditorProvider.test.ts` case for the two routed commands. One
  pre-existing test's exact-item-list assertion loosened from raw
  `textContent` to a `.mm-context-menu-item-label`-aware helper (the hint
  text is now part of `textContent`) — same "fix the test to the new,
  correct shape" discipline as Phase A's link-click-semantics fix, not a
  weakened assertion.
- Not committed — left for the user, same as every phase so far.

## Phase C — done (post-M5 catch-up: node relations VS Code wiring)

Wired the platform-free relations support Phase A ported dormant to actual
VS Code UI/host behavior, including the redesigned relation/link modal and
its QuickPick-driven target picker (the one piece originally escalated —
now resolved by the user and built). Reference commits
`4c7d178`/`f58b3c1`/`7578f31`. Full reasoning in DECISIONS.md's two dated
"Phase C" entries; summary:

- **`showRelations` setting:** `contributes.configuration` entry,
  `MindMapWebviewConfig`/`setConfig` extended (not a parallel channel),
  baked into `SvgRenderer`'s constructor at buildFromScratch time — same
  next-open-only treatment as `layoutMode`/`headingDepth`/
  `animationNodeThreshold` (M4 precedent, not re-litigated).
- **Resolving/rendering relations, live:** `resolveRelations` wired into
  `buildFromScratch`/`onChange`/`rebuildFromExternalText`, `activeRelations`
  passed into `SvgRenderer.mount`/`.update`. `bench:relations` re-run with
  this actually live — both fixture sizes clear every budget (see
  benchmarks.md). Arrow/cross-doc-badge CSS added to `media/mindmap.css`
  (`--vscode-*`-only, M4 convention) — it existed in `SvgRenderer` since
  Phase A but had no styling at all until now.
- **Cross-document badge click:** opens the target via the existing
  `openLink` round trip (matches the reference's own
  `openCrossDocRelation`, which calls `openLink`, not the "Go to section"
  beside-column mechanism — that one's for jumping within the *current*
  document).
- **External link opening fix:** re-derived for this repo's architecture,
  not copied — `MindMapEditorProvider.openLink` now classifies a link
  target by its *shape* (URL/bare-domain, absolute filesystem path, or
  workspace-relative reference) via host-side duplicates of `webview/
  model/links.ts`'s `isUrlTarget`/`normalizeUrlTarget`/
  `isAbsoluteFilesystemPath`/`expandHomePath`, using `vscode.env.
  openExternal` for both the URL and absolute-path cases (VS Code's
  documented equivalent of Electron's `shell.openExternal`/`openPath`,
  used directly rather than reaching for a lower-level Electron API this
  host doesn't need).
- **Ctrl/Cmd+Shift+G** ("Go to note section" keyboard equivalent): routed
  as a command (`mindmapView.goToSection` -> `"goToNoteSection"`), same
  conservative VS Code-default-collision handling as every other Shift-
  chord this project has added (collides with "Show Source Control").
- **Cross-document host-side data access, built ahead of the modal:**
  three new message pairs in `MindMapEditorProvider.ts`
  (`listMarkdownFiles`/`readForeignDocument`/`writeForeignDocument`),
  following the exact request/response-by-id shape `resolveImage`/
  `writeImage` already established — the VS Code implementation of
  `sync/foreignRelation.ts`'s `ForeignVaultReader`/`ForeignVaultWriter`
  contracts. Not yet called from anywhere (the modal that would call them
  isn't built), but ready regardless of which UI approach the modal ends
  up using.
- **The relation/link modal redesign, resolved (reference `7578f31`,
  436-line `LinkModal.ts` diff) and its searchable-combobox predecessor
  (`f58b3c1`):** flagged as a genuine platform-fit fork — VS Code has a
  native `showQuickPick` API that could serve the "pick a document, then a
  node in it" two-step picker, as an alternative to extending this repo's
  plain-DOM-overlay family (InlineEditor/SearchPanel/LinkModal/
  ContextMenu). **User decided: build it with `showQuickPick`.**
  `webview/ui/LinkModal.ts` is fully redesigned to match — item list (each
  relation/link individually removable) plus a radio-gated add flow
  (*Document relation*, default, delegates the whole document+node pick to
  a host-native two-step QuickPick via `webview/main.ts`'s
  `pickAndAddRelation`; *Link*, the pre-redesign free-text wikilink/URL/
  path form, now defaulting to "URL or file path"). One new generic
  message pair, `showQuickPick`/`quickPickResult`
  (`MindMapEditorProvider.ts`), reused for both picker steps — the host
  never learns anything about relations/documents/nodes, only shows a
  label list and returns a picked index (or `null` on Escape/click-away,
  which the whole flow treats as a clean no-op — no partial insert). The
  actual relation-commit logic on a successful pick is 100% already-ported
  core (`forcePersistentId`/`buildLinkText`/`appendLinkText`/
  `Controller.commitRename`/`commitForeignRelationTarget`) — nothing new
  invented for the mutation itself, only the QuickPick sequencing.
  Entry point stayed Ctrl/Cmd+K (`linkEditor`), extended in place — the
  reference's own move to Ctrl/Cmd+Shift+L was purely to dodge an
  Obsidian-core hotkey collision this repo's Ctrl/Cmd+K has never had.
- **No core files touched:** `webview/{model,layout,render,sync,
  controller}` re-confirmed byte-identical to reference HEAD
  (`SvgRenderer.ts`'s divergence still exactly the pre-existing M5
  `getViewport`/`setViewport` pair).
- **Tests:** 492 passed / 0 skipped (36 files, up from 484) —
  `test/linkModal.test.ts` fully rewritten (10 tests) for the new shape;
  `test/webviewBootstrap.test.ts` gained two QuickPick-flow tests (a
  successful pick end-to-end, a cancel-at-step-1 no-op) and one adjusted
  pre-existing test; `test/mindMapEditorProvider.test.ts` gained five new
  host-side tests covering `listMarkdownFiles`/`readForeignDocument`/
  `writeForeignDocument`/`showQuickPick` directly (previously dead code
  with zero host-level coverage), extending that file's fake `vscode`
  module with `findFiles`/`fs.readFile`/`showQuickPick` stubs.
- Not committed — left for the user, same as every phase so far.

**Phase C is now fully done** — a relation (same-doc or cross-doc) can be
both authored (Ctrl/Cmd+K's "Document relation" add flow) and consumed
(arrow/badge rendering, click-to-open, `showRelations` toggle) entirely
through VS Code UI. No escalation remains open for this phase.

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
| M4 theming + high-contrast palette | Pure CSS on `--vscode-*`; the 8 branch slots map to `--vscode-charts-*`/`--vscode-terminal-ansi*`, so HC passes by construction (agent resolved, not escalated) | M4; DECISIONS.md |
| M4 settings live-vs-next-open split | Two debounces live; layoutMode/headingDepth/animationNodeThreshold next-open (deliberate per-setting, carried over from reference) | M4; DECISIONS.md |
| `localResourceRoots` widened for images | Extended beyond `media/` to workspace folders + the document's dir so `asWebviewUri` can serve workspace images (security implication noted) | M4; DECISIONS.md |
| Pasted-image save location | **User decided:** `mindmapView.pastedImageFolder` setting, default `""` = alongside the document; `![](relative/path)` embed | M4; DECISIONS.md |
| Webview state persistence design | Selection persisted by structural sibling-index path (not id — ids churn on reparse); viewport persisted exactly via the new `SvgRenderer.getViewport`/`setViewport` (see next row) | M5; DECISIONS.md |
| Full pan/zoom fidelity (adding `getViewport`/`setViewport` to `SvgRenderer`) | **User decided: ADD IT** (chose exact viewport restore over the byte-identical-core invariant). Purely additive two-method pair; `render/SvgRenderer.ts` now intentionally diverges from the reference — the core-integrity check has one known exception (see below) | M5; DECISIONS.md |
| `retainContextWhenHidden` (trade-off #11) — final call | **User decided: stays `false`** (agent recommendation, confirmed). State persistence makes reveal selection+viewport-correct, so this is a pure bounded-one-time-latency vs. continuous-memory choice; `false` wins | M5; DECISIONS.md |
| Workspace trust declaration | Agent decided (not a perf trade-off, a documentation/manifest one): `untrustedWorkspaces: true` with `pastedImageFolder` restricted; `virtualWorkspaces: "limited"` (link-open/image-display/image-paste assume a real fs path) | M5; DECISIONS.md |
| Packaging / `.vscodeignore` scope | Agent decided: ship only `dist/`/`media/`/`package.json`/README/CHANGELOG/LICENSE; `--no-rewrite-relative-links` works around a `vsce` hard failure caused by the still-missing `repository` field | M5; DECISIONS.md |

## Open decisions expected ahead

- (Both M5 escalations are now **resolved by the user** — `retainContext
  WhenHidden` stays `false`; full pan/zoom fidelity was authorized and
  implemented as an additive `SvgRenderer.getViewport`/`setViewport` pair.
  See the "Decisions taken so far" table and DECISIONS.md.)
- Write-back edit granularity (full replace vs minimal ranges, trade-off
  #10) — measured in M2, not budget-relevant; only revisit if a real
  split-view window (M5 human check) shows the text editor's
  viewport/decorations misbehaving on every map edit.
- Any SVG-limit / animation-threshold questions if the 5k stress test in a
  real window (M5 human check) surfaces them.
- Whether to later rewrite `openLink`/`resolveImage`/`writeImage`'s path
  resolution to be URI-aware (closing the virtual-workspace gap fully) —
  flagged as a scoped follow-up in DECISIONS.md, not undertaken in M5
  (no real virtual-workspace usage signal for this extension yet).
- (All M3, M4, and — bar the one item above — M5 questions are resolved.)

## Remaining for human (accumulating)

Everything measured so far is jsdom/headless/vi.mock — no pixels painted,
no real process-boundary `postMessage`, no real Extension Development
Host keybinding interception. `benchmarks.md` keeps the authoritative F5
checklist, now including M2's: open `fixtures/2000-nodes.md` via Reopen
With → Mind Map in an Extension Development Host, check open latency,
60 fps pan/zoom, Tab/Enter/F2/Delete/arrows/Escape feel instant, Ctrl/
Cmd+Z/Shift+Z/Y actually reach the mind map (not VS Code's own no-op
undo), split-view edit propagation both directions, the external-edit-
during-pending-write warning notice, 5k graceful degradation. M3 and M4
each add their own checklist in `benchmarks.md` (M3: folding-twice, drag
interactions, links, search, context menu, clipboard, Ctrl/Cmd+M both
directions; M4: theming on light/dark/both-HC, image thumbnails, each
setting taking effect, clipboard image paste). As of M4 the map is themed
against `--vscode-*` variables — it should now look like a native VS Code
editor, not unstyled DOM. The headless + idle-window benchmark sign-off is
complete for every milestone through M5 (all within budget — see
`benchmarks.md`); the F5 real-window pass remains the one paint/frame-rate
check no headless run can substitute for.

**M5 adds to that same real-window checklist** (all consolidated in
`benchmarks.md`'s M5 section now, as the single human gate before any
release): the 5,000-node stress test's *actual* frame rate/responsiveness
(headless benches can only prove the compute doesn't freeze, not that
Chromium paints it smoothly); hide a mind-map tab and reveal it again —
confirm the selection and the **exact pan/zoom** come back (including a
free pan/zoom with nothing selected), and gauge whether the brief
rebuild-flash feels acceptable (`retainContextWhenHidden` is decided
`false`, but a bad-feeling flash is the one signal that would reopen it);
open the packaged `.vsix` in a scratch profile end-to-end (`RELEASING.md`
step 5) rather than trusting `npm test`/`vsce package`'s own output alone.

**Also human-only, not fake-able from here:**
- **Publisher id** (`package.json`'s `"publisher"` is still
  `"TODO-set-publisher-id"`) — required before a real `vsce publish`; `vsce
  package` (confirmed by testing) succeeds with the placeholder, so this
  didn't block producing a local `.vsix`, but publishing needs a real one.
- **`repository` field** — none configured (no git remote either); `vsce
  package` needed `--no-rewrite-relative-links` to work around a hard
  failure caused by its absence (see DECISIONS.md). Cosmetic for now (no
  relative links in `README.md` to rewrite), but worth adding once the repo
  has a public home.
- **Icon** — none exists; `RELEASING.md` lists the size/format and the
  `package.json` field to add it under.
- **LICENSE copyright line** — generated with this repo's git identity
  (`burak.ucbinli`); confirm or adjust before publishing.
- **Actually running `vsce publish`** — never executed here, per the hard
  rule that publishing is the user's own credentialed action; `RELEASING.md`
  is the full step-by-step for when they're ready.
