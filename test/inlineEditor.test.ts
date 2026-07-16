// @vitest-environment jsdom
//
// SKIPPED in M0: this test targets `webview/ui/InlineEditor.ts`, ported
// verbatim from the reference repo's `src/view/InlineEditor.ts`. That file
// has zero Obsidian-API dependencies (it's a plain DOM overlay) and could
// technically be ported now — but the M0 task scope explicitly lists only
// model/layout/render/sync/controller for porting; `view/*` -> `webview/ui/*`
// is scoped to M1 (webview bootstrap) / M2 (inline editing) in the roadmap
// (plan §9, §4 port-map table). Rather than pull UI work forward, the test
// is preserved verbatim below (import path pre-adjusted) and skipped so it
// activates with a one-line diff once InlineEditor.ts lands in M1/M2.
//
// This is a scope call, not a "genuinely depends on Obsidian" call — flagged
// as an open question in the M0 report for the user to confirm or override.
import { describe, it } from "vitest";

describe.skip("InlineEditor (source not yet ported — see comment above; will move to test/ui/ or stay here once webview/ui/InlineEditor.ts exists in M1/M2)", () => {
	it("placeholder — original suite preserved in git history / see comment block below", () => {});
});

/* Original suite, ready to re-enable once `webview/ui/InlineEditor.ts` exists:

import { describe, expect, it, vi } from "vitest";
import { InlineEditor } from "../webview/ui/InlineEditor";

const RECT = { left: 0, top: 0, width: 100, height: 20 };

function fireKey(input: HTMLTextAreaElement, key: string, opts: Partial<KeyboardEventInit> = {}) {
	const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
	input.dispatchEvent(evt);
	return evt;
}

// jsdom never computes real layout, so `scrollWidth` is always 0 — stub it to a fixed px-per-character so the width-growth logic (which only reads `scrollWidth`) is exercised meaningfully. Returns a restore function.
function stubScrollWidth(pxPerChar: number): () => void {
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
	Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return (this.textContent?.length ?? 0) * pxPerChar;
		},
	});
	return () => {
		if (original) Object.defineProperty(HTMLElement.prototype, "scrollWidth", original);
	};
}

describe("InlineEditor", () => {
	it("pre-fills and focuses a textarea with the initial text", () => {
		const host = document.createElement("div");
		document.body.appendChild(host); // jsdom only tracks activeElement for attached nodes
		new InlineEditor(host, {
			initialText: "hello",
			rect: RECT,
			onCommit: () => {},
			onCancel: () => {},
			onCommitAndCreateChild: () => {},
		});
		const input = host.querySelector("textarea") as HTMLTextAreaElement;
		expect(input).not.toBeNull();
		expect(input.value).toBe("hello");
		expect(document.activeElement).toBe(input);
		document.body.removeChild(host);
	});

	it("Enter commits and closes editing without creating a sibling", () => {
		const onCommit = vi.fn();
		const host = document.createElement("div");
		new InlineEditor(host, {
			initialText: "x",
			rect: RECT,
			onCommit,
			onCancel: () => {},
			onCommitAndCreateChild: () => {},
		});
		const input = host.querySelector("textarea") as HTMLTextAreaElement;
		input.value = "edited";
		fireKey(input, "Enter");
		expect(onCommit).toHaveBeenCalledWith("edited");
		expect(host.querySelector("textarea")).toBeNull();
	});

	it("Shift+Enter is left unhandled (no preventDefault, no commit) so the textarea inserts a newline itself", () => {
		const onCommit = vi.fn();
		const host = document.createElement("div");
		new InlineEditor(host, {
			initialText: "x",
			rect: RECT,
			onCommit,
			onCancel: () => {},
			onCommitAndCreateChild: () => {},
		});
		const input = host.querySelector("textarea") as HTMLTextAreaElement;
		const evt = fireKey(input, "Enter", { shiftKey: true });
		expect(evt.defaultPrevented).toBe(false);
		expect(onCommit).not.toHaveBeenCalled();
		expect(host.querySelector("textarea")).not.toBeNull(); // editing stays open
	});

	it("Tab commits and requests a child", () => {
		const onCommitAndCreateChild = vi.fn();
		const host = document.createElement("div");
		new InlineEditor(host, {
			initialText: "x",
			rect: RECT,
			onCommit: () => {},
			onCancel: () => {},
			onCommitAndCreateChild,
		});
		const input = host.querySelector("textarea") as HTMLTextAreaElement;
		fireKey(input, "Tab");
		expect(onCommitAndCreateChild).toHaveBeenCalledWith("x");
	});

	it("Escape cancels without committing", () => {
		const onCommit = vi.fn();
		const onCancel = vi.fn();
		const host = document.createElement("div");
		new InlineEditor(host, {
			initialText: "x",
			rect: RECT,
			onCommit,
			onCancel,
			onCommitAndCreateChild: () => {},
		});
		const input = host.querySelector("textarea") as HTMLTextAreaElement;
		fireKey(input, "Escape");
		expect(onCancel).toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("blur commits the current value exactly once", () => {
		const onCommit = vi.fn();
		const host = document.createElement("div");
		document.body.appendChild(host);
		new InlineEditor(host, {
			initialText: "x",
			rect: RECT,
			onCommit,
			onCancel: () => {},
			onCommitAndCreateChild: () => {},
		});
		const input = host.querySelector("textarea") as HTMLTextAreaElement;
		input.value = "blurred value";
		input.dispatchEvent(new FocusEvent("blur"));
		expect(onCommit).toHaveBeenCalledWith("blurred value");
		expect(onCommit).toHaveBeenCalledTimes(1);
		document.body.removeChild(host);
	});

	it("Enter does not also fire blur's onCommit a second time", () => {
		const onCommit = vi.fn();
		const host = document.createElement("div");
		document.body.appendChild(host);
		new InlineEditor(host, {
			initialText: "x",
			rect: RECT,
			onCommit,
			onCancel: () => {},
			onCommitAndCreateChild: () => {},
		});
		const input = host.querySelector("textarea") as HTMLTextAreaElement;
		fireKey(input, "Enter");
		input.dispatchEvent(new FocusEvent("blur"));
		expect(onCommit).toHaveBeenCalledTimes(1);
		document.body.removeChild(host);
	});

	it("grows width with content between minWidth/maxWidth, floors at minWidth, and clamps at maxWidth", () => {
		const restore = stubScrollWidth(10); // simulate ~10px/char since jsdom can't measure real text
		try {
			const host = document.createElement("div");
			new InlineEditor(host, {
				initialText: "",
				rect: RECT,
				minWidth: 30,
				maxWidth: 120,
				onCommit: () => {},
				onCancel: () => {},
				onCommitAndCreateChild: () => {},
			});
			const input = host.querySelector("textarea") as HTMLTextAreaElement;
			expect(input.style.width).toBe("30px"); // empty text floors at minWidth, not a near-zero box

			input.value = "abc"; // 3 * 10 + 16 = 46, within bounds
			input.dispatchEvent(new Event("input"));
			expect(input.style.width).toBe("46px");

			input.value = "twelve chars"; // 12 * 10 + 16 = 136, clamps at maxWidth
			input.dispatchEvent(new Event("input"));
			expect(input.style.width).toBe("120px");
		} finally {
			restore();
		}
	});

	it("without minWidth/maxWidth options, keeps the old fixed rect.width sizing regardless of content", () => {
		const restore = stubScrollWidth(10);
		try {
			const host = document.createElement("div");
			new InlineEditor(host, {
				initialText: "",
				rect: RECT,
				onCommit: () => {},
				onCancel: () => {},
				onCommitAndCreateChild: () => {},
			});
			const input = host.querySelector("textarea") as HTMLTextAreaElement;
			expect(input.style.width).toBe(`${RECT.width}px`);

			input.value = "a much longer sentence than before";
			input.dispatchEvent(new Event("input"));
			expect(input.style.width).toBe(`${RECT.width}px`);
		} finally {
			restore();
		}
	});

	it("destroy() removes the textarea without firing any callback", () => {
		const onCommit = vi.fn();
		const onCancel = vi.fn();
		const host = document.createElement("div");
		const editor = new InlineEditor(host, {
			initialText: "x",
			rect: RECT,
			onCommit,
			onCancel,
			onCommitAndCreateChild: () => {},
		});
		editor.destroy();
		expect(host.querySelector("textarea")).toBeNull();
		expect(onCommit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});
});

*/
