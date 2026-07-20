export type LinkKind = "wikilink" | "mdlink";

export interface TextSegment {
	text: string;
	link: { kind: LinkKind; target: string } | null;
}

// [[target]] or [[target|alias]], and [label](target) — the two link forms
// callable from the Ctrl/Cmd+Shift+L editor (R5).
const LINK_RE = /\[\[([^\]]+)\]\]|\[([^\]]*)\]\(([^)]+)\)/g;

/** Splits node text into plain-text and link runs for rendering as clickable spans. */
export function parseTextSegments(text: string): TextSegment[] {
	const segments: TextSegment[] = [];
	let lastIndex = 0;
	LINK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = LINK_RE.exec(text))) {
		if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), link: null });
		if (match[1] !== undefined) {
			const [target, alias] = match[1].split("|");
			segments.push({ text: alias ?? target, link: { kind: "wikilink", target } });
		} else {
			segments.push({ text: match[2] || match[3], link: { kind: "mdlink", target: match[3] } });
		}
		lastIndex = LINK_RE.lastIndex;
	}
	if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), link: null });
	if (segments.length === 0) segments.push({ text: "", link: null });
	return segments;
}

/**
 * The text as it should actually be displayed/measured (link syntax
 * replaced by its label) — used for both rendering and node-width
 * estimation. Width estimation runs on every layout pass and flextree
 * invokes it multiple times per node internally, so the fast path here
 * (skip the regex entirely when there's no `[` at all — the vast majority
 * of node text) matters: it's what keeps layout time from regressing
 * once link-aware width estimation was added (see DECISIONS.md).
 */
export function getDisplayText(text: string): string {
	if (!text.includes("[")) return text;
	return parseTextSegments(text)
		.map((s) => s.text)
		.join("");
}

/** True if node text has exactly one link occupying the whole label (the common case the Ctrl/Cmd+Shift+L editor produces) — used to prefill the link editor. */
export function getSoleLink(text: string): { kind: LinkKind; target: string; label: string } | null {
	const segments = parseTextSegments(text).filter((s) => s.text.length > 0);
	if (segments.length === 1 && segments[0].link) {
		return { ...segments[0].link, label: segments[0].text };
	}
	return null;
}

/** Builds node-text for a link (Ctrl/Cmd+Shift+L editor), matching the syntax `parseTextSegments` understands. */
export function buildLinkText(result: { label: string; kind: LinkKind; target: string }): string {
	if (result.kind === "wikilink") {
		return result.label === result.target ? `[[${result.target}]]` : `[[${result.target}|${result.label}]]`;
	}
	return `[${result.label}](${result.target})`;
}

/**
 * Appends a newly authored link/relation to a node's existing text (R3/R5)
 * rather than replacing it, so one node can carry multiple relations —
 * resolved per user decision D7 as **visible** append
 * (`"existing text → target label"`), not an invisible/empty-alias append:
 * a plain `" → "` separator, not part of the link syntax itself, so
 * `getDisplayText` renders it as ordinary text. `linkText` is expected to
 * already be `buildLinkText(...)` output.
 */
export function appendLinkText(text: string, linkText: string): string {
	return text.trim() ? `${text} → ${linkText}` : linkText;
}

// Matches appendLinkText's separator exactly — used by removeLinkOccurrence
// to avoid leaving a dangling arrow behind when one relation among several
// is removed.
const APPEND_ARROW = " → ";

/**
 * Removes the Nth link occurrence (0-based, in the same left-to-right order
 * `parseTextSegments`/`LINK_RE` find them — see `listNodeLinkItems` in
 * `model/relations.ts`, which hands out exactly this index for each row it
 * lists) from `text`, along with one adjacent `" → "` separator so removing
 * one relation from a multi-relation node (R3/R5) doesn't leave a dangling
 * arrow behind. Operates on raw regex match positions rather than
 * re-serializing `parseTextSegments`'s output (which keeps only a link's
 * display label, not its exact source syntax), so every other link/plain
 * text in `text` round-trips untouched. A no-op (returns `text` unchanged)
 * if `occurrenceIndex` is out of range.
 */
export function removeLinkOccurrence(text: string, occurrenceIndex: number): string {
	const matches: { start: number; end: number }[] = [];
	LINK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = LINK_RE.exec(text))) {
		matches.push({ start: match.index, end: LINK_RE.lastIndex });
	}
	if (occurrenceIndex < 0 || occurrenceIndex >= matches.length) return text;

	const { start, end } = matches[occurrenceIndex];
	let removeStart = start;
	let removeEnd = end;
	if (text.slice(Math.max(0, start - APPEND_ARROW.length), start) === APPEND_ARROW) {
		removeStart = start - APPEND_ARROW.length;
	} else if (text.slice(end, end + APPEND_ARROW.length) === APPEND_ARROW) {
		removeEnd = end + APPEND_ARROW.length;
	}
	return text.slice(0, removeStart) + text.slice(removeEnd);
}

export interface EmbedInfo {
	kind: LinkKind;
	target: string;
	alt: string;
}

// ![[target]] or ![[target|alt]], and ![alt](target) — embed syntax (plan
// item 07: image display). The leading `!` is what distinguishes an embed
// from an ordinary link of the same shape.
const EMBED_RE = /!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)/g;

/** Every embed in `text`, regardless of target type (image or otherwise) — callers that only care about images should filter with `isImageTarget`/use `getImageEmbed`. */
export function parseEmbeds(text: string): EmbedInfo[] {
	const out: EmbedInfo[] = [];
	EMBED_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = EMBED_RE.exec(text))) {
		if (match[1] !== undefined) {
			const [target, alias] = match[1].split("|");
			out.push({ kind: "wikilink", target, alt: alias ?? target });
		} else {
			out.push({ kind: "mdlink", target: match[3], alt: match[2] ?? "" });
		}
	}
	return out;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

/** Whether `target` (a vault path or URL, possibly with a query string/fragment) points at a common image file type. */
export function isImageTarget(target: string): boolean {
	return IMAGE_EXT_RE.test(target.split(/[?#]/)[0]);
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Common TLDs a bare (no-scheme) domain-shaped target is allowed to end in
 * for `isUrlTarget` to treat it as a URL — deliberately a curated list, not
 * "any 2-24 letter final segment", because that shape collides with plenty
 * of ordinary file names (`config.json`, `notes.txt`). `.md` is
 * deliberately excluded even though it's a real ccTLD (Moldova): in an
 * Obsidian vault, `word.md` overwhelmingly means a note/attachment
 * reference, not a domain, and the cost of that false positive (breaking a
 * real vault-file link) is far worse than the cost of not recognizing a
 * genuine `.md` domain (rare).
 */
const COMMON_BARE_TLDS = new Set([
	"com", "org", "net", "io", "dev", "app", "co", "edu", "gov", "info", "biz", "me", "ai",
	"us", "uk", "ca", "de", "fr", "jp", "cn", "in", "au", "nl", "xyz", "tv", "site", "online", "tech", "cloud",
]);

const BARE_DOMAIN_RE = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+)([a-z]{2,24})(:\d+)?([/?#]\S*)?$/i;

/** Whether `target` (no explicit scheme) is shaped like a bare domain (`www.example.com`, `example.co.uk`) — a `www.` prefix is always accepted; otherwise the final segment must be a common TLD (see `COMMON_BARE_TLDS`) to keep ordinary dotted file names from being misclassified. */
function hasBareDomainShape(target: string): boolean {
	const m = BARE_DOMAIN_RE.exec(target);
	if (!m) return false;
	if (/^www\./i.test(target)) return true;
	return COMMON_BARE_TLDS.has(m[2].toLowerCase());
}

/**
 * Whether `target` is a URL — either an explicit scheme (`https://…`,
 * `mailto:…`) or a bare domain typed without one (`www.youtube.com`,
 * `youtube.com`). A real wikilink/vault-relative target never looks like
 * either shape, so this doubles as a defensive check when a URL ends up on
 * a wikilink-kind link (e.g. typed as `[[https://example.com]]`, or
 * entered into the modal's Target field with "Wikilink" left selected):
 * such a link should still open externally, not try to create/open a vault
 * note named after it.
 */
export function isUrlTarget(target: string): boolean {
	return URL_SCHEME_RE.test(target) || hasBareDomainShape(target);
}

/** `target` as a URL a browser/`shell.openExternal` can actually navigate to — adds `https://` when `target` had no scheme (the bare-domain case `isUrlTarget` also recognizes). A no-op when a scheme is already present. */
export function normalizeUrlTarget(target: string): string {
	return URL_SCHEME_RE.test(target) ? target : `https://${target}`;
}

const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;

/** Whether `target` is an absolute filesystem path (`/…`, `~/…`, or `C:\…`/`C:/…`) rather than a vault-relative note/attachment reference — the signal used to route a "Link" target to the OS (open the file in its default app, or the folder in the system file browser) instead of Obsidian's own vault-relative link resolution. */
export function isAbsoluteFilesystemPath(target: string): boolean {
	return target === "~" || target.startsWith("/") || target.startsWith("~/") || WINDOWS_ABS_RE.test(target);
}

/** Expands a leading `~`/`~/` to `homeDir` (typically `os.homedir()` — passed in rather than read here so this stays a pure, unit-testable function); any other path is returned unchanged. */
export function expandHomePath(target: string, homeDir: string): string {
	if (target === "~") return homeDir;
	if (target.startsWith("~/")) return homeDir + target.slice(1);
	return target;
}

/**
 * The image embed to render for a node (plan item 07), if its text has
 * one — the *first* image-target embed, not requiring it to occupy the
 * whole text (unlike `getSoleLink`): a caption alongside an embed
 * (`Photo: ![[img.png]]`) is common and shouldn't disqualify it. Null if
 * there's no embed, or its target isn't an image (e.g. `![[note.pdf]]`).
 */
export function getImageEmbed(text: string): EmbedInfo | null {
	if (!text.includes("![")) return null; // fast path — avoids the regex for the vast majority of node text, same reasoning as getDisplayText
	return parseEmbeds(text).find((e) => isImageTarget(e.target)) ?? null;
}
