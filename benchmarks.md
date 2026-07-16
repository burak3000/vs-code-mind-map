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
