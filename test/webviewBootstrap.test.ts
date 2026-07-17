// @vitest-environment jsdom
//
// M1 webview bootstrap / host-message protocol tests (plan §10: "new unit
// tests for: host<->webview message protocol"). Exercises webview/main.ts
// as a real module against a faked acquireVsCodeApi: ready-handshake,
// setDocument -> parse/layout/mount, the version gate, and the
// external-edit rebuild path (selection carry-over). jsdom doesn't paint —
// these assert DOM structure and wiring, not visuals (see CLAUDE.md).
import { beforeAll, describe, expect, it, vi } from "vitest";

const postMessage = vi.fn();

function sendFromHost(data: unknown): void {
	window.dispatchEvent(new MessageEvent("message", { data }));
}

function nodeTexts(): string[] {
	return Array.from(document.querySelectorAll(".mm-node-text")).map((el) => el.textContent ?? "");
}

beforeAll(async () => {
	(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage,
		getState: () => undefined,
		setState: () => {},
	});
	document.body.innerHTML = '<div class="mindmap-view-container"><div class="mindmap-placeholder">Loading…</div></div>';
	await import("../webview/main");
});

describe("webview bootstrap (main.ts)", () => {
	it("posts the ready handshake once its message listener is registered", () => {
		expect(postMessage).toHaveBeenCalledWith({ type: "ready" });
	});

	it("mounts the map (and clears the placeholder) on the first setDocument", () => {
		sendFromHost({ type: "setDocument", text: "# Root\n## Branch A\n- child one\n", version: 3, title: "fallback" });
		expect(document.querySelector(".mindmap-placeholder")).toBeNull(); // renderer owns the container now
		expect(document.querySelector(".mm-svg")).not.toBeNull();
		expect(nodeTexts()).toEqual(expect.arrayContaining(["Root", "Branch A", "child one"]));
	});

	it("drops a stale message (version <= last rendered)", () => {
		sendFromHost({ type: "setDocument", text: "# Should Not Render\n", version: 2, title: "fallback" });
		expect(nodeTexts()).toEqual(expect.arrayContaining(["Root", "Branch A", "child one"]));
		expect(nodeTexts()).not.toEqual(expect.arrayContaining(["Should Not Render"]));
	});

	it("selects a node on click and clears the selection on background click", () => {
		const nodeEl = Array.from(document.querySelectorAll<SVGGElement>(".mm-node")).find((el) =>
			el.textContent?.includes("child one")
		);
		expect(nodeEl).toBeTruthy();
		nodeEl!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(document.querySelectorAll(".mm-selected").length).toBe(1);

		const svg = document.querySelector(".mm-svg")!;
		svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(document.querySelectorAll(".mm-selected").length).toBe(0);
	});

	it("rebuilds from an external edit (newer version) and preserves the selection structurally", () => {
		// Select "child one" (structural position: root -> child 0 -> child 0).
		const nodeEl = Array.from(document.querySelectorAll<SVGGElement>(".mm-node")).find((el) =>
			el.textContent?.includes("child one")
		);
		nodeEl!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(document.querySelectorAll(".mm-selected").length).toBe(1);

		// External edit: same structure plus one appended node.
		sendFromHost({
			type: "setDocument",
			text: "# Root\n## Branch A\n- child one\n- child two\n",
			version: 4,
			title: "fallback",
		});
		expect(nodeTexts()).toEqual(expect.arrayContaining(["Root", "Branch A", "child one", "child two"]));
		// findEquivalentNode matches "child one" by structural position+text, so it stays selected across the rebuild.
		const selected = document.querySelectorAll(".mm-selected");
		expect(selected.length).toBe(1);
		expect(selected[0].textContent).toContain("child one");
	});

	it("ignores unknown message types without touching the map", () => {
		sendFromHost({ type: "somethingElse", text: "# Nope\n", version: 99, title: "x" });
		expect(nodeTexts()).toEqual(expect.arrayContaining(["Root", "child two"]));
		expect(nodeTexts()).not.toEqual(expect.arrayContaining(["Nope"]));
	});
});

// M2: editing, keyboard shortcuts, undo/redo command routing, debounced
// write-back. Continues from the M1 tests' state above (same singleton
// MindMapApp instance/module — jsdom, no real pixels, see file header).
describe("webview bootstrap (main.ts) — M2 editing + sync", () => {
	function container(): HTMLElement {
		return document.querySelector<HTMLElement>(".mindmap-view-container")!;
	}

	function selectNodeByText(text: string): SVGGElement {
		// A background click first resets SvgRenderer's own same-node
		// double-click tracking (real Date.now(), not fake-timer-driven) —
		// without it, clicking the same node twice across two of these tests
		// in quick succession reads as a double-click and opens the inline
		// editor instead of just (re)selecting.
		document.querySelector(".mm-svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		const nodeEl = Array.from(document.querySelectorAll<SVGGElement>(".mm-node")).find((el) => el.textContent?.includes(text));
		expect(nodeEl).toBeTruthy();
		nodeEl!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return nodeEl!;
	}

	function keydown(key: string, opts: KeyboardEventInit = {}): void {
		container().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
	}

	it("Tab creates a child of the selected node and opens the inline editor", () => {
		selectNodeByText("child two");
		const before = nodeTexts().length;
		keydown("Tab");
		expect(nodeTexts().length).toBe(before + 1);
		const editor = document.querySelector<HTMLTextAreaElement>(".mm-inline-editor");
		expect(editor).not.toBeNull();
		expect(editor!.value).toBe("");

		// Commit via Enter — same InlineEditor wiring as the reference (Enter
		// without Shift commits and selects, it does not also create a
		// sibling; a second Enter would do that).
		editor!.value = "new child";
		editor!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(document.querySelector(".mm-inline-editor")).toBeNull();
		expect(nodeTexts()).toEqual(expect.arrayContaining(["new child"]));
	});

	it("schedules a debounced write-back after a local edit, posting the full serialized document", () => {
		vi.useFakeTimers();
		try {
			postMessage.mockClear();
			selectNodeByText("new child");
			keydown("Delete");
			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "writeDocument" }));
			vi.advanceTimersByTime(400);
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "writeDocument", text: expect.any(String) }));
			const call = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "writeDocument");
			expect((call![0] as { text: string }).text).not.toContain("new child"); // it was just deleted
		} finally {
			vi.useRealTimers();
		}
	});

	it("Delete removes the selected node", () => {
		const before = nodeTexts().length;
		selectNodeByText("child two");
		keydown("Delete");
		expect(nodeTexts().length).toBe(before - 1);
		expect(nodeTexts()).not.toEqual(expect.arrayContaining(["child two"]));
	});

	it("Arrow key navigation moves the selection to an adjacent visible node", () => {
		// Root has just one branch at this point in the tree (Branch A), so
		// which of the four directions actually lands on it depends on which
		// side of the root the layout assigned that branch to — assert that
		// *some* direction moves the selection off Root, rather than
		// hardcoding a side the layout doesn't guarantee.
		selectNodeByText("Root");
		const moved = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].some((dir) => {
			keydown(dir);
			const selected = document.querySelectorAll(".mm-selected");
			return selected.length === 1 && !selected[0].textContent?.includes("Root");
		});
		expect(moved).toBe(true);
	});

	it("routes an undo command message to the controller, reversing the last mutation", () => {
		const before = nodeTexts();
		selectNodeByText("child one");
		keydown("Tab"); // creates a new child + opens the inline editor
		document.querySelector<HTMLTextAreaElement>(".mm-inline-editor")!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
		);
		expect(nodeTexts().length).toBe(before.length + 1);

		sendFromHost({ type: "command", name: "undo" });
		expect(nodeTexts().length).toBe(before.length);

		sendFromHost({ type: "command", name: "redo" });
		expect(nodeTexts().length).toBe(before.length + 1);

		// Leave the model back where it started so later tests in this file
		// aren't affected by this test's own mutation.
		sendFromHost({ type: "command", name: "undo" });
		expect(nodeTexts().length).toBe(before.length);
	});

	it("an external setDocument arriving while a local edit is still unwritten is kept, not overwritten, and surfaces a warning to the host", () => {
		vi.useFakeTimers();
		try {
			postMessage.mockClear();
			selectNodeByText("child one");
			keydown("Tab"); // schedules a write-back, not yet fired (still inside the 400ms debounce window)
			document.querySelector<HTMLTextAreaElement>(".mm-inline-editor")!.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
			);
			const beforeExternal = nodeTexts();

			sendFromHost({ type: "setDocument", text: "# Root\n## Branch A\n- child one\n", version: 1000, title: "fallback" });
			expect(nodeTexts()).toEqual(beforeExternal); // not rebuilt — local edit kept
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "showWarning" }));

			vi.advanceTimersByTime(400); // let the pending write flush so later tests start clean
		} finally {
			vi.useRealTimers();
		}
	});
});

// M3: folding, manual positioning, drag-reorder, links, search, link editor,
// context menu ("Go to section" plumbing + flush), and clipboard. Each test
// below resets to a known tree first (via `resetTree`) rather than chaining
// off whatever state the previous test happened to leave — the M1/M2 tests
// above already accumulate enough incidental state (deleted/renamed/undone
// nodes) that depending on it here would make these tests fragile for no
// benefit. `resetTree` flushes any pending write first (via the same
// "flushWrite" command the host uses for the Ctrl/Cmd+M toggle) so a
// still-pending edit from a previous test can never make the reset's
// `setDocument` look like a conflicting external edit.
describe("webview bootstrap (main.ts) — M3 feature wiring", () => {
	let version = 10_000;

	function resetTree(text = "# Root\n## Branch A\n- child one\n- child two\n## Branch B\n- child three\n"): void {
		sendFromHost({ type: "command", name: "flushWrite" });
		version += 1;
		sendFromHost({ type: "setDocument", text, version, title: "fallback" });
	}

	function container(): HTMLElement {
		return document.querySelector<HTMLElement>(".mindmap-view-container")!;
	}

	function keydown(key: string, opts: KeyboardEventInit = {}): void {
		container().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
	}

	function nodeEls(): SVGGElement[] {
		return Array.from(document.querySelectorAll<SVGGElement>(".mm-node"));
	}

	function findNodeEl(text: string): SVGGElement {
		document.querySelector(".mm-svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); // reset double-click tracking, same reasoning as selectNodeByText above
		const el = nodeEls().find((n) => n.textContent?.includes(text));
		expect(el).toBeTruthy();
		return el!;
	}

	function selectNodeByText(text: string): SVGGElement {
		const el = findNodeEl(text);
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return el;
	}

	/** Forces the pending debounced write out immediately via the same "flushWrite" command the host uses for the Ctrl/Cmd+M toggle — synchronous, so it sidesteps the 400ms debounce timer entirely rather than racing fake vs. real timers. */
	function flushedWriteText(): string {
		postMessage.mockClear();
		sendFromHost({ type: "command", name: "flushWrite" });
		const call = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "writeDocument");
		return call ? (call[0] as { text: string }).text : "";
	}

	it("clicking a node's fold badge hides its children, and clicking again unfolds", () => {
		resetTree();
		// Re-queries the badge fresh before each click (rather than caching
		// one element reference across both clicks) — same as what a real
		// mouse click always does (hit-test whatever is currently on screen).
		// This matters here specifically: a node's *first* fold mints it a
		// fresh persistent id (see `reconcilePersistentIds` in webview/main.ts
		// and its DECISIONS.md entry), which can mean a brand-new DOM element
		// for that node from this point on — a cached reference to the old
		// one would stop bubbling clicks at all, which isn't the thing this
		// test is trying to verify.
		const findBadge = () => findNodeEl("Branch A").querySelector(".mm-fold-badge")!;

		findBadge().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(nodeTexts()).not.toEqual(expect.arrayContaining(["child one"]));
		expect(nodeTexts()).toEqual(expect.arrayContaining(["Root", "Branch A", "Branch B", "child three"]));

		findBadge().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(nodeTexts()).toEqual(expect.arrayContaining(["child one", "child two"]));
	});

	it("Ctrl/Cmd+/ (routed as a 'toggleFold' command, since VS Code intercepts the chord) folds/unfolds the selected node", () => {
		resetTree();
		selectNodeByText("Branch B");

		sendFromHost({ type: "command", name: "toggleFold" });
		expect(nodeTexts()).not.toEqual(expect.arrayContaining(["child three"]));

		sendFromHost({ type: "command", name: "toggleFold" });
		expect(nodeTexts()).toEqual(expect.arrayContaining(["child three"]));
	});

	it("Alt+drag on a node pins it to a manual position, persisted as frontmatter 'pos:' metadata on write-back", () => {
		resetTree();
		const nodeG = findNodeEl("child one");

		nodeG.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, altKey: true, clientX: 100, clientY: 100, pointerId: 1 }));
		const svg = document.querySelector(".mm-svg")!;
		svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, altKey: true, clientX: 160, clientY: 140, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, altKey: true, clientX: 160, clientY: 140, pointerId: 1 }));

		expect(flushedWriteText()).toContain("pos: [");
	});

	it("dragging a node's resize handle sets a manual wrap width, persisted as frontmatter 'width:' metadata on write-back", () => {
		resetTree();
		const nodeG = findNodeEl("child one");
		const handle = nodeG.querySelector(".mm-resize-handle")!;

		handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 1 }));
		const svg = document.querySelector(".mm-svg")!;
		svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 160, clientY: 100, pointerId: 1 }));
		svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 160, clientY: 100, pointerId: 1 }));

		expect(flushedWriteText()).toContain("width:");
	});

	it("plain drag-drop onto another node reparents it as that node's last child (drag-reorder)", () => {
		resetTree();
		const dragged = findNodeEl("child one");
		const target = findNodeEl("Branch B");

		// jsdom has no real layout, so drop-target hit-testing (elementsFromPoint)
		// and drop-position banding (getBoundingClientRect) can't resolve for
		// real — stub the former (same technique renderer.smoke.test.ts uses)
		// so the drop resolves onto `target`; the latter's zero-height rect
		// makes computeDropPosition fall back to "inside" regardless, which is
		// exactly the case under test (reparent, not same-level reorder).
		(document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = () => [target];
		try {
			dragged.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 }));
			const svg = document.querySelector(".mm-svg")!;
			svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: 200, pointerId: 1 }));
			svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 200, clientY: 200, pointerId: 1 }));
		} finally {
			delete (document as Partial<Document>).elementsFromPoint;
		}

		const text = flushedWriteText();
		// Reparented under Branch B, after its existing child (child three) —
		// a plain "still somewhere in the document" check would pass even if
		// the drop silently no-op'd, so assert the actual new relative order.
		expect(text.indexOf("child three")).toBeLessThan(text.indexOf("child one"));
	});

	it("Alt+ArrowUp/Down reorders the selected node among its own siblings", () => {
		resetTree();
		selectNodeByText("child one"); // Branch A's first child, before "child two"

		keydown("ArrowDown", { altKey: true });

		const text = flushedWriteText();
		expect(text.indexOf("child two")).toBeLessThan(text.indexOf("child one"));
	});

	it("clicking a wikilink in a node's text posts an 'openLink' message to the host instead of navigating in-webview", () => {
		resetTree();
		selectNodeByText("child one");
		keydown("F2");
		const editor = document.querySelector<HTMLTextAreaElement>(".mm-inline-editor")!;
		editor.value = "See [[Some Note]]";
		editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

		postMessage.mockClear();
		const link = document.querySelector<SVGElement>(".mm-node-link")!;
		expect(link.dataset.linkKind).toBe("wikilink");
		link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(postMessage).toHaveBeenCalledWith({ type: "openLink", kind: "wikilink", target: "Some Note" });
	});

	it("Ctrl/Cmd+K (routed as a 'linkEditor' command) opens the link editor for the selected node, and Save commits link syntax", () => {
		resetTree();
		selectNodeByText("child two");

		sendFromHost({ type: "command", name: "linkEditor" });
		const backdrop = document.querySelector(".mm-link-modal-backdrop");
		expect(backdrop).not.toBeNull();

		const targetInput = document.querySelectorAll<HTMLInputElement>(".mm-link-modal-input")[1];
		targetInput.value = "https://example.com";
		targetInput.dispatchEvent(new Event("input"));
		const kindSelect = document.querySelector<HTMLSelectElement>(".mm-link-modal-select")!;
		kindSelect.value = "mdlink";
		kindSelect.dispatchEvent(new Event("change"));
		document.querySelector<HTMLButtonElement>(".mm-link-modal-save")!.click();

		expect(document.querySelector(".mm-link-modal-backdrop")).toBeNull();
		// The rendered node text shows the link's *label* ("child two"), not
		// its target — the target lives on the rendered link span's dataset.
		const link = document.querySelector<SVGElement>(".mm-node-link")!;
		expect(link.dataset.linkKind).toBe("mdlink");
		expect(link.dataset.linkTarget).toBe("https://example.com");
	});

	it("Ctrl/Cmd+F (routed as a 'search' command) opens the search panel; selecting a result selects and centers that node", () => {
		resetTree();
		sendFromHost({ type: "command", name: "search" });
		expect(document.querySelector(".mm-search-panel")).not.toBeNull();

		const input = document.querySelector<HTMLInputElement>(".mm-search-input")!;
		input.value = "child three";
		input.dispatchEvent(new Event("input"));
		const result = document.querySelector<HTMLElement>(".mm-search-result")!;
		expect(result.textContent).toBe("child three");
		result.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		const selected = document.querySelectorAll(".mm-selected");
		expect(selected.length).toBe(1);
		expect(selected[0].textContent).toContain("child three");

		// A second "search" command while already open just refocuses it,
		// rather than opening a duplicate panel.
		sendFromHost({ type: "command", name: "search" });
		expect(document.querySelectorAll(".mm-search-panel").length).toBe(1);
	});

	it("right-click opens a context menu whose items operate on that node; 'Go to note section' flushes the pending write and posts 'goToSection'", () => {
		resetTree();
		const nodeG = findNodeEl("child two");
		selectNodeByText("child one"); // make an edit dirty elsewhere so the flush below is observable
		keydown("Tab");
		document.querySelector<HTMLTextAreaElement>(".mm-inline-editor")!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
		);

		nodeG.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }));
		const menu = document.querySelector(".mm-context-menu");
		expect(menu).not.toBeNull();
		// Right-clicking selects the node the menu belongs to.
		expect(document.querySelectorAll(".mm-selected").length).toBe(1);

		const items = Array.from(document.querySelectorAll(".mm-context-menu-item"));
		expect(items.map((i) => i.textContent)).toEqual(
			expect.arrayContaining(["Go to note section", "Edit", "Add child", "Add sibling", "Edit link", "Fold", "Copy", "Cut", "Paste", "Copy subtree as markdown", "Delete"])
		);

		postMessage.mockClear();
		const goTo = items.find((i) => i.textContent === "Go to note section")!;
		goTo.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		// The still-pending Tab edit from above is flushed synchronously
		// (not after the 400ms debounce) before "goToSection" is posted.
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "writeDocument" }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "goToSection", line: expect.any(Number) }));
		expect(document.querySelector(".mm-context-menu")).toBeNull(); // closed after the click
	});

	it("Escape / an outside click closes the context menu without acting", () => {
		resetTree();
		const nodeG = findNodeEl("child one");
		nodeG.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
		expect(document.querySelector(".mm-context-menu")).not.toBeNull();

		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(document.querySelector(".mm-context-menu")).toBeNull();
	});

	it("Ctrl/Cmd+C copies the selected subtree to the OS clipboard as markdown, and Ctrl/Cmd+V pastes it as a new child", () => {
		resetTree();
		const writeText = vi.fn().mockResolvedValue(undefined);
		const readText = vi.fn();
		(navigator as unknown as { clipboard: unknown }).clipboard = { writeText, readText };

		selectNodeByText("child one");
		keydown("c", { ctrlKey: true });
		expect(writeText).toHaveBeenCalledWith("- child one");

		// Ctrl/Cmd+V: the OS clipboard read resolves to exactly what we just
		// wrote ourselves, so the paste uses the *internal* clipboard
		// (pasteToSelected), not parseExternalPaste — mirrors the reference's
		// "didn't come from outside this plugin" check.
		readText.mockResolvedValue("- child one");
		selectNodeByText("Branch B");
		const before = nodeTexts().length;
		keydown("v", { ctrlKey: true });
		return Promise.resolve().then(() => {
			expect(nodeTexts().length).toBe(before + 1);
			expect(nodeTexts().filter((t) => t === "child one").length).toBe(2); // original + pasted clone
		});
	});
});
