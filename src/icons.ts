import { addIcon } from "obsidian";

/**
 * Atlas draws its own icons.
 *
 * Which Lucide icons ship with Obsidian varies by version, and a name that is
 * missing renders as nothing at all — a button that is there, does something,
 * and looks like a gap. Obsidian expects a 0 0 100 100 viewBox and takes the
 * colour from the theme.
 *
 * They live here rather than in main.ts because the views need the names too,
 * and a view importing the plugin that registers the view is a circle.
 */

/** Three stops joined by a route — the map, which is the whole idea. */
export const ICON_ID = "atlas-route";

const ROUTE = `<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
	<path d="M24 76 C 42 76 34 50 52 48 C 68 46 66 28 78 24" stroke-dasharray="3 12" />
	<circle cx="24" cy="76" r="10" fill="currentColor" stroke="none" />
	<circle cx="52" cy="48" r="8" />
	<circle cx="78" cy="24" r="10" />
</g>`;

/** A pane with an arrow leaving it: this tab, moved to a window of its own. */
export const POPOUT_ICON = "atlas-popout";

const POPOUT = `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
	<path d="M46 22 H22 A6 6 0 0 0 16 28 V72 A6 6 0 0 0 22 78 H66 A6 6 0 0 0 72 72 V50" />
	<path d="M58 16 H84 V42" />
	<path d="M84 16 L52 48" />
</g>`;

export function registerIcons(): void {
	addIcon(ICON_ID, ROUTE);
	addIcon(POPOUT_ICON, POPOUT);
}
