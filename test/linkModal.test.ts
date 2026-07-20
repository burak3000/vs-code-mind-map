// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LinkModal } from "../webview/ui/LinkModal";
import { LinkItem } from "../webview/model/relations";

function item(overrides: Partial<LinkItem> = {}): LinkItem {
	return {
		occurrenceIndex: 0,
		label: "Some Note",
		linkKind: "wikilink",
		rawTarget: "Some Note",
		relation: null,
		badge: "unresolved",
		...overrides,
	};
}

describe("LinkModal (Phase C redesign)", () => {
	it("shows 'No links yet.' when there are no items, and each item's label/badge otherwise", () => {
		const host = document.createElement("div");
		new LinkModal(host, {
			items: [],
			onPickAndAddRelation: async () => null,
			onAddLink: () => [],
			onRemoveItem: () => [],
		});
		expect(host.querySelector(".mm-link-items-empty")?.textContent).toBe("No links yet.");

		const host2 = document.createElement("div");
		new LinkModal(host2, {
			items: [item({ label: "Target node", badge: "same-doc" }), item({ occurrenceIndex: 1, label: "", rawTarget: "https://example.com", badge: "external" })],
			onPickAndAddRelation: async () => null,
			onAddLink: () => [],
			onRemoveItem: () => [],
		});
		const rows = host2.querySelectorAll(".mm-link-item");
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector(".mm-link-item-label")?.textContent).toBe("Target node");
		expect(rows[0].querySelector(".mm-link-item-badge")?.textContent).toBe("Relation");
		// Second item has an empty label — falls back to its raw target.
		expect(rows[1].querySelector(".mm-link-item-label")?.textContent).toBe("https://example.com");
		expect(rows[1].querySelector(".mm-link-item-badge")?.textContent).toBe("External link");
	});

	it("Remove calls onRemoveItem with the item's occurrenceIndex and re-renders the returned list", () => {
		const host = document.createElement("div");
		const onRemoveItem = vi.fn().mockReturnValue([item({ label: "Remaining" })]);
		new LinkModal(host, {
			items: [item({ occurrenceIndex: 2, label: "Doomed" })],
			onPickAndAddRelation: async () => null,
			onAddLink: () => [],
			onRemoveItem,
		});

		host.querySelector<HTMLButtonElement>(".mm-link-item-remove")!.click();
		expect(onRemoveItem).toHaveBeenCalledWith(2);
		expect(host.querySelectorAll(".mm-link-item").length).toBe(1);
		expect(host.querySelector(".mm-link-item-label")?.textContent).toBe("Remaining");
	});

	it("defaults to 'Document relation' mode; the radio toggles which sub-form is visible", () => {
		const host = document.createElement("div");
		new LinkModal(host, {
			items: [],
			onPickAndAddRelation: async () => null,
			onAddLink: () => [],
			onRemoveItem: () => [],
		});

		const forms = host.querySelectorAll<HTMLDivElement>(".mm-link-add-form");
		const [relationForm, linkForm] = Array.from(forms);
		expect(relationForm.style.display).not.toBe("none");
		expect(linkForm.style.display).toBe("none");

		const radios = host.querySelectorAll<HTMLInputElement>(".mm-link-mode-option input");
		expect(radios[0].checked).toBe(true); // "relation"
		radios[1].checked = true;
		radios[1].dispatchEvent(new Event("change"));

		expect(relationForm.style.display).toBe("none");
		expect(linkForm.style.display).not.toBe("none");
	});

	it("'Choose document & node…' calls onPickAndAddRelation with the trimmed label, disables itself while pending, and re-renders on a successful pick", async () => {
		const host = document.createElement("div");
		let resolvePick: (result: LinkItem[] | null) => void = () => {};
		const onPickAndAddRelation = vi.fn(
			() =>
				new Promise<LinkItem[] | null>((resolve) => {
					resolvePick = resolve;
				})
		);
		new LinkModal(host, {
			items: [],
			onPickAndAddRelation,
			onAddLink: () => [],
			onRemoveItem: () => [],
		});

		const labelInput = host.querySelector<HTMLInputElement>(".mm-link-add-form input[type='text']")!;
		labelInput.value = "  My relation  ";
		labelInput.dispatchEvent(new Event("input"));

		const pickBtn = host.querySelector<HTMLButtonElement>(".mm-link-pick-relation")!;
		pickBtn.click();
		expect(onPickAndAddRelation).toHaveBeenCalledWith("My relation");
		expect(pickBtn.disabled).toBe(true);

		resolvePick([item({ label: "Newly related node", badge: "same-doc" })]);
		await Promise.resolve();
		await Promise.resolve();

		expect(host.querySelector(".mm-link-item-label")?.textContent).toBe("Newly related node");
		// Re-enabled, and the label field was cleared for the next add.
		const pickBtnAfter = host.querySelector<HTMLButtonElement>(".mm-link-pick-relation")!;
		expect(pickBtnAfter.disabled).toBe(false);
		const labelInputAfter = host.querySelector<HTMLInputElement>(".mm-link-add-form input[type='text']")!;
		expect(labelInputAfter.value).toBe("");
	});

	it("a cancelled pick (onPickAndAddRelation resolves null) is a pure no-op — item list unchanged, button re-enabled", async () => {
		const host = document.createElement("div");
		const onPickAndAddRelation = vi.fn().mockResolvedValue(null);
		new LinkModal(host, {
			items: [item({ label: "Existing" })],
			onPickAndAddRelation,
			onAddLink: () => [],
			onRemoveItem: () => [],
		});

		const pickBtn = host.querySelector<HTMLButtonElement>(".mm-link-pick-relation")!;
		pickBtn.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(host.querySelectorAll(".mm-link-item").length).toBe(1);
		expect(host.querySelector(".mm-link-item-label")?.textContent).toBe("Existing");
		expect(host.querySelector<HTMLButtonElement>(".mm-link-pick-relation")!.disabled).toBe(false);
	});

	it("'Add link' calls onAddLink with the trimmed kind/target/label (defaulting label to the target) and re-renders", () => {
		const host = document.createElement("div");
		const onAddLink = vi.fn().mockReturnValue([item({ label: "https://example.com", badge: "external" })]);
		new LinkModal(host, {
			items: [],
			onPickAndAddRelation: async () => null,
			onAddLink,
			onRemoveItem: () => [],
		});

		// Switch to "Link" mode.
		const radios = host.querySelectorAll<HTMLInputElement>(".mm-link-mode-option input");
		radios[1].checked = true;
		radios[1].dispatchEvent(new Event("change"));

		const linkForm = host.querySelectorAll<HTMLDivElement>(".mm-link-add-form")[1];
		const targetInput = linkForm.querySelectorAll<HTMLInputElement>(".mm-link-modal-input")[1];
		targetInput.value = "  https://example.com  ";
		targetInput.dispatchEvent(new Event("input"));

		const kindSelect = linkForm.querySelector<HTMLSelectElement>("select")!;
		expect(kindSelect.value).toBe("mdlink"); // defaults to URL/file path, not wikilink (reference 7578f31)

		linkForm.querySelector<HTMLButtonElement>(".mm-link-add-link")!.click();
		expect(onAddLink).toHaveBeenCalledWith("mdlink", "https://example.com", "https://example.com");
		expect(host.querySelector(".mm-link-item-label")?.textContent).toBe("https://example.com");
	});

	it("'Add link' is a no-op when the target is blank", () => {
		const host = document.createElement("div");
		const onAddLink = vi.fn();
		new LinkModal(host, {
			items: [],
			onPickAndAddRelation: async () => null,
			onAddLink,
			onRemoveItem: () => [],
		});
		const radios = host.querySelectorAll<HTMLInputElement>(".mm-link-mode-option input");
		radios[1].checked = true;
		radios[1].dispatchEvent(new Event("change"));
		host.querySelectorAll<HTMLDivElement>(".mm-link-add-form")[1].querySelector<HTMLButtonElement>(".mm-link-add-link")!.click();
		expect(onAddLink).not.toHaveBeenCalled();
	});

	it("Escape closes without side effects and fires onClose", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		new LinkModal(host, {
			items: [],
			onPickAndAddRelation: async () => null,
			onAddLink: () => [],
			onRemoveItem: () => [],
			onClose,
		});

		host.querySelector(".mm-link-modal-backdrop")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(onClose).toHaveBeenCalled();
		expect(host.querySelector(".mm-link-modal-backdrop")).toBeNull();
	});

	it("a mousedown directly on the backdrop (not the modal box) closes it; inside the modal box does not", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		new LinkModal(host, {
			items: [],
			onPickAndAddRelation: async () => null,
			onAddLink: () => [],
			onRemoveItem: () => [],
			onClose,
		});

		host.querySelector(".mm-link-modal")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(onClose).not.toHaveBeenCalled();

		host.querySelector(".mm-link-modal-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(onClose).toHaveBeenCalled();
	});

	it("destroy() removes the modal from the DOM and fires onClose exactly once, even if called twice", () => {
		const host = document.createElement("div");
		const onClose = vi.fn();
		const modal = new LinkModal(host, {
			items: [],
			onPickAndAddRelation: async () => null,
			onAddLink: () => [],
			onRemoveItem: () => [],
			onClose,
		});
		modal.destroy();
		expect(host.querySelector(".mm-link-modal-backdrop")).toBeNull();
		expect(onClose).toHaveBeenCalledTimes(1);
		modal.destroy();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
