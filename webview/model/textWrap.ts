import { LinkKind, parseTextSegments } from "./links";

export interface WordToken {
	text: string;
	link: { kind: LinkKind; target: string } | null;
	/** Whether a single space precedes this token when re-joined onto its line (false for the first token on a line). */
	spaceBefore: boolean;
}

/** Flattens link-aware segments into individual words, each still carrying its source link (if any) so wrapping can break between words without losing link click targets. */
function tokenize(text: string): WordToken[] {
	const segments = parseTextSegments(text);
	const tokens: WordToken[] = [];
	for (const seg of segments) {
		for (const word of seg.text.split(/\s+/)) {
			if (word.length === 0) continue;
			tokens.push({ text: word, link: seg.link, spaceBefore: tokens.length > 0 });
		}
	}
	return tokens;
}

/**
 * Greedy word-wrap: packs tokens onto a line while the running character
 * count (each word plus one space before it, except the first on a line)
 * stays within `maxCharsPerLine`. A single token longer than the limit is
 * left whole on its own line rather than hyphenated — out of scope (not
 * requested; real complexity for an edge case a user is unlikely to hit).
 */
export function wrapTokens(tokens: WordToken[], maxCharsPerLine: number): WordToken[][] {
	if (tokens.length === 0) return [[]];
	const limit = Math.max(1, maxCharsPerLine);
	const lines: WordToken[][] = [];
	let current: WordToken[] = [];
	let currentLen = 0;
	for (const tok of tokens) {
		const isFirstOnLine = current.length === 0;
		const addLen = tok.text.length + (isFirstOnLine ? 0 : 1);
		if (!isFirstOnLine && currentLen + addLen > limit) {
			lines.push(current);
			current = [{ ...tok, spaceBefore: false }];
			currentLen = tok.text.length;
		} else {
			current.push(isFirstOnLine ? { ...tok, spaceBefore: false } : tok);
			currentLen += addLen;
		}
	}
	lines.push(current);
	return lines;
}

export function wrapText(text: string, maxCharsPerLine: number): WordToken[][] {
	return wrapTokens(tokenize(text), maxCharsPerLine);
}

/** Character length of a line as it would actually be displayed (words + one space between each). */
export function lineLength(line: WordToken[]): number {
	return line.reduce((sum, t) => sum + t.text.length + (t.spaceBefore ? 1 : 0), 0);
}
