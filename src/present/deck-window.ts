import { ItemView, WorkspaceLeaf } from "obsidian";

export const DECK_VIEW = "atlas-deck-view";

/**
 * A window that exists only to hold a deck.
 *
 * The deck itself is an overlay the presentation builds and owns; this view
 * supplies the window to build it in, and tells the presentation when that
 * window is closed by hand. It draws nothing of its own — the overlay is
 * `position: fixed`, so it covers this window whole, which is what a projector
 * wants.
 *
 * Splitting it this way is what lets the canvas stay on the first screen: the
 * main Obsidian window is never touched, so the map, your notes and the minutes
 * are all still there while the talk runs on the second.
 */
export class DeckView extends ItemView {
	/** Set by the presentation, so closing the window stops the deck. */
	onWindowClose: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return DECK_VIEW;
	}

	getDisplayText(): string {
		return "Deck";
	}

	getIcon(): string {
		return "atlas-route";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("atl-deck-host");
	}

	async onClose(): Promise<void> {
		const stop = this.onWindowClose;
		this.onWindowClose = null;
		stop?.();
	}
}
