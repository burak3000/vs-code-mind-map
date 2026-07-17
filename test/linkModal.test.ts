// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LinkModal } from "../webview/ui/LinkModal";

describe("LinkModal", () => {
	it("pre-fills label/kind/target from the options and focuses the target input", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		new LinkModal(host, {
			initialLabel: "My Note",
			initialKind: "wikilink",
			initialTarget: "My Note",
			hasExistingLink: false,
			onSave: () => {},
			onRemove: () => {},
			onClose: () => {},
		});

		const labelInput = host.querySelector<HTMLInputElement>(".mm-link-modal-row input");
		expect(labelInput!.value).toBe("My Note");
		const select = host.querySelector<HTMLSelectElement>(".mm-link-modal-select");
		expect(select!.value).toBe("wikilink");
		const targetInput = host.querySelectorAll<HTMLInputElement>(".mm-link-modal-input")[1];
		expect(document.activeElement).toBe(targetInput);

		document.body.removeChild(host);
	});

	it("Save calls onSave with the trimmed label/kind/target and closes", () => {
		const host = document.createElement("div");
		const onSave = vi.fn();
		const onClose = vi.fn();
		new LinkModal(host, {
			initialLabel: "",
			initialKind: "wikilink",
			initialTarget: "",
			hasExistingLink: false,
			onSave,
			onRemove: () => {},
			onClose,
		});

		const targetInput = host.querySelectorAll<HTMLInputElement>(".mm-link-modal-input")[1];
		targetInput.value = "  Some Note  ";
		targetInput.dispatchEvent(new Event("input"));

		const select = host.querySelector<HTMLSelectElement>(".mm-link-modal-select")!;
		select.value = "mdlink";
		select.dispatchEvent(new Event("change"));

		host.querySelector<HTMLButtonElement>(".mm-link-modal-save")!.click();

		expect(onSave).toHaveBeenCalledWith({ label: "Some Note", kind: "mdlink", target: "Some Note" });
		expect(onClose).toHaveBeenCalled();
		expect(host.querySelector(".mm-link-modal-backdrop")).toBeNull();
	});

	it("Save is a no-op when the target is blank", () => {
		const host = document.createElement("div");
		const onSave = vi.fn();
		new LinkModal(host, {
			initialLabel: "x",
			initialKind: "wikilink",
			initialTarget: "",
			hasExistingLink: false,
			onSave,
			onRemove: () => {},
		});

		host.querySelector<HTMLButtonElement>(".mm-link-modal-save")!.click();
		expect(onSave).not.toHaveBeenCalled();
		expect(host.querySelector(".mm-link-modal-backdrop")).not.toBeNull();
	});

	it("shows a Remove link button only when hasExistingLink is true, and it calls onRemove + closes", () => {
		const host = document.createElement("div");
		const onRemove = vi.fn();
		const onClose = vi.fn();
		new LinkModal(host, {
			initialLabel: "x",
			initialKind: "wikilink",
			initialTarget: "x",
			hasExistingLink: true,
			onSave: () => {},
			onRemove,
			onClose,
		});

		const removeBtn = host.querySelector<HTMLButtonElement>(".mm-link-modal-remove");
		expect(removeBtn).not.toBeNull();
		removeBtn!.click();
		expect(onRemove).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();

		const host2 = document.createElement("div");
		new LinkModal(host2, {
			initialLabel: "x",
			initialKind: "wikilink",
			initialTarget: "x",
			hasExistingLink: false,
			onSave: () => {},
			onRemove: () => {},
		});
		expect(host2.querySelector(".mm-link-modal-remove")).toBeNull();
	});

	it("Escape closes without saving", () => {
		const host = document.createElement("div");
		const onSave = vi.fn();
		const onClose = vi.fn();
		new LinkModal(host, {
			initialLabel: "x",
			initialKind: "wikilink",
			initialTarget: "x",
			hasExistingLink: false,
			onSave,
			onRemove: () => {},
			onClose,
		});

		host.querySelector(".mm-link-modal-backdrop")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
		expect(host.querySelector(".mm-link-modal-backdrop")).toBeNull();
	});

	it("a mousedown directly on the backdrop (not the modal box) closes it", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		new LinkModal(host, {
			initialLabel: "x",
			initialKind: "wikilink",
			initialTarget: "x",
			hasExistingLink: false,
			onSave: () => {},
			onRemove: () => {},
			onClose,
		});

		const backdrop = host.querySelector(".mm-link-modal-backdrop")!;
		backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(onClose).toHaveBeenCalled();
	});

	it("a mousedown inside the modal box does not close it", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		new LinkModal(host, {
			initialLabel: "x",
			initialKind: "wikilink",
			initialTarget: "x",
			hasExistingLink: false,
			onSave: () => {},
			onRemove: () => {},
			onClose,
		});

		host.querySelector(".mm-link-modal")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(onClose).not.toHaveBeenCalled();
	});

	it("destroy() removes the modal from the DOM and fires onClose", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		const modal = new LinkModal(host, {
			initialLabel: "x",
			initialKind: "wikilink",
			initialTarget: "x",
			hasExistingLink: false,
			onSave: () => {},
			onRemove: () => {},
			onClose,
		});
		modal.destroy();
		expect(host.querySelector(".mm-link-modal-backdrop")).toBeNull();
		expect(onClose).toHaveBeenCalledTimes(1);
		modal.destroy(); // idempotent — must not fire onClose a second time
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
