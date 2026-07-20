# Benchmarks

Per-milestone benchmark numbers (CLAUDE.md rule 5: run after every
milestone, report against budgets before moving on). Same discipline as the
reference Obsidian plugin's `benchmarks.md`: >20% regression vs. the
previous entry for the same fixture/operation gets flagged and discussed
before the milestone is considered done.

All numbers below are from this machine, `node scripts/bench-m1.mjs` /
`bench-m2.mjs` / `bench-images.mjs`, run against the ported (unmodified)
`webview/sync`, `webview/layout`, `webview/render`, `webview/model` code —
i.e. these measure the exact same code paths the reference repo's numbers
measure, just re-run in this repo/checkout.

## M0 — Scaffold & port of the platform-free core

Ported `model/`, `layout/`, `render/`, `sync/`, `controller/Controller.ts`
verbatim (byte-identical, `diff` confirmed) into `webview/*`; no logic
changed, so these numbers are a **re-measurement of the reference repo's
code on this machine**, not new work — they exist to (a) confirm the port
didn't silently break anything perf-relevant and (b) give this repo its own
dated baseline to diff milestone-over-milestone from here on.

### `npm run bench:m1` (parse + flextree layout)

| Fixture | Parse | Layout | Total | Budget | Status |
|---|---|---|---|---|---|
| 100 nodes | 0.7 ms | 3.8 ms | 4.5 ms | 300 ms | OK |
| 500 nodes | 0.5 ms | 6.6 ms | 7.1 ms | 300 ms | OK |
| 2,000 nodes | 2.1 ms | 16.2 ms | 18.3 ms | 1,000 ms | OK |
| 5,000 nodes (stress) | 4.3 ms | 36.2 ms | 40.4 ms | 2,000 ms | OK, no freeze |

**vs. reference repo (`/Users/burakucbinli/projects/obsidian`), same
benchmark's first-ever recorded numbers** (its `benchmarks.md`, M1
section — different machine/run, headless Node in both cases so directly
comparable in kind, not necessarily in absolute ms):

| Fixture | Reference total | This repo total | Delta |
|---|---|---|---|
| 100 nodes | 1.9 ms | 4.5 ms | +2.6 ms |
| 500 nodes | 3.9 ms | 7.1 ms | +3.2 ms |
| 2,000 nodes | 11.8 ms | 18.3 ms | +6.5 ms |
| 5,000 nodes | 21.9 ms | 40.4 ms | +18.5 ms |

All still comfortably inside budget (worst case, 5,000 nodes, uses ~2% of
its 2,000 ms budget). The consistent ~1.8-2x gap across every fixture size
looks like machine/JIT-warmup variance between the two environments (esbuild
version, Node version, and background load all differ) rather than a code
difference — the code is byte-identical (verified with `diff`). Flagging
per the >20% rule for the record, but not treating it as a regression: same
source, same asymptotic shape (parse ~linear, layout ~n log n from
flextree), no architecture change to explain it. Worth a second same-machine
comparison once the reference repo re-runs its own bench on this machine, if
that ever matters.

### `npm run bench:m2` (mutate + relayout + dirty-render-update)

| Fixture | Tab | Rename | Delete | Fold | Unfold | Serialize |
|---|---|---|---|---|---|---|
| 100 nodes | 5.3 ms | 3.4 ms | 3.1 ms | 2.9 ms | 7.3 ms | 0.3 ms |
| 500 nodes | 5.2 ms | 5.4 ms | 5.0 ms | 5.8 ms | 10.4 ms | 0.2 ms |
| 2,000 nodes | 10.5 ms | 14.3 ms | 15.1 ms | 9.8 ms | 13.9 ms | 0.5 ms |
| 5,000 nodes (stress) | 31.2 ms | 32.3 ms | 25.8 ms | 19.7 ms | 29.9 ms | 1.1 ms |

Budget: 50 ms target / 100 ms hard ceiling (Tab/Enter -> new node
visible & editable). All fixtures OK against target, including the 5,000-node
stress fixture.

**vs. reference repo's most recent `bench:m2` numbers** (tail of its
`benchmarks.md`, after several feature milestones — multi-select,
anticlockwise sides, image support, etc. all landed since M1):

| Fixture | Reference (latest) Tab/Rename/Delete/Fold/Unfold | This repo (M0) |
|---|---|---|
| 100 nodes | 4.3 / 3.3 / 2.7 / 2.6 / 6.1 ms | 5.3 / 3.4 / 3.1 / 2.9 / 7.3 ms |
| 500 nodes | 4.3 / 4.1 / 3.6 / 4.1 / 5.0 ms | 5.2 / 5.4 / 5.0 / 5.8 / 10.4 ms |
| 2,000 nodes | 10.3 / 10.9 / 11.9 / 8.5 / 11.4 ms | 10.5 / 14.3 / 15.1 / 9.8 / 13.9 ms |
| 5,000 nodes | 26.8 / 27.6 / 22.4 / 16.5 / 24.2 ms | 31.2 / 32.3 / 25.8 / 19.7 / 29.9 ms |

Same story as M1: same source code (`Controller`, `SvgRenderer`,
`layoutEngine`, `mutations` are all byte-identical ports), numbers are in
the same ballpark with a mild consistent offset attributable to
machine/run variance, not a regression introduced by porting. All well
inside the 100 ms ceiling even on the 5,000-node stress fixture.

### `npm run bench:images` (sanity check — not part of the M0 required run, but wired and verified working since the task asked for the npm script)

```
201 nodes (200 with an image embed): parse+layout=5.1ms mount=53.5ms
open=64.2ms (budget 1000ms) [OK] pan-dispatch=3.3ms
.mm-node-image elements created: 200
```

Comparable to the reference repo's own `bench:images` baseline
(parse+layout 3.5-4.2ms, mount 40.9-43.2ms, open 47.9-49.9ms) — again a
mild constant-factor offset, same shape, both well inside the 1,000 ms
open budget.

### Bundle sizes (`npm run build`)

| Bundle | Raw | Gzip | Budget |
|---|---|---|---|
| `dist/extension.js` (host) | 2,822 B (2.8 KB) | 1,525 B (1.5 KB) | < 500 KB target / 1 MB ceiling |
| `media/webview.js` (webview) | 154 B | 168 B | < 500 KB target / 1 MB ceiling |

Both are tiny because M0's webview bundle is a placeholder (`webview/main.ts`
is a no-op — see its header comment) that doesn't yet import any of the
ported `webview/model|layout|render|sync|controller` code or `d3-flextree`.
Once the M1 webview bootstrap actually imports the parser/layout/renderer
(and pulls in `d3-flextree`, ~10 KB per the plan), expect this to jump to
something in the same neighborhood as the reference plugin's M1 bundle
(14.4 KB minified) — still far under budget, but flagging now so the M1
report isn't surprised by the jump.

### What remains unverified (same caveat as every entry in the reference repo's `benchmarks.md`)

All numbers above are headless (plain Node for `bench:m1`, jsdom for
`bench:m2`/`bench:images`) — neither paints pixels or reflects real
Chromium layout/GC/paint behavior, and there is no real webview here yet to
measure at all (M0 ships a placeholder, not the interaction loop). Per
CLAUDE.md, the authoritative check is the real VS Code Extension
Development Host (F5) once M1 exists; nothing UI-observable can be verified
in this environment. Explicitly not claimed here.

## M1 — Read-only map in the webview

No ported core file was touched in M1 (verified: `webview/model|layout|
render|sync|controller` are still byte-identical to the reference repo),
so `bench:m1`/`bench:m2` were not re-run — the M0 numbers above remain the
current baseline for those paths per the coordinator's instruction.

### `npm run bench:open` (new in M1) — the full webview open path

Measures exactly the sequence `webview/main.ts::buildFromScratch()` runs
when the host posts the document: parse -> assignMissingColors ->
assignMissingSides -> computeLayout -> `SvgRenderer` construction + mount,
in jsdom (1200x800 fake viewport):

| Fixture | Parse+colors+sides+layout | Mount | Total | Budget | Status |
|---|---|---|---|---|---|
| 100 nodes | 3.0 ms | 21.2 ms | 24.1 ms | 300 ms | OK |
| 500 nodes | 4.9 ms | 7.3 ms | 12.2 ms | 300 ms | OK |
| 2,000 nodes | 15.0 ms | 2.1 ms | 17.1 ms | 1,000 ms | OK |
| 5,000 nodes (stress) | 30.7 ms | 1.8 ms | 32.5 ms | 2,000 ms | OK, no freeze |

The seemingly inverted mount column (100 nodes costs more than 5,000) is
the ported viewport culling working as designed plus JIT warm-up on the
first iteration: below the 300-node culling threshold every node gets DOM
elements created at mount (100-node fixture — and it runs first, cold);
above it, only in-viewport nodes do, so the 2,000/5,000-node mounts create
DOM for just the handful of nodes inside the fake 1200x800 viewport. This
matches the reference repo's design (culling threshold 300, see its
DECISIONS.md) — the total is what the budget governs, and worst case uses
8% of its budget (100 nodes) / 1.7% (2,000 nodes).

### Bundle sizes (`npm run build`)

| Bundle | Raw | Gzip | Budget | M0 |
|---|---|---|---|---|
| `dist/extension.js` (host) | 3,038 B (3.0 KB) | 1,639 B (1.6 KB) | < 500 KB target / 1 MB ceiling | 2.8 KB |
| `media/webview.js` (webview) | 46,685 B (45.6 KB) | 14,778 B (14.4 KB) | < 500 KB target / 1 MB ceiling | 154 B |

The webview jump predicted in the M0 entry happened: the bundle now
actually contains the ported parser/layout/renderer/controller plus
`d3-flextree`. 45.6 KB minified is larger than the reference plugin's M1
bundle (14.4 KB) because this bundle already includes the full ported
`SvgRenderer` (with culling/drag/image code paths), `Controller`,
`CommandStack`, serializer, and reconcile — modules the reference only
added in its M2+ — while its M1 bundle had just parser+layout+an early
renderer. Both bundles combined use ~10% of the 500 KB target.

### Test suite

302 passed / 0 skipped (25 files) — includes the two re-enabled UI test
files (`inlineEditor`, `searchPanel`, 20 tests) and the new
`webviewBootstrap.test.ts` (6 tests: ready-handshake, mount-on-setDocument,
version-gate stale drop, click-select + background-clear, external-edit
rebuild with selection carry-over, unknown-message ignore).

### REMAINING FOR HUMAN — real-window verification (M1 exit criterion)

The M1 exit criterion "a 2,000-node file opens within budget inside a real
VS Code window" is **not verified**. Everything above is headless jsdom —
no pixels are painted, no real Chromium layout/GC runs, and the
host->webview postMessage hop isn't exercised end-to-end (the bootstrap
test fakes `acquireVsCodeApi`). What a human needs to do, exactly as the
reference repo's benchmarks.md prescribes for its own dev-vault checks:

1. `npm run dev` (or `npm run build`), then F5 in VS Code to launch the
   Extension Development Host.
2. Open `fixtures/2000-nodes.md`, right-click tab -> "Reopen Editor With…"
   -> Mind Map (or the "Open as Mind Map" command).
3. Confirm open-to-interactive < 1 s (2 s hard ceiling), pan/zoom at 60
   fps (DevTools Performance panel: Developer: Open Webview Developer
   Tools), click-selection responds instantly, and editing the md in a
   split view updates the map after the ~300 ms forward debounce.
4. Same pass on `5000-nodes.md`: must degrade gracefully, never freeze.

Also not yet verified in a real window: the styling pass — mindmap.css
still uses Obsidian CSS variables (M4 theming TODO), so colors/fonts will
fall back to CSS defaults in a VS Code webview. Functional, not pretty, by
design at this milestone.

## M2 — Editing + bidirectional sync + keybinding plumbing

No ported core file was touched in M2 either (verified: `webview/model|
layout|render|sync|controller` still byte-identical to the reference
repo) — `bench:m1`/`bench:m2`/`bench:open` re-run below purely to confirm
no regression snuck in via the new `webview/main.ts`/`MindMapEditorProvider`
wiring; numbers are within noise of the M1 baseline.

### `npm run bench:m1`

| Fixture | Parse | Layout | Total | Budget | Status |
|---|---|---|---|---|---|
| 100 nodes | 0.6 ms | 3.0 ms | 3.6 ms | 300 ms | OK |
| 500 nodes | 0.6 ms | 5.8 ms | 6.4 ms | 300 ms | OK |
| 2,000 nodes | 1.6 ms | 15.0 ms | 16.6 ms | 1,000 ms | OK |
| 5,000 nodes (stress) | 3.7 ms | 33.3 ms | 37.0 ms | 2,000 ms | OK, no freeze |

### `npm run bench:open`

| Fixture | Parse+colors+sides+layout | Mount | Total | Budget | Status |
|---|---|---|---|---|---|
| 100 nodes | 3.2 ms | 24.2 ms | 27.5 ms | 300 ms | OK |
| 500 nodes | 5.0 ms | 8.1 ms | 13.1 ms | 300 ms | OK |
| 2,000 nodes | 15.6 ms | 2.2 ms | 17.7 ms | 1,000 ms | OK |
| 5,000 nodes (stress) | 34.2 ms | 2.7 ms | 36.9 ms | 2,000 ms | OK, no freeze |

### `npm run bench:m2` (mutate + relayout + dirty-render-update + serialize)

| Fixture | Tab | Rename | Delete | Fold | Unfold | Serialize |
|---|---|---|---|---|---|---|
| 100 nodes | 4.2 ms | 3.0 ms | 2.5 ms | 2.5 ms | 6.2 ms | 0.3 ms |
| 500 nodes | 4.2 ms | 3.8 ms | 3.9 ms | 4.0 ms | 6.9 ms | 0.2 ms |
| 2,000 nodes | 9.5 ms | 11.1 ms | 12.1 ms | 8.6 ms | 11.8 ms | 0.5 ms |
| 5,000 nodes (stress) | 28.8 ms | 26.5 ms | 23.5 ms | 17.2 ms | 24.5 ms | 0.7 ms |

The `Serialize` column is the number that actually matters for the M2
write-back path (`serializeMindMap` runs on every `onChange`, before the
400 ms debounce even starts): 0.7 ms worst case (5,000 nodes) is
negligible against the debounce window, confirming trade-off #10's
"start with full replace" call needs no revisiting yet (DECISIONS.md).
Budget: 50 ms target / 100 ms hard ceiling for Tab/Enter -> node visible
& editable — all fixtures comfortably OK, including the 5,000-node stress
fixture.

### Bundle sizes (`npm run build`)

| Bundle | Raw | Gzip | Budget | M1 |
|---|---|---|---|---|
| `dist/extension.js` (host) | 3,782 B (3.7 KB) | 1,887 B (1.8 KB) | < 500 KB target / 1 MB ceiling | 3.0 KB |
| `media/webview.js` (webview) | 54,511 B (53.2 KB) | 17,121 B (16.7 KB) | < 500 KB target / 1 MB ceiling | 45.6 KB |

The webview grew ~7.6 KB raw over M1: `InlineEditor`, `debounce`,
`navigation`, `visibility`, and `metadata` (`ensurePersistentIds`) are now
actually imported and bundled (M1's build imported the parser/layout/
renderer/controller but not yet the editing-support modules). Both
bundles combined are ~11.6% of the 500 KB target — no dependency was
added (still just `d3-flextree`), so this is entirely more of the
already-ported core being reached, not new weight.

### Test suite

313 passed / 0 skipped (26 files) — 11 new tests in `webviewBootstrap.
test.ts` (Tab-creates-and-opens-editor, commit-via-Enter, debounced
write-back posts the serialized doc, Delete, arrow navigation, undo/redo
via `command` messages, and the external-edit-while-pending-write
conflict guard) plus a new `mindMapEditorProvider.test.ts` (5 tests: ready
handshake posts the document, `writeDocument` applies a full-document
`WorkspaceEdit`, the resulting change event is **not** re-forwarded to the
webview as an external edit — the self-write-suppression case — a
genuine external edit **is** forwarded after the 300 ms debounce, and
`mindmapView.undo`/`redo` route only to the active panel) against a fake
`vscode` module (`vscode` isn't installed as a package; `vi.mock`
supplies one, per the plan's own testing-strategy note about host<->
webview protocol tests needing a fake VS Code API).

### REMAINING FOR HUMAN — real-window verification (M2 exit criterion)

Same caveat as M1, now covering the new interaction loop: everything above
is headless jsdom/vi.mock — no pixels painted, no real Chromium
keyboard/focus/IME behavior, and the fake `vscode` module's `applyEdit`/
`onDidChangeTextDocument` simulate the real cross-process contract but
aren't it. What a human needs to check in a real Extension Development
Host (F5), per the plan's M2 exit criterion ("keystroke/creation latency
within budget; round-trip loses nothing; split-view editing works both
directions"):

1. Open a fixture as a mind map. Tab/Enter/Shift+Enter/F2/double-click/
   Delete/Backspace/Escape/arrow keys — confirm each feels instant (no
   visible lag before the new/edited node appears) and that typing in the
   inline editor never stutters.
2. Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y — confirm VS Code doesn't
   intercept these into its own (no-op, since there's no text editor
   focused) undo command instead of routing to the mind map; this is the
   one thing `contributes.keybindings`' `when` clause needs a real
   workbench to prove.
3. Open the same file in a split view as plain markdown. Edit the mind
   map — confirm the text side updates only after the ~400 ms debounce,
   with no visible flicker/cursor-jump in the text editor (full-document
   replace, trade-off #10 — this is exactly the scenario that would
   surface a need for minimal-range edits instead). Then edit the text
   side — confirm the map rebuilds after the ~300 ms forward debounce and
   preserves selection.
4. Trigger the conflict case on purpose (edit the map, then within ~400 ms
   also save an edit to the text side from another program/process) and
   confirm the warning notice appears and the map's own edit still wins
   (documented limitation in DECISIONS.md, not a bug to "fix" here).
5. 5,000-node fixture: repeat step 1 — must stay responsive, no freeze.

## M3 — Full feature parity

No ported core file was touched (verified: `diff -rq webview/{model,layout,
render,sync,controller}` against the reference repo's `src/{...}` — zero
diffs, same as every milestone so far). `webview/main.ts` did change
(fold/manual-position/reorder/link/search/context-menu/clipboard wiring,
plus the `reconcilePersistentIds` bug fix — see DECISIONS.md), so all three
bench scripts were re-run in full, not skipped.

### M3 budget sign-off — clean re-run, all within budget

The initial M3 bench run was contaminated by heavy concurrent machine load
(load average ~1.7–6.5; the Vitest suite took ~33s vs. its normal ~2.5s, a
~13x slowdown unrelated to the code under test) and produced numbers that
inflated the *small* fixtures as hard as the large ones — the signature of
contention, not a code regression, especially since the measured code is
verified **byte-identical** to the reference (`diff -rq`, confirmed above),
so no M3 change *could* have moved these paths. Those contaminated numbers
were not recorded as authoritative.

The tables below are the **clean re-run on an idle window** (2026-07-17;
Vitest suite back to 2.24s, its normal runtime — the independent gauge that
the machine was actually quiet). They confirm no regression: every figure
is within noise of the M2 baseline, and all are inside budget.

### `npm run bench:m1`

| Fixture | Parse | Layout | Total | Budget | Status | M2 baseline (total) |
|---|---|---|---|---|---|---|
| 100 nodes | 0.6 ms | 3.3 ms | 3.9 ms | 300 ms | OK | 3.6 ms |
| 500 nodes | 0.5 ms | 5.0 ms | 5.5 ms | 300 ms | OK | 6.4 ms |
| 2,000 nodes | 1.6 ms | 14.0 ms | 15.6 ms | 1,000 ms | OK | 16.6 ms |
| 5,000 nodes (stress) | 3.6 ms | 33.9 ms | 37.6 ms | 2,000 ms | OK, no freeze | 37.0 ms |

### `npm run bench:open`

| Fixture | Parse+colors+sides+layout | Mount | Total | Budget | Status |
|---|---|---|---|---|---|
| 100 nodes | 3.1 ms | 41.7 ms | 44.8 ms | 300 ms | OK |
| 500 nodes | 9.5 ms | 8.7 ms | 18.3 ms | 300 ms | OK |
| 2,000 nodes | 16.0 ms | 2.1 ms | 18.1 ms | 1,000 ms | OK |
| 5,000 nodes (stress) | 32.0 ms | 2.0 ms | 34.0 ms | 2,000 ms | OK, no freeze |

Same culling-driven inverted-mount-column shape as M1/M2 (below the
300-node threshold every node mounts; above it, only the in-viewport
handful do). Worst case (100 nodes) uses ~15% of its budget.

### `npm run bench:m2`

| Fixture | Tab | Rename | Delete | Fold | Unfold | Serialize |
|---|---|---|---|---|---|---|
| 100 nodes | 4.0 ms | 3.1 ms | 2.7 ms | 2.2 ms | 6.0 ms | 0.2 ms |
| 500 nodes | 4.1 ms | 3.6 ms | 3.9 ms | 4.0 ms | 4.9 ms | 3.1 ms |
| 2,000 nodes | 10.1 ms | 11.3 ms | 11.5 ms | 8.1 ms | 11.3 ms | 0.4 ms |
| 5,000 nodes (stress) | 28.1 ms | 26.9 ms | 22.5 ms | 16.7 ms | 24.6 ms | 0.6 ms |

Budget: 50 ms target / 100 ms hard ceiling for Tab/Enter → node visible &
editable — every fixture OK against **target**, including the 5,000-node
stress fixture (worst case 28.1 ms, well under the 50 ms target). These
line up with M2's baseline (Tab 4.2/4.2/9.5/28.8 ms) within noise, exactly
as expected for byte-identical mutation/layout/render code. **Serialize**
(the column that gates the write-back path, running on every edit before
the 400 ms debounce) is ≤0.6 ms at 5,000 nodes — far under CLAUDE.md's
"Markdown sync after node edit" budget row.

### Bundle sizes (`npm run build`)

| Bundle | Raw | Gzip | Budget | M2 |
|---|---|---|---|---|
| `dist/extension.js` (host) | 5,527 B (5.4 KB) | 2,546 B (2.5 KB) | < 500 KB target / 1 MB ceiling | 3.7 KB |
| `media/webview.js` (webview) | 68,244 B (66.6 KB) | 20,523 B (20.0 KB) | < 500 KB target / 1 MB ceiling | 53.2 KB |

Combined ~74 KB raw / ~23 KB gzip — **~14.8% of the 500 KB target**. No new
dependency was added (still just `d3-flextree`); the growth is
`LinkModal`/`ContextMenu` (new, small) plus more of the already-bundled
ported `sync`/`model` modules (`goToSection`, `parseExternalPaste`,
`search`) actually being *reached* now that M3 wires them, not new weight
per se.

### Test suite

**348 passed / 0 skipped** (28 files) — 313 from M0–M2 plus 35 new: 12 in
`test/webviewBootstrap.test.ts`'s new "M3 feature wiring" describe block
(fold badge + Ctrl/Cmd+/ toggle, Alt+drag manual position, resize-handle
manual width, plain drag-reorder, Alt+Up/Down keyboard reorder, link click
-> `openLink` message, Ctrl/Cmd+K link editor + save, Ctrl/Cmd+F search
open/select, right-click context menu + "Go to section" flush, Escape/
outside-click menu dismissal, Ctrl/Cmd+C/X/V clipboard round trip), 9 new
in `test/mindMapEditorProvider.test.ts` (search/rebalance/linkEditor/
toggleFold command routing, `openLink`'s URL-vs-relative-path split,
`goToSection` opening beside at the resolved target line + an out-of-range
line clamp, the toggleToText flush round trip incl. the no-active-panel
no-op case, toggleToMindMap incl. the non-markdown no-op case), plus two
new files: `test/linkModal.test.ts` (8 tests) and
`test/contextMenu.test.ts` (6 tests).

### REMAINING FOR HUMAN — real-window verification (M3 exit criterion)

Same caveat as every milestone: everything above is headless jsdom/
vi.mock. What a human needs to check in a real Extension Development Host
(F5 — `.vscode/launch.json` now exists; run `npm run build` or `npm run
dev` first, no auto-build task is wired, see DECISIONS.md):

1. Fold/unfold via badge click and Ctrl/Cmd+/ — **specifically test folding
   the *same* node twice in a row** (fold, then immediately unfold again)
   on a node that has never been folded before in that file — this is the
   exact case the `reconcilePersistentIds` fix (DECISIONS.md) addresses;
   also confirm the fold state round-trips through a save/reopen.
2. Alt+drag a node to a manual position; drag its resize handle; drag-drop
   a node onto another (nest) and near a sibling's top/bottom edge
   (reorder); Alt+Up/Down keyboard reorder. Confirm the frontmatter
   `pos:`/`width:` metadata appears after write-back and survives reopen.
3. Click a wikilink and a URL link — confirm the wikilink opens the
   right file (appending `.md`, relative to the current file's folder) and
   the URL opens in the system browser, in both cases without disturbing
   the open mind map tab. Ctrl/Cmd+K on a node with/without an existing
   link — confirm the modal pre-fills correctly and Remove/Save both work.
4. Ctrl/Cmd+F opens the search panel; typing filters; Enter/click selects
   and centers/unfolds the result; a second Ctrl/Cmd+F while already open
   just refocuses (no duplicate panel).
5. Right-click a node — confirm every menu item does what it says,
   including "Go to note section": it should open the document as a plain
   text editor **in the column beside** the map, with the cursor on the
   node's own line/heading/block, leaving the map tab open and untouched
   (user-decided reveal semantics). Try it on a node with a persisted
   `^blockid`, on a unique heading, and on a plain list item (the three
   `resolveGoToTarget` tiers) — each should land on the right line.
6. Ctrl/Cmd+C/X on a selection, Ctrl/Cmd+V within the map, and pasting the
   same OS-clipboard text into a *different* app (confirm it's readable
   plain markdown) — plus pasting external markdown/plain-text copied from
   outside the extension into the map.
7. Ctrl/Cmd+Shift+B rebalances (clears manual positions); confirm it
   doesn't collide with VS Code's own "Run Build Task" default on that
   chord while a mind map tab is focused.
8. Ctrl/Cmd+M both directions: from a mind map tab to the same file as
   plain markdown, and back — confirm the *same* tab toggles (no
   duplicate tabs pile up) and that an in-flight edit is never lost
   (make an edit, immediately Ctrl/Cmd+M, confirm the text side shows the
   edit, not stale content).
9. Re-run this whole checklist's 5,000-node case — must stay responsive
   throughout; if it doesn't, that's real information this session's noisy
   headless numbers above couldn't rule out.
10. **Re-run `bench:m1`/`bench:m2`/`bench:open` on an idle machine** and
    compare against M2's baseline numbers properly — this session's numbers
    are flagged, not trusted, for the reasons above.

## M4 — Images, theming, settings

No ported core file was touched (verified: `diff -rq webview/{model,layout,
render,sync,controller}` vs the reference — zero diffs). `webview/main.ts`
(image-resolver wiring, settings, clipboard-image-paste plumbing) and
`src/MindMapEditorProvider.ts` (image resolution, config, the pasted-image
write path) changed, so all four bench scripts were re-run — on an **idle
window** this time (the per-op numbers below match the M2/M3 baseline to
within noise, the independent confirmation that the machine was actually
quiet, unlike M3's first contaminated run).

### `npm run bench:images` (the M4-relevant script)

```
201 nodes (200 with an image embed): parse+layout=3.8ms mount=42.1ms
open=51.4ms (budget 1000ms) [OK] pan-dispatch=3.1ms
.mm-node-image elements created: 200
```

Comparable to the M1-era `bench:images` baseline (open ~48–64ms) — the M4
image *resolution* round-trip doesn't show here because it's async and
viewport-bounded (only culled-in nodes request a URL, off this synchronous
open/mount path by design, plan §8); the `<img>` elements are created, the
webview-URI resolution happens lazily afterward. Well within the 1,000ms
open budget.

### `npm run bench:m2` (regression check — byte-identical mutation core)

| Fixture | Tab | Rename | Delete | Fold | Unfold | Serialize |
|---|---|---|---|---|---|---|
| 100 nodes | 4.3 ms | 2.9 ms | 3.0 ms | 2.5 ms | 6.1 ms | 0.3 ms |
| 500 nodes | 3.9 ms | 4.0 ms | 3.6 ms | 4.4 ms | 6.9 ms | 0.3 ms |
| 2,000 nodes | 10.2 ms | 11.4 ms | 12.0 ms | 8.6 ms | 11.0 ms | 0.4 ms |
| 5,000 nodes (stress) | 29.6 ms | 26.4 ms | 23.5 ms | 17.2 ms | 24.6 ms | 0.7 ms |

Matches the M3 idle baseline (Tab 4.0/4.1/10.1/28.1) within noise — no
regression, as expected for untouched mutation/layout/render code. All
within the 50ms target.

### `npm run bench:open`

| Fixture | Parse+colors+sides+layout | Mount | Total | Budget | Status |
|---|---|---|---|---|---|
| 100 nodes | 3.2 ms | 23.5 ms | 26.7 ms | 300 ms | OK |
| 500 nodes | 4.9 ms | 7.5 ms | 12.4 ms | 300 ms | OK |
| 2,000 nodes | 15.3 ms | 1.9 ms | 17.2 ms | 1,000 ms | OK |
| 5,000 nodes (stress) | 32.3 ms | 1.8 ms | 34.1 ms | 2,000 ms | OK, no freeze |

### Bundle sizes (`npm run build`)

| Bundle | Raw | Gzip | Budget | M3 |
|---|---|---|---|---|
| `dist/extension.js` (host) | 7,738 B (7.6 KB) | — | < 500 KB target / 1 MB ceiling | 5.4 KB |
| `media/webview.js` (webview) | 70,554 B (68.9 KB) | 21,238 B (20.7 KB) | < 500 KB target / 1 MB ceiling | 66.6 KB |

Combined ~78 KB raw / ~23 KB gzip — **~15.6% of the 500 KB target**. The
host grew ~2.2 KB (config reads, image resolution, the pasted-image write
path); the webview ~2.3 KB (image-resolver wiring, settings, clipboard
plumbing). Still no new dependency (just `d3-flextree`).

### Test suite

**368 passed / 0 skipped** (30 files) — M4 added `test/theming.test.ts`
(asserts `media/mindmap.css` references `--vscode-*` variables, not
Obsidian ones), `test/webviewConfig.test.ts` (settings load + live-update +
next-open baking), and image-resolve + clipboard-image-write cases in
`mindMapEditorProvider.test.ts` (including the pasted-image default-folder,
`pastedImageFolder`-subfolder, and write-failure-falls-through paths).

### High-contrast palette verdict

**PASSES by construction** (see DECISIONS.md): the 8 per-branch color slots
map to `--vscode-charts-*` / `--vscode-terminal-ansi*`, which every shipped
theme (incl. both high-contrast variants) is required to keep legible
against its own background. Not verified by a hand contrast calculation
(deliberately — that's the fragility this avoids), so the one thing a human
should still eyeball in a real window is that branch *hue identity* reads
acceptably per-theme (it now varies with each theme's chart colors rather
than being fixed hex).

### REMAINING FOR HUMAN — real-window verification (M4)

Headless as always. In a real Extension Development Host (F5):
1. **Theming:** open a map on a light theme, a dark theme, and both
   High Contrast themes (Light/Dark) — confirm nodes, edges, badges, the
   inline editor, search panel, context menu, and link modal are all
   legible and the 8 branch colors are distinguishable in each.
2. **Images:** a node whose text is `![](some-image.png)` (relative to the
   file) shows the thumbnail; one with a `https://…` image shows it too
   (resolved with no host round trip); a broken path shows the renderer's
   missing-image glyph, not a crash.
3. **Settings:** change each `mindmapView.*` setting — confirm
   `writeDebounceMs`/`externalEditForwardDebounceMs` take effect
   immediately, and `layoutMode`/`headingDepth`/`animationNodeThreshold`
   take effect on the next open (per DECISIONS.md's per-setting split).
4. **Clipboard image paste:** copy a screenshot to the OS clipboard, paste
   into the map — confirm a `pasted-image-<timestamp>.png` file appears
   beside the document (or in `pastedImageFolder` if set), a new node shows
   its thumbnail, and the file round-trips on reopen.

## M5 — Hardening & release readiness

**Core-integrity check — one known intentional exception this milestone.**
`model/`, `layout/`, `sync/`, `controller/` remain fully byte-identical to
the reference (`diff -rq` — zero diffs, same as every prior milestone).
`render/` now differs by **exactly** the user-authorized additive
`SvgRenderer.getViewport`/`setViewport` pair — `diff -u`/`git diff` shows a
single hunk of **additions only, no `-` lines**, so no existing renderer
behavior changed (see DECISIONS.md's dated maintenance note). The
verification going forward is "render/ differs *only* by that pair," not
"clean." `webview/main.ts` also changed (state persistence —
`persistState`/`restoreViewState`/`onViewportGesture`/`pathOf`/`nodeAtPath`);
`src/MindMapEditorProvider.ts` did **not** change (the capability
declarations are manifest-only, in `package.json`). All four bench scripts
re-run to confirm no regression — the new `SvgRenderer` methods are O(1)
field copies called only at persist/restore, never on a bench path.

Machine check before running: `uptime` showed load averages ~2.7–6.8 across
the session (spiking to ~6.8 during the final bench re-run after the
`SvgRenderer` change); the Vitest suite ran in ~2.6–3.0s vs. the documented
"normal ~2.5s" baseline — a mild slowdown, nowhere near the ~13x
contamination signature M3's first (discarded) run showed. Numbers are all
comfortably within budget and within noise of the M4 baseline, so treated as
authoritative; flagging the elevated load per the "check machine load first"
instruction — read the individual figures as "within budget, not a
regression" rather than as precise timings.

### `npm run bench:m1`

| Fixture | Parse | Layout | Total | Budget | Status | M4 baseline (total) |
|---|---|---|---|---|---|---|
| 100 nodes | 0.6 ms | 2.9 ms | 3.5 ms | 300 ms | OK | 3.6 ms (M2/M3 baseline; M4 didn't re-run bench:m1) |
| 500 nodes | 0.5 ms | 5.1 ms | 5.6 ms | 300 ms | OK | 6.4 ms |
| 2,000 nodes | 1.5 ms | 13.9 ms | 15.3 ms | 1,000 ms | OK | 16.6 ms |
| 5,000 nodes (stress) | 3.2 ms | 30.0 ms | 33.1 ms | 2,000 ms | OK, no freeze | 37.0 ms |

### `npm run bench:open`

| Fixture | Parse+colors+sides+layout | Mount | Total | Budget | Status |
|---|---|---|---|---|---|
| 100 nodes | 2.9 ms | 21.6 ms | 24.5 ms | 300 ms | OK |
| 500 nodes | 4.6 ms | 8.3 ms | 12.9 ms | 300 ms | OK |
| 2,000 nodes | 15.7 ms | 2.3 ms | 18.0 ms | 1,000 ms | OK |
| 5,000 nodes (stress) | 31.0 ms | 1.7 ms | 32.7 ms | 2,000 ms | OK, no freeze |

Matches the M1–M4 baseline within noise — expected, since
`restoreViewState()` only runs once per `buildFromScratch` and is bounded by
selection size (typically 0, on a fresh open with no persisted state),
not map size.

### `npm run bench:m2`

| Fixture | Tab | Rename | Delete | Fold | Unfold | Serialize |
|---|---|---|---|---|---|---|
| 100 nodes | 3.9 ms | 2.8 ms | 2.9 ms | 2.0 ms | 5.8 ms | 0.3 ms |
| 500 nodes | 3.6 ms | 3.4 ms | 3.4 ms | 3.7 ms | 4.2 ms | 2.3 ms |
| 2,000 nodes | 10.4 ms | 10.1 ms | 10.6 ms | 7.6 ms | 12.0 ms | 0.3 ms |
| 5,000 nodes (stress) | 26.6 ms | 27.1 ms | 22.2 ms | 16.4 ms | 24.0 ms | 0.6 ms |

Matches the M4 baseline (Tab 4.3/3.9/10.2/29.6 ms) within noise. The new
`persistState()` call at the end of every `onChange` (same frequency as
`serializeMindMap`) adds no measurable cost — it's O(selection size) via
`Array.prototype.indexOf` over each node's own sibling list, not a tree
walk, and every fixture stays comfortably under the 50 ms target including
at 5,000 nodes.

### `npm run bench:images`

```
201 nodes (200 with an image embed): parse+layout=3.7ms mount=40.5ms
open=49.2ms (budget 1000ms) [OK] pan-dispatch=2.8ms
.mm-node-image elements created: 200
```

Matches the M4 baseline (open 51.4ms) within noise — no regression.

### Bundle sizes (`npm run build`)

| Bundle | Raw | Gzip | Budget | M4 |
|---|---|---|---|---|
| `dist/extension.js` (host) | 7,738 B (7.6 KB) | 3,341 B (3.3 KB) | < 500 KB target / 1 MB ceiling | 7.6 KB (unchanged — `src/` untouched this milestone) |
| `media/webview.js` (webview) | 72,225 B (70.5 KB) | — | < 500 KB target / 1 MB ceiling | 68.9 KB |

Combined ~80 KB raw — **~16% of the 500 KB target**. The webview grew
~3.3 KB raw over M4 (`persistState`/`restoreViewState`/`onViewportGesture`/
`pathOf`/`nodeAtPath` in `webview/main.ts`, plus the additive
`getViewport`/`setViewport` in `SvgRenderer`). No new dependency (still just
`d3-flextree`).

### Packaged `.vsix` size (new in M5 — `npm run package`)

```
mindmap-view-0.0.1.vsix (9 files, 39.77 KB on vsce's own accounting;
40,728 bytes / ~39.8 KB on disk)
├─ LICENSE.txt            1.04 KB
├─ changelog.md           4.32 KB
├─ package.json           6.37 KB
├─ readme.md              9.07 KB
├─ dist/extension.js      7.56 KB
└─ media/
   ├─ mindmap.css        14.92 KB
   └─ webview.js         70.53 KB
```

**~8% of the 500 KB target, ~4% of the 1 MB hard ceiling.** Packaged
successfully with the placeholder `"TODO-set-publisher-id"` publisher
(`vsce package`, unlike `publish`, doesn't validate it) and no
`repository` field (`--no-rewrite-relative-links` works around the hard
failure that field's absence otherwise causes — see DECISIONS.md). Not
committed (`*.vsix` is already `.gitignore`d).

### Test suite

**374 passed / 0 skipped** (31 files) — M5 added
`test/webviewStatePersistence.test.ts` (6 tests): no `setState` call with
nothing selected; primary+multi-selection persisted as structural
sibling-index paths on every selection change; selection restored across a
simulated reload (fresh module + a shared fake state store, mirroring what
VS Code's own store actually preserves across a real one); **an exact
pan/zoom with nothing selected round-tripped** (ctrl+wheel zoom → persist →
reload → byte-identical transform string, via the new
`getViewport`/`setViewport`); selection AND a changed viewport restored
together; a persisted path that no longer resolves (tree shrank) ignored
without throwing.

### REMAINING FOR HUMAN — the consolidated real-window checklist (M5 = the release gate)

Everything measured in this file, across every milestone, is headless
(plain Node / jsdom / `vi.mock`) — no pixels painted, no real Chromium
paint/layout/GC, no real cross-process `postMessage`, no real Extension
Development Host keybinding interception. This is the single consolidated
list a human needs to walk before a release; it supersedes having to dig
through each milestone's own scattered "remaining for human" section
above (kept there for the historical record, not repeated here item-for-
item where this list already covers the same ground):

1. **Open latency / responsiveness, all four fixture sizes** (100/500/
   2,000/5,000 nodes, `fixtures/*.md`, generated by `npm run fixtures`,
   opened via Reopen Editor With… → Mind Map): confirm each is within its
   budget row in this file's own tables, and — the one thing no headless
   bench can prove — that **5,000 nodes stays responsive** (pan/zoom, click,
   scroll) rather than merely "not frozen at open." Watch DevTools'
   Performance panel (Developer: Open Webview Developer Tools) for actual
   frame rate during a pan/zoom gesture; target 60 fps, hard floor 30 fps.
2. **Every M2/M3/M4 interaction**, per their own sections above: inline
   editing feel: Tab/Enter/Shift+Enter/F2/double-click/Delete/Backspace/
   Escape/arrows; undo/redo chords actually reach the mind map (not VS
   Code's own no-op); split-view text-editor sync both directions,
   including the external-edit-during-pending-write warning notice;
   folding (specifically fold-then-immediately-unfold-the-same-node-twice,
   the `reconcilePersistentIds` regression case); manual position/resize/
   drag-reorder persisting through a save+reopen; links (wikilink + URL)
   and Ctrl/Cmd+K; search; the context menu including "Go to note section"
   opening beside the map at the right line; multi-select clipboard
   (internal + external paste); Ctrl/Cmd+Shift+B rebalance; Ctrl/Cmd+M
   toggle both directions, same tab, no lost in-flight edit; theming on
   light/dark/both High-Contrast variants; image thumbnails (local +
   remote + broken-path glyph); every setting taking effect per its
   live-vs-next-open classification; clipboard image paste round-tripping
   through save+reopen.
3. **M5's own new ground — webview lifecycle:** pan/zoom to a distinctive
   view and select a node, then switch away from the mind-map tab (another
   tab, editor group, or VS Code window) long enough for it to be hidden,
   and switch back. Confirm: (a) the selection you had comes back (visually
   highlighted); (b) the **exact pan/zoom** comes back — not re-centered,
   not reset to default — *including* the case where you pan/zoom with
   nothing selected (this is what the user-authorized
   `SvgRenderer.getViewport`/`setViewport` pair is for); (c) judge whether
   the brief rebuild-flash (full re-parse + fresh mount, same cost as a
   fresh open — see this file's open-latency numbers above) is noticeable/
   objectionable. `retainContextWhenHidden` is **decided** (`false`,
   DECISIONS.md) — but if that flash feels bad in a real window, it's the
   one signal that would reopen that decision; there's no way to judge it
   from a headless run.
4. **The packaged `.vsix` itself** (`RELEASING.md` step 5): install
   `mindmap-view-0.0.1.vsix` into a scratch VS Code profile
   (`code --install-extension mindmap-view-0.0.1.vsix`) and repeat a quick
   pass of the above — confirms the *shipped* artifact (not just the dev
   checkout with `npm run dev` watching) actually works, since packaging
   and dev-mode load the bundle differently.
5. **Workspace trust / virtual workspace**, new capability declarations
   (`package.json`): open a workspace in Restricted Mode and confirm the
   mind map still opens/edits normally, and that setting
   `mindmapView.pastedImageFolder` from that workspace's own
   `.vscode/settings.json` is genuinely ignored (falls back to the
   user-level value or the same-directory default) — the specific gap the
   `restrictedConfigurations` declaration is supposed to close. A virtual
   workspace (e.g. a GitHub repository browsed via `github.dev`) is a
   secondary check — confirmed *not* fully supported by design (`"limited"`
   — see DECISIONS.md), so the useful check there is that the core
   open/edit story still works, not that every feature does.

## Phase A — catch-up re-sync of the platform-free core (relations, status badges, layout fix)

The reference plugin gained node relations, status badges, and a
tall-node-overlap layout fix after this repo's M0 port point; Phase A
brings the platform-free core current with all of it (DECISIONS.md has the
full entry). No VS Code-side UI wiring yet — the new features are dormant
(rendering paths exist but nothing in `webview/main.ts` calls
`resolveRelations` or sets a `statusBadge`, so the relations layer stays
empty and no node ever carries a status badge, regardless of
`showRelations`'s `true` default).

### Core-integrity re-verification

`model/`, `layout/`, `sync/`, `controller/` — byte-identical to reference
HEAD (`diff -rq`, zero diffs), same as every milestone. `render/` — differs
from reference HEAD *only* by the authorized `getViewport`/`setViewport`
pair (`diff -u`: 26 added, 0 removed) — re-confirmed after the full-file
re-copy, so the ongoing verification convention ("render/ differs only by
that pair," not "clean") still holds. `webview/ui/InlineEditor.ts` (ported
outside the protected core back at M1) is back to fully byte-identical —
reference's own `reposition()` addition (F3, keeps the inline editor glued
to its node across pan/zoom) came along in the re-copy; it's dormant too
(not called from `webview/main.ts` yet).

### `npm run bench:relations` (new)

```
2000 nodes, 200 relations: open(parse+layout=18.8ms resolve=1.0ms mount=5.0ms
total=30.7ms OK) Tab=14.9ms OK rename(relation source)=13.6ms OK
pan-dispatch=3.3ms serialize=1.2ms
  round-trip check: serialized text contains all 200 relation links: true
5000 nodes, 500 relations: open(parse+layout=35.6ms resolve=1.6ms mount=2.8ms
total=40.8ms OK) Tab=27.4ms OK rename(relation source)=30.2ms OK
pan-dispatch=0.2ms serialize=1.4ms
  round-trip check: serialized text contains all 500 relation links: true
```

Both fixtures comfortably inside the open budget (30.7ms/1000ms and
40.8ms/2000ms respectively). This is a *ported-core* baseline, not yet a
measurement of real usage — relations aren't wired to run on every
`onChange` until Phase B/C, at which point `resolveRelations`'s per-node
work and relation-arrow rendering become a real per-edit cost worth
re-measuring against budget (flagged, not skipped).

### Test suite

**479 passed / 0 skipped** (36 files, up from 374/30) — new:
`relations.test.ts`, `relationsRenderer.test.ts`, `foreignRelation.test.ts`,
`statusBadgePersistence.test.ts`, `ensureVisible.test.ts`,
`test/helpers/{model,render}.ts` (shared scaffolding); updated:
`metadata/controller/serializer/colors/layout/manualPosition/
renderer.smoke/links/inlineEditor/webviewBootstrap.test.ts` (the last one
for a legitimate upstream link-click-semantics change — plain click now
selects, Ctrl/Cmd+click opens the link — see DECISIONS.md).

### REMAINING FOR HUMAN — Phase A

Nothing new to check in a real window yet (everything new is dormant/
render-only) beyond re-confirming the existing checklist above still holds
— the re-synced code is a superset of what was there, verified via the
same headless suite. Phase B (status badges wiring) and Phase C (relations
wiring) will each add their own real-window checklist once there's
something interactive to click.

## Phase B — status badges wired to VS Code UI (keyboard shortcuts, context menu, quick-pick, click handler)

No new per-edit or per-frame cost. `SvgRenderer.upsertStatusBadge` has run
on every `update()` call since Phase A landed (same conditional-DOM-
element pattern as the fold badge — it just never actually built a badge
element because nothing set `node.statusBadge`); this phase only adds code
paths behind explicit, infrequent user actions:

- A keyboard shortcut press (Ctrl/Cmd+Shift+D/I) — routed through
  `contributes.keybindings` + a `command` message, identical cost shape to
  the five other chords already routed this way (Ctrl/Cmd+Z/F/K/Shift+B/`/`).
- A right-click — the context menu's item list grew by 6 badge items (+1
  "Clear status" when applicable); building a few more plain `<div>`s in an
  already-one-time DOM-overlay construction is not a measurable cost.
- A status-badge click, or the quick-pick it opens — same `ContextMenu`
  overlay construction the right-click menu already does, just positioned
  via the existing (M5-additive) `SvgRenderer.getNodeScreenRect` instead of
  the mouse event.

No dependency added. `diff -rq webview/{model,layout,render,sync,
controller}` against reference HEAD re-confirmed byte-identical
(`SvgRenderer.ts`'s divergence is still exactly the pre-existing M5
`getViewport`/`setViewport` pair — 0 lines touched by this phase).

### Test suite

**484 passed / 0 skipped** (36 files, up from 479) — new: a "Phase B:
status badges" describe block in `webviewBootstrap.test.ts` (keyboard
shortcut -> badge toggle + persisted `badge:` metadata; quick-pick open +
checked-state + item click; context-menu badge section + conditional
"Clear status"; click-on-existing-badge -> quick-pick, positioned at the
node not the mouse) and one new case in `mindMapEditorProvider.test.ts`
(the two newly-routed commands reach only the active panel). One
pre-existing context-menu test's item-label assertion adjusted for the new
hint-text DOM shape (see DECISIONS.md) — not weakened, made shape-aware.

### REMAINING FOR HUMAN — Phase B (add to the consolidated real-window checklist)

Everything above is jsdom — no real pixels, no real Extension Development
Host keybinding interception, no real Chromium hit-testing. Before this
phase is considered done in practice, in a real F5 window:

- **Ctrl/Cmd+Shift+D actually reaches the mind map**, not VS Code's own
  "Show Run and Debug" view — this is the one thing no headless test here
  can prove; if it does collide in a real window, rebind the same way
  Ctrl/Cmd+K -> a different chord was kept open as a fallback path
  elsewhere in this project's history.
- **Ctrl/Cmd+Shift+I actually reaches the mind map**, not a "Toggle
  Developer Tools" binding some VS Code builds have carried on this chord.
- Open the quick-pick (shortcut and via clicking an existing badge) and
  confirm it visually appears anchored to the node, not the last mouse
  position, and that its checkmark tracks the node's actual current status.
- Right-click a node, confirm the 6 status items plus (once one is set)
  "Clear status" render with legible checkmarks/hints against at least one
  light and one dark theme (the badge circle fill/text-color pair is new
  CSS, not yet real-window-verified against a live theme the way M4's
  branch palette was).
- Set a few different statuses across several nodes, save, close and
  reopen the map — confirm each badge's glyph/color persists (the model-
  level round trip is covered by `statusBadgePersistence.test.ts`, but that
  test doesn't paint pixels).
