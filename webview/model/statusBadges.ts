/** The 6 canonical node-status badges (Tool notes.md backlog item, plans/09). Single source of truth for the mutation layer, the renderer's glyph/CSS-class lookup, and the context menu / quick-pick menu item list. */
export type BadgeKey = "done" | "started" | "blocked" | "red-flag" | "green-flag" | "ready";

export interface BadgeDef {
	key: BadgeKey;
	label: string;
	/** Rendered as SVG <text> content — not an emoji/image, so no licensing concern and no decode cost (see plans/09-feature-status-badges.md). */
	glyph: string;
	/** Direct toggle shortcut, if this badge has one (only "done" does, Cmd+Shift+D) — shown as a hint on its context/quick-pick menu item (MindMapView.ts's menuItemTitle) and wired in `onKeyDown`. */
	hotkey?: { mac: string; other: string };
}

export const BADGE_DEFS: BadgeDef[] = [
	{ key: "done", label: "Done", glyph: "✓", hotkey: { mac: "⌘⇧D", other: "Ctrl+Shift+D" } },
	{ key: "started", label: "Started", glyph: "◐" },
	{ key: "blocked", label: "Blocked", glyph: "⛔" },
	{ key: "red-flag", label: "Red Flag", glyph: "⚑" },
	{ key: "green-flag", label: "Green Flag", glyph: "⚑" },
	{ key: "ready", label: "Ready to work on", glyph: "▷" },
];

const BADGE_DEFS_BY_KEY = new Map(BADGE_DEFS.map((d) => [d.key, d]));

/** Looks up a badge def by key, tolerating an unrecognized/stale value (e.g. from a newer plugin version's frontmatter) by returning undefined rather than throwing — see `nodeHasPersistableMeta`/`extractMindmapData`'s round-trip-without-validation note. */
export function getBadgeDef(key: string | undefined): BadgeDef | undefined {
	return key === undefined ? undefined : BADGE_DEFS_BY_KEY.get(key as BadgeKey);
}
