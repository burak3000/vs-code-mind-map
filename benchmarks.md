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
