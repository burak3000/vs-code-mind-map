import { LinkKind } from "../model/links";
import { LinkItem, LinkItemBadge } from "../model/relations";

const BADGE_LABEL: Record<LinkItemBadge, string> = {
	"same-doc": "Relation",
	"cross-doc": "Cross-doc",
	external: "External link",
	unresolved: "Unresolved link",
};

export interface LinkModalOptions {
	/** Every relation/link already on the node (R3), document/text order. Passed fresh at open time; refreshed thereafter by this modal itself using each on* callback's return value. */
	items: LinkItem[];
	/**
	 * Runs the full document+node relation-target picker (host-native
	 * `vscode.window.showQuickPick`, driven end-to-end by the caller — see
	 * `webview/main.ts`'s `pickAndAddRelation`) and, on a successful pick,
	 * commits the new relation immediately and returns the node's refreshed
	 * item list. Resolves to `null` if the user dismissed either QuickPick
	 * step (Escape/click-away) — a cancelled pick commits nothing, so this
	 * modal must treat `null` as a pure no-op (re-enable the button, leave
	 * the item list untouched), not an error.
	 */
	onPickAndAddRelation: (label: string) => Promise<LinkItem[] | null>;
	/** Commits an added free-text link (the "Link" radio path — free-text wikilink/URL/path, unchanged fields from the pre-Phase-C single-edit modal) immediately and returns the refreshed item list. */
	onAddLink: (kind: LinkKind, target: string, label: string) => LinkItem[];
	/** Removes exactly one item, identified by its `occurrenceIndex`, immediately and returns the refreshed item list. */
	onRemoveItem: (occurrenceIndex: number) => LinkItem[];
	/** Fired on every close path (dismiss/Escape/backdrop-click/Close button) so the caller can restore focus to the mind map. */
	onClose?: () => void;
}

type AddMode = "relation" | "link";

/**
 * Ctrl/Cmd+K (R3/R5, redesigned per reference `7578f31` from the earlier
 * single-edit "Edit link" modal): lists every relation/link already on the
 * node — each individually removable — plus a radio-gated add flow:
 * *Document relation* (default, a same- or cross-document relation to
 * another node, authored via a host-native QuickPick picker — see below)
 * or *Link* (the original free-text wikilink/URL/path editor, unchanged).
 * Adding appends to the node's text rather than replacing it (D7: visible
 * append, `"existing → target label"`, via `appendLinkText`), which is
 * what lets one node carry multiple relations (R5) — every add/remove
 * commits immediately, so there's no "Save" step; a single "Close" button
 * replaces it.
 *
 * **Platform-fit fork from the reference (user-decided, see
 * DECISIONS.md):** the reference's redesign paired this modal with a
 * hand-rolled searchable plain-DOM combobox (`f58b3c1`) for picking a
 * document and then a node in it. This modal does not reimplement that
 * combobox at all — picking a relation target is delegated wholesale to
 * `opts.onPickAndAddRelation`, which drives VS Code's native
 * `showQuickPick` (host-side, outside this modal's own DOM) for both
 * steps. This modal's own job is only: show the current item list, offer
 * a "Choose document & node…" button that kicks that off, and re-render
 * once it resolves (or do nothing if the user cancelled).
 *
 * Still a plain absolutely-positioned DOM overlay (same family as
 * `InlineEditor`/`SearchPanel`/`ContextMenu` — no VS Code webview
 * equivalent of Obsidian's `Modal`/`Setting`).
 */
export class LinkModal {
	private readonly backdrop: HTMLDivElement;
	private items: LinkItem[];
	private mode: AddMode = "relation";
	private closed = false;

	// "Document relation" sub-form state.
	private relationLabel = "";

	// "Link" sub-form state. Defaults to "URL or file path" (not
	// "Wikilink") since the "Link" radio is specifically for external
	// resources — a wikilink to a workspace note is better served by
	// "Document relation" (matches reference `7578f31`'s default flip).
	private linkLabel = "";
	private linkKind: LinkKind = "mdlink";
	private linkTarget = "";

	private itemsContainer!: HTMLDivElement;
	private relationForm!: HTMLDivElement;
	private linkForm!: HTMLDivElement;

	constructor(host: HTMLElement, private readonly opts: LinkModalOptions) {
		this.items = opts.items;

		const backdrop = document.createElement("div");
		backdrop.className = "mm-link-modal-backdrop";

		const modal = document.createElement("div");
		modal.className = "mm-link-modal";
		backdrop.appendChild(modal);

		const title = document.createElement("h3");
		title.className = "mm-link-modal-title";
		title.textContent = "Links & relations";
		modal.appendChild(title);

		this.itemsContainer = document.createElement("div");
		this.itemsContainer.className = "mm-link-items";
		modal.appendChild(this.itemsContainer);
		this.renderItems();

		const addHeading = document.createElement("h4");
		addHeading.className = "mm-link-modal-subtitle";
		addHeading.textContent = "Add";
		modal.appendChild(addHeading);

		this.renderModeRadio(modal);

		this.relationForm = document.createElement("div");
		this.relationForm.className = "mm-link-add-form";
		modal.appendChild(this.relationForm);
		this.renderRelationForm(this.relationForm);

		this.linkForm = document.createElement("div");
		this.linkForm.className = "mm-link-add-form";
		modal.appendChild(this.linkForm);
		this.renderLinkForm(this.linkForm);

		this.updateFormVisibility();

		const buttons = document.createElement("div");
		buttons.className = "mm-link-modal-buttons";
		const closeBtn = document.createElement("button");
		closeBtn.type = "button";
		closeBtn.className = "mm-link-modal-save";
		closeBtn.textContent = "Close";
		closeBtn.addEventListener("click", () => this.close());
		buttons.appendChild(closeBtn);
		modal.appendChild(buttons);

		// Keys inside the modal never reach the mind map canvas's own
		// keydown handler (stopPropagation, same pattern as SearchPanel) —
		// Escape dismisses. There is no single "Enter commits" field anymore
		// (unlike the pre-redesign single-edit form): each sub-form's own
		// "Add…" button is the explicit commit action, since a QuickPick
		// (relation form) and free-text fields (link form) don't share one
		// natural Enter target.
		backdrop.addEventListener("keydown", (evt) => {
			evt.stopPropagation();
			if (evt.key === "Escape") {
				evt.preventDefault();
				this.close();
			}
		});
		// A mousedown that lands on the dim backdrop itself (not the modal
		// box) dismisses, same convention as most modal dialogs.
		backdrop.addEventListener("mousedown", (evt) => {
			if (evt.target === backdrop) this.close();
		});

		host.appendChild(backdrop);
		this.backdrop = backdrop;
	}

	// --- Item list ---

	private renderItems(): void {
		this.itemsContainer.innerHTML = "";
		if (this.items.length === 0) {
			const empty = document.createElement("div");
			empty.className = "mm-link-items-empty";
			empty.textContent = "No links yet.";
			this.itemsContainer.appendChild(empty);
			return;
		}
		for (const item of this.items) {
			const row = document.createElement("div");
			row.className = "mm-link-item";

			const label = document.createElement("span");
			label.className = "mm-link-item-label";
			label.textContent = item.label || item.rawTarget;
			row.appendChild(label);

			const badge = document.createElement("span");
			badge.className = `mm-link-item-badge mm-link-item-badge-${item.badge}`;
			badge.textContent = BADGE_LABEL[item.badge];
			row.appendChild(badge);

			const removeBtn = document.createElement("button");
			removeBtn.type = "button";
			removeBtn.className = "mm-link-item-remove";
			removeBtn.textContent = "Remove";
			removeBtn.addEventListener("click", () => {
				this.items = this.opts.onRemoveItem(item.occurrenceIndex);
				this.renderItems();
			});
			row.appendChild(removeBtn);

			this.itemsContainer.appendChild(row);
		}
	}

	// --- Add: mode radio ---

	private renderModeRadio(container: HTMLElement): void {
		const wrapper = document.createElement("div");
		wrapper.className = "mm-link-mode-radio";
		const groupName = "mm-link-add-mode";

		const makeOption = (value: AddMode, text: string) => {
			const label = document.createElement("label");
			label.className = "mm-link-mode-option";
			const input = document.createElement("input");
			input.type = "radio";
			input.name = groupName;
			input.value = value;
			input.checked = value === this.mode;
			input.addEventListener("change", () => {
				if (!input.checked) return;
				this.mode = value;
				this.updateFormVisibility();
			});
			label.appendChild(input);
			const span = document.createElement("span");
			span.textContent = text;
			label.appendChild(span);
			wrapper.appendChild(label);
		};

		makeOption("relation", "Document relation");
		makeOption("link", "Link");
		container.appendChild(wrapper);
	}

	private updateFormVisibility(): void {
		this.relationForm.style.display = this.mode === "relation" ? "" : "none";
		this.linkForm.style.display = this.mode === "link" ? "" : "none";
	}

	// --- Add: "Document relation" sub-form ---

	private renderRelationForm(container: HTMLElement): void {
		container.innerHTML = "";

		const labelRow = LinkModal.makeRow("Display text (optional — defaults to the picked node's own text)");
		const labelInput = document.createElement("input");
		labelInput.type = "text";
		labelInput.className = "mm-link-modal-input";
		labelInput.value = this.relationLabel;
		labelInput.addEventListener("input", () => {
			this.relationLabel = labelInput.value;
		});
		labelRow.appendChild(labelInput);
		container.appendChild(labelRow);

		const desc = document.createElement("div");
		desc.className = "mm-link-modal-desc";
		desc.textContent = "Opens a searchable picker: first the document the target node lives in (this document is listed first), then a node inside it.";
		container.appendChild(desc);

		const pickRow = document.createElement("div");
		pickRow.className = "mm-link-modal-row";
		const pickBtn = document.createElement("button");
		pickBtn.type = "button";
		pickBtn.className = "mm-link-modal-save mm-link-pick-relation";
		pickBtn.textContent = "Choose document & node…";
		pickBtn.addEventListener("click", () => {
			pickBtn.disabled = true;
			const label = this.relationLabel.trim();
			this.opts
				.onPickAndAddRelation(label)
				.then((result) => {
					// null = the user dismissed one of the two QuickPick steps —
					// a pure no-op per the cancel-safety contract (nothing was
					// committed, so there's nothing to re-render or reset here
					// beyond re-enabling the button, done in .finally below).
					if (result) {
						this.items = result;
						this.renderItems();
						this.relationLabel = "";
						this.renderRelationForm(this.relationForm);
					}
				})
				.finally(() => {
					pickBtn.disabled = false;
				});
		});
		pickRow.appendChild(pickBtn);
		container.appendChild(pickRow);
	}

	// --- Add: "Link" sub-form (unchanged fields from the pre-redesign modal) ---

	private renderLinkForm(container: HTMLElement): void {
		container.innerHTML = "";

		const labelRow = LinkModal.makeRow("Display text");
		const labelInput = document.createElement("input");
		labelInput.type = "text";
		labelInput.className = "mm-link-modal-input";
		labelInput.value = this.linkLabel;
		labelInput.addEventListener("input", () => {
			this.linkLabel = labelInput.value;
		});
		labelRow.appendChild(labelInput);
		container.appendChild(labelRow);

		const kindRow = LinkModal.makeRow("Link type");
		const kindSelect = document.createElement("select");
		kindSelect.className = "mm-link-modal-select";
		const mdOpt = document.createElement("option");
		mdOpt.value = "mdlink";
		mdOpt.textContent = "URL or file path";
		const wikiOpt = document.createElement("option");
		wikiOpt.value = "wikilink";
		wikiOpt.textContent = "Wikilink (note in this workspace)";
		kindSelect.appendChild(mdOpt);
		kindSelect.appendChild(wikiOpt);
		kindSelect.value = this.linkKind;
		kindSelect.addEventListener("change", () => {
			this.linkKind = kindSelect.value as LinkKind;
		});
		kindRow.appendChild(kindSelect);
		container.appendChild(kindRow);

		const targetRow = LinkModal.makeRow("Target");
		const targetDesc = document.createElement("div");
		targetDesc.className = "mm-link-modal-desc";
		targetDesc.textContent =
			"A note title for a wikilink; a URL (with or without https://), an absolute file path, or a folder path for a URL/file-path link — opens in the browser, default app, or file browser respectively.";
		targetRow.appendChild(targetDesc);
		const targetInput = document.createElement("input");
		targetInput.type = "text";
		targetInput.className = "mm-link-modal-input";
		targetInput.value = this.linkTarget;
		targetInput.addEventListener("input", () => {
			this.linkTarget = targetInput.value;
		});
		targetRow.appendChild(targetInput);
		container.appendChild(targetRow);

		const addRow = document.createElement("div");
		addRow.className = "mm-link-modal-row";
		const addBtn = document.createElement("button");
		addBtn.type = "button";
		addBtn.className = "mm-link-modal-save mm-link-add-link";
		addBtn.textContent = "Add link";
		addBtn.addEventListener("click", () => {
			if (!this.linkTarget.trim()) return;
			this.items = this.opts.onAddLink(this.linkKind, this.linkTarget.trim(), this.linkLabel.trim() || this.linkTarget.trim());
			this.renderItems();
			this.linkLabel = "";
			this.linkTarget = "";
			this.renderLinkForm(this.linkForm);
		});
		addRow.appendChild(addBtn);
		container.appendChild(addRow);
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

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.backdrop.remove();
		this.opts.onClose?.();
	}

	/** Force-dismiss without saving (e.g. the caller is tearing down for a full rebuild) — fires onClose like any other close path. */
	destroy(): void {
		this.close();
	}
}
