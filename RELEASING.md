# Releasing

Everything in this file is run by a human, not by an agent — publishing is a
credentialed, outward-facing action. Nothing here has been executed for you.

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

## Every release

1. Bump `"version"` in `package.json` (semver — `vsce publish patch/minor/major`
   can do this for you and tag the commit).
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
6. Publish:
   ```sh
   npx @vscode/vsce publish -p <your-PAT>
   ```
   or `npx @vscode/vsce login <publisher>` once, then `npx @vscode/vsce publish`
   for subsequent releases without repeating the PAT each time.
7. Confirm the new version shows up on the Marketplace listing
   (https://marketplace.visualstudio.com/items?itemName=<publisher>.mindmap-view)
   — propagation is usually within a few minutes.

## Un-publishing / rolling back

`npx @vscode/vsce unpublish <publisher>.mindmap-view` removes the *entire*
extension listing, not just one version — there is no "unpublish this one
version" for a single bad release; publish a fixed patch version instead
unless the whole extension needs to come down.
