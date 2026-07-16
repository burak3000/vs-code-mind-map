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
