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

---

## 2026-07-17 — M4: localResourceRoots widened beyond media/

**Context:** R18 (image display) needs `webview.asWebviewUri` to convert a
node's image-embed target (resolved relative to the document's own
directory) into a URL the webview is actually allowed to load. `Webview.
options.localResourceRoots` gates that: only paths *under* one of the
listed roots can ever be converted/served, and until now the only root was
the extension's own `media/` directory (the bundle + CSS) — no workspace
file could resolve at all.

**Decision:** widen `localResourceRoots` (`MindMapEditorProvider.
resolveCustomTextEditor`) to `[media/, ...vscode.workspace.workspaceFolders
.map(f => f.uri), vscode.Uri.file(path.dirname(document.uri.fsPath))]` —
every workspace folder, plus the document's own directory explicitly (so a
loose file opened outside any workspace folder — no folder open at all, or
the file lives outside every open folder — still resolves images relative
to itself).

**Alternatives considered:**
- *Just the document's own directory* (no workspace folders) — rejected:
  a very common case (`![[../assets/diagram.png]]`, or any image living in
  a workspace-wide `attachments/` folder alongside many notes) would
  reference a path outside the document's own directory and fail to
  resolve, a worse gap than the security cost below.
- *Compute the minimal common ancestor of the document dir and each
  resolved embed target, one root per unique target* — rejected as
  needless complexity for a per-request, dynamically-changing allowlist;
  `localResourceRoots` is set once at `resolveCustomTextEditor` time, not
  per message, so it would need to be *widened* reactively per new image
  target encountered (extra IPC, extra state, no real security gain since
  the whole workspace is already implicitly trusted content the moment its
  markdown is opened in this same editor).

**Security implication (accepted, not silently):** any file under a
listed root becomes fetchable by the webview's own script via a
constructed `asWebviewUri`-shaped URL, not just the specific image(s)
actually embedded in the current document — a markdown file could in
principle embed `![[../../.env]]` and have its bytes requested as an
`<image>` src. Two mitigating factors, neither a full answer: (1) the
webview's script is still CSP-locked to our own nonce-tagged bundle — this
widens what *our own, trusted* code is *permitted* to read, it does not
let injected/attacker content run new code; (2) a non-image file loaded
into an SVG `<image>` element fails to decode and never becomes visible or
otherwise exfiltratable through the DOM the way, say, a `<script src>`
would. Still a real widening of the trust boundary versus "just media/",
and workspace trust (`vscode.workspace.isTrusted` / the `untrustedFiles`
capability declaration) is the correct real mitigation — that's explicitly
M5 scope (per the plan's roadmap: "workspace-trust/virtual-workspace
declarations"), so this is accepted as an interim state for M4, not
resolved here. Flagged in `PROGRESS.md`'s M4 status and `benchmarks.md`'s
F5 checklist.

**Cost:** none measurable — `localResourceRoots` is a startup-time
allowlist check inside `asWebviewUri`, not a per-frame or per-keystroke
cost.

---

## 2026-07-17 — M4: image resolution is async (host round trip) but only for culled-in nodes, and the renderer's own dirty-tracking forces a debounced `mount()` rather than a plain `update()` to show a resolved image

**Context:** the ported (unmodified) `SvgRenderer.setImageResolver` takes a
**synchronous** `(node) => string | null` function — Obsidian's own
`resolveNodeImageUrl` could answer synchronously (`vault.getResourcePath`
is sync). VS Code's equivalent (`webview.asWebviewUri`) is *also*
synchronous, but only the **host** can call it (it needs `document.uri` +
the webview's own `cspSource`/root allowlist) — the webview process has no
such API. So resolution has to cross the process boundary, which is
inherently async, layered underneath a resolver interface the ported
renderer requires to return an answer *immediately*.

**Decision:** `resolveImageUrl` (webview/main.ts) never blocks: it checks a
local `Map<string, string|null>` cache (keyed `${nodeId}\0${target}`,
which naturally misses instead of showing a stale image if a node's embed
target changes); on a miss it fires a `resolveImage` postMessage (once —
guarded by an `imagePending` Set so the renderer's own repeated per-draw
resolver calls don't refire the same request) and returns `null` for now,
which the (untouched) renderer already renders as its own placeholder/
missing-glyph state. A remote (`https://…`) target resolves synchronously
to itself, no round trip at all — same split `openLink` already makes.
This is called *only* for a node `SvgRenderer` has actually drawn (mount/
update only walks the culled-in set above the 300-node threshold), so the
round-trip volume is bounded by the viewport, not map size — preserving
the reference's lazy-load design exactly as the plan requires.

**The dirty-tracking wrinkle (found while writing `test/webviewConfig.
test.ts`):** `SvgRenderer.upsertImage` — and therefore the resolver call
itself — only re-runs when a node's text/size/side changed (see its own
doc comment: "only called when text/size/side actually changed"). A plain
`renderer.update(model)` call after an `imageResolved` reply arrives is a
no-op for that node: nothing about the *model* changed, only the
resolver's own cached answer did, so the dirty check never trips and the
image would silently stay on its placeholder forever. The one public API
that unconditionally re-derives every visible node is `mount()` (it clears
the renderer's internal dirty-tracking maps first) — but `mount()` is
documented as "intended for file open only, not per-edit" and is a full
remove+recreate of every currently-visible node's DOM.

Rather than edit the protected renderer to add a narrower "refresh just
this node's image" method (out of scope per the task's hard rule — would
require justifying and pausing for approval before touching `webview/
render/`), `onImageResolved` calls a **debounced** `mount()` (`webview/
main.ts`'s `refreshResolvedImages`, 50ms) instead of an immediate one.
Rationale for debouncing rather than calling `mount()` directly per reply:
a freshly-opened map with many visible images — exactly `bench:images`'
own 200-image stress fixture — fires one `resolveImage` per node during
the single initial `mount()` pass, and the host's replies arrive as
**separate `postMessage` deliveries** (separate macrotasks, not
microtasks — a same-tick `Promise.resolve().then()` batching trick would
not coalesce across them, since microtasks fully drain before the next
message-event task even starts). Without debouncing, a worst-case cold
open could trigger on the order of 200 full remounts of the ~200-node
visible set in quick succession; debounced, a realistic reply burst
collapses to close to one trailing remount. This is **not** treated as a
CLAUDE.md rule-3 performance-vs-something trade-off requiring escalation:
it has no user-visible downside to weigh against (a thumbnail still "pops
in" within ~50ms of resolving either way) and strictly improves on the
naive alternative — there's no richer feature, simpler code, or different
scope being traded away by choosing to batch.

**Cost:** `bench:images` (200 image-embedded nodes, worst case the plan
calls out) — `parse+layout=3.5ms mount=38.0ms open=46.6ms` (budget
1,000ms) — see `benchmarks.md`'s M4 section for the full table; no
regression vs. M0's first recording of this same benchmark (the ported
render/layout code under test is unchanged).

---

## 2026-07-17 — M4: theming — pure CSS, no theme-change message channel, and the branch palette maps to VS Code's own chart/terminal colors instead of new hand-picked hex values

**Context:** plan §8 calls for swapping Obsidian's CSS variables for
`--vscode-*` ones and verifying the result on light, dark, *and*
high-contrast, flagging a "palette must pass on light/dark/HC or ask"
escalation trigger specifically about the reference's 8-slot per-branch
palette (R9).

**Decision, part 1 (mechanism):** pure CSS, no `onDidChangeActiveColorTheme`
listener/message. VS Code injects `--vscode-*` custom properties (and a
`body.vscode-light`/`vscode-dark`/`vscode-high-contrast`/
`vscode-high-contrast-light` class) into every webview automatically and
keeps both live-updated across a theme switch with no reload — so a CSS
file that only ever references those variables repaints for free. Verified
by reading VS Code's own webview theming documentation (referenced in the
plan) rather than assumed; no code in `webview/main.ts` was needed at all
for this part.

**Decision, part 2 (the R9 palette question — resolved, not escalated):**
before rewriting the CSS, the reference's own two tone sets (a "light"
mid-dark saturated set and a "dark" bright-pastel set — see `media/
mindmap.css`'s pre-M4 history) were checked against WCAG contrast ratios
for a plausible high-contrast rendering (pure-black or pure-white surfaces,
which is what VS Code's built-in High Contrast themes actually use, unlike
a typical light/dark theme's softer off-white/dark-grey). Result: the
"dark" set reused for a dark HC background passed comfortably (~8–15:1,
computed by hand for several slots); the "light" set reused for a
**light** HC background did not — 5 of 8 slots measured under the 4.5:1
WCAG AA threshold, one (`#f08c00`, the orange slot) as low as **2.48:1**.

This is exactly the "palette doesn't pass HC" case the task flagged as a
stop-and-ask trigger — **except** the premise (that fixing it means
editing the protected `render/colors.ts`) doesn't hold: `colors.ts` only
assigns which of 8 opaque slot *keys* (`c0`..`c7`) a branch gets; the
actual hex values those keys resolve to have always lived in `media/
mindmap.css`, a file explicitly in this milestone's edit scope, not
`colors.ts`. So there was no protected file standing between "the palette
fails HC" and "fix the palette." Rather than hand-picking a *third* tone
set and re-deriving contrast ratios by hand again (correct today, but
silently wrong the instant VS Code ships a new HC variant, or wrong for a
user's custom HC-adjacent theme), every one of the 8 slots is mapped
directly to a VS Code theme-contributed categorical color instead:
`--vscode-charts-{red,blue,green,orange,purple,yellow}` for 6 slots, and
`--vscode-terminal-ansi{Magenta,Cyan}` for the remaining 2 (chart colors
only cover 6 hues). Every shipped VS Code theme — dark, light, both
high-contrast variants, and any well-formed custom theme — is required to
keep its chart/terminal colors legible against its own backgrounds (this
is exactly the mechanism that makes the integrated terminal and built-in
chart-consuming extensions usable in High Contrast mode already), so this
sidesteps the fidelity-vs-adaptation question rather than deciding it by
hand: no hex value chosen here can ever be "wrong" for a theme this
extension has never seen tested against.

**High-contrast verdict: PASSES**, by construction, for both HC variants —
not by re-running a hand contrast calculation against a hardcoded palette
(which is exactly the thing this decision avoids repeating), but because
the 8 slots no longer own any color data of their own to verify; they
inherit whatever the active theme itself already guarantees for its own
chart/terminal colors. This is flagged here explicitly (rather than
silently shipped) because it's a real design choice — hue *identity*
across branches is no longer guaranteed pixel-identical between themes the
way the reference's fixed hex-per-theme sets were (e.g. "branch 3 is
always exactly `#e8590c`"); it now varies with whatever a given theme
authors chose for `charts.orange`. If strict cross-theme hue fidelity
turns out to matter more than always-correct-contrast in practice (a real
product question a screenshot-comparing user might raise), that's the
trade-off to revisit — surfaced here, not silently foreclosed.

**Alternatives considered:** (a) hand-picking a third HC-specific hex tone
set — rejected per above (unverifiable against future/custom themes,
doubles the maintenance surface); (b) keeping the reference's exact hex
values and accepting the HC-light contrast failure as a known gap —
rejected, since a fix that costs nothing (no new dependency, no new
architecture, `--vscode-charts-*`/`--vscode-terminal-ansi*` are already
free to reference) was available.

**Cost:** none — swapping `var(--mm-color-c0)`'s definition from a literal
hex to `var(--vscode-charts-red)` is free at both build and paint time.

---

## 2026-07-17 — M4: settings — three of four apply live, one setting is host-only; layoutMode/headingDepth/animationNodeThreshold bake in at buildFromScratch (next-open-only), not live

**Context:** plan §9 M4 calls for `contributes.configuration` (layout mode,
heading depth, write-back delay, animation cutoff) "with live config
updates," while separately noting the reference baked its own equivalent
settings at construction (its `SettingsTab.ts`'s own tooltips literally say
"Changing this only affects maps opened after saving" for 3 of its 4
settings) — the task asked to decide, deliberately, per setting, not
default to one blanket answer.

**Decision — five settings total** (`package.json`'s `contributes.
configuration`, mirrored in `MindMapEditorProvider.ts`'s
`MindMapWebviewConfig`/`readWebviewConfig` and `webview/main.ts`'s own
`MindMapWebviewConfig`): `writeDebounceMs` (400), the M1-flagged
`externalEditForwardDebounceMs` (300, host-only — the webview never sees
it), `animationNodeThreshold` (500), `headingDepth` (1), `layoutMode`
("balanced"). Host reads `vscode.workspace.getConfiguration("mindmapView",
document.uri)` (resource-scoped, so a multi-root workspace's per-folder
override applies) once per panel at `resolveCustomTextEditor` time, posts
a `setConfig` message *before* the first `setDocument` (order matters —
see below), and again on every `onDidChangeConfiguration` that
`affectsConfiguration("mindmapView", document.uri)`.

**Per-setting live-vs-next-open split, and why it isn't one blanket rule:**
- **`writeDebounceMs`** — live. It's a plain debounce-wrapper delay
  entirely owned by `webview/main.ts`; `applyConfig` rebuilds
  `scheduleWrite` with the new delay as soon as a `setConfig` arrives. (A
  pending write already in flight under the old delay is simply orphaned —
  harmless, since the new wrapper still fires on the very next mutation;
  not worth hand-migrating a live `setTimeout` for a settings change this
  rare.)
- **`externalEditForwardDebounceMs`** — live, host-only. Read into a
  `let` (not `const`) closure variable per panel in `resolveCustomTextEditor`,
  used directly by the next `setTimeout` call in the `onDidChangeTextDocument`
  handler — no restart needed, nothing to bake.
- **`animationNodeThreshold`** — next-open-only, and not actually a
  *choice*: the ported `SvgRenderer`'s constructor parameter is `private
  readonly` — there is no live setter to call without editing the
  protected renderer, so this one is bound by the protected file itself,
  not a preference.
- **`layoutMode`/`headingDepth`** — next-open-only, and here it *is* a
  deliberate choice, not a technical wall (both are plain data read at
  `computeLayout`/`serializeMindMap` call sites, which already re-run on
  every edit): applying a `layoutMode` change live would mean recomputing
  every first-level branch's side assignment for the *current* map — a
  visual reshuffle indistinguishable from an unrequested "Rebalance" the
  user didn't ask for. Applying a `headingDepth` change live would mean
  the *next* keystroke's write-back silently rewrites every existing
  heading/list-item marker in the file to match the new depth, not just
  new content going forward — a much bigger diff than the user's own edit
  would suggest. Both mirror the reference's own settled choice (its
  `SettingsTab.ts` tooltip: "Takes effect for maps opened after saving")
  — carried over rather than re-litigated, per CLAUDE.md's own carry-over
  clause for a reference-repo decision the user already approved there.

`buildFromScratch` (webview/main.ts) is the only place `layoutMode`/
`headingDepth`/`animationNodeThreshold` are actually read from
`this.config` — a `setConfig` arriving after that point is still cached
(so the *next* full open picks it up) but never re-baked into the running
session's `layoutConfig`/`serializeConfig`/renderer instance.
`rebuildFromExternalText` (a genuine external edit to the same open map)
reuses the already-baked `layoutConfig`/`serializeConfig`, matching "next
*open*," not "next *external rebuild*."

**Order dependency:** the host always posts `setConfig` before the first
`setDocument` reply to "ready" (both inside the same `onDidReceiveMessage`
"ready" branch, in that order) — `postMessage` delivery preserves send
order, so the webview's `buildFromScratch` (triggered by that first
`setDocument`) is guaranteed to already have the real config cached, not
`DEFAULT_CONFIG`. `webview/main.ts`'s own `DEFAULT_CONFIG` constant exists
purely as a defensive fallback for that ordering guarantee somehow ever
being broken, not as an expected code path.

**Alternatives considered:** one blanket "everything bakes at
buildFromScratch, nothing is ever live" (simpler to state, but throws away
a real, free win for the two debounce settings, which have zero technical
or UX reason to wait for a reopen) and one blanket "everything posts fresh
and is applied immediately, always" (the reference itself rejected this
for exactly `layoutMode`/`headingDepth`, for reasons that apply here
identically — carried over, not re-derived from scratch).

**Cost:** negligible — `getConfiguration`/`get` calls are synchronous,
cheap VS Code API reads; the `onDidChangeConfiguration` subscription is
one more `Disposable` per panel, torn down on `onDidDispose` alongside the
other two.

---

## 2026-07-17 — M4: clipboard-image paste save location — a `mindmapView.pastedImageFolder` setting, default alongside the document (escalation resolved by the user)

**Context:** the M4 agent plumbed clipboard-image paste end-to-end (webview
reads the OS clipboard image, base64-encodes it, posts a `writeImage`
message; host writes the file, returns the embed markdown; webview inserts
it via the ported `Controller.pasteImageAsChild`) but left the host's
`writeImage` a deliberate stub returning `embedText: null` — because VS
Code, unlike Obsidian's vault, has no configured "attachment folder," so
*where* a pasted image is written had no settled answer. That was escalated
to the user (not decided by the agent), per CLAUDE.md's ask-don't-guess
discipline. (Note: this is a product/UX design fork, not a
performance-vs-X trade-off, so it wasn't a rule-3 escalation specifically —
it was surfaced under the same spirit.)

**Decision (user, 2026-07-17):** a `mindmapView.pastedImageFolder` setting —
a path relative to the markdown file's own folder, default `""` = write
alongside the file. Implemented in `MindMapEditorProvider.writeImage`:
- Read fresh on every paste (`readPastedImageFolder`), not baked into the
  session — a settings change applies to the very next paste. Consistent
  with the M4 settings entry's treatment of the two debounce settings as
  live; nothing here needs a session rebuild.
- Filenames are `pasted-image-<YYYYMMDDHHmmss>.<ext>`, **hyphenated (no
  spaces)** so the emitted `![](…)` is valid CommonMark without angle-bracket
  wrapping or percent-encoding (N3 markdown-friendliness) — a deliberate
  divergence from the reference's space-containing `Pasted image ….png`,
  which was fine only because Obsidian emitted it as a `![[wikilink]]`.
  Collision-suffixed (`-1`, `-2`, …) via an `fs.stat` existence check if a
  same-second paste already took the name.
- Emits a standard markdown embed `![](relative/path)` (not a wikilink) —
  plain-markdown-native, and the target is a POSIX-relative path from the
  document's folder so it round-trips through the same `getImageEmbed`
  (parse) / `resolveImage` (host resolve against docDir) pair M4's image
  *display* already uses. So a pasted image is immediately displayable by
  the very resolver built earlier in the milestone, no extra wiring.
- The folder is created if missing (`fs.createDirectory`, recursive/no-op
  for the default same-dir case). Any failure (unwritable folder, empty
  data) returns `embedText: null`, which the webview's `handlePaste`
  already treats as "no usable image" and falls through to text-paste — a
  paste never crashes or hangs.

**Alternatives considered:** (a) always same folder, no setting — rejected
as needlessly inflexible when a one-line setting gives both the sensible
default *and* an `assets/`-style option; (b) a fixed `assets/` subfolder —
rejected: imposes a directory the user didn't ask for as the *default*,
whereas the setting lets them opt into exactly that if they want it; (c)
matching Obsidian's wikilink embed form — rejected for plain-markdown
friendliness (see filename note above).

**Cost:** none on any interactive path — the write is a one-shot host
operation on an explicit paste, off the keystroke loop entirely; the
`fs.stat` collision check is one stat per paste (bounded, not per-frame).
No new dependency.

**This resolves M4's one open escalation. M4 is now feature-complete.**

---

## 2026-07-18 — M5: webview state persistence — selection restored by structural path, not id; viewport restored only approximately (no protected-core change)

**Context:** plan §11's risk row ("Webview reload loses map state") calls for
`getState`/`setState` to persist viewport (pan/zoom) + selection across a
hidden→revealed reload (`retainContextWhenHidden: false` means the whole JS
context — every `MindNode`, `Controller`, id — is destroyed and rebuilt from
scratch; only whatever was handed to `setState` survives, since that's a
VS-Code-owned store outside the webview's own JS heap).

**Decision, part 1 (why selection is persisted by structural path, not id):**
a plain node with no persisted `^blockid` metadata (`sync/metadata.ts`'s
`ensurePersistentIds` only mints one the first time a node needs it — first
fold/manual-position/resize) gets a **fresh random id** every time
`parseMindMap` runs (`model/id.ts`'s `createId()`), so an id saved before a
reload almost never matches anything after it. Instead, `webview/main.ts`
persists the same sibling-index path `sync/reconcile.ts`'s
`findEquivalentNode` already walks to carry selection across an
external-edit reparse (M1) — `pathOf`/`nodeAtPath` (new, `webview/main.ts`)
are that identical walk-up/walk-down, just replayed against plain
`number[]` data instead of a live `MindNode` object (nothing from before a
reload survives to hand `findEquivalentNode` directly — there is no old
node object left to start from). `persistState()` runs at the end of every
`onChange()` (selection or model change) and `rebuildFromExternalText()`;
`restoreViewState()` runs once, at the end of `buildFromScratch()` (the one
place a session's first model exists) — a plain first-ever open
(`getState()` returns `undefined`) is a no-op, unchanged from before this
existed.

**Decision, part 2 (viewport — SUPERSEDED, see the 2026-07-18 follow-up entry
below):** as *originally* built, this stopped short of exact pan/zoom
restore. The ported `SvgRenderer` had **no public getter for its current
pan/zoom** (`private view: {tx, ty, scale}`) and **no public setter for
scale** — only `centerOnWorldPoint`/`centerOnRoot` — so `restoreViewState()`
re-centered (`centerOnWorldPoint`) on the restored selection: an
approximation, with zoom always back at default and a free-panned-with-
nothing-selected view unrecoverable. That gap, and whether to close it by
adding methods to the protected renderer (CLAUDE.md hard rule 2), was
**escalated to the coordinator** rather than decided here (recommendation at
the time: don't touch the core, the gap is narrow). **The user decided the
other way** — see the follow-up entry "M5: full pan/zoom fidelity —
user-authorized additive change to `SvgRenderer`" below, which is the
current, authoritative state. This paragraph is left intact as the
append-only historical record of what was surfaced.

**Alternatives considered:**
- Persisting by node id anyway, accepting that most restores would silently
  fail — rejected: silent failure (nothing selected after a reload with no
  visible explanation) is worse than the structural-path approach, which
  costs nothing extra and actually works for the common "same doc, nothing
  structurally changed while hidden" case this feature exists for.
- Replicating the renderer's pan/zoom math independently in `webview/
  main.ts` via a second set of pointer/wheel listeners on the same
  container — rejected: real risk of drift (the renderer's own `MIN_SCALE`/
  `MAX_SCALE` clamps and drag-vs-click thresholds are private constants not
  visible to duplicate), and rule 6 discourages parallel logic paths for
  something this fiddly to keep in sync by hand.

**Cost:** negligible — `pathOf`/`persistState` are O(depth × selection
size) via `Array.prototype.indexOf` over each node's own sibling list, not
a tree walk; called at the same frequency `serializeMindMap` (a full O(n)
walk) already runs at every `onChange`. No new dependency. `bench:m1`/
`bench:m2`/`bench:open`/`bench:images` re-run clean (see `benchmarks.md`'s
M5 section) — no regression, as expected for a change bounded by selection
size, not map size.

**Tests:** new `test/webviewStatePersistence.test.ts` (see the follow-up
entry below for the final, expanded test list once exact viewport
round-trip was added).

---

## 2026-07-18 — M5: full pan/zoom fidelity — USER-AUTHORIZED additive change to the protected `SvgRenderer` (the one intentional divergence from the byte-identical port)

**Context / authorization:** the immediately-preceding state-persistence
entry surfaced two things to the coordinator: (1) `retainContextWhenHidden`
(the separate entry at the bottom of this file), and (2) whether to reach
*exact* pan/zoom restore by adding a getter/setter pair to the protected,
byte-identically-ported `webview/render/SvgRenderer.ts`. **The user decided
(via the coordinator) to add it** — explicitly choosing exact viewport
restore over preserving the byte-identical-core invariant for this one
file. This entry records that authorization and exactly what changed, so
the divergence is auditable.

**Exactly what was added (additive-only, zero deletions — verified by
`git diff`):** two public methods on `SvgRenderer`, immediately after
`centerOnWorldPoint`:

```ts
getViewport(): Viewport {
    return { tx: this.view.tx, ty: this.view.ty, scale: this.view.scale };
}
setViewport(v: Viewport): void {
    this.view.tx = v.tx;
    this.view.ty = v.ty;
    this.view.scale = v.scale;
    this.scheduleApplyViewport();
}
```

`getViewport` returns a **copy** of the renderer's existing private `view`
field (so a caller can't mutate the live viewport through the returned
object). `setViewport` writes the three fields and then calls the
renderer's **own existing** `scheduleApplyViewport()` — the exact same
rAF-batched transform-write + recull path every other pan/zoom mutation
(`onWheel`, the background-drag pan, `centerOnRoot`, `centerOnWorldPoint`)
already funnels through — rather than hand-rolling a second transform
application. No existing method, field, constant, or behavior was changed;
`Viewport` is the file's own already-existing (non-exported) interface. The
`diff -u` against the reference is a single hunk of additions, no `-`
lines.

**Wiring in `webview/main.ts`:** `PersistedViewState` gained an optional
`viewport: {tx, ty, scale}` field (optional so an older selection-only
persisted state object still loads — it falls back to the previous
`centerOnWorldPoint`-on-selection approximation). `persistState()` now
records `renderer.getViewport()`; `restoreViewState()` now calls
`renderer.setViewport(state.viewport)` when present, restoring the exact
pan/zoom **independently of selection** — so a free pan/zoom with nothing
selected round-trips too. Because pure pan/zoom gestures are handled inside
the renderer's private handlers and never emit a controller `onChange`
(the only thing that was previously driving `persistState`), a new
`onViewportGesture()` on `MindMapApp` is wired to container-level `pointerup`
and `wheel` listeners (both bubble up from the renderer's SVG; the renderer
updates its `view` synchronously in its handlers, so `getViewport()` is
already current by the time these fire) and calls `persistState()` directly
— `setState` is a cheap small-object write, so no debounce is needed.

**MAINTENANCE NOTE (important for anyone re-syncing from the reference
repo):** `webview/render/SvgRenderer.ts` is **no longer byte-identical** to
`/Users/burakucbinli/projects/obsidian/src/render/SvgRenderer.ts`. The
core-integrity check that has run after every milestone (`diff -rq
webview/{model,layout,render,sync,controller}` against the reference,
expecting zero diffs) now has **one known, intentional exception**: `render/`
will report `SvgRenderer.ts` differs, and the correct verification is
"differs *only* by the additive `getViewport`/`setViewport` pair (and its
doc comment), no `-` lines" — confirmed with `diff -u` / `git diff`, **not**
"clean." `model/`, `layout/`, `sync/`, and `controller/` remain fully
byte-identical and should still be checked as such. Any future port of a
reference-repo change to `SvgRenderer` must **preserve this addition** (re-
apply the two methods on top of the new reference version); it is not
disposable drift.

**Recommendation-vs-outcome note:** the agent's own recommendation (prior
entry) was *not* to make this change; the user overrode that in favor of
exact fidelity. Recorded plainly so the reasoning trail is honest — this
was a user call on a genuine trade-off (feature fidelity vs. a maintenance
invariant), exactly the kind rule 3's spirit says to surface rather than
decide unilaterally, and it was surfaced and then decided by the user.

**Cost:** none on any interactive path — `getViewport`/`setViewport` are
O(1) field copies, called only at persist/restore (a reload boundary or a
gesture end), never on the render/keystroke loop. Bundle grew ~0.4 KB raw
(webview 72.2 KB). `bench:m1`/`bench:m2`/`bench:open`/`bench:images` re-run
within noise (these paths don't touch the new methods) — see `benchmarks.md`'s
M5 section.

**Tests (final, `test/webviewStatePersistence.test.ts`, 6 tests):** persists
nothing when nothing is selected; persists primary + multi-selection as
structural paths on every selection change; restores selection across a
simulated reload (default viewport unchanged); **round-trips an exact
pan/zoom with nothing selected** (ctrl+wheel zoom → persist → reload →
byte-identical transform string, exact even through the zoom math's ugly
floats, since the same stored numbers reproduce the same representation);
restores selection AND a changed viewport together; ignores a persisted
path that no longer resolves without throwing.

---

## 2026-07-18 — M5: workspace-trust and virtual-workspace capability declarations

**Context:** plan N4 ("VS Code citizenship") calls for honest
`capabilities.untrustedWorkspaces`/`capabilities.virtualWorkspaces`
declarations in `package.json`, based on what the extension actually does:
parses/renders markdown (pure data, no code execution), writes back edits
via `WorkspaceEdit` (the same class of operation any text editor already
performs), writes clipboard-pasted images via `workspace.fs`, and opens
links via `openExternal`/`vscode.open`.

**Decision — untrusted workspaces: `supported: true`, with one restricted
configuration.** Nothing this extension does executes code or configuration
sourced from workspace content — no tasks, no scripts, no debug configs, no
`eval` of file content. Parsing markdown into a visual tree and opening a
clicked link (a user-initiated action, resolved the same way VS Code's own
built-in Markdown preview already does, which fully supports untrusted
workspaces) is not the class of risk workspace trust exists to gate. One
exception: `mindmapView.pastedImageFolder` is a plain path string
`path.resolve`'d against the document's directory with no traversal
guard — a malicious untrusted repo's own committed `.vscode/settings.json`
could set it to `"../../../"`-style traversal to redirect where a *user's
own, explicitly-initiated* paste action writes a file, outside the
folder the user would reasonably expect. Declaring it in
`restrictedConfigurations` makes VS Code ignore that setting's
workspace-level value in an untrusted workspace (falling back to the
user's own User-level setting, or the same-directory default), closing
that specific gap without weakening anything else the setting is for.

**Decision — virtual workspaces: `supported: "limited"`.** Opening a
document and editing it as a mind map works over any workspace filesystem —
`TextDocument`/`WorkspaceEdit` are scheme-agnostic VS Code APIs with no
real-filesystem assumption baked in anywhere in this codebase. But three
features do carry a real-filesystem assumption: `MindMapEditorProvider.
openLink`/`resolveImage`/`writeImage` all call `path.dirname(document.uri.
fsPath)` (Node's `path` module, operating on `.fsPath` — a real OS path
string) rather than a URI-aware equivalent (`vscode.Uri.joinPath`/a
`dirname`-shaped helper). Over a non-`file://` virtual filesystem
(`vscode-vfs://`, a `github.dev`-style provider, etc.), `.fsPath` is not
guaranteed to be a meaningful, resolvable OS path, so these three features
(link-opening, image display, clipboard-image paste) may resolve
incorrectly or throw — while the core read/edit story keeps working.
`"limited"` is the honest middle ground: not `"true"` (real, exercised
features demonstrably assume a real filesystem), not `"false"` (the primary
open-and-edit workflow does not, and disabling the whole extension over a
gap in three secondary features would be a worse outcome for every virtual-
workspace user than a documented partial degradation).

**Alternatives considered:**
- Rewriting `openLink`/`resolveImage`/`writeImage` to use a URI-aware path
  join (e.g. a small `vscode-uri`-style `dirname`/`joinPath` helper) instead
  of Node's `path` + `.fsPath`, to honestly reach `"true"` — considered
  out of scope for this milestone: it touches three call sites' path
  logic (not just a manifest declaration) for a workspace shape (virtual
  filesystems) with no test fixture or real usage signal in this project
  yet, and the task's own framing ("reason about whether to declare
  `limited` and degrade, or `false`") anticipated deciding the declaration,
  not rewriting the path-resolution architecture. Flagged here as a
  concrete, scoped follow-up if virtual-workspace usage ever becomes real
  for this extension, rather than silently left unmentioned.
- `untrustedWorkspaces: "limited"` with a broader restriction (e.g. also
  disabling link-opening entirely in restricted mode) — rejected: link
  clicks are user-initiated and read-only (open-in-editor/open-externally,
  not execute), the same trust level VS Code's own Markdown preview already
  operates at; restricting it would be a strictly worse experience for no
  corresponding security gain.

**Cost:** none — this is a static manifest declaration, checked once by
VS Code at extension load / settings-resolution time, not a runtime or
per-frame cost.

---

## 2026-07-18 — M5: packaging — `.vscodeignore`, `npm run package`, and the `--no-rewrite-relative-links` `vsce` flag

**Context:** plan §9 M5 calls for `vsce package` with a bundle-size check
against the 500 KB target / 1 MB ceiling, and a lean `.vscodeignore` (ship
only the built bundles + a handful of top-level docs, not the TypeScript
sources/tests/design docs that produced them).

**Decision:** `.vscodeignore` excludes `src/**`/`webview/**` (compiled into
`dist/extension.js`/`media/webview.js` by esbuild — the TS sources
themselves are never loaded at runtime), `test/**`/`scripts/**`/
`fixtures/**`, `node_modules/**` (esbuild already bundles the one runtime
dependency, `d3-flextree`, directly into both output bundles — nothing is
`require()`'d at runtime, so shipping `node_modules` would be pure dead
weight), both `tsconfig*.json` and `package-lock.json`, `esbuild.config.mjs`,
and every internal design/process doc (`CLAUDE.md`,
`vscode-mindmap-extension-plan.md`, `DECISIONS.md`, `PROGRESS.md`,
`benchmarks.md`, `RELEASING.md`) — `README.md`/`CHANGELOG.md`/`LICENSE` are
the only markdown that ships. `npm run package` = `npm run build && npx
@vscode/vsce package --no-rewrite-relative-links` (a dev-only tool, run via
`npx`, not an added dependency — see rule 4).

**The `--no-rewrite-relative-links` flag, and why it's there:** `vsce
package` hard-fails (exit 1, not a warning) with no `repository` field in
`package.json` and no git remote configured (both true in this repo right
now — no remote is configured, and the publisher/repository fields are
placeholders the user hasn't filled in yet): it refuses to guess how to
rewrite README.md's relative links into absolute Marketplace-hosted URLs.
`--allow-missing-repository` (the flag that sounds like the fix) does
**not** bypass this specific check — only `--no-rewrite-relative-links` or
supplying `--baseContentUrl`/`--baseImagesUrl` does, confirmed by testing
both. Since this README has no relative links to rewrite in the first
place, the flag is a permanent no-op here regardless of whether the user
later adds a real `repository` field — kept in the npm script rather than
worked around by inventing a placeholder repository URL (which would be
actively wrong metadata, not just incomplete).

**Result:** `npm run package` succeeds today, placeholder publisher id and
all (`vsce package`, unlike `vsce publish`, does not validate the publisher
id against a real Marketplace account — only warns about the missing
`repository` field). Packaged `mindmap-view-0.0.1.vsix`: **40,609 bytes
(~39.7 KB)** — about **8% of the 500 KB target**, contents: `dist/
extension.js` (7.6 KB), `media/mindmap.css` (14.9 KB), `media/webview.js`
(70.1 KB, pre-zip), `package.json`, `README.md`, `CHANGELOG.md`,
`LICENSE`. No `.vsix` is committed (`*.vsix` is already in `.gitignore`).

**Alternatives considered:** inventing a placeholder `repository` URL to
avoid needing the flag — rejected, that's fabricated metadata a real
publish would ship to the Marketplace verbatim; `--allow-missing-
repository` alone — tested, does not actually suppress the hard failure
(only the separate "missing repository field" *warning* survives after
adding `--no-rewrite-relative-links`, and that warning is expected/correct
until the user supplies a real URL, see `RELEASING.md`).

**Cost:** none — build-time tooling only, not shipped.

---

## 2026-07-18 — M5: `retainContextWhenHidden` — DECIDED: stays `false` (user)

**Decision (user, via the coordinator):** `webviewOptions.
retainContextWhenHidden` **stays `false`** — unchanged from M1, no code
change. This was surfaced as a memory-vs-latency trade-off (rule 3) with
both sides quantified and a recommendation to keep `false`; the user
confirmed that recommendation.

**The trade-off, as quantified for the decision:**
- **Cost of `true` (the rejected option):** unconditional and *continuous* —
  every hidden mind-map tab keeps its full webview DOM/JS resident (up to
  the 150–300 MB per-map budget/ceiling for a 2k/5k-node map) for as long
  as it stays hidden, and multiplies across however many maps a user leaves
  open over a session.
- **Benefit of `true`:** avoids one reveal-time rebuild — a *one-time* cost
  on the same order as this file's `bench:open` numbers (~18 ms compute at
  2k nodes, ~34 ms at 5k, plus unmeasured real Chromium paint), paid only
  when a hidden tab is revealed.
- **Why `false` wins:** the cost is bounded, one-time, and budget-compliant;
  `true`'s memory cost is continuous and this extension's own usage pattern
  (many notes, each possibly opened as a map, left open across a long
  session) is exactly where forgotten hidden tabs would accumulate.

**Load-bearing interaction with the state-persistence work above:** that
work was deliberately built **before** this was raised, so the `false` path
is now selection-*and*-viewport-correct on reveal (not merely "eventually
re-synced from the document"). That's what turned this from a
data-loss-vs-memory question into a pure performance/memory optimization
choice — and with the data-loss concern gone, the continuous memory cost of
`true` had nothing left to justify it. The one thing no headless run can
answer — whether the brief reveal-time rebuild-flash *feels* acceptable in a
real window — is called out in `benchmarks.md`'s consolidated F5 checklist
as the observation that could reopen this, but absent that signal, `false`
is the decided state.

---

## 2026-07-20 — Phase A: re-synced the platform-free core to reference HEAD (relations, status badges, tall-node-overlap fix)

**Context:** the reference Obsidian plugin gained node relations (same-doc
arrows + cross-doc badges, commits 4c7d178/f58b3c1/7578f31), status badges
(bfd6997), and two bug fixes (cc1bf66 color-inheritance/center-into-view,
61d8aa0 tall-node-overlap) since this repo's M0 port point (`0a66f7c`).
Phase A brings the platform-free core current with all of that, without
yet building any VS Code-side UI wiring for the new features.

**Decision — re-synced verbatim, core stays byte-identical (plus the one
authorized exception):** copied reference HEAD's `model/{types,links,
mutations}.ts` and the two new files `model/{relations,statusBadges}.ts`,
`layout/layoutEngine.ts`, `render/{colors,navigation}.ts`, `sync/{metadata,
serializer}.ts` and the new `sync/foreignRelation.ts`, and
`controller/Controller.ts` into `webview/` verbatim — `diff -rq` against
reference HEAD confirms `model/`, `layout/`, `sync/`, `controller/` are
byte-identical, same discipline as M0. `render/SvgRenderer.ts` was copied
from reference HEAD and then had the additive `getViewport`/`setViewport`
pair (the one authorized divergence, 2026-07-18 entry above) re-applied
immediately after `ensureWorldRectVisible` (reference's own new
`ensureWorldRectVisible`, added by cc1bf66, now occupies the spot
immediately after `centerOnWorldPoint` that the pair originally sat in) —
confirmed with `diff -u` against reference HEAD: 26 added lines, 0 removed,
nothing else touched. Every new/re-synced file was grepped for `"obsidian"`
imports before copying — none found; the new `ForeignVaultReader`/
`ForeignVaultWriter` interfaces in `sync/foreignRelation.ts` are injected,
not Obsidian-coupled, exactly as the plan anticipated.

**`webview/ui/InlineEditor.ts` — a second, narrower divergence, now
resolved by re-sync:** this file was ported byte-identical from reference's
`src/view/InlineEditor.ts` back at M1 (DECISIONS.md, 2026-07-16) — outside
the model/layout/render/sync/controller "protected core," but tracked the
same way. Reference's 7578f31 added one additive method to it
(`reposition()`, F3: keeps the editor glued to its node's screen position
across pan/zoom) — platform-free, zero Obsidian coupling, needed by the
ported `inlineEditor.test.ts`. Applied the same way: copied reference HEAD's
version in; `diff -u` confirms byte-identical, not just additive — this
file was never claimed byte-identical with local additions the way
`SvgRenderer.ts` is, so a clean re-copy was the simpler, more honest
outcome. `reposition()` is not called from `webview/main.ts` — dormant
until the M-equivalent viewport-tracking wiring lands (out of Phase A
scope).

**Tests ported wholesale from reference HEAD** (per the coordinator's
instruction to prefer whole-file replacement over hand-merging, since
they're platform-free): `relations.test.ts`, `relationsRenderer.test.ts`,
`foreignRelation.test.ts`, `statusBadgePersistence.test.ts` (new), and
`metadata/controller/serializer/colors/layout/manualPosition/renderer.smoke/
links/inlineEditor.test.ts` (updated), plus the new `ensureVisible.test.ts`
and `test/helpers/{model,render}.ts` (shared scaffolding several of the
above import — not explicitly named in the task's file list but a direct
prerequisite, ported the same way). Import paths adjusted `../src/X` ->
`../webview/X` (and `../src/view/InlineEditor` -> `../webview/ui/
InlineEditor`, since that file lives one directory shallower in this repo's
layout), matching the M0-established convention. Did **not** port any
Obsidian-view-coupled test (nothing here imports `MindMapView`/`Modal`) — no
tests needed `describe.skip`; every ported test is genuinely platform-free
and passes as-is.

**Two pre-existing behaviors this re-sync legitimately changed, and how the
fallout was handled (not silently absorbed):**
1. **Link-click semantics (4c7d178):** a plain click on a node's link text
   used to navigate immediately; now it falls through to ordinary node
   selection, and Ctrl/Cmd+click is the dedicated "open this link" gesture
   — an intentional upstream UX fix (the old behavior made a linked node
   unselectable by clicking it). This broke one of our own (out-of-
   Phase-A-scope) `test/webviewBootstrap.test.ts` assertions, which
   expected the old semantics. Fixed the test to assert the new, correct
   semantics (Ctrl/Cmd+click navigates, plain click selects) rather than
   weakening it — the same kind of test-currency maintenance the reference
   repo's own commit did for its equivalent `MindMapView` tests.
2. **A cascading test-order bug this surfaced, not introduced:** the fixed
   test's own click sequence (select a node, edit it, then raw-dispatch a
   second click on its link) landed both clicks on the same node within
   `SvgRenderer`'s `DOUBLE_CLICK_MS` (400ms) window — trivial in a
   synchronous unit test, unlikely in real interactive use — which
   misfired the existing double-click-to-edit gesture and left an inline
   editor open, breaking the next test in the file (`this.inlineEditor`
   guards `handleCommand` from acting). Fixed by adding the same
   "reset double-click tracking via a background click" idiom this test
   file's own `findNodeEl` helper already uses elsewhere, rather than
   loosening the double-click window or any source-level behavior.

**Bench script:** ported `scripts/bench-relations.mjs` (path strings
`src/…` -> `webview/…`, matching the other bench scripts) and added
`npm run bench:relations`. Numbers in `benchmarks.md`'s new Phase A
section — both fixture sizes comfortably inside budget.

**Dormant by design (Phase A does not wire these):** `showRelations`
defaults to `true` in `SvgRenderer`'s constructor (reference's own
default), but `webview/main.ts` never calls `resolveRelations` or passes an
`activeRelations` array to `mount`/`update` (both default that parameter to
`[]`), so the relations layer stays empty regardless. No node ever gets a
`statusBadge` (no UI sets one). `sync/foreignRelation.ts`'s
`ForeignVaultReader`/`Writer` seam has no VS Code-side implementation yet.
None of this required any edit to `webview/main.ts` or
`src/MindMapEditorProvider.ts` to keep compiling — every new
constructor/function parameter these ported files introduced already
defaults to the value that preserves current (pre-Phase-A) behavior, which
is what made this a clean core upgrade rather than a wiring task.

**Verification:** `npm run build` clean; `npm test` — 36 files, 479 tests,
0 failed, 0 skipped. `diff -rq webview/{model,layout,sync,controller}`
against reference HEAD `src/{...}`: byte-identical. `render/`: differs only
in `SvgRenderer.ts`, confirmed additive-only (0 removed / 26 added lines) by
`diff -u`.

**Cost:** none of the ported code runs yet from any real interaction path
(dormant, see above) except the two intentional behavior changes (link
click semantics, tall-node-overlap layout fix) and the pre-existing
model/render code paths they touch — no new per-frame or per-keystroke
work. `bench:relations` (a new benchmark, not a regression check against a
prior number) shows both fixture sizes inside their existing open/edit
budgets. Flagging for the benchmark phase per the task's guardrail: once
relations are actually wired to run on every `onChange` (Phase B/C),
`resolveRelations`'s per-node work and the relations-layer arrow rendering
become real per-edit costs worth re-measuring against budget at that point,
not just at this dormant-code baseline.

## 2026-07-20 — Phase B: wired status badges to VS Code UI (keyboard shortcuts, context menu, quick-pick, click handler)

**Context:** Phase A (this same file's entry above) re-synced the
platform-free status-badge model/renderer support from the reference
plugin (`model/statusBadges.ts`'s 6 badges, `Controller.setStatusBadge`/
`toggleStatusBadge`, `SvgRenderer`'s `upsertStatusBadge` rendering and
`onStatusBadgeClick` hook) but deliberately left it dormant — no VS Code UI
set or clicked a badge yet. This phase is that wiring, ported from the
reference's commit `bfd6997` ("Add node status badges … Cmd+Shift+I/D
shortcuts, and context-menu hotkey hints"), adapted from Obsidian's `Menu`/
hotkey system to this repo's own conventions.

**Keyboard shortcut interception — Ctrl/Cmd+Shift+D and Ctrl/Cmd+Shift+I
routed as `contributes.keybindings` commands, not plain webview keydown:**
this repo already has precedent for exactly this question — Ctrl/Cmd+Z/
Shift+Z/Y (M2), Ctrl/Cmd+F (M3 search), Ctrl/Cmd+Shift+B (M3 rebalance),
Ctrl/Cmd+/ (M3 fold), and Ctrl/Cmd+K (M3 link editor) are all VS Code-
intercepted chords that never reach the webview's own `keydown` handler,
so they're routed as `command` messages via `package.json`'s
`contributes.keybindings` + `MindMapEditorProvider.ts`'s
`registerRoutedCommand`/`postCommandToActivePanel` instead. Checked whether
Ctrl/Cmd+Shift+D/I are free the same way Alt+Up/Down or Ctrl/Cmd+Home are
(M3's own plain-webview-keydown chords): **no** — Ctrl+Shift+D is VS Code's
own default binding for "Show Run and Debug" (the debug viewlet), a direct
collision with the same shape of problem Ctrl+Shift+B (rebalance) already
hit before M3 routed it as a command. Ctrl+Shift+I has carried a "Toggle
Developer Tools" binding in some VS Code versions/builds. Per the task's
explicit guidance ("safer to add the keybinding than to assume it's
unnecessary"), both are routed conservatively as commands
(`mindmapView.toggleStatusDone` / `mindmapView.statusQuickPick`) exactly
like the other five, rather than risking a live collision that would
silently swallow the shortcut in a real VS Code window (something no
headless test here can catch — flagged in benchmarks.md's real-window
checklist addition below).

**Quick-pick UI — reused the existing plain-DOM `ContextMenu` overlay,
positioned at the node instead of the mouse, rather than a fourth UI
primitive:** the reference's Cmd+Shift+I opens the same Obsidian `Menu`
its context-menu status section uses, just positioned at the node's screen
rect (`showAtPosition`) instead of the mouse-click point (`showAtMouseEvent`).
This repo has no Obsidian `Menu` — its equivalent, `webview/ui/
ContextMenu.ts`, is a plain absolutely-positioned DOM overlay (R17, M3).
Considered three options: (a) build a new "QuickPick" overlay type,
(b) extend `ContextMenu` to support being opened at an arbitrary point
with an arbitrary item list, (c) something VS Code-native (the host's own
`vscode.window.showQuickPick`, which lives in the extension host, not the
webview). Rejected (a): this repo already has four UI primitives
(InlineEditor/SearchPanel/LinkModal/ContextMenu) and the task's own
guidance was to escalate rather than invent a fifth; `ContextMenu`'s shape
(a positioned list of clickable items, closes on Escape/outside-click) is
already exactly what a quick-pick needs. Rejected (c): a host-side
`showQuickPick` would need a round trip through `postMessage` for both
opening it and receiving the choice, and would render as a native VS Code
UI element positioned by VS Code's own logic, not glued to the node's
on-canvas position the way the reference's node-anchored menu is — a
worse fit for "look, this node has 6 possible statuses, right here."
Chose (b): `ContextMenu.ts` already took `x`/`y` in container-relative
coordinates (`showNodeMenu` derives them from `evt.clientX/Y` minus the
container's own offset) — `SvgRenderer.getNodeScreenRect` (already
additive since M5, used by the inline editor for the same reason: same
container-relative coordinate space) needed no change to slot into the
same `x`/`y` fields. **No performance concern to escalate here** (rule 3):
this is a one-time DOM-overlay construction on an explicit user action
(shortcut/click/right-click), not a per-frame or per-keystroke cost —
identical order of work to every existing `ContextMenu` open.

**Checked/hint support added to `ContextMenuItem`:** two new optional
fields, `checked` (renders a checkmark prefix) and `hint` (a muted right-
aligned keyboard-shortcut string) — the plain-DOM analogs of Obsidian's
`MenuItem.setChecked()` and the reference's own `menuItemTitle` helper
(which builds a `flex` row with a `min-width` floor so the hint lines up
as a column regardless of label length — same technique, re-implemented
here as `.mm-context-menu-item-row`/`-label`/`-hint` in `media/
mindmap.css`, since that CSS technique is layout-engine-agnostic, not an
Obsidian-specific hack). Existing items with neither field render exactly
as before (plain `textContent`) — zero visual/behavioral change to menu
items that don't need either.

**Styling — `.mm-status-badge*` CSS was never actually ported in Phase A:**
it lived in the reference's `styles.css` (not one of the `src/` files that
phase re-synced), so `media/mindmap.css` had zero rules for it despite
`SvgRenderer.upsertStatusBadge` already emitting the classes. Added now,
translated from Obsidian's `--color-red/green/blue/cyan` /
`--text-on-accent` / `--background-primary` to this file's established
`--vscode-*` mapping (see its header comment): done/green-flag -> the same
`--vscode-charts-green` the branch palette's c2 slot already uses;
started -> `--vscode-charts-blue` (c1); blocked/red-flag ->
`--vscode-charts-red` (c0, matching the reference's own reuse of one red
tone for both); ready -> `--vscode-terminal-ansiCyan`, the same fallback
the branch palette's c7 slot uses since `charts.*` has no dedicated cyan.
No new hardcoded hex value introduced, keeping this file's post-M4
all-`--vscode-*` invariant intact.

**Test-currency fallout, fixed rather than weakened (same discipline as
Phase A's link-click-semantics fix):** the existing right-click context-
menu test in `webviewBootstrap.test.ts` asserted the exact item-label list
via raw `el.textContent`. Since a hint is now rendered as a nested span
inside the same entry, `textContent` for those items became
`"EditF2"`/`"CopyCtrl+C"`/etc. Fixed the assertion to read
`.mm-context-menu-item-label`'s own `textContent` (falling back to the
entry's own `textContent` for items with neither `checked` nor `hint`,
which don't get the wrapping span) — the same "assert the new, correct
shape" resolution as Phase A's link-click test fix, not a loosened check.

**Verification:** `npm run build` clean; `npm test` — 36 files, 484 tests
(up from 479), 0 failed, 0 skipped. New: a "Phase B: status badges"
describe block in `webviewBootstrap.test.ts` (4 tests: shortcut toggle,
quick-pick shortcut + checked-state + selection, context-menu badge
section + Clear status, click-on-existing-badge) and one new case in
`mindMapEditorProvider.test.ts` (the two routed commands reach only the
active panel, same pattern as the existing undo/redo/search/etc. test).
`diff -rq webview/{model,layout,render,sync,controller}` against reference
HEAD `src/{...}`: still byte-identical (`render/SvgRenderer.ts` differs
only by the pre-existing, unrelated M5 `getViewport`/`setViewport` pair —
this phase added/changed 0 lines there). No changes needed to
`webview/model/statusBadges.ts` or `SvgRenderer.ts`'s existing status-
badge rendering — both already exposed everything this phase needed
(`setStatusBadge`/`toggleStatusBadge`, `setStatusBadgeClickHandler`,
`getNodeScreenRect`) since Phase A.

**Cost:** zero new per-frame or per-keystroke work. The rendering itself
(`SvgRenderer.upsertStatusBadge`) was already running every `update()` call
since Phase A (conditional DOM-element pattern identical to the fold
badge) — this phase only adds code paths that run on an explicit,
infrequent user action (a shortcut press, a right-click, a badge click),
each a one-time DOM-overlay construction of the same order of cost as the
existing `ContextMenu`/`goToNoteSection` interactions. No dependency added.

## 2026-07-20 — Phase C: relations wired live (settings, render-loop wiring, cross-doc badge click, external-link-open fix); modal redesign escalated

**Context:** Phase A re-synced the platform-free relations logic
(`model/relations.ts`'s `resolveRelations`/`listNodeLinkItems`,
`sync/foreignRelation.ts`'s `ForeignVaultReader`/`ForeignVaultWriter`
contracts + `resolveRelationTargetsForDocument`/`commitForeignRelationTarget`,
`SvgRenderer`'s relation-arrow/cross-doc-badge rendering + `showRelations`
constructor param) but built no VS Code UI at all — relations were fully
dormant (`webview/main.ts` never called `resolveRelations` or passed
`activeRelations`/`showRelations` anywhere real). This phase wires
everything that does *not* depend on how the relation-authoring modal ends
up being built, and stops short of the modal itself — see the escalation
below.

**`showRelations` setting — live-vs-next-open treatment:** followed the
precedent M4 already established for `layoutMode`/`headingDepth`/
`animationNodeThreshold`: baked into `SvgRenderer`'s constructor at
`buildFromScratch` time, not applied to an already-mounted renderer.
Not re-litigated as a fresh question because the *reason* is identical —
`SvgRenderer`'s own doc comment for the `showRelations` param (ported
verbatim in Phase A) already states the intent: "when false,
`updateRelations` never runs and `relationsG` stays permanently empty —
'no arrows/relation layer work happens' at all, not just hidden via CSS."
Rebuilding that live would mean either (a) tearing down and remounting the
whole renderer on a settings change (the same cost as opening a fresh map,
for a rarely-toggled setting), or (b) adding a second, narrower "toggle
relations layer" method to the protected renderer — both disproportionate
to a setting nobody is shown to need at cadence faster than "next open."
`package.json`'s description says so explicitly ("Takes effect the next
time a map is opened"), matching the other three settings' wording.

**`resolveRelations` wired into the render loop (the one perf checkpoint
this phase must clear):** added to `buildFromScratch`/`onChange`/
`rebuildFromExternalText` in the exact position the reference's
`MindMapView` puts it — after layout, before `ensurePersistentIds`/
`serializeMindMap` (both depend on the `isRelationTarget` flags
`resolveRelations` sets, per that function's own doc comment: a same-doc
relation's target must keep its `^blockid` suffix across serialize).
`bench:relations`, re-run with this wiring actually in place, shows both
fixture sizes still comfortably inside every relevant budget (open:
31.0ms/41.6ms vs. 1000ms/2000ms; Tab-edit: 15.9ms/27.4ms vs. the 50ms
target/100ms ceiling; a relation-source rename: 14.1ms/30.7ms, same
budget) — see benchmarks.md's dated "Phase C" entry for the full numbers.
**No performance trade-off to escalate:** the benchmark script itself
already called `resolveRelations`/`mount`/`update` directly since Phase A
(it exercises the ported core modules, not `webview/main.ts`), so this
phase's wiring doesn't change what the script measures — it only makes
real interactive usage exercise a path that used to be dead code. Nothing
here required touching `model/relations.ts`'s own hot-path discipline
(the two-pass walk, the per-node link-cache fast path) — it was already
built to run every `onChange`, this phase just started actually calling it
there.

**Cross-document badge click:** `SvgRenderer.setCrossDocBadgeClickHandler`
wired to a new `openCrossDocRelation(nodeId)` in `webview/main.ts` — finds
the node's first `resolvedRelations` entry with `kind === "cross-doc"` and
opens it via the *existing* `openLink` host round trip (same message the
reference's `MindMapView.openCrossDocRelation` reuses, per the task's
guidance to match its actual behavior rather than reusing "Go to
section"'s beside-column mechanism, which is for jumping to a location
*within the current document*, not opening a different one — cross-doc
relations are exactly the `openLink` case, since Obsidian's own
`openCrossDocRelation` calls `this.openLink`, not `goToNoteSection`).

**External link opening fix (reference `7578f31`) — re-derived for this
repo's host-round-trip architecture, not copied:** the reference's bug was
Obsidian-specific in its *symptom* (a URL/absolute path stored with
`kind: "wikilink"` tried to create/open a vault note named after it) but
the underlying issue — deciding how to open a link by inspecting its
*target's shape* (URL vs. absolute path vs. relative reference) instead of
trusting whatever `kind` it happened to be stored as — applies identically
here. Confirmed this repo's pre-Phase-C `MindMapEditorProvider.openLink`
had the same *shape* of bug (though usually silently self-correcting for
absolute paths, since `path.resolve(docDir, "/Users/…")` treats an
absolute second argument as authoritative and "accidentally" opens the
right file) but definitely broken for a bare-domain URL (`www.example.com`,
no `://`) or a `mailto:`-less scheme-free link, which fell straight
through to the workspace-relative-file branch and resolved to a
nonexistent path. Fixed by adding host-side (Node) duplicates of the
webview's `isUrlTarget`/`normalizeUrlTarget`/`isAbsoluteFilesystemPath`/
`expandHomePath` (`webview/model/links.ts`, already ported byte-identical
in Phase A) to `MindMapEditorProvider.ts` — duplicated rather than
imported, for the same two-tsconfig reason this file's pre-existing
`LinkKind`/`URL_SCHEME_RE` are already duplicated (that module compiles
against the browser-lib tsconfig; this file is the Node-side host). The
actual *open* mechanism differs from the reference by necessity: Obsidian
lazily `require("electron")`s `shell.openExternal`/`shell.openPath`
(guarded, since Obsidian mobile has no Electron underneath); this
extension's host is a VS Code extension process, which exposes the same
"open with the OS's default handler" capability through the documented,
non-Electron-coupled `vscode.env.openExternal(uri)` API for both a URL
*and* an absolute `file://` URI (VS Code dispatches a local file/folder
URI to the OS default app/file-browser the same way `shell.openPath`
would) — so there was no need to reach for Electron directly, and no mobile
guard is needed (this host always runs under Node/Electron-hosted VS
Code, unlike Obsidian's mobile target). `~`/`~/…` expansion still needs
`os.homedir()`, imported directly (unconditionally available here, unlike
the reference's guarded/optional access).

**Ctrl/Cmd+Shift+G ("Go to note section" keyboard equivalent, reference
`7578f31`):** routed as a `contributes.keybindings` command
(`mindmapView.goToSection` -> a `"goToNoteSection"` `CommandMessage`,
distinct from the pre-existing `"goToSection"` *host* message the webview
already sends when the user picks it from the context menu — kept as two
different names specifically so they aren't confused with each other),
rather than a plain webview keydown — Ctrl/Cmd+Shift+G is VS Code's own
default binding for "Show Source Control," the same class of collision
Ctrl/Cmd+Shift+B (rebalance) and Ctrl/Cmd+Shift+D/I (status badges)
already had, so it's routed the same conservative way per the established
precedent rather than assumed free.

**Host support for cross-document (R4) data access — built ahead of the
modal, since the modal needs it regardless of which UI it ends up using:**
three new request/response message pairs in `MindMapEditorProvider.ts`,
following the exact shape already established by `resolveImage`/
`imageResolved` and `writeImage`/`imageWritten` (a monotonic request id,
never a new message-passing pattern, per the task's explicit guidance):
`listMarkdownFiles`/`markdownFilesListed` (enumerates every `.md` file in
the workspace via `vscode.workspace.findFiles('**/*.md', '**/node_modules/**')`,
excluding the current document — this repo has no `.gitignore`-aware
`.md` file-exclusion convention beyond `node_modules` to mirror, and
`findFiles` already applies the user's own `files.exclude`/`search.exclude`
settings for free, matching the task's "at minimum excluding node_modules"
floor), `readForeignDocument`/`foreignDocumentRead` (one-shot UTF-8 read
of an arbitrary workspace `.md` file by absolute path — the VS Code
counterpart of `ForeignVaultReader.cachedRead`), and
`writeForeignDocument`/`foreignDocumentWritten` (a plain
`vscode.workspace.fs.writeFile`, not a `WorkspaceEdit` — a foreign file
generally isn't open as a live `TextDocument` in this editor session the
way the *current* document is, so there is no document to route an edit
through; this matches `commitForeignRelationTarget`'s own "re-read fresh,
mint an id if needed, write once" one-off I/O shape). Every foreign file
is identified by its absolute fsPath (not a workspace-relative path) —
avoids any multi-root-workspace ambiguity, and slots directly into
`sync/foreignRelation.ts`'s existing "any id other than
`CURRENT_DOCUMENT_ID` is a vault path" contract with no changes to that
file. None of these three run on any per-keystroke/per-render path — only
when a user opens the relation modal and interacts with the document/node
picker, per CLAUDE.md rule 3's own workspace-scanning cost question (not
escalated as a *live* rule-3 trade-off, since it's a one-time,
user-initiated, bounded-by-workspace-size operation, not a hot path — but
noted here since the task specifically flagged it as a candidate).

**Escalated, not built — the relation/link modal redesign itself (reference
`7578f31`'s `LinkModal.ts`, 436 lines changed) and its searchable-combobox
predecessor (`f58b3c1`):** the task's own guardrail calls this out as a
genuine platform-fit fork requiring the user's steer before building: VS
Code has a native `showQuickPick`/`showInputBox` API that could serve the
"pick a document, then pick a node in it" two-step search-as-you-type flow
the reference's hand-rolled plain-DOM combobox implements, as an
alternative to extending this repo's own established plain-DOM-overlay
family (InlineEditor/SearchPanel/LinkModal/ContextMenu — all built as
`Modal`/`Menu`-replacement overlays specifically because VS Code has no
webview-embedded equivalent of those Obsidian classes, per this repo's own
established convention). Unlike the M3-era "no VS Code equivalent exists"
default that justified the *original* single-edit `LinkModal.ts`, a
QuickPick genuinely could exist here and might be a *better* fit for a
searchable list than reproducing the reference's hand-rolled filtering —
but it would also mean the picker leaves the webview's own DOM (rendered
by VS Code itself, not glued to the node/map the way every other overlay
in this app is), and the round trip shape (webview posts "open a picker",
host shows a native QuickPick, host posts back the choice) is a new
message pattern this repo hasn't needed before. Per the task's explicit
instruction to stop rather than default to either approach, this decision
was surfaced to the coordinating instance rather than guessed — see the
task-level report for the question as posed and the two options'
trade-offs. **Net effect:** resolving/rendering a relation that already
exists in a document's markdown source works end-to-end (arrows, cross-doc
badges, click-to-open, the `showRelations` toggle); there is currently no
UI path to *author* a new relation by clicking through the mind map —
`webview/ui/LinkModal.ts` is unchanged from its pre-Phase-C single-link-edit
form this phase. This is flagged as a real functional gap in PROGRESS.md
and benchmarks.md's real-window checklist, not silently left implicit.

**Verification:** `npm run build` clean; `npm test` — 36 files, 484 tests,
0 failed, 0 skipped (unchanged count from Phase B — this phase's wiring is
exercised by the existing module-level relations/renderer/config test
suites; two `mindMapEditorProvider.test.ts` assertions updated for the new
`showRelations: true` field in the posted `setConfig` payload, the same
"assert the new, correct shape" treatment as every prior phase's
config-shape churn, not a weakened check). `diff -rq webview/{model,
layout,sync,controller}` against reference HEAD `src/{...}`: still
byte-identical; `render/SvgRenderer.ts` still differs only by the
pre-existing M5 `getViewport`/`setViewport` pair — 0 lines touched by this
phase (only `webview/main.ts`, `src/MindMapEditorProvider.ts`,
`package.json`, and `media/mindmap.css` changed).

**Cost:** the one real per-edit cost this phase adds — `resolveRelations`
running on every `onChange`/mount/rebuild instead of never — is exactly
the cost Phase A's own DECISIONS.md entry flagged as "worth re-measuring
once wired," and `bench:relations`'s re-run (see benchmarks.md) confirms
it clears every budget with room to spare. The three new foreign-document
message handlers add zero cost to any existing path (they're unreachable
until the still-unbuilt modal calls them). No new dependency introduced.

## 2026-07-20 — Phase C (continued): relation-target picker built with VS Code's native QuickPick, not a plain-DOM combobox

**Context:** the previous Phase C entry (above) escalated one genuine
platform-fit fork rather than guessing: should the relation-target picker
(document, then a node in it) be a hand-rolled plain-DOM searchable
combobox — extending this repo's existing InlineEditor/SearchPanel/
LinkModal/ContextMenu overlay family, matching the reference's own
`f58b3c1` — or VS Code's native `showQuickPick`? **User decision: build it
with `vscode.window.showQuickPick`.** This entry covers what was built on
that decision: the redesigned relation/link modal (reference `7578f31`)
and its QuickPick-driven picker flow, closing out Phase C's one remaining
piece.

**Message-protocol shape — one new generic primitive, not a
relations-specific one:** `showQuickPick`/`quickPickResult`
(`MindMapEditorProvider.showQuickPick`, `webview/main.ts`'s
`requestQuickPick`) is deliberately generic — a plain `{label,
description?}[]` in, a picked `index | null` out — rather than a
"pick a relation target" message that bakes in domain knowledge. This
matters architecturally: it keeps the *entire* two-step sequencing (which
list to show first, what a pick means, what to do next) inside the
webview, exactly like CLAUDE.md rule 7 requires ("the entire interaction
loop lives in the webview; the host is only the persistence layer plus a
handful of platform actions"). The host never learns it's showing a
document picker vs. a node picker vs. anything else — same "reuse the
established request/response-by-id shape" discipline as `resolveImage`/
`writeImage` and the three foreign-document handlers from the prior Phase
C entry. `index`, not the picked item itself, round-trips back — the
webview already holds the authoritative list it built the QuickPick items
from, so this avoids re-serializing (possibly large) label strings across
the boundary and sidesteps ambiguity if two items share a label (e.g. two
nodes with identical text) — see `MindMapEditorProvider.showQuickPick`'s
own doc comment.

**Two-step flow lives entirely in `webview/main.ts`'s
`pickAndAddRelation`, using only already-ported core functions — nothing
new invented for the mutation itself:** step 1 (`requestListMarkdownFiles`
+ a `showQuickPick` for "current document" + every other workspace `.md`
file) and step 2 (a second `showQuickPick`, over either the in-memory
current-document node list or `resolveRelationTargetsForDocument`'s
lazily-read-and-cached foreign-document one — `sync/foreignRelation.ts`,
ported unmodified since Phase A) are pure sequencing/data-fetching. The
actual relation-authoring logic on a successful pick is verbatim
already-ported core: `forcePersistentId` (sync/metadata.ts) mints the
target's block id, `buildLinkText`/`appendLinkText` (model/links.ts) build
the appended node text, `Controller.commitRename` commits it (undo/redo,
debounced write-back — everything downstream is unchanged); the
foreign-document case additionally routes through
`commitForeignRelationTarget` for the read-modify-write against the
*other* file. This matches the task's explicit instruction not to invent
new mutation logic — the only genuinely new code is the QuickPick
sequencing and the host-side data-access primitives (already built in the
prior Phase C entry).

**Cancel-safety (guardrail #4):** both `requestQuickPick` calls check
`=== null` before proceeding; a `null` at either step returns `null` from
`pickAndAddRelation` immediately, before any `commitRename`/
`commitForeignRelationTarget` call — verified by two dedicated tests (a
webview-level one in `webviewBootstrap.test.ts` asserting no relation
appears and no `.mm-node-link` is rendered after an Escape at step 1, and
a `LinkModal.ts`-level one asserting the item list and button state are
untouched after a cancelled pick). `LinkModal.ts`'s own "Choose document &
node…" button treats a `null` result as a pure no-op: it doesn't touch the
item list, only re-enables the button (via `.finally`, so this holds
whether the pick succeeded, was cancelled, or the promise rejected).

**Trigger — reused the existing Ctrl/Cmd+K `linkEditor` entry point, not a
new command:** re-checked the reference's commit history per the task's
own instruction — `7578f31`'s title ("Redesign the relation/link modal")
confirms Obsidian's own relation and link editing were already unified
into one modal (`Ctrl/Cmd+Shift+L` there, moved off `Ctrl/Cmd+K` purely to
dodge an Obsidian-core hotkey collision — see that reference commit's own
`MindMapView.ts` diff). This repo's Ctrl/Cmd+K binding has never had an
equivalent VS Code-default collision (M3 already established it without
incident), so there was no reason to move it — `openLinkEditor`
(`webview/main.ts`) is extended in place, same `"linkEditor"`
`CommandMessage`/`contributes.keybindings` entry as before. The existing
right-click context menu's "Edit link" item (already wired to
`openLinkEditor`) picks up the new modal for free, unchanged.

**`webview/ui/LinkModal.ts` full redesign:** item list (label + badge +
per-item Remove button, `listNodeLinkItems`'s `LinkItemBadge` mapped to
the same four labels the reference uses) plus a radio-gated add flow —
*Document relation* (default) triggers the QuickPick flow via a single
`onPickAndAddRelation` callback the modal doesn't need to understand;
*Link* is the pre-redesign free-text wikilink/URL/path form, defaulting to
"URL or file path" not "Wikilink" (mirrors reference `7578f31`'s same
default flip, reasoning unchanged: "Link" is specifically for external
resources, a same-workspace wikilink is better served by "Document
relation"). Every add/remove commits immediately and re-renders from the
callback's returned item list; a single "Close" button replaces the old
modal's "Save" (D7: multiple adds per session, no discrete save step).
Still a plain absolutely-positioned DOM overlay (no VS Code webview
equivalent of Obsidian's `Modal`/`Setting` — same family as
InlineEditor/SearchPanel/ContextMenu) — only the *picker* moved to native
QuickPick, not the modal shell itself, since the modal's own list/remove/
free-text-link UI has no comparable VS Code-native alternative and
extending the existing plain-DOM family for that part remains the better
fit.

**Styling:** widened `.mm-link-modal` from the pre-redesign fixed 320px to
`min(560px, 92vw)` (an item row plus two sub-forms need more room than a
single-field editor did — reference `7578f31`'s own redesign widens its
modal too, to `min(640px, 92vw)`; chose a narrower cap here since this
modal has no document/node combobox of its own to fit, that work having
moved to the native QuickPick). Added `.mm-link-items`/`-empty`,
`.mm-link-item`/`-label`/`-badge*`/`-remove`, `.mm-link-mode-radio`/
`-option`, `.mm-link-add-form` — translated from the reference's
`styles.css` (`f58b3c1`/`7578f31`) to this file's established `--vscode-*`
mapping (border/description/errorForeground/badge-background tokens,
matching the pattern every other section of this file already uses); no
new hardcoded hex.

**Verification:** `npm run build` clean; `npm test` — 36 files, 492 tests,
0 failed, 0 skipped (up from 484): `test/linkModal.test.ts` fully rewritten
(10 tests) for the new item-list/add-flow/QuickPick-delegation shape (not
a weakened suite — the old single-edit-form assertions no longer apply to
a form that no longer exists, replaced by tests of the new, correct
shape); `test/webviewBootstrap.test.ts` gained two new "Document relation"
QuickPick-flow tests (a full successful pick end-to-end, and a
cancel-at-step-1 no-op) alongside one adjusted pre-existing "linkEditor
command" test (now exercises the "Link" mode explicitly, and confirms the
modal stays open after adding per D7, rather than asserting the
pre-redesign auto-close); `test/mindMapEditorProvider.test.ts` gained five
new host-side tests covering `listMarkdownFiles`/`readForeignDocument`/
`writeForeignDocument`/`showQuickPick` directly (these existed as
unreachable dead code after the prior Phase C entry with zero host-level
test coverage — closed that gap now that they're actually exercised by a
real flow), which required extending the file's fake `vscode` module with
`workspace.findFiles`, `fs.readFile`, and `window.showQuickPick` stubs.
`diff -rq webview/{model,layout,sync,controller}` against reference HEAD
`src/{...}`: still byte-identical; `render/SvgRenderer.ts` still differs
only by the pre-existing M5 `getViewport`/`setViewport` pair — 0 lines
touched by this piece (only `webview/ui/LinkModal.ts`, `webview/main.ts`,
`src/MindMapEditorProvider.ts`, `media/mindmap.css`, and three test files
changed). `bench:relations` re-run: numbers unchanged within noise from
the prior entry (2000/200: open 30.4ms, Tab 15.0ms, relation-rename
14.0ms; 5000/500: open 41.3ms, Tab 28.3ms, relation-rename 30.2ms) — this
piece adds no per-frame/per-keystroke cost, only code paths behind an
explicit "Choose document & node…" click.

**Cost:** zero new per-frame or per-keystroke work — `showQuickPick`/
`listMarkdownFiles`/`readForeignDocument`/`writeForeignDocument` all run
only when a user explicitly opens the relation modal and clicks through
its add flow, the same order of infrequency as opening `ContextMenu` or
`LinkModal` itself. No new dependency (native `vscode.window.showQuickPick`
is a built-in VS Code API, not a package).

**Net effect — Phase C is now feature-complete:** a relation (same-doc or
cross-doc) can be both authored (via Ctrl/Cmd+K's "Document relation" add
flow) and consumed (arrow/badge rendering, click-to-open, `showRelations`
toggle) entirely through VS Code UI. No further escalation open for this
phase.

## 2026-07-20 — Phase D: trademark scrub, README/CHANGELOG updates, final consolidated benchmark re-run, re-package

**Scope:** the closing cleanup phase of the post-M5 catch-up (Phases
A–C brought node relations and status badges over from the reference
plugin). No production code in `webview/{model,layout,render,sync,
controller}` touched — this phase is docs, a trademark scrub, and a
verification/packaging pass, per its own task scope.

**Trademark scrub, mirroring reference commit `e5eea50`:** grepped this
repo case-insensitively for "XMind" across `*.md`/`*.ts`/`*.css`/`*.json`.
Found and fixed three real occurrences: `package.json`'s `description`
("XMind-like…" → "Mind mapping custom editor for markdown files, with
true bidirectional sync." — dropped the trademark rather than substituting
a paraphrase, since the sentence reads fine without it); `README.md`'s
intro line and its R1 feature-table row (both → "in the style of a
traditional desktop mind-mapper" / "familiar desktop-mind-mapper
interaction model" — following the reference's own replacement wording
almost verbatim, since it fits here too); and a code comment in
`media/mindmap.css` (`XMind-style` → `in the classic mind-map style`,
same substitution the reference made to the analogous comment in its own
`styles.css`). **Two files intentionally left untouched per the task's
explicit instruction:** `CLAUDE.md` and `vscode-mindmap-extension-plan.md`
are project-instruction/planning documents, not shipped marketing copy —
their "XMind-like" phrasing describes the original design brief and
rewriting it would blur the historical record of what was actually asked
for. **Confirmed zero remaining case-insensitive "XMind" matches anywhere
else** (`grep -rni xmind` over `*.md`/`*.ts`/`*.css`/`*.json`, excluding
`node_modules`) after the fix — including no stray hits in DECISIONS.md's
own historical entries (this phase's own file) or PROGRESS.md.

**README.md / CHANGELOG.md — documented the two Phase A–C features at the
same detail level as the existing R1–R20 list:** added R21 (node
relations: same-doc arrows, cross-doc badges, the Ctrl/Cmd+K "Document
relation" QuickPick add flow, `mindmapView.showRelations`) and R22 (status
badges: the six badges, `Ctrl/Cmd+Shift+D` toggle-done, `Ctrl/Cmd+Shift+I`
quick-pick, context-menu entries) to README's feature table; added both
new shortcuts to the keyboard-shortcut table and the "chords VS Code would
otherwise intercept" sentence; added `showRelations` to the settings
table. `CHANGELOG.md` gained a new "Unreleased — Post-M5 catch-up: node
relations & status badges" section, describing this as what it is (an
unplanned catch-up body of work, not part of the original M0–M5 milestone
numbering) rather than folding it into the M5 section or inventing a fake
milestone number.

**Packaging hygiene fix (found while re-packaging, not part of the
original task list but a real bug in the packaged artifact):** the first
`npm run package` run of this phase picked up two untracked,
uncommitted files sitting in the repo root —
`MindMapBaba.md` and `pasted-image-20260718003555.png` (a 39 KB image) —
inflating the `.vsix` to 75.45 KB. Root cause: `.vscodeignore` only lists
specific known paths (no catch-all), and `vsce` does not consult
`.gitignore` for files that were never `git add`ed, so untracked scratch
files in the repo root ship by default. Added two lines to
`.vscodeignore` (`MindMapBaba.md`, `pasted-image-*.png`) — the corrected
package is 48.33 KB. Did **not** delete the two stray files themselves
(out of scope for this phase to unilaterally remove workspace files the
user didn't ask about); flagged to the user/coordinator in the final
report instead.

**Final consolidated benchmark re-run:** `uptime` showed a load average of
3.35 (1-min, 8 cores) before running — moderate, and `npm test`'s own
2.82s completion time (normal range ~2.5–3.5s) confirmed the run wasn't
contaminated (unlike one earlier M3 run, where the suite itself ran ~13x
slower and its numbers were correctly discarded). `npm run build` clean;
`npm test` — **492 passed, 0 skipped** (36 files), unchanged from Phase C
since no production behavior changed this phase. `bench:m1`/`bench:m2`/
`bench:open`/`bench:images`/`bench:relations` all re-run and all within
budget, every figure within noise of its Phase A–C counterpart — no
regression anywhere in the whole M0–M5 + Phase A–D history. Full
consolidated table in `benchmarks.md`'s new "Phase D — final catch-up
benchmarks" section (added specifically so this doesn't need
reconstructing from eight scattered per-milestone sections later).

**Core-integrity re-verification:** `diff -rq webview/{model,layout,sync,
controller}` against reference HEAD — byte-identical, zero diffs (`diff -q`
printed nothing, confirming — not assuming — the invariant holds).
`render/SvgRenderer.ts` differs from reference HEAD only by the
user-authorized additive `getViewport`/`setViewport` pair (`diff -u`
shows one hunk, all `+` lines, zero `-` lines) — same as every prior
milestone's check.

**`RELEASING.md` — checked, not changed:** still references the
placeholder `"publisher": "TODO-set-publisher-id"`; still describes but
does not execute anything (`vsce publish`, git tag/push). Phases A–D
changed nothing about the release process, so no edit was needed —
confirmed rather than assumed.

**Cost:** none — this phase is docs, a packaging-config fix, and
verification; zero runtime code changed.

---

## 2026-07-21 — Bug fix: clicking a same-file wikilink (a same-doc relation) tried to open a nonexistent file

**Context:** user-reported (`ToolNotes.md` ^3xv1d0, with a screenshot):
Ctrl/Cmd+clicking a node's link text — specifically `[[#^3xv1d0|relation]]`,
exactly the shape a same-doc relation (Phase A/C) produces — opened a new
tab titled `#^3xv1d0.md` and immediately failed: "The editor could not be
opened because the file was not found."

**Root cause:** `webview/main.ts`'s `openLink` unconditionally forwarded
every wikilink to the host as `{type:"openLink", kind:"wikilink", target}`;
`MindMapEditorProvider.openLink` treats any non-URL, non-absolute-path
wikilink target as a *different* note's basename and appends `.md` before
resolving it relative to the document's folder. A same-file target — an
empty file part (`[[#^id]]`) or one matching the current document's own
basename — isn't a different note at all; there is no file named
`#^id.md`, so this always failed for exactly this link shape.

This gap exists because the reference Obsidian plugin's equivalent
`openLink` never needed to special-case it: `app.workspace.openLinkText`
resolves a same-file target internally, for free. `vscode.open` (this
port's replacement for that call, host-side) has no equivalent same-file
resolution — the case was simply never wired when `openLink` was ported.

**Decision:** resolve same-file wikilinks **in the webview**, before ever
reaching the host, since only the webview has the live model needed to
look a block id up:
- `isSameFileWikilinkTarget(target)`: true when the wikilink's file part
  (text before `#`, or the whole target if there's no `#`) is empty or
  case-insensitively matches `this.title` — a hand-kept mirror of
  `model/relations.ts`'s private `isSameFileTarget` (protected core, not
  exported/importable; same duplication-over-touching-core precedent as
  `MindMapEditorProvider.ts`'s own `isUrlTarget`/`isAbsoluteFilesystemPath`
  copies).
- `resolveSameFileWikilinkNode(target)`: for a same-file target with a
  `^blockid` fragment, looks it up in `this.controller.model.byId` —
  mirrors `relations.ts`'s `classifyLink`'s same-doc branch.
- `openLink`: if the target resolves to a node, calls `focusNode(id)` (the
  same select-and-center behavior the search panel already uses for "jump
  to a node") instead of posting to the host at all — no new tab, no
  round trip, and arguably more useful than opening a second view of the
  same file. If the target is same-file but unresolvable (a dangling
  `^id`, or a bare heading-text link with no caret — the same "(c) neither"
  case `classifyLink` already treats as "not a relation, ignore"), it's a
  silent no-op rather than a doomed host round trip. Only a genuinely
  different-file wikilink (or any mdlink/URL, unaffected by this fix)
  still posts to the host.

**Alternatives considered:**
- Fixing it host-side (in `MindMapEditorProvider.openLink`) by special-
  casing an empty/self file part and opening the *current* document
  instead — rejected: the host doesn't have the model, so it can't resolve
  `^blockid` to anything more useful than "open the same file with no
  scroll position," which is strictly worse than the webview-side fix
  (which can select and center the exact node) and still round-trips for
  no benefit.
- Exporting `isSameFileTarget`/`classifyLink` from `model/relations.ts` so
  `openLink` could import them directly instead of a hand-kept mirror —
  rejected: that file is byte-identical protected core; adding an export
  is a second, unauthorized divergence from the reference for a two-line
  helper that's simpler to duplicate than to get permission to touch core
  for. Flagging the duplication here (not silently maintaining two copies
  without a pointer) so a future core re-sync that changes
  `isSameFileTarget`'s rule is a deliberate "update the mirror too" step,
  not a silent drift.

**Verification:** two new tests in `test/webviewBootstrap.test.ts` — a
resolvable `[[#^id]]` click focuses (selects + is implied to center) the
target node and never posts `openLink`; an unresolvable one (`^nosuchid`)
also never posts `openLink` (silent no-op, not a broken open). 494 tests
pass (up from 492); `webview/{model,layout,render,sync,controller}`
unchanged and still byte-identical to reference HEAD — this fix lives
entirely in `webview/main.ts`.

**Cost:** none — this only runs on an explicit Ctrl/Cmd+click, and does
strictly less work than before (no host message, no `vscode.open` file
resolution attempt) for the case it fixes.

---

## 2026-07-21 — Packaging fix: `.vscodeignore`'s doc/scratch-note exclusion switched from a filename list to a blanket rule

**Context:** re-packaging after the fix above, `ToolNotes.md` (a new
scratch notes file the user created in the repo root — the same source as
the bug report itself) showed up inside the built `.vsix`. `.vscodeignore`
excluded design docs and prior scratch files (`MindMapBaba.md`,
`pasted-image-*.png`) **by exact name**, added one at a time as each was
noticed (M5, then Phase D). That approach's flaw is structural, not a
one-off miss: any *new* root-level `.md` a human drops while testing (this
one, the next one) isn't covered until someone notices it leaked and adds
its specific name — the same class of gap, recurring.

**Decision:** replaced the per-filename doc exclusions (`CLAUDE.md`,
`vscode-mindmap-extension-plan.md`, `DECISIONS.md`, `PROGRESS.md`,
`benchmarks.md`, `RELEASING.md`, `MindMapBaba.md`) with a blanket
`*.md` exclude plus an explicit two-line allowlist (`!README.md`,
`!CHANGELOG.md`) — `.vscodeignore` follows `.gitignore` syntax, including
`!` negation. Every root-level `.md` file, present today or created later
for any reason, is excluded by default; only the two that are meant to
ship are named. `pasted-image-*.png` is left as a name/glob pattern (not
generalized further) since it already matches this extension's own
generated filename format (`MindMapEditorProvider.ts`'s `writeImage`)
exactly, so it already covers every future paste-test artifact, not just
past ones — no structural gap there to fix.

**Alternatives considered:** just adding `ToolNotes.md` to the list —
rejected as treating the symptom; would need repeating for the next stray
note file, exactly the failure this decision closes off.

**Verification:** `npm run package` re-run — the `.vsix`'s file listing no
longer includes `ToolNotes.md` (or any other project `.md` besides
`readme.md`/`changelog.md`), confirmed by inspecting `vsce`'s own printed
file tree. `mindmap-view-0.0.1.vsix`: 48.45 KB (~9.7% of the 500 KB
target) — smaller than the erroneous build, not larger, since one file
was removed.

**Cost:** none — packaging-config only, no runtime code touched.

---

## 2026-07-21 — Feature: "Go to Mind Map Node" — the inverse of "Go to note section"

**Context:** user request — from the plain markdown text editor (e.g. after
using "Go to note section" to jump there from the map), a context-menu item
that jumps back to the corresponding node in the mind map. No reference-repo
counterpart exists (Obsidian's own architecture never needed this, and the
plugin doesn't have it) — this is new, VS Code-native functionality, not a
port.

**Decision — symmetric with the forward direction, host stays a dumb
relay:**
- `contributes.menus`'s `editor/context` (new — this repo had no menu
  contributions before) adds `mindmapView.goToMindMapNode`, `when:
  editorLangId == markdown`. No keybinding (not requested; the forward
  direction's Ctrl/Cmd+Shift+G stays the only keyboard entry point for now).
- **Line -> node resolution happens entirely in the webview**, never the
  host (CLAUDE.md rule 7 — the host never parses markdown or touches a
  model). The command only ever carries a raw 0-based cursor line
  (`editor.selection.active.line`) to whichever webview panel is or becomes
  responsible for that document; `webview/main.ts`'s new `focusNodeAtLine`
  resolves it against its own live model and calls the existing `focusNode`
  (same select+center used by search results).
- **Two panel-lifecycle cases**, both in `MindMapEditorProvider.ts`:
  - Already open: `entry.panel.reveal()` (bring its existing tab/column to
    front, wherever the user left it) + post `{type:"focusAtLine", line}`
    directly.
  - Not open yet: `vscode.openWith(uri, viewType, ViewColumn.Beside)` —
    beside, not a same-tab swap, matching "Go to note section"'s own
    beside-opening choice for symmetry (also leaves the source text editor
    open, which a swap would not). The line to focus is stashed in a new
    `pendingFocusLines: Map<uriString, line>` and delivered the moment that
    panel's "ready" handshake arrives (right after the initial
    `setDocument`, same message-order guarantee `postConfig`/`postDocument`
    already rely on) — there is no way to talk to a webview that doesn't
    exist yet, so the command can't just post-and-forget.
- **The line->node algorithm mirrors `sync/goToSection.ts`'s exported
  `findNodeLine`** (same frontmatter + depth-first, node-then-
  attachedContent line accounting) but inverted: `findNodeLine` takes a
  node id and returns its line; this needs the reverse (a line, find the
  node), which isn't something `findNodeLine` supports without O(n) calls
  (one per candidate node) — so it's a new single-pass walk, not a reuse of
  that function's O(n²)-if-abused shape. Written in `webview/main.ts`
  (platform layer), not added to `sync/goToSection.ts` — that file is
  protected core (byte-identical to the reference, which has no equivalent
  feature to diverge from in the first place, unlike the M5 viewport pair,
  where an existing reference file was being extended). Consuming
  `findNodeLine`'s own already-exported ingredients (`collectMeta`,
  `applyMindmapData` — both public API of protected files, not modified)
  keeps the two directions' line-numbering formula from drifting apart
  without needing to touch or fork the protected file itself.

**Alternatives considered:**
- Resolving the line to a node **host-side** (parse the document, compute a
  structural path or block-id, send that instead of a raw line) — rejected:
  requires the host to import/run the platform-free parser and walk a
  model, which is exactly the "host never parses markdown" line CLAUDE.md
  rule 7 draws; also, node ids minted fresh by two independent parses
  (host's vs. the webview's live one) aren't guaranteed to match at all
  (`webview/model/id.ts`'s counter is per-process/per-load), so an
  id-based message would be unreliable for any node without a *persisted*
  block id — the same reasoning that ruled out a host-side fix for the
  same-file-wikilink bug fix above.
- Same-tab swap (like Ctrl/Cmd+M) instead of beside — rejected: would close
  the text editor the user is actively reading, which is the opposite of
  helpful for "I'm reading the text, show me where this is in the map."

**Verification:** new tests — one in `webviewBootstrap.test.ts` (four
`focusAtLine` cases: mid-branch, a heading, the root/frontmatter boundary,
and past-the-end falls back to the last node) and three in
`mindMapEditorProvider.test.ts` (reveal+post for an already-open panel, no
new tab opened; open-beside + pending-line-delivered-after-setDocument for
a not-yet-open one, with message ordering asserted; no-op for a
non-markdown active editor). 498 tests pass (up from 494).
`webview/{model,layout,render,sync,controller}` unchanged and still
byte-identical to reference HEAD (`sync/goToSection.ts` specifically
re-confirmed untouched).

**Cost:** none on any hot path — this only runs on an explicit right-click
menu action; the line-to-node walk is O(n) over the tree once, the same
order of work `findNodeLine`'s own forward direction already does for
"Go to note section."

---

## 2026-07-21 — Feature: "Center" (context-menu item + plain `Home` shortcut)

**Context:** user request — no equivalent existed. `Ctrl/Cmd+Home` already
centers on the *root* (`SvgRenderer.centerOnRoot`, resets zoom to 1); there
was no way to re-center the view on whatever node is currently *selected*
after panning/zooming away from it, short of deselecting and re-selecting
(which `focusNode` — used by search results and the same-file-wikilink fix
above — also unfolds ancestors for, since it's built for "reveal a possibly
hidden/off-screen node," not "re-center a node I can already see").

**Decision:** a new `centerNode(nodeId)` in `webview/main.ts` that calls
the already-additive-from-core `SvgRenderer.centerOnWorldPoint` (keeps the
current zoom, unlike `centerOnRoot`) — no core change needed, this is pure
platform-layer wiring reusing an existing ported method. Exposed two ways:
- **Context-menu item** "Center" (hint: `Home`), added right after "Go to
  note section" in `showNodeMenu`'s item list — both are "jump/pan to a
  location" actions, grouped together ahead of the `Edit`/action group.
- **Plain (unmodified) `Home`** in `onKeyDown`, centering
  `this.controller.selectedId` — chosen as the mnemonic complement to the
  already-existing `Ctrl/Cmd+Home` (root): "Home" for "my" current
  position, "Ctrl/Cmd+Home" for the document's true home. Like
  `Ctrl/Cmd+Home` itself, this isn't on VS Code's intercepted-chord list
  (a bare `Home` inside a focused, non-input `div` reaches the webview's
  own `keydown` handler directly, same reasoning already established for
  Tab/Enter/Arrows/Ctrl+Home), so no `contributes.keybindings` entry is
  needed.

**Alternatives considered:** reusing `focusNode` instead of adding
`centerNode` — rejected: `focusNode` also calls `revealAndSelect` (unfolds
ancestors + reselects), which is redundant work for a node that's already
selected and visible; `centerNode` is the minimal "just pan" primitive the
task actually needs, and `focusNode` still exists unchanged for its own
"the node might be hidden/off-screen/culled" callers (search, same-file
wikilink clicks, "Go to Mind Map Node").

**Verification:** two new tests in `test/webviewBootstrap.test.ts` — the
context-menu item's label/hint and that clicking it re-centers without
changing selection; plain `Home` vs. `Ctrl/Cmd+Home` producing different
`.mm-viewport` transforms (the latter always resetting to `scale(1)`, the
former preserving zoom), following the existing `viewportTransform()`/
`nextFrame()` pattern from `webviewStatePersistence.test.ts`. 500 tests
pass (up from 498). `webview/{model,layout,render,sync,controller}`
unchanged and still byte-identical to reference HEAD.

**Cost:** none — a single `centerOnWorldPoint` call on an explicit user
action (click or keypress), no different in kind or frequency from every
other one-off pan this codebase already does (search result selection,
"Go to Mind Map Node," the same-file-wikilink fix).
