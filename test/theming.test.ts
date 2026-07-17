// M4 theming (plan §8, §4 port-map table): asserts `media/mindmap.css` was
// actually rewritten to VS Code's `--vscode-*` theme variables instead of
// still referencing Obsidian's own CSS custom properties (`--text-normal`,
// `--background-primary`, `.theme-dark`, …), which never existed in a VS
// Code webview and previously left the map rendering unstyled (see every
// milestone's benchmarks.md before this one). Doesn't (can't, headlessly)
// verify actual paint/contrast — that's the real-window F5 checklist in
// benchmarks.md — this is a structural regression guard: nobody
// accidentally reverts to an Obsidian variable name again.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const cssWithComments = readFileSync(join(__dirname, "..", "media", "mindmap.css"), "utf8");
// The file's header comment documents the Obsidian->VS Code variable mapping
// by naming the old variables for reference — strip comments before
// scanning for leftover *usages*, so that explanatory prose doesn't trip a
// check whose actual point is "no CSS rule still resolves to the old names".
const css = cssWithComments.replace(/\/\*[\s\S]*?\*\//g, "");

describe("media/mindmap.css theming", () => {
	it("uses VS Code's --vscode-* theme variables extensively", () => {
		const matches = css.match(/--vscode-[a-zA-Z.-]+/g) ?? [];
		expect(matches.length).toBeGreaterThan(20);
	});

	it("does not reference any of Obsidian's own CSS custom properties", () => {
		const obsidianVars = [
			"--text-normal",
			"--text-muted",
			"--text-faint",
			"--text-error",
			"--text-accent",
			"--text-on-accent",
			"--background-primary",
			"--background-secondary",
			"--background-modifier-border",
			"--background-modifier-hover",
			"--background-modifier-active-hover",
			"--background-modifier-error",
			"--interactive-accent",
			"--link-color",
			"--shadow-s",
			"--size-4-",
		];
		for (const v of obsidianVars) {
			expect(css.includes(v)).toBe(false);
		}
	});

	it("does not use Obsidian's .theme-dark/.theme-light body-class selectors", () => {
		expect(css.includes(".theme-dark")).toBe(false);
		expect(css.includes(".theme-light")).toBe(false);
	});

	it("maps the 8-slot branch palette to VS Code chart/terminal theme colors, not hardcoded hex values", () => {
		for (let i = 0; i < 8; i++) {
			const re = new RegExp(`--mm-color-c${i}:\\s*var\\(--vscode-(charts-|terminal-ansi)[a-zA-Z]+\\)`);
			expect(re.test(css)).toBe(true);
		}
		// No 6-digit hex codes left anywhere (the old hardcoded tone sets) —
		// a light regression guard against a future "just add a hex value"
		// edit that would reintroduce a hand-picked, unverified color.
		expect(css.match(/#[0-9a-fA-F]{6}\b/g)).toBeNull();
	});
});
