export interface ContextMenuItem {
	label: string;
	disabled?: boolean;
	/** Draws a separator line above this item — used to group related actions, same visual grouping as the reference's Obsidian `Menu.addSeparator()`. */
	separatorBefore?: boolean;
	onClick?: () => void;
}

export interface ContextMenuOptions {
	/** Position in coordinates relative to `host` (the caller resolves screen coordinates to host-relative ones — see `MindMapApp.showNodeMenu`). */
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose: () => void;
}

/**
 * Right-click node menu (R17). The reference uses Obsidian's native `Menu`
 * class; there's no VS Code webview equivalent (a webview can't summon the
 * host's native context menu for arbitrary custom items), so this is a
 * plain absolutely-positioned DOM overlay — same family as `SearchPanel`/
 * `InlineEditor`/`LinkModal`. Closes on Escape or an outside click.
 */
export class ContextMenu {
	private readonly root: HTMLDivElement;
	private readonly onDocPointerDown = (evt: PointerEvent): void => {
		if (!this.root.contains(evt.target as Node)) this.close();
	};
	private readonly onDocKeyDown = (evt: KeyboardEvent): void => {
		if (evt.key === "Escape") {
			evt.preventDefault();
			this.close();
		}
	};
	private closed = false;

	constructor(host: HTMLElement, private readonly opts: ContextMenuOptions) {
		const root = document.createElement("div");
		root.className = "mm-context-menu";
		root.style.left = `${opts.x}px`;
		root.style.top = `${opts.y}px`;

		for (const item of opts.items) {
			if (item.separatorBefore) {
				const sep = document.createElement("div");
				sep.className = "mm-context-menu-separator";
				root.appendChild(sep);
			}
			const entry = document.createElement("div");
			entry.className = "mm-context-menu-item";
			if (item.disabled) entry.classList.add("mm-context-menu-item-disabled");
			entry.textContent = item.label;
			entry.addEventListener("click", () => {
				if (item.disabled) return;
				item.onClick?.();
				this.close();
			});
			root.appendChild(entry);
		}

		host.appendChild(root);
		this.root = root;

		// Attached on the capture phase, after this constructor runs, so the
		// pointerdown/contextmenu event pair that opened the menu doesn't
		// immediately close it again.
		document.addEventListener("pointerdown", this.onDocPointerDown, true);
		document.addEventListener("keydown", this.onDocKeyDown, true);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
		document.removeEventListener("keydown", this.onDocKeyDown, true);
		this.root.remove();
		this.opts.onClose();
	}

	destroy(): void {
		this.close();
	}
}
