export type LinkKind = "wikilink" | "mdlink";

export interface TextSegment {
	text: string;
	link: { kind: LinkKind; target: string } | null;
}

// [[target]] or [[target|alias]], and [label](target) — the two link forms
// callable from the Ctrl/Cmd+K editor (R5).
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

/** True if node text has exactly one link occupying the whole label (the common case the Ctrl/Cmd+K editor produces) — used to prefill the link editor. */
export function getSoleLink(text: string): { kind: LinkKind; target: string; label: string } | null {
	const segments = parseTextSegments(text).filter((s) => s.text.length > 0);
	if (segments.length === 1 && segments[0].link) {
		return { ...segments[0].link, label: segments[0].text };
	}
	return null;
}

/** Builds node-text for a link (Ctrl/Cmd+K editor), matching the syntax `parseTextSegments` understands. */
export function buildLinkText(result: { label: string; kind: LinkKind; target: string }): string {
	if (result.kind === "wikilink") {
		return result.label === result.target ? `[[${result.target}]]` : `[[${result.target}|${result.label}]]`;
	}
	return `[${result.label}](${result.target})`;
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
