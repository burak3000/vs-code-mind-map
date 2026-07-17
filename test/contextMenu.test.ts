// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../webview/ui/ContextMenu";

describe("ContextMenu", () => {
	it("renders each item's label, in order, with separators as their own element", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		new ContextMenu(host, {
			x: 10,
			y: 20,
			items: [
				{ label: "Edit" },
				{ label: "Delete", separatorBefore: true },
			],
			onClose: () => {},
		});

		const menu = host.querySelector<HTMLDivElement>(".mm-context-menu")!;
		expect(menu.style.left).toBe("10px");
		expect(menu.style.top).toBe("20px");
		const children = Array.from(menu.children);
		expect(children.map((c) => c.className)).toEqual(["mm-context-menu-item", "mm-context-menu-separator", "mm-context-menu-item"]);
		expect(children[0].textContent).toBe("Edit");
		expect(children[2].textContent).toBe("Delete");

		document.body.removeChild(host);
	});

	it("clicking an item calls its onClick and closes the menu", () => {
		const host = document.createElement("div");
		const onClick = vi.fn();
		const onClose = vi.fn();
		new ContextMenu(host, { x: 0, y: 0, items: [{ label: "Fold", onClick }], onClose });

		host.querySelector<HTMLDivElement>(".mm-context-menu-item")!.click();
		expect(onClick).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
		expect(host.querySelector(".mm-context-menu")).toBeNull();
	});

	it("a disabled item does not fire onClick or close the menu", () => {
		const host = document.createElement("div");
		const onClick = vi.fn();
		const onClose = vi.fn();
		new ContextMenu(host, { x: 0, y: 0, items: [{ label: "Go to section", disabled: true, onClick }], onClose });

		const item = host.querySelector<HTMLDivElement>(".mm-context-menu-item")!;
		expect(item.classList.contains("mm-context-menu-item-disabled")).toBe(true);
		item.click();
		expect(onClick).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(host.querySelector(".mm-context-menu")).not.toBeNull();
	});

	it("Escape closes the menu", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		new ContextMenu(host, { x: 0, y: 0, items: [{ label: "x" }], onClose });

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(onClose).toHaveBeenCalled();
		expect(host.querySelector(".mm-context-menu")).toBeNull();
	});

	it("a pointerdown outside the menu closes it; inside does not", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const onClose = vi.fn();
		new ContextMenu(host, { x: 0, y: 0, items: [{ label: "x" }], onClose });

		host.querySelector(".mm-context-menu-item")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(onClose).not.toHaveBeenCalled();

		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(onClose).toHaveBeenCalled();
		expect(host.querySelector(".mm-context-menu")).toBeNull();

		document.body.removeChild(host);
	});

	it("destroy() removes the menu and is idempotent", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		const menu = new ContextMenu(host, { x: 0, y: 0, items: [{ label: "x" }], onClose });
		menu.destroy();
		expect(host.querySelector(".mm-context-menu")).toBeNull();
		expect(onClose).toHaveBeenCalledTimes(1);
		menu.destroy();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
