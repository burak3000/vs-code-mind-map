# Releasing

Everything in this file is run by a human, not by an agent — publishing is a
credentialed, outward-facing action. Nothing here has been executed for you.

There are two separate release surfaces:

1. **GitHub Releases** (`.vsix` download, install via "Install from VSIX") —
   automated by `.github/workflows/release.yml` once you push a version tag.
   No publisher account or PAT needed for this path.
2. **VS Code Marketplace** (`vsce publish`) — fully manual, credentialed,
   and separate; do this only once you're ready, after GitHub-release
   testing. See "One-time setup" and the Marketplace step below.

## One-time setup

1. **Publisher id.** `package.json`'s `"publisher"` is still the placeholder
   `"TODO-set-publisher-id"`. Create a publisher at
   https://marketplace.visualstudio.com/manage (or reuse an existing one),
   then replace the placeholder with its exact id.
2. **Azure DevOps Personal Access Token (PAT).** `vsce` publishes through
   Azure DevOps. Create an organization at https://dev.azure.com if you
   don't have one, then a PAT with **Marketplace: Manage** scope (User
   Settings → Personal Access Tokens). Treat it like a password — don't
   commit it, don't paste it anywhere but `vsce`'s own prompt/`--pat` flag.
3. **`repository` field.** `package.json` currently has no `"repository"`
   entry (this repo has no configured git remote yet). Without it, `vsce
   package`/`publish` hard-fails trying to rewrite README.md's relative
   links to absolute URLs — `npm run package` works around this today with
   `--no-rewrite-relative-links` (harmless either way here, since the README
   has no relative links to rewrite). Once the repo has a public home, add:
   ```json
   "repository": { "type": "git", "url": "https://github.com/<you>/<repo>.git" }
   ```
   and the Marketplace listing gets a working repository link. The
   `--no-rewrite-relative-links` flag can stay in `npm run package` either
   way — it's a no-op once there's nothing relative to rewrite.
4. **Icon.** No icon has been created — `vsce` packages without one but
   warns, and the Marketplace listing falls back to a generic icon. Add a
   128×128 (or larger, square) PNG, e.g. `media/icon.png`, and reference it
   from `package.json`:
   ```json
   "icon": "media/icon.png"
   ```
5. **LICENSE copyright line.** `LICENSE` was generated with `burak.ucbinli`
   (this repo's git identity) as the copyright holder — confirm that's the
   name/entity you want on it before publishing, and adjust if not.

## Every release — GitHub Release (`.vsix` download)

1. Bump `"version"` in `package.json` (semver).
2. Add a new dated section to `CHANGELOG.md`.
3. `npm test` — confirm the full suite is green.
4. `npm run build` — confirm a clean type-check + bundle.
5. `npm run package` — produces `mindmap-view-<version>.vsix` locally. Sanity
   check it: install it into a scratch VS Code profile
   (`code --install-extension mindmap-view-<version>.vsix`) and run the real-
   window checklist in `benchmarks.md` (open a fixture, confirm the map
   renders, edit round-trips, theme looks right) — nothing in this repo's
   automated test suite paints pixels, so this is the one check that
   actually looks at what a user will see.
6. Commit the `package.json`/`CHANGELOG.md` bump on `main`, then tag and
   push:
   ```sh
   git tag v<version>   # e.g. v0.0.2 — must match package.json exactly
   git push origin v<version>
   ```
   `.github/workflows/release.yml` picks up the tag, re-runs the test suite
   and build in CI (validating the tag matches `package.json`'s version),
   and publishes a GitHub Release with `mindmap-view-<version>.vsix`
   attached — watch it at the repo's Actions tab. If it fails, fix the
   issue, delete the tag (`git tag -d v<version> && git push origin
   :refs/tags/v<version>`), and re-tag once fixed; nothing partial is left
   behind since the release step only runs after tests+package succeed.
7. Once published, the release is at
   `https://github.com/<owner>/<repo>/releases/tag/v<version>` — anyone can
   download the `.vsix` and install it via "Install from VSIX..." without a
   Marketplace listing.

## When ready — VS Code Marketplace (`vsce publish`)

A separate, later, fully manual step — do this once you're satisfied with
GitHub-release testing, not automatically on every tag.

1. Complete "One-time setup" above if you haven't (publisher id, PAT,
   `repository` field, icon).
2. From the same tagged commit:
   ```sh
   npx @vscode/vsce publish -p <your-PAT>
   ```
   or `npx @vscode/vsce login <publisher>` once, then `npx @vscode/vsce publish`
   for subsequent releases without repeating the PAT each time.
3. Confirm the new version shows up on the Marketplace listing
   (https://marketplace.visualstudio.com/items?itemName=<publisher>.mindmap-view)
   — propagation is usually within a few minutes.

## Un-publishing / rolling back

`npx @vscode/vsce unpublish <publisher>.mindmap-view` removes the *entire*
extension listing, not just one version — there is no "unpublish this one
version" for a single bad release; publish a fixed patch version instead
unless the whole extension needs to come down.
