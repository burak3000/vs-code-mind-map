// @vitest-environment jsdom
//
// SKIPPED in M0: this test targets `webview/ui/SearchPanel.ts`, ported
// verbatim from the reference repo's `src/view/SearchPanel.ts`. That file
// has zero Obsidian-API dependencies (it's a plain DOM overlay) and could
// technically be ported now — but the M0 task scope explicitly lists only
// model/layout/render/sync/controller for porting; `view/*` -> `webview/ui/*`
// is scoped to M3 (search panel) in the roadmap (plan §9, §4 port-map table).
// Rather than pull UI work forward, the test is preserved verbatim below
// (import path pre-adjusted) and skipped so it activates with a one-line
// diff once SearchPanel.ts lands in M3.
//
// This is a scope call, not a "genuinely depends on Obsidian" call — flagged
// as an open question in the M0 report for the user to confirm or override.
import { describe, it } from "vitest";

describe.skip("SearchPanel (source not yet ported — see comment above; will move to test/ui/ or stay here once webview/ui/SearchPanel.ts exists in M3)", () => {
	it("placeholder — original suite preserved in comment block below", () => {});
});

/* Original suite, ready to re-enable once `webview/ui/SearchPanel.ts` exists:

import { describe, expect, it, vi } from "vitest";
import { SearchPanel } from "../webview/ui/SearchPanel";
import { SearchOutcome } from "../webview/model/search";

function fireKey(input: HTMLInputElement, key: string) {
	input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const OUTCOME: SearchOutcome = {
	results: [
		{ id: "n1", text: "Alpha" },
		{ id: "n2", text: "Beta" },
	],
	totalMatches: 2,
};

describe("SearchPanel", () => {
	it("focuses the input on creation and runs a query on every keystroke", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const onQuery = vi.fn().mockReturnValue(OUTCOME);
		new SearchPanel(host, { onQuery, onSelect: () => {}, onClose: () => {} });

		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		expect(document.activeElement).toBe(input);

		input.value = "alp";
		input.dispatchEvent(new Event("input"));
		expect(onQuery).toHaveBeenCalledWith("alp");
		expect(host.querySelectorAll(".mm-search-result").length).toBe(2);
		expect(host.querySelector(".mm-search-result")!.textContent).toBe("Alpha");

		document.body.removeChild(host);
	});

	it("clicking a result calls onSelect with that node's id", () => {
		const host = document.createElement("div");
		const onSelect = vi.fn();
		new SearchPanel(host, { onQuery: () => OUTCOME, onSelect, onClose: () => {} });

		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		input.dispatchEvent(new Event("input"));

		const items = host.querySelectorAll(".mm-search-result");
		items[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onSelect).toHaveBeenCalledWith("n2");
	});

	it("Enter selects the first result by default", () => {
		const host = document.createElement("div");
		const onSelect = vi.fn();
		new SearchPanel(host, { onQuery: () => OUTCOME, onSelect, onClose: () => {} });
		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		input.dispatchEvent(new Event("input"));

		fireKey(input, "Enter");
		expect(onSelect).toHaveBeenCalledWith("n1");
	});

	it("ArrowDown/ArrowUp move the highlighted result, and Enter selects it", () => {
		const host = document.createElement("div");
		const onSelect = vi.fn();
		new SearchPanel(host, { onQuery: () => OUTCOME, onSelect, onClose: () => {} });
		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		input.dispatchEvent(new Event("input"));

		fireKey(input, "ArrowDown"); // 0 -> 1
		expect(host.querySelectorAll(".mm-search-result")[1].classList.contains("mm-search-result-active")).toBe(true);

		fireKey(input, "Enter");
		expect(onSelect).toHaveBeenCalledWith("n2");
	});

	it("ArrowDown wraps from the last result back to the first", () => {
		const host = document.createElement("div");
		new SearchPanel(host, { onQuery: () => OUTCOME, onSelect: () => {}, onClose: () => {} });
		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		input.dispatchEvent(new Event("input"));

		fireKey(input, "ArrowDown"); // 0 -> 1
		fireKey(input, "ArrowDown"); // 1 -> wraps to 0
		expect(host.querySelectorAll(".mm-search-result")[0].classList.contains("mm-search-result-active")).toBe(true);
	});

	it("Escape calls onClose", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		new SearchPanel(host, { onQuery: () => ({ results: [], totalMatches: 0 }), onSelect: () => {}, onClose });
		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		fireKey(input, "Escape");
		expect(onClose).toHaveBeenCalled();
	});

	it("shows a count of total matches even when the result list is capped", () => {
		const host = document.createElement("div");
		new SearchPanel(host, {
			onQuery: () => ({ results: [{ id: "n1", text: "x" }], totalMatches: 5 }),
			onSelect: () => {},
			onClose: () => {},
		});
		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		input.value = "x";
		input.dispatchEvent(new Event("input"));
		expect(host.querySelector(".mm-search-count")!.textContent).toContain("5 matches");
	});

	it("shows nothing for an empty query and 'No matches' for a query with zero hits", () => {
		const host = document.createElement("div");
		let outcome: SearchOutcome = { results: [], totalMatches: 0 };
		new SearchPanel(host, { onQuery: () => outcome, onSelect: () => {}, onClose: () => {} });
		const input = host.querySelector(".mm-search-input") as HTMLInputElement;

		input.value = "";
		input.dispatchEvent(new Event("input"));
		expect(host.querySelector(".mm-search-count")!.textContent).toBe("");

		input.value = "nothing matches this";
		input.dispatchEvent(new Event("input"));
		expect(host.querySelector(".mm-search-count")!.textContent).toBe("No matches");
	});

	it("destroy() removes the panel from the DOM", () => {
		const host = document.createElement("div");
		const panel = new SearchPanel(host, { onQuery: () => OUTCOME, onSelect: () => {}, onClose: () => {} });
		panel.destroy();
		expect(host.querySelector(".mm-search-panel")).toBeNull();
	});

	it("focus() re-focuses the input without rebuilding the panel", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const panel = new SearchPanel(host, { onQuery: () => OUTCOME, onSelect: () => {}, onClose: () => {} });
		const input = host.querySelector(".mm-search-input") as HTMLInputElement;
		(document.activeElement as HTMLElement).blur();
		expect(document.activeElement).not.toBe(input);

		panel.focus();
		expect(document.activeElement).toBe(input);
		document.body.removeChild(host);
	});
});

*/
