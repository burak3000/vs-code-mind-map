/** Where a plain drag-drop lands relative to its drop target: nested as its last child, or reordered as a sibling immediately before/after it (same-level reorder). */
export type DropPosition = "before" | "after" | "inside";

export interface NodeLayout {
	x: number;
	y: number;
	w: number;
	h: number;
	side: "L" | "R";
}

export interface MindNode {
	id: string;
	text: string;
	children: MindNode[];
	parent: MindNode | null;
	depth: number;
	folded: boolean;
	colorKey?: string;
	/** Sticky left/right assignment for a first-level branch (R11) — set once, never auto-reassigned; see DECISIONS.md "sticky sides". */
	branchSide?: "L" | "R";
	manualPos?: { x: number; y: number };
	/** Drag-resized wrap width override (px) — takes over from the default character-count wrap width until cleared. */
	manualWidth?: number;
	/** Descendant count, maintained incrementally on mutation — O(1) read for the fold badge (R14). */
	subtreeCount: number;
	layout?: NodeLayout;
	/**
	 * Non-heading/non-list lines (paragraphs, code fences, blank lines) that
	 * followed this node's own line in the source, preserved verbatim for
	 * round-trip fidelity (N2/N3) and re-emitted right after this node on
	 * serialize.
	 */
	attachedContent?: string[];
}

export interface MindMapModel {
	root: MindNode;
	/** O(1) node lookup by id. */
	byId: Map<string, MindNode>;
	/** Monotonic version, bumped on every mutation — used for sync reconciliation (M2). */
	version: number;
	/** YAML frontmatter block (including `---` delimiters), preserved verbatim if present. */
	frontmatterRaw: string | null;
	/** True only if the source file's very first heading was an actual `# H1` line that became the root — false when the root is a synthetic stand-in (`fallbackTitle`) because the file had no H1 (yet). Used to disable "Go to note section" for the root in that case (there's no real heading line to jump to). */
	hasExplicitRootHeading: boolean;
}
