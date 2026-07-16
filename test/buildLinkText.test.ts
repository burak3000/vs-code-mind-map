import { describe, expect, it } from "vitest";
import { buildLinkText, parseTextSegments } from "../webview/model/links";

describe("buildLinkText", () => {
	it("builds a bare wikilink when label matches target", () => {
		expect(buildLinkText({ label: "Some Note", kind: "wikilink", target: "Some Note" })).toBe("[[Some Note]]");
	});

	it("builds an aliased wikilink when label differs from target", () => {
		expect(buildLinkText({ label: "Display", kind: "wikilink", target: "Some Note" })).toBe("[[Some Note|Display]]");
	});

	it("builds a markdown link for mdlink kind", () => {
		expect(buildLinkText({ label: "label", kind: "mdlink", target: "https://example.com" })).toBe("[label](https://example.com)");
	});

	it("round-trips through parseTextSegments", () => {
		const built = buildLinkText({ label: "Display", kind: "wikilink", target: "Some Note" });
		const segments = parseTextSegments(built);
		expect(segments).toEqual([{ text: "Display", link: { kind: "wikilink", target: "Some Note" } }]);
	});
});
