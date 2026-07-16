import { SearchOutcome } from "../model/search";

export interface SearchPanelOptions {
	onQuery: (query: string) => SearchOutcome;
	onSelect: (nodeId: string) => void;
	onClose: () => void;
}

/**
 * Lightweight overlay panel (same positioning approach as `InlineEditor`):
 * a plain `<input>` + a results list, absolutely positioned inside `host`.
 * Owns only DOM/keyboard-navigation state; the actual search and the
 * reveal/select/focus behavior on click live in `MindMapView` and
 * `Controller`/`SvgRenderer` respectively — this is just the list UI.
 */
export class SearchPanel {
	private readonly root: HTMLDivElement;
	private readonly input: HTMLInputElement;
	private readonly countEl: HTMLDivElement;
	private readonly resultsEl: HTMLDivElement;
	private currentResults: SearchOutcome["results"] = [];
	private highlightedIndex = -1;

	constructor(host: HTMLElement, private readonly opts: SearchPanelOptions) {
		const root = document.createElement("div");
		root.className = "mm-search-panel";

		const input = document.createElement("input");
		input.type = "text";
		input.className = "mm-search-input";
		input.placeholder = "Search nodes…";
		root.appendChild(input);

		const countEl = document.createElement("div");
		countEl.className = "mm-search-count";
		root.appendChild(countEl);

		const resultsEl = document.createElement("div");
		resultsEl.className = "mm-search-results";
		root.appendChild(resultsEl);

		host.appendChild(root);

		this.root = root;
		this.input = input;
		this.countEl = countEl;
		this.resultsEl = resultsEl;

		input.addEventListener("keydown", (evt) => this.onKeyDown(evt));
		input.addEventListener("input", () => this.runQuery());
		resultsEl.addEventListener("click", (evt) => this.onResultClick(evt));

		input.focus();
	}

	/** Re-focuses the query input without rebuilding the panel — used when the toggle shortcut/action fires while the panel is already open. */
	focus(): void {
		this.input.focus();
		this.input.select();
	}

	destroy(): void {
		this.root.remove();
	}

	private onKeyDown(evt: KeyboardEvent): void {
		evt.stopPropagation(); // keep global node-navigation shortcuts from firing while typing
		if (evt.key === "Escape") {
			evt.preventDefault();
			this.opts.onClose();
		} else if (evt.key === "ArrowDown") {
			evt.preventDefault();
			this.move(1);
		} else if (evt.key === "ArrowUp") {
			evt.preventDefault();
			this.move(-1);
		} else if (evt.key === "Enter") {
			evt.preventDefault();
			const target = this.currentResults[this.highlightedIndex >= 0 ? this.highlightedIndex : 0];
			if (target) this.opts.onSelect(target.id);
		}
	}

	private move(delta: number): void {
		if (this.currentResults.length === 0) return;
		this.highlightedIndex = (this.highlightedIndex + delta + this.currentResults.length) % this.currentResults.length;
		this.renderHighlight();
	}

	private onResultClick(evt: MouseEvent): void {
		const item = (evt.target as Element).closest(".mm-search-result") as HTMLElement | null;
		const id = item?.dataset.nodeId;
		if (id) this.opts.onSelect(id);
	}

	private runQuery(): void {
		const { results, totalMatches } = this.opts.onQuery(this.input.value);
		this.currentResults = results;
		this.highlightedIndex = results.length > 0 ? 0 : -1;
		this.renderResults();
		this.renderCount(totalMatches);
	}

	private renderResults(): void {
		while (this.resultsEl.firstChild) this.resultsEl.removeChild(this.resultsEl.firstChild);
		for (const result of this.currentResults) {
			const item = document.createElement("div");
			item.className = "mm-search-result";
			item.dataset.nodeId = result.id;
			item.textContent = result.text.length > 0 ? result.text : "(empty)";
			this.resultsEl.appendChild(item);
		}
		this.renderHighlight();
	}

	private renderHighlight(): void {
		const items = this.resultsEl.querySelectorAll(".mm-search-result");
		items.forEach((item, i) => {
			const active = i === this.highlightedIndex;
			item.classList.toggle("mm-search-result-active", active);
			// Guarded: jsdom (tests) doesn't implement scrollIntoView.
			if (active && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
		});
	}

	private renderCount(totalMatches: number): void {
		if (this.input.value.trim().length === 0) {
			this.countEl.textContent = "";
		} else if (totalMatches === 0) {
			this.countEl.textContent = "No matches";
		} else if (totalMatches > this.currentResults.length) {
			this.countEl.textContent = `${totalMatches} matches (showing first ${this.currentResults.length})`;
		} else {
			this.countEl.textContent = `${totalMatches} match${totalMatches === 1 ? "" : "es"}`;
		}
	}
}
