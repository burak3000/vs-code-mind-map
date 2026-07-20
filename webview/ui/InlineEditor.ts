export interface ScreenRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface InlineEditorOptions {
	initialText: string;
	rect: ScreenRect;
	/** Screen-px width floor/ceiling for the grow-with-content behavior below. Omit to keep the old fixed-`rect.width` sizing (used by tests that don't exercise this path). */
	minWidth?: number;
	maxWidth?: number;
	/** Screen-px font size (depth-scaled, at the view's current zoom) so the editor's text metrics agree with the node it's editing. Omit to keep the CSS default. */
	fontSize?: number;
	onCommit: (text: string) => void;
	onCancel: () => void;
	onCommitAndCreateChild: (text: string) => void;
}

/**
 * Lightweight overlay editor (plan §9.5, addendum §4.5): a plain positioned
 * `<textarea>`, not a round-trip through the file. Keystrokes are handled
 * entirely by the native element — the model/layout/render pipeline is
 * untouched until commit, so typing never triggers a tree mutation,
 * relayout, or re-render (addendum rule 6: no full work per keystroke).
 * A `<textarea>` (not `<input>`) so Shift+Enter can insert an actual
 * newline for long/multi-line labels — plain `<input>` has no concept of a
 * line break at all.
 *
 * Positioned `absolute` inside `host` (which must be `position: relative`
 * or similar), not `fixed` against the viewport — `fixed` silently
 * anchors to the nearest transformed ancestor instead of the viewport if
 * one exists anywhere up the tree, which Obsidian's workspace often has
 * (pane animations, mobile), landing the input in the wrong place.
 */
export class InlineEditor {
	private readonly input: HTMLTextAreaElement;
	private readonly measureEl: HTMLSpanElement;
	private readonly minWidth: number;
	private readonly maxWidth: number;
	private committed = false;

	constructor(host: HTMLElement, opts: InlineEditorOptions) {
		const input = document.createElement("textarea");
		input.className = "mm-inline-editor";
		input.value = opts.initialText;
		input.rows = 1;
		input.style.position = "absolute";
		input.style.left = `${opts.rect.left}px`;
		input.style.top = `${opts.rect.top}px`;
		input.style.height = `${opts.rect.height}px`;
		if (opts.fontSize) input.style.fontSize = `${opts.fontSize}px`;
		host.appendChild(input);
		this.input = input;

		// minWidth/maxWidth both default to rect.width when omitted, which
		// collapses resizeWidth() to the old fixed-width behavior — used by
		// tests that only exercise keyboard interactions.
		this.minWidth = opts.minWidth ?? opts.rect.width;
		this.maxWidth = opts.maxWidth ?? opts.rect.width;

		// Hidden mirror element, same font as the textarea, used only to
		// measure the longest line's rendered width so the overlay can grow
		// to fit content up to the node's own wrap ceiling — instead of
		// soft-wrapping at the box's pre-edit width (~40px/minNodeWidth for a
		// freshly created, still-empty node), which put nearly every typed
		// character on its own line.
		const measure = document.createElement("span");
		measure.style.position = "absolute";
		measure.style.visibility = "hidden";
		measure.style.whiteSpace = "pre";
		measure.style.left = "-9999px";
		measure.style.top = "0";
		measure.style.font = getComputedStyle(input).font;
		host.appendChild(measure);
		this.measureEl = measure;

		this.resizeWidth();
		input.focus();
		input.select();

		const finish = (action: () => void) => {
			if (this.committed) return;
			this.committed = true;
			action();
			input.remove();
			this.measureEl.remove();
		};

		// Grows the overlay to fit content that wraps past the node's
		// current (pre-edit) box height — a pure DOM style write on the
		// overlay element itself, not a tree mutation/relayout, so it stays
		// within the "no full work per keystroke" rule same as everything
		// else in this class.
		input.addEventListener("input", () => {
			this.resizeWidth();
			input.style.height = "auto";
			input.style.height = `${input.scrollHeight}px`;
		});

		input.addEventListener("keydown", (evt) => {
			evt.stopPropagation(); // keep global node-navigation shortcuts from firing while typing
			if (evt.key === "Enter" && !evt.shiftKey) {
				// Closes editing and leaves the node selected (same as
				// blur/onCommit) rather than immediately creating a new
				// sibling — a second Enter, now that nothing is being
				// edited, is what creates the sibling (see MindMapView's
				// keydown handler). Shift+Enter is deliberately left
				// unhandled here so the textarea's own default behavior
				// (insert a newline) applies.
				evt.preventDefault();
				finish(() => opts.onCommit(input.value));
			} else if (evt.key === "Tab") {
				evt.preventDefault();
				finish(() => opts.onCommitAndCreateChild(input.value));
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				finish(() => opts.onCancel());
			}
		});

		input.addEventListener("blur", () => finish(() => opts.onCommit(input.value)));
	}

	/** Grows the overlay's width to fit the longest line, clamped to [minWidth, maxWidth]. */
	private resizeWidth(): void {
		const lines = this.input.value.split("\n");
		let longest = "";
		for (const line of lines) if (line.length > longest.length) longest = line;
		this.measureEl.textContent = longest.length ? longest : " ";
		const contentWidth = this.measureEl.scrollWidth + 16; // padding/border/caret allowance, see CSS .mm-inline-editor
		const width = Math.min(this.maxWidth, Math.max(this.minWidth, contentWidth));
		this.input.style.width = `${width}px`;
	}

	/**
	 * F3: re-syncs the overlay's screen position (and font size, since zoom
	 * changes that too) after the canvas's pan/zoom transform changes
	 * underneath it — called from `MindMapView`'s viewport-change subscription,
	 * never on a keystroke/tree-mutation path. Left/top always follow `rect`;
	 * width is re-measured against the new font (if `fontSize` changed) so the
	 * grow-with-content behavior stays consistent with the new zoom level,
	 * without discarding a height the user already grew past the original
	 * `rect.height` by typing multiple lines.
	 */
	reposition(rect: ScreenRect, fontSize?: number): void {
		if (this.committed) return;
		this.input.style.left = `${rect.left}px`;
		this.input.style.top = `${rect.top}px`;
		if (fontSize) {
			this.input.style.fontSize = `${fontSize}px`;
			this.measureEl.style.font = getComputedStyle(this.input).font;
			this.resizeWidth();
		}
	}

	destroy(): void {
		if (this.committed) return;
		this.committed = true;
		this.input.remove();
		this.measureEl.remove();
	}
}
