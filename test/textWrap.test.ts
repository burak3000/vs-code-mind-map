import { describe, expect, it } from "vitest";
import { wrapText, lineLength } from "../webview/model/textWrap";

const text = (lines: ReturnType<typeof wrapText>) => lines.map((l) => l.map((t) => (t.spaceBefore ? " " : "") + t.text).join(""));

describe("wrapText", () => {
	it("keeps short text on a single line", () => {
		const lines = wrapText("hello world", 60);
		expect(lines.length).toBe(1);
		expect(text(lines)).toEqual(["hello world"]);
	});

	it("wraps at a word boundary once the limit is exceeded", () => {
		const lines = wrapText("one two three four five", 12);
		// "one two" = 7 chars, adding " three" would be 13 > 12, so wraps there.
		expect(text(lines)).toEqual(["one two", "three four", "five"]);
	});

	it("never breaks a single word even if it exceeds the limit", () => {
		const lines = wrapText("supercalifragilisticexpialidocious", 10);
		expect(lines.length).toBe(1);
		expect(text(lines)[0]).toBe("supercalifragilisticexpialidocious");
	});

	it("treats an empty string as a single empty line, not zero lines", () => {
		const lines = wrapText("", 60);
		expect(lines.length).toBe(1);
		expect(lines[0]).toEqual([]);
	});

	it("keeps a link's label attached to the correct token when it wraps across lines", () => {
		const lines = wrapText("start [[Some Note]] end of a long line that keeps going", 20);
		const flatTokens = lines.flat();
		const someTok = flatTokens.find((t) => t.text === "Some");
		const noteTok = flatTokens.find((t) => t.text === "Note");
		expect(someTok?.link).toEqual({ kind: "wikilink", target: "Some Note" });
		expect(noteTok?.link).toEqual({ kind: "wikilink", target: "Some Note" });
	});

	it("lineLength counts words plus one space between each", () => {
		const lines = wrapText("ab cd", 60);
		expect(lineLength(lines[0])).toBe(5); // "ab cd"
	});
});
