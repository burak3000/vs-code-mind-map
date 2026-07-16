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
