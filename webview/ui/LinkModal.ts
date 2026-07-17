import { LinkKind } from "../model/links";

export interface LinkModalResult {
	label: string;
	kind: LinkKind;
	target: string;
}

export interface LinkModalOptions {
	initialLabel: string;
	initialKind: LinkKind;
	initialTarget: string;
	hasExistingLink: boolean;
	onSave: (result: LinkModalResult) => void;
	onRemove: () => void;
	/** Fired on every close path (save, remove, or dismiss/Escape/backdrop-click) so the caller can restore focus to the mind map. */
	onClose?: () => void;
}

/**
 * Ctrl/Cmd+K (R5): add/edit/remove a link on the selected node.
 *
 * The reference (`LinkModal.ts`) extends Obsidian's `Modal`/`Setting` —
 * genuinely Obsidian-coupled UI classes with no VS Code equivalent, so per
 * the plan's port-map table this is a rewrite, not a port: a plain
 * absolutely-positioned DOM overlay (same family as `InlineEditor`/
 * `SearchPanel`) with the identical field set (display text, link type,
 * target) and identical save/remove/close semantics.
 */
export class LinkModal {
	private readonly backdrop: HTMLDivElement;
	private label: string;
	private kind: LinkKind;
	private target: string;
	private closed = false;

	constructor(host: HTMLElement, private readonly opts: LinkModalOptions) {
		this.label = opts.initialLabel;
		this.kind = opts.initialKind;
		this.target = opts.initialTarget;

		const backdrop = document.createElement("div");
		backdrop.className = "mm-link-modal-backdrop";

		const modal = document.createElement("div");
		modal.className = "mm-link-modal";
		backdrop.appendChild(modal);

		const title = document.createElement("h3");
		title.className = "mm-link-modal-title";
		title.textContent = "Edit link";
		modal.appendChild(title);

		const labelRow = LinkModal.makeRow("Display text");
		const labelInput = document.createElement("input");
		labelInput.type = "text";
		labelInput.className = "mm-link-modal-input";
		labelInput.value = this.label;
		labelInput.addEventListener("input", () => {
			this.label = labelInput.value;
		});
		labelRow.appendChild(labelInput);
		modal.appendChild(labelRow);

		const kindRow = LinkModal.makeRow("Link type");
		const kindSelect = document.createElement("select");
		kindSelect.className = "mm-link-modal-select";
		const wikiOpt = document.createElement("option");
		wikiOpt.value = "wikilink";
		wikiOpt.textContent = "Wikilink (note in this workspace)";
		const mdOpt = document.createElement("option");
		mdOpt.value = "mdlink";
		mdOpt.textContent = "URL or file path";
		kindSelect.appendChild(wikiOpt);
		kindSelect.appendChild(mdOpt);
		kindSelect.value = this.kind;
		kindSelect.addEventListener("change", () => {
			this.kind = kindSelect.value as LinkKind;
		});
		kindRow.appendChild(kindSelect);
		modal.appendChild(kindRow);

		const targetRow = LinkModal.makeRow("Target");
		const targetDesc = document.createElement("div");
		targetDesc.className = "mm-link-modal-desc";
		targetDesc.textContent = "Note title for a wikilink, or a URL/path for a URL link.";
		targetRow.appendChild(targetDesc);
		const targetInput = document.createElement("input");
		targetInput.type = "text";
		targetInput.className = "mm-link-modal-input";
		targetInput.value = this.target;
		targetInput.addEventListener("input", () => {
			this.target = targetInput.value;
		});
		targetRow.appendChild(targetInput);
		modal.appendChild(targetRow);

		const buttons = document.createElement("div");
		buttons.className = "mm-link-modal-buttons";
		if (opts.hasExistingLink) {
			const removeBtn = document.createElement("button");
			removeBtn.type = "button";
			removeBtn.className = "mm-link-modal-remove";
			removeBtn.textContent = "Remove link";
			removeBtn.addEventListener("click", () => {
				opts.onRemove();
				this.close();
			});
			buttons.appendChild(removeBtn);
		}
		const saveBtn = document.createElement("button");
		saveBtn.type = "button";
		saveBtn.className = "mm-link-modal-save";
		saveBtn.textContent = "Save";
		saveBtn.addEventListener("click", () => this.save());
		buttons.appendChild(saveBtn);
		modal.appendChild(buttons);

		// Keys inside the modal never reach the mind map canvas's own
		// keydown handler (stopPropagation, same pattern as SearchPanel) —
		// Escape dismisses, Enter in either text field saves.
		backdrop.addEventListener("keydown", (evt) => {
			evt.stopPropagation();
			if (evt.key === "Escape") {
				evt.preventDefault();
				this.close();
			} else if (evt.key === "Enter" && (evt.target === labelInput || evt.target === targetInput)) {
				evt.preventDefault();
				this.save();
			}
		});
		// A mousedown that lands on the dim backdrop itself (not the modal
		// box) dismisses, same convention as most modal dialogs.
		backdrop.addEventListener("mousedown", (evt) => {
			if (evt.target === backdrop) this.close();
		});

		host.appendChild(backdrop);
		this.backdrop = backdrop;
		targetInput.focus();
	}

	private static makeRow(labelText: string): HTMLDivElement {
		const row = document.createElement("div");
		row.className = "mm-link-modal-row";
		const label = document.createElement("label");
		label.className = "mm-link-modal-label";
		label.textContent = labelText;
		row.appendChild(label);
		return row;
	}

	private save(): void {
		if (!this.target.trim()) return;
		this.opts.onSave({ label: this.label.trim() || this.target.trim(), kind: this.kind, target: this.target.trim() });
		this.close();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.backdrop.remove();
		this.opts.onClose?.();
	}

	/** Force-dismiss without saving (e.g. the caller is tearing down for a full rebuild) — does not fire onSave/onRemove, but does fire onClose like any other close path. */
	destroy(): void {
		this.close();
	}
}
