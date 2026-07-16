import { describe, expect, it } from "vitest";
import { parseTextSegments, getDisplayText, getSoleLink, parseEmbeds, getImageEmbed, isImageTarget } from "../webview/model/links";

describe("parseTextSegments", () => {
	it("returns a single plain segment for text with no links", () => {
		expect(parseTextSegments("just text")).toEqual([{ text: "just text", link: null }]);
	});

	it("parses a bare wikilink", () => {
		expect(parseTextSegments("[[Some Note]]")).toEqual([{ text: "Some Note", link: { kind: "wikilink", target: "Some Note" } }]);
	});

	it("parses an aliased wikilink, showing the alias", () => {
		expect(parseTextSegments("[[Some Note|Display]]")).toEqual([{ text: "Display", link: { kind: "wikilink", target: "Some Note" } }]);
	});

	it("parses a markdown link", () => {
		expect(parseTextSegments("[label](https://example.com)")).toEqual([{ text: "label", link: { kind: "mdlink", target: "https://example.com" } }]);
	});

	it("mixes plain text and a link in one string, preserving order", () => {
		const segments = parseTextSegments("Check [[Note A]] please");
		expect(segments).toEqual([
			{ text: "Check ", link: null },
			{ text: "Note A", link: { kind: "wikilink", target: "Note A" } },
			{ text: " please", link: null },
		]);
	});

	it("handles multiple links in one string", () => {
		const segments = parseTextSegments("[[A]] and [[B]]");
		expect(segments.filter((s) => s.link).map((s) => s.text)).toEqual(["A", "B"]);
	});
});

describe("getDisplayText", () => {
	it("strips link syntax down to the visible label", () => {
		expect(getDisplayText("Check [[Some Note|Display]] please")).toBe("Check Display please");
		expect(getDisplayText("[label](https://example.com)")).toBe("label");
		expect(getDisplayText("no links here")).toBe("no links here");
	});
});

describe("getSoleLink", () => {
	it("returns the link when the whole node text is exactly one link", () => {
		expect(getSoleLink("[[Some Note]]")).toEqual({ kind: "wikilink", target: "Some Note", label: "Some Note" });
		expect(getSoleLink("[label](url)")).toEqual({ kind: "mdlink", target: "url", label: "label" });
	});

	it("returns null when there is surrounding plain text", () => {
		expect(getSoleLink("Check [[Note]] please")).toBeNull();
	});

	it("returns null when there is no link at all", () => {
		expect(getSoleLink("plain text")).toBeNull();
	});
});

describe("parseEmbeds (plan item 07: image display)", () => {
	it("parses a wikilink embed", () => {
		expect(parseEmbeds("![[photo.png]]")).toEqual([{ kind: "wikilink", target: "photo.png", alt: "photo.png" }]);
	});

	it("parses a wikilink embed with an alias as alt text", () => {
		expect(parseEmbeds("![[photo.png|My photo]]")).toEqual([{ kind: "wikilink", target: "photo.png", alt: "My photo" }]);
	});

	it("parses a markdown-form embed", () => {
		expect(parseEmbeds("![alt text](path/to.png)")).toEqual([{ kind: "mdlink", target: "path/to.png", alt: "alt text" }]);
	});

	it("does not confuse a regular (non-embed) link with an embed", () => {
		expect(parseEmbeds("[[Some Note]]")).toEqual([]);
		expect(parseEmbeds("[label](url)")).toEqual([]);
	});

	it("finds multiple embeds in one string", () => {
		const embeds = parseEmbeds("![[a.png]] and ![[b.png]]");
		expect(embeds.map((e) => e.target)).toEqual(["a.png", "b.png"]);
	});
});

describe("isImageTarget", () => {
	it("recognizes common image extensions, case-insensitively", () => {
		for (const ext of ["png", "PNG", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"]) {
			expect(isImageTarget(`photo.${ext}`)).toBe(true);
		}
	});

	it("ignores a query string/fragment when checking the extension", () => {
		expect(isImageTarget("https://example.com/photo.png?w=200")).toBe(true);
		expect(isImageTarget("photo.png#fragment")).toBe(true);
	});

	it("rejects non-image targets", () => {
		expect(isImageTarget("note.pdf")).toBe(false);
		expect(isImageTarget("Some Note")).toBe(false);
	});
});

describe("getImageEmbed (plan item 07: image display)", () => {
	it("returns the embed when the target is an image", () => {
		expect(getImageEmbed("![[photo.png]]")).toEqual({ kind: "wikilink", target: "photo.png", alt: "photo.png" });
	});

	it("returns the embed even alongside surrounding caption text (unlike getSoleLink, doesn't require the whole text to be just the embed)", () => {
		expect(getImageEmbed("Photo: ![[photo.png]]")).toEqual({ kind: "wikilink", target: "photo.png", alt: "photo.png" });
	});

	it("returns null when the embed's target isn't an image (e.g. a PDF)", () => {
		expect(getImageEmbed("![[note.pdf]]")).toBeNull();
	});

	it("returns null when there's no embed at all", () => {
		expect(getImageEmbed("plain text")).toBeNull();
		expect(getImageEmbed("[[Some Note]]")).toBeNull(); // a regular link, not an embed
	});

	it("returns the first image embed when there are several", () => {
		const embed = getImageEmbed("![[a.png]] ![[b.png]]");
		expect(embed?.target).toBe("a.png");
	});
});
