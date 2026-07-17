# Architectural Decision Records

Append-only log, newest entries at the bottom is the reference repo's
convention; this file is new, so it starts at M0 and will follow the same
convention going forward (new dated entries, don't edit old ones).

## 2026-07-16 — M0: port of the platform-free core from the Obsidian reference repo

**Context:** per the plan (§4 port-map table) and the task scope for this
milestone, `model/`, `layout/`, `render/`, `sync/`, and
`controller/Controller.ts` from `/Users/burakucbinli/projects/obsidian` are
platform-free TypeScript with zero Obsidian-API imports (confirmed by
grepping every file's import list before copying) and were ported into
`webview/model|layout|render|sync|controller` in this repo.

**Decision:** ported byte-for-byte, verified with `diff -r` against the
source directories — zero content changes. This was possible with zero
import-path edits inside the ported files themselves, because
`webview/<dir>/*` mirrors `src/<dir>/*`'s depth exactly (e.g.
`webview/controller/Controller.ts` importing `../model/types` resolves to
`webview/model/types.ts`, exactly as `src/controller/Controller.ts`'s same
import resolves to `src/model/types.ts` in the reference repo). Only the
**test suite's** imports needed rewriting (`../src/X` -> `../webview/X`),
and the four **bench scripts'** hardcoded path strings (`"src/sync/..."` ->
`"webview/sync/..."`).

**Alternatives considered:** none seriously — the task explicitly calls for
a verbatim port, and the code had no platform coupling to remove, so there
was nothing to redesign.

**Cost:** none measurable; see `benchmarks.md` M0 section — bench numbers on
this machine are in the same ballpark as the reference repo's own numbers
for the identical code, with a small constant-factor offset attributable to
machine/run variance, not a regression.

---

## 2026-07-16 — M0: two tsconfigs (host vs. webview) instead of one shared config

**Context:** the reference Obsidian plugin uses a single `tsconfig.json`
with `lib: ["DOM", "ES2020"]` for everything, because an Obsidian plugin
runs entirely inside the Electron renderer (one process, one global scope
mixing DOM and a few Node globals Obsidian polyfills). This extension does
not have that luxury: `src/extension.ts` runs in the **extension host**
(Node.js, no DOM at all) while `webview/*.ts` runs in the **webview**
(a browser sandbox, no Node globals at all) — CLAUDE.md rule 7 states this
split explicitly.

Trying to type-check both under one tsconfig with `lib: ["DOM", "ES2020"]`
plus the auto-included `@types/node` produces duplicate-identifier errors
(`fetch`, `AbortController`, and other globals are declared by both
`@types/node`'s bundled undici types and `lib.dom.d.ts`).

**Decision:** two tsconfigs — `tsconfig.json` (`lib: ["ES2020"]`, no DOM,
`@types/node` auto-included, covers `src/**/*.ts`) and
`tsconfig.webview.json` (`lib: ["DOM", "DOM.Iterable", "ES2020"]`,
`"types": []` to exclude `@types/node`, covers `webview/**/*.ts`).
`npm run build` type-checks both (`tsc -noEmit -p tsconfig.json && tsc
-noEmit -p tsconfig.webview.json`) before bundling. Both are `strict: true`
per the task requirement.

**Alternatives considered:**
- One tsconfig covering both, `skipLibCheck` papering over the conflict —
  rejected: `skipLibCheck` only skips checking `.d.ts` *library* files, it
  does not suppress duplicate-identifier errors between two libs both in
  scope; the conflict remains a hard compile error.
- One tsconfig with `types: []` globally and explicit `/// <reference
  types="node" />` only in `src/*.ts` files that need it — rejected as more
  fragile/manual than two small project configs, and it still doesn't
  prevent someone from `import`-ing a Node builtin from `webview/*` without
  a compile error to catch it (the whole point of the split).

**Cost:** two `tsc -noEmit` invocations instead of one — negligible
(hundreds of ms each on this codebase's current size); no runtime/bundle
cost, this only affects the type-check step, not the esbuild bundling step
(esbuild doesn't type-check at all, by design, in both the reference repo
and this one).

This is a build-correctness decision, not a performance-vs-X trade-off, so
it was not escalated under CLAUDE.md rule 3 — flagging that reasoning here
so it's auditable if it turns out to matter later.

---

## 2026-07-16 — M0: dropped the reference repo's `dev-vault/fixtures/` mirror copy

**Context:** the reference repo's `scripts/generate-fixtures.mjs` writes
every fixture twice: once to `fixtures/`, once to `dev-vault/fixtures/` (a
real Obsidian vault checked into that repo for manual testing). This
extension has no vault/workspace-folder equivalent bundled into the repo —
manual testing happens by opening any workspace folder in the Extension
Development Host (F5) and pointing it at a `.md` file, per this repo's
CLAUDE.md ("Manual verification happens in a real VS Code window").

**Decision:** ported `generate-fixtures.mjs` with the second `writeFileSync`
call (and the `DEV_VAULT_DIR` constant/`mkdirSync` call) removed; it now
writes only to `fixtures/`. Everything else (seeded PRNG, tree shape, link
density, serialization) is unchanged.

**Cost:** none — this is strictly less work per run, and the manual-testing
story (open `fixtures/*.md` directly in the Extension Development Host) is
equivalent in effect, just without a second on-disk copy.

---

## 2026-07-16 — M0: skipped `inlineEditor.test.ts` and `searchPanel.test.ts` — flagged as an open question, not a clean-cut Obsidian-API skip

**Context:** the task's skip criterion was "skip only tests that genuinely
depend on Obsidian APIs with no cheap fake." `test/inlineEditor.test.ts`
and `test/searchPanel.test.ts` target `src/view/InlineEditor.ts` and
`src/view/SearchPanel.ts` in the reference repo — and neither of those two
source files imports anything from `"obsidian"` (verified by grep before
this decision). They are, in fact, platform-free plain-DOM classes already,
same as everything else ported in M0.

The reason they weren't ported is different: the task's M0 port-map
explicitly lists only `model/`, `layout/`, `render/`, `sync/`,
`controller/Controller.ts`, and `types/d3-flextree.d.ts` — the plan's own
§4 port-map table puts `view/InlineEditor.ts`, `SearchPanel.ts`,
`LinkModal.ts` in a separate row (destination `webview/ui/*`) that the
roadmap (§9) assigns to M1 (webview bootstrap)/M2 (inline editing)/M3
(search panel), not M0.

**Decision made (provisional):** did not port `InlineEditor.ts` /
`SearchPanel.ts` early just to keep two tests green; skipped both test
files instead, with `describe.skip(...)` plus a comment explaining the
above, and the original test bodies preserved verbatim in a block comment
so re-enabling is a one-line diff once the source lands in M1/M2/M3.

**This is flagged as an open question for the user**, not a unilateral
call I'm confident is uncontroversial: an equally valid reading of the task
instructions is that these two tests should have stayed green, since the
skip criterion was specifically about Obsidian-API coupling and these files
have none — which would mean porting `InlineEditor.ts` and `SearchPanel.ts`
(~280 lines combined, zero risk, they're leaf DOM classes with no
dependencies on anything not already ported) into `webview/ui/` now, ahead
of the roadmap's stated milestone for that work. See the M0 completion
report for the explicit question and both options.

**Cost of either option:** negligible either way — this is a scope
question, not a performance question, which is why it wasn't escalated
under CLAUDE.md rule 3 (that rule is specifically for performance-vs-X
trade-offs). Flagging per the spirit of "ask rather than guess" anyway,
since it's a real fork in what "M0 done" means.

**Follow-up (2026-07-16, M1):** resolved by the user — port them now. Done:
`webview/ui/InlineEditor.ts` and `webview/ui/SearchPanel.ts` ported verbatim
(byte-identical), both test files re-enabled with only the import path
changed; suite fully green. `LinkModal.ts` stays deferred to M3: it
genuinely extends Obsidian's `Modal` and builds its UI with Obsidian's
`Setting` helper, so it must be rewritten as a plain DOM overlay per the
plan's port-map table, not ported.

---

## 2026-07-16 — M1: host->webview document bridge — ready-handshake, version gate, debounced external-edit forwarding

**Context:** M1 needs the document text in the webview (on open, and again
after edits made in a side-by-side text editor). Three VS Code-specific
hazards shaped the design:

1. `postMessage` into a webview whose script hasn't registered its
   `message` listener yet is silently lost — so the webview posts
   `{type:"ready"}` first and the host replies with the document. This
   also self-heals the `retainContextWhenHidden: false` reload case: a
   hidden->revealed webview re-runs its script, re-sends "ready", and gets
   re-synced without any host-side visibility tracking.
2. Message delivery order isn't contractual — every `setDocument` carries
   `TextDocument.version`, and the webview drops any message whose version
   is <= the version already rendered (the coordinator-required version
   gate).
3. Unlike Obsidian's vault `modify` event (fires on save),
   `onDidChangeTextDocument` fires **per keystroke** when the user types
   in a split text editor. Forwarding each event would make the webview
   full-re-parse + fresh-mount per keystroke — the exact architectural
   anti-pattern CLAUDE.md rule 6 names. The host therefore debounces
   forwarding (300 ms provisional default), and because the debounced
   callback reads `document.getText()`/`.version` at fire time, it always
   ships the newest state — intermediate keystrokes are skipped, never
   queued.

**Decision:** ready-handshake + version gate + 300 ms trailing-edge
debounce in `src/MindMapEditorProvider.ts`. The debounce *mechanism* is
plan-approved (§11 risk table: "Debounce + version-gate reconciliation");
the *value* (300 ms) is a provisional default flagged in the M1 report — it
becomes a user-visible setting in M4 alongside the write-back delay, and is
trivially changeable (a single constant).

**Alternatives considered:** forwarding raw change events and letting the
webview debounce — rejected: it ships one full document text across the
process boundary per keystroke (serialization cost scales with document
size, per-keystroke, for zero benefit). Sending diffs instead of full
text — the plan (§6) marks this "ideally" for later; full-text is the
approved starting point, measured before optimizing.

**Cost:** one full-document string copy across the process boundary per
debounced external edit; at 5,000 nodes the fixture is ~200 KB, well under
any per-interaction budget since it never happens on the keystroke path of
the mind map itself (CLAUDE.md rule 7 — the interaction loop never crosses
the boundary; this path only runs when the *other* editor changed the
file).

---

## 2026-07-16 — M1: webview bootstrap mirrors the reference view's build/rebuild paths (carried over from reference)

**Context:** `webview/main.ts` is the rewritten equivalent of the reference
repo's `MindMapView.ts` (the one "real porting work" row in the plan's §4
table). All render-pipeline behavior was already decided and user-approved
in the reference repo.

**Decision:** `buildFromScratch()` (parse -> assignMissingColors ->
assignMissingSides -> computeLayout -> Controller -> SvgRenderer.mount, with
click-to-select / ctrl-toggle / shift-range / background-clear wiring) and
`rebuildFromExternalText()` (full re-parse + fresh mount with first-level
color/side carry-over by structural position and selection preservation via
`findEquivalentNode`) are line-for-line transcriptions of the reference's
`buildFromScratch()` / `onVaultModify()` with the M2/M3 wiring omitted (not
stubbed): no inline editor, no write-back/serialize tail in `onChange()`,
no dblclick/fold/link/image/context-menu/drag handlers, no keyboard map.
Carried over from reference: full re-parse on external edit (explicitly
allowed by the plan as the M2 fallback; incremental re-parse is a logged
non-implemented optimization there too), pan/zoom/culling/dirty-tracking
all inside the ported `SvgRenderer` untouched.

**Cost:** measured — see `benchmarks.md` M1 section (`npm run bench:open`):
the full open path (parse+colors+sides+layout+mount) is 17.1 ms for 2,000
nodes and 32.5 ms for 5,000 in jsdom, 1.7% / 1.6% of the respective
budgets. Real-window paint cost remains unverified (no VS Code window in
this environment — flagged, not claimed).

---

## 2026-07-16 — M2: undo/redo integration (plan trade-off #9) — webview-local command stack, document undo left alone

**Context:** plan §3.3 trade-off #9 flags that VS Code's document undo
stack and a webview-local command stack can fight if both are wired to
Ctrl/Cmd+Z. This is a performance/architecture trade-off, not a cosmetic
one: routing undo through the document's `WorkspaceEdit` stack would mean
every undo step is a host round-trip plus a full external-edit
reconciliation in the webview — the exact "no interaction may block on a
host round-trip" violation CLAUDE.md rule 7 forbids. The reference repo
already ported a platform-free `commandStack.ts` (100-edit cap, ported
verbatim into `webview/model/commandStack.ts` in M0) built exactly for
this purpose.

**Decision (user-confirmed 2026-07-16, resumed after a paused session):**
undo/redo stays entirely inside the webview, using the ported
`CommandStack` (100-edit cap, unchanged). `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`
(and `Ctrl/Cmd+Y` on Windows/Linux) are captured by
`contributes.keybindings` scoped to
`when: activeCustomEditorId == 'mindmapView.editor'` and forwarded to the
webview as messages; the webview calls `CommandStack.undo()`/`.redo()` and
re-renders + re-serializes exactly like any other local mutation (same
debounced write-back path). VS Code's own document undo stack is left
alone — it still works for anyone editing the file as plain text in a
split view, since that path never touches the webview's command stack.

**Consequence for write-back:** because undo/redo produces a new model
state synchronously in the webview, it schedules a write-back exactly like
Tab/Enter/rename/delete do — no special-casing needed at the sync layer.

**Alternatives considered:**
- Route undo through `WorkspaceEdit`/document undo — rejected: every undo
  keystroke would need a host round-trip (apply edit -> host fires
  `onDidChangeTextDocument` -> webview reconciles) before the screen
  updates, violating rule 7's "keystroke -> screen must never cross the
  process boundary." It would also fight with self-write suppression
  (undo's resulting edit looks identical to the webview's own last
  write-back, needing extra bookkeeping to disambiguate "my own undo" from
  "an external revert").
- Two independent undo stacks both bound to Ctrl/Cmd+Z (document's default
  behavior left registered, plus the webview's) — rejected: VS Code would
  route the keystroke to whichever has focus, which is ambiguous/surprising
  for a canvas-like webview with no visible text cursor; a single
  scoped-keybinding source of truth avoids the fight entirely.

**Cost:** none beyond what's already paid for by the ported CommandStack
(100-edit cap bounds memory; push/undo/redo are O(1) — see the reference
repo's own commandStack benchmarks, unchanged since the port is
byte-identical). No new dependency.

---

## 2026-07-16 — M2: write-back path — webview-side debounce, full-document `WorkspaceEdit`, text-comparison self-write suppression

**Context:** plan §6 leaves two things open for M2 to settle: where the
400 ms write-back debounce lives, and how the host tells its own
write-back apart from a genuine external edit (needed so it doesn't
immediately forward its own edit right back into the webview as if
someone else had changed the file — that would be wasted work at best,
and a re-entrant rebuild racing the edit that produced it at worst).

**Decision:**
1. **Debounce lives in the webview** (`webview/main.ts`'s `scheduleWrite`,
   ported `sync/debounce.ts`), not the host. Every local mutation
   (keystroke-driven or not) re-serializes and restarts a 400 ms timer;
   only the final state after the last mutation in a burst crosses the
   process boundary via a `writeDocument` postMessage. This mirrors the
   reference's own `scheduleWrite`/`debounce` placement (in the view, not
   a vault-side scheduler) and keeps with rule 7: the host never has to
   run its own throttling logic to protect itself from a chatty webview.
2. **Full-document replace** (`WorkspaceEdit.replace` over the whole
   document range), not minimal ranges — trade-off #10's own stated
   starting point ("start with full replace, measure, ask if it
   matters"). Not revisited here: `bench:m2`'s serialize numbers (<1.1 ms
   even at 5,000 nodes) and the write-back's own debouncing mean this
   isn't remotely near the write-back budget; minimal-range edits would
   only matter for the split-view *text editor's* viewport/decoration
   stability while the map is mid-edit, which is a real but separate
   concern (noted below, not solved in M2).
3. **Self-write suppression by text comparison**, not a synchronous
   "I'm mid-edit" flag: `MindMapEditorProvider` tracks `lastAppliedText`
   (the text it just told `applyEdit` to write) and compares every
   `onDidChangeTextDocument`'s resulting `document.getText()` against it;
   a match means "this is my own write echoing back," not an external
   edit, and is never forwarded to the webview. A boolean flag bracketing
   the `applyEdit` call was considered and rejected — `applyEdit` crosses
   to the renderer process and back, so there is no reliable synchronous
   window to set/clear a flag around; the change event can fire on
   either side of any `await`. Text comparison is correct regardless of
   that ordering. Verified in `test/mindMapEditorProvider.test.ts` with a
   fake `vscode` module whose fake `applyEdit` fires the change listener
   after a real async hop (not synchronously), specifically to catch a
   flag-based approach that would have looked correct under a naive
   synchronous test.
4. **Webview-side conflict guard, mirroring N2** ("never silently drop
   either side"): the webview also tracks its own `lastWrittenText` vs.
   its current serialized `data`; if a genuinely-external `setDocument`
   arrives while that diff is nonzero (a local edit not yet flushed by
   the debounce), the webview keeps its own state, lets the pending
   write proceed as scheduled (which will overwrite the external edit —
   last-local-write-wins), and posts a `showWarning` message so the host
   can surface a `vscode.window.showWarningMessage` notice. This is the
   direct port of the reference's `hasPendingWrite` check in
   `onVaultModify` (text-diff based, not a boolean "a write is
   scheduled" flag — the first attempt used a boolean and it produced
   false positives on plain selection-change re-serializations, which
   don't actually change `data`; fixed by switching to the same
   content-comparison the reference uses). Covered by
   `webviewBootstrap.test.ts`'s "external setDocument arriving while a
   local edit is still unwritten" test.

**Alternatives considered:** debouncing at the host (buffering
`writeDocument` messages there instead) — rejected as strictly worse:
it would mean the webview posts a message on every keystroke-driven
mutation (message-passing cost scales with keystrokes, not edits), and
gains nothing, since the host has no other reason to throttle once the
webview already does.

**Known limitation, not solved in M2 (flagging per N2's "never silently
drop" spirit rather than treating as closed):** if an external edit lands
*after* the webview's debounce window has already started but the
`writeDocument` message hasn't posted yet — i.e., faster than the
webview's own conflict-guard can observe it as "pending" — the
subsequent write-back will still overwrite it (last-local-write-wins).
This is the same race the reference plugin accepts (`hasPendingWrite`
only catches it if the external change arrives *after* the local diff
exists, not intra-debounce-window micro-races), so it is not a new gap
introduced here — noted for M5 hardening pass, not re-litigated now.

**Cost:** measured — see `benchmarks.md`'s M2 section for `bench:m2`
serialize numbers and bundle size; no change to the ported
model/layout/render code, so `bench:m1`/`bench:open` are unchanged from
M1's baseline.

---

## 2026-07-17 — M3: LinkModal and node context menu rewritten as plain DOM overlays

**Context:** the plan's port-map table (§4) already calls out `LinkModal.ts`
as needing "minor" rewrite work ("no Obsidian Modal class — plain DOM
overlay") — it genuinely extends Obsidian's `Modal`/`Setting`, unlike every
other `view/*` file, which are plain DOM classes ported verbatim in M0/M1.
The node right-click menu (R17) has the same shape of problem, one level
up: the reference builds it with Obsidian's native `Menu` class
(`showAtMouseEvent`), which has no VS Code webview equivalent — a webview
cannot summon the host's native context menu for a list of arbitrary custom
items.

**Decision:** both are new, small, dependency-free DOM classes in
`webview/ui/` — `LinkModal.ts` (a centered overlay with a dim backdrop:
display-text input, link-type `<select>`, target input + description,
Remove/Save buttons) and `ContextMenu.ts` (an absolutely-positioned item
list at the click point, optional separators, disabled items, closes on
Escape or an outside pointerdown). Both follow the exact same conventions
already established by `InlineEditor`/`SearchPanel`: host-relative absolute
positioning, `stopPropagation` on their own keydown so the mind map
canvas's global shortcuts don't fire while typing/navigating inside them,
and a `destroy()`/`onClose` contract. Field set and item set are otherwise
identical to the reference (same labels, same save/remove semantics, same
menu items minus icons — no icon font is wired up, and none of the other
ported UI uses one either).

**Alternatives considered:**
- A native HTML `<menu type="context">` / browser context menu — rejected:
  deprecated and unsupported in current browsers/Electron, and it can't be
  triggered programmatically with custom items anyway.
- VS Code's own `vscode.window.showQuickPick`/`showInputBox` (host-side UI)
  for the link editor and context menu — rejected on rule 7 grounds: both
  would be a host round-trip per keystroke/selection (QuickPick filters as
  you type, over `postMessage`), which is exactly the "interaction loop
  crosses the process boundary" pattern rule 7 forbids for something that's
  purely a rename/menu-selection with no host-side data dependency.

**Cost:** ~4 KB combined raw, no new dependency (plain DOM + CSS, same as
`InlineEditor`/`SearchPanel`) — see `benchmarks.md`'s M3 bundle-size entry.
Test coverage: `test/linkModal.test.ts` (8 tests) and
`test/contextMenu.test.ts` (6 tests), new.

---

## 2026-07-17 — M3: links (R5) open via a host message, `vscode.open`/`openExternal`, no in-webview navigation

**Context:** clicking a link/image inside the webview can't do anything by
itself — a webview has no ambient permission to navigate elsewhere or open
files, and per rule 7 the host must still never own the interaction *loop*,
just the one-shot platform action a click requests. The reference's
`openLink`/`openImage` split (current tab vs. new tab, so the map stays
open) doesn't have a VS Code equivalent worth keeping: a mind map custom
editor tab and whatever `vscode.open` opens for a link target are always
*different* tabs (the custom editor can never be replaced by a link
click's target), so there is nothing to distinguish.

**Decision:** both link and image clicks post the same
`{type:"openLink", kind, target}` message. The host
(`MindMapEditorProvider.openLink`) checks for a URL scheme
(`/^[a-z][a-z0-9+.-]*:\/\//i`, same regex the reference uses) — a match
opens via `vscode.env.openExternal`; anything else is resolved as a path
relative to the *document's own* directory (there is no vault-wide link
index to consult, unlike Obsidian's `openLinkText`/
`getFirstLinkpathDest` — a wikilink target gets `.md` appended if it has no
extension, an `mdlink` target is used as-is) and opened via the built-in
`vscode.open` command, which picks a sensible editor for whatever it
resolves to on its own.

**Alternatives considered:** a vault-wide fuzzy link index (matching
Obsidian's basename-based resolution across the whole workspace) — out of
scope for M3 parity; VS Code has no equivalent primitive, and building one
means indexing every markdown file in the workspace, a real feature in its
own right, not a wiring task. Flagging as a known parity gap, not silently
matching Obsidian's more powerful resolution.

**Cost:** none measurable — one message/one host-side path resolution per
link click, off the interactive render loop entirely.

---

## 2026-07-17 — M3: Ctrl/Cmd+M toggle and "Go to section" share one flush mechanism (flushWrite/flushAck), not an arbitrary timeout

**Context:** both features need the host to be sure the document is fully
current before it acts (swap editor kind; reveal a line) — but the
serialized model only exists in the webview, and the write-back is
debounced 400ms. A host awaiting an arbitrary fixed delay ("wait 500ms and
hope") would either race a slow webview or add needless latency to the
common "nothing was pending" case.

**Decision:** a small message pair. The host posts
`{type:"command", name:"flushWrite"}`; the webview's `handleCommand`
handles it *before* the usual `if (this.inlineEditor || !this.controller)`
guard (unlike every other command) — cancels the pending debounce timer,
writes immediately if `data !== lastWrittenText` (posting `writeDocument`
first, synchronously, if so), then unconditionally posts `{type:
"flushAck"}`. The host's `MindMapEditorProvider.flush()` awaits that ack,
then awaits `PanelEntry.lastWriteback` — the promise the `writeDocument`
handler assigned, which (thanks to in-order message delivery) is already
set to *this* flush's own write by the time the ack arrives. No timeout,
no polling: the wait is exactly as long as it needs to be, zero when
nothing was pending.

**Alternatives considered:** a fixed `setTimeout` before proceeding —
rejected as both unsafe (a slow/large document's serialize+write could
exceed any fixed budget) and wasteful (the overwhelmingly common case, no
pending edit, would still pay the full delay). Doing the flush check
host-side by comparing document text against some cached "expected" value —
rejected: the host has no visibility into the webview's in-memory `data`
until a message tells it, so there's nothing to compare against without
the webview's participation anyway.

**Cost:** two tiny messages per toggle/go-to-section — happens once per
user action, not per keystroke, nowhere near a budget.

---

## 2026-07-17 — M3 bug found and fixed (webview/main.ts only): `ensurePersistentIds`' id-mint could silently desync the renderer's DOM and the controller's own selection

**Context:** found while writing integration tests for folding (R13) —
folding a node, then immediately clicking its own fold badge *again* to
unfold, silently did nothing. Root cause, confirmed with a minimal
reproduction against the ported `Controller`/`SvgRenderer` directly (not a
jsdom/test artifact — this reproduces with genuine fresh DOM hit-testing,
not a stale captured reference): `ensurePersistentIds` (ported,
`sync/metadata.ts`) mints a fresh, non-synthetic block id the *first* time
a node gains persistable metadata (first fold, first manual position R12,
first manual-width resize) and mutates `node.id`/`model.byId` in place.
The (reference-identical) `onChange()` order called it *after*
`renderer.update()`/`setSelection()` — so the DOM element `SvgRenderer`
had just keyed under the *old* id, and `Controller.selectedId`/
`selectedIds` (plain string/Set fields the Controller never revisits) if
they held that id, are left holding a value `model.byId` no longer
recognizes. The next click on that exact node (badge, drag, dblclick,
resize — anything that resolves via `dataset.nodeId` -> `byId.get(id)`)
silently no-ops, because every `Controller` mutation method starts with
`model.byId.get(nodeId)` and bails on a miss.

This is not something introduced by M3's wiring — it's inherent to code
that was already byte-identically ported in M0/M1 (`ensurePersistentIds`,
`SvgRenderer`'s id-keyed DOM maps) and an `onChange()` order that was
itself a line-for-line transcription of the reference (see the M1 entry
above). It went unnoticed through M1/M2 only because neither ever created
persistable metadata on an already-mounted node — folding/manual-position/
manual-width are exactly the M3 features that do.

**Decision:** fixed entirely in `webview/main.ts` (unprotected — no ported
core file touched, verified with `diff -rq` below), not by touching
`sync/metadata.ts` or `controller/Controller.ts`. Added
`MindMapApp.reconcilePersistentIds()`, called from `onChange()` *before*
`renderer.update()`/`setSelection()` (reordered relative to
`ensurePersistentIds`, which the reference calls last): it captures the
actual `MindNode` object (not just the id string) behind
`selectedId`/each member of `selectedIds` *before* calling
`ensurePersistentIds`, then re-reads `.id` off those same objects
afterward — object identity survives the rename even though the id string
doesn't, so this is correct regardless of how many ids got minted that
cycle, without needing `ensurePersistentIds` itself to report what
changed. Reordering also means `renderer.update()` sees the *final* ids
for this render, so `SvgRenderer`'s own id-keyed maps churn (one clean
create/destroy for the just-renamed node) within the same synchronous
call that caused the rename, instead of silently drifting until some
unrelated future full remount fixed it by accident.

**This was not escalated under rule 3** — it's a plain correctness bug fix
with no performance-vs-anything trade-off (the extra work is a handful of
Map lookups over the current selection, not a full-tree walk, and only
runs on the already-infrequent "a node just became persistable" edit).
Flagging it as its own dated entry anyway because of where it lives:
believed to reproduce identically in the reference Obsidian plugin (same
ported files, same call order there), not verified against that repo in
this session — noted for the user's awareness, not silently carried over
as "reference behavior, therefore correct."

**Cost:** negligible — one extra pass over the current selection (typically
0-1 nodes, occasionally more under multi-select) per model mutation;
`ensurePersistentIds` itself is unchanged (still O(n) over the whole tree,
same as before, ported unchanged). Regression-tested by
`test/webviewBootstrap.test.ts`'s fold-badge-toggle-twice and
Ctrl/Cmd+/-toggle-twice tests, which fail without the fix (verified before
applying it).

---

## 2026-07-17 — M3: two escalations deliberately left undecided (per CLAUDE.md rule 3 / the task's explicit forks)

Not decisions — recorded here so the append-only log shows they were
surfaced, not silently resolved one way:

1. **"Go to section" open semantics.** `resolveGoToTarget` (ported) plus a
   small webview-side line-number resolver (blockid/heading/line ->
   0-based line in the current document) are fully wired, and the pending
   write is flushed (see the flushWrite entry above) before the host is
   asked to do anything — but `MindMapEditorProvider`'s `goToSection`
   handler deliberately does not reveal the line; it shows an information
   message stating the decision is pending, rather than guessing at new
   column vs. replace-tab vs. Reopen-With-text semantics.
2. **Clipboard image paste scope.** Ctrl/Cmd+V is fully wired for text
   (OS-clipboard text vs. the internal clipboard, `parseExternalPaste` for
   external content) — the reference's `pasteClipboardImage` (write a
   clipboard image into the vault, insert an embed) is not implemented at
   all; M3 vs. M4 scope for it is the open question.

See the M3 completion report for both questions stated with options and a
recommendation.

---

## 2026-07-17 — M3: intercepted-chord enumeration, and `.vscode/launch.json`/`tasks.json` added without an automatic build task

**Context:** the task asked to enumerate every chord VS Code may intercept
before the webview and wire each through `contributes.keybindings`, same
mechanism as M2's undo/redo. Six chords total needed this (Ctrl/Cmd+Z was
M2's): Ctrl/Cmd+F (search — VS Code's own Quick Find), Ctrl/Cmd+K
(a *chord prefix* in VS Code's default keymap — pressed alone it always
enters "waiting for second key" mode, so this one is unconditionally
captured, not just conditionally by a competing default binding),
Ctrl/Cmd+Shift+B (Windows/Linux default: `workbench.action.tasks.build`),
Ctrl/Cmd+/ (default: `editor.action.commentLine`, normally
`editorTextFocus`-gated so it likely wouldn't fire against a webview
anyway — included regardless, since the task named it explicitly and the
cost of a belt-and-suspenders keybinding is zero), and Ctrl/Cmd+M (R20's
own toggle, two directions/two `when` clauses — see the flushWrite entry
above for the mind-map-to-text direction). Alt+Up/Down (keyboard reorder),
Ctrl/Cmd+C/X/V (clipboard), and Ctrl/Cmd+Home (center-on-root) were *not*
added to `contributes.keybindings` — none of VS Code's own default
keybindings for those chords apply outside actual text-input focus, so
they reach the webview's own keydown handler the same way Tab/Enter/
Delete/arrows already did in M2.

The repo had no `.vscode/launch.json` at all, making F5 (Extension
Development Host) impossible without hand-writing one first.

**Decision:** `.vscode/launch.json` — one standard `extensionHost`
configuration, no `preLaunchTask`. `.vscode/tasks.json` — one convenience
`npm: dev` (esbuild watch) background task, available via "Tasks: Run
Task" but *not* wired as the default/auto-run build task.

**Alternatives considered:** wiring `npm run dev`'s esbuild watch context
as `launch.json`'s `preLaunchTask`/`tasks.json`'s default build task (the
common Yeoman-extension-generator pattern) — rejected: `esbuild.config.mjs`
watch mode never exits, and VS Code's task system needs either a
`isBackground: false` task (which would then block F5 forever waiting for
a process that never completes) or a `background` problem-matcher with
`beginsPattern`/`endsPattern` regexes matched against esbuild's actual
watch-mode log lines — guessing at that format and shipping it unverified
risked a *broken* F5 (worse than the status quo of "no launch.json at
all", which is at least an obvious, immediately-visible gap). The user
runs `npm run build` (one-shot) or `npm run dev` (watch, in a separate
terminal) before F5 instead — noted in the M3 report, not silently assumed.

**Cost:** none — these are editor/tooling config, not shipped in the
extension bundle.

---

## 2026-07-17 — M3: both escalations resolved by the user

Follow-up to the "two escalations deliberately left undecided" entry above —
the user decided both; recording the resolutions (append-only, so the
earlier "surfaced, pending" entry stays as the historical record).

1. **"Go to note section" open semantics → open in a NEW COLUMN BESIDE
   (user-decided).** `MindMapEditorProvider.goToSection(document, line)`
   now calls `vscode.window.showTextDocument(document, { viewColumn:
   vscode.ViewColumn.Beside, selection: <zero-width range at the target
   line> })` instead of the previous information-message stub. The mind
   map tab itself stays open and untouched — the least-destructive of the
   three options considered (new column / replace tab / Reopen-With text),
   and the closest match to the reference plugin's own "always opens in a
   new tab" behavior. The target line is clamped to `document.lineCount-1`
   defensively (the webview resolves it against its own just-flushed
   serialization, which is the same text now in `document`, so they agree,
   but an out-of-range selection costs nothing to guard against).

   **Coexistence with `supportsMultipleEditorsPerDocument: false`:** that
   option forbids two *custom* (mind map) editors on one document, not a
   custom editor plus a plain text editor on the same document — which is
   the exact same arrangement M2's split-view bidirectional sync already
   relies on and is tested against. No conflict; verified by
   `test/mindMapEditorProvider.test.ts`'s new "opens ... in the column
   beside ... revealing the resolved target line" and out-of-range-clamp
   tests.

2. **Clipboard image paste scope → DEFER TO M4 (user-decided).** Text-only
   paste ships in M3 exactly as it was (OS-clipboard text vs. the internal
   clipboard, `parseExternalPaste` for external content). The reference's
   `pasteClipboardImage` (write an OS-clipboard image into the workspace,
   insert an embed node) is **not** implemented in M3 and moves to M4:
   it needs host-side workspace file writes (`workspace.fs` / an
   attachment-path resolver) and shares essentially all of that plumbing
   (attachment path resolution, `asWebviewUri` conversion) with M4's
   image-*display* work (R18) — implementing it in M3 would mean building
   and testing that plumbing twice. No image-save path was built in this
   milestone. Recorded as M4 scope in `PROGRESS.md`.
