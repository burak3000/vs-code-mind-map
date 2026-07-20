// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineEditor } from "../webview/ui/InlineEditor";

const RECT = { left: 0, top: 0, width: 100, height: 20 };

function fireKey(input: HTMLTextAreaElement, key: string, opts: Partial<KeyboardEventInit> = {}) {
	const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
	input.dispatchEvent(evt);
	return evt;
}

/** jsdom never computes real layout, so `scrollWidth` is always 0 — stub it to a fixed px-per-character so the width-growth logic (which only reads `scrollWidth`) is exercised meaningfully. Returns a restore function. */
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

type EditorOpts = Partial<{ initialText: string; rect: typeof RECT; minWidth: number; maxWidth: number; fontSize: number; attach: boolean }>;

let attachedHosts: HTMLElement[] = [];
afterEach(() => {
	for (const host of attachedHosts) host.remove();
	attachedHosts = [];
});

/** Builds an InlineEditor with vi.fn() spies for all three callbacks (override via the returned handles). `attach: true` appends the host to document.body — needed for activeElement/blur tests — and is auto-removed in afterEach. */
function makeEditor(opts: EditorOpts = {}) {
	const host = document.createElement("div");
	if (opts.attach) {
		document.body.appendChild(host);
		attachedHosts.push(host);
	}
	const onCommit = vi.fn();
	const onCancel = vi.fn();
	const onCommitAndCreateChild = vi.fn();
	const editor = new InlineEditor(host, {
		initialText: opts.initialText ?? "x",
		rect: opts.rect ?? RECT,
		minWidth: opts.minWidth,
		maxWidth: opts.maxWidth,
		fontSize: opts.fontSize,
		onCommit,
		onCancel,
		onCommitAndCreateChild,
	});
	const input = host.querySelector("textarea") as HTMLTextAreaElement;
	return { host, editor, input, onCommit, onCancel, onCommitAndCreateChild };
}

describe("InlineEditor", () => {
	it("pre-fills and focuses a textarea with the initial text", () => {
		const { input } = makeEditor({ initialText: "hello", attach: true }); // jsdom only tracks activeElement for attached nodes
		expect(input).not.toBeNull();
		expect(input.value).toBe("hello");
		expect(document.activeElement).toBe(input);
	});

	it("Enter commits and closes editing without creating a sibling", () => {
		const { host, input, onCommit } = makeEditor();
		input.value = "edited";
		fireKey(input, "Enter");
		expect(onCommit).toHaveBeenCalledWith("edited");
		expect(host.querySelector("textarea")).toBeNull();
	});

	it("Shift+Enter is left unhandled (no preventDefault, no commit) so the textarea inserts a newline itself", () => {
		const { host, input, onCommit } = makeEditor();
		const evt = fireKey(input, "Enter", { shiftKey: true });
		expect(evt.defaultPrevented).toBe(false);
		expect(onCommit).not.toHaveBeenCalled();
		expect(host.querySelector("textarea")).not.toBeNull(); // editing stays open
	});

	it("Tab commits and requests a child", () => {
		const { input, onCommitAndCreateChild } = makeEditor();
		fireKey(input, "Tab");
		expect(onCommitAndCreateChild).toHaveBeenCalledWith("x");
	});

	it("Escape cancels without committing", () => {
		const { input, onCommit, onCancel } = makeEditor();
		fireKey(input, "Escape");
		expect(onCancel).toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("blur commits the current value exactly once", () => {
		const { input, onCommit } = makeEditor({ attach: true });
		input.value = "blurred value";
		input.dispatchEvent(new FocusEvent("blur"));
		expect(onCommit).toHaveBeenCalledWith("blurred value");
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("Enter does not also fire blur's onCommit a second time", () => {
		const { input, onCommit } = makeEditor({ attach: true });
		fireKey(input, "Enter");
		input.dispatchEvent(new FocusEvent("blur"));
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("grows width with content between minWidth/maxWidth, floors at minWidth, and clamps at maxWidth", () => {
		const restore = stubScrollWidth(10); // simulate ~10px/char since jsdom can't measure real text
		try {
			const { input } = makeEditor({ initialText: "", minWidth: 30, maxWidth: 120 });
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
			const { input } = makeEditor({ initialText: "" });
			expect(input.style.width).toBe(`${RECT.width}px`);

			input.value = "a much longer sentence than before";
			input.dispatchEvent(new Event("input"));
			expect(input.style.width).toBe(`${RECT.width}px`);
		} finally {
			restore();
		}
	});

	it("reposition() updates left/top style to the new rect (F3: pan/zoom tracking)", () => {
		const { editor, input } = makeEditor();
		expect(input.style.left).toBe(`${RECT.left}px`);
		expect(input.style.top).toBe(`${RECT.top}px`);

		editor.reposition({ left: 250, top: 130, width: 90, height: 30 });
		expect(input.style.left).toBe("250px");
		expect(input.style.top).toBe("130px");
	});

	it("reposition() updates font size when zoom changes it, and re-measures width against the new font", () => {
		const restore = stubScrollWidth(10);
		try {
			const { editor, input } = makeEditor({ initialText: "abc", minWidth: 30, maxWidth: 120, fontSize: 14 });
			expect(input.style.fontSize).toBe("14px");

			editor.reposition({ left: 0, top: 0, width: 100, height: 20 }, 21);
			expect(input.style.fontSize).toBe("21px");
			// Width still gets re-clamped to [minWidth, maxWidth] after the font
			// change — resizeWidth() ran again rather than leaving a stale width.
			expect(input.style.width).toBe("46px"); // "abc": 3 * 10 + 16, within bounds
		} finally {
			restore();
		}
	});

	it("reposition() is a no-op after commit/destroy — does not throw or resurrect the textarea", () => {
		const { host, editor } = makeEditor();
		editor.destroy();
		expect(() => editor.reposition({ left: 1, top: 2, width: 3, height: 4 })).not.toThrow();
		expect(host.querySelector("textarea")).toBeNull();
	});

	it("destroy() removes the textarea without firing any callback", () => {
		const { host, editor, onCommit, onCancel } = makeEditor();
		editor.destroy();
		expect(host.querySelector("textarea")).toBeNull();
		expect(onCommit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});
});
