import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { ICON_ID, POPOUT_ICON } from "../icons";

export const DECK_VIEW = "atlas-deck-view";

/**
 * The tab a deck is presented in.
 *
 * It was a popout window, opened for you. That put the deck somewhere Obsidian
 * itself could not follow: a modal belongs to the main window, and so does a
 * notice, and a new leaf opens in whichever window is focused — so pressing G
 * built the graph inside the deck's own window, behind a full-screen overlay,
 * where nothing could be seen of it.
 *
 * A tab is an ordinary leaf. Everything Obsidian opens lands beside it, the
 * keys and the modals are in one place, and you can drag it out to a window of
 * its own and onto whichever screen you like — which is the same thing the
 * popout gave you, chosen by you rather than for you.
 *
 * The view draws nothing itself: the deck is an overlay the presentation builds
 * inside it. This supplies the container, and says when the tab is closed.
 */
export class DeckView extends ItemView {
	/** Set by the presentation, so closing the tab stops the deck. */
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
		return ICON_ID;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("atl-deck-host");

		// A tab can already be dragged out, and Obsidian offers the same on the
		// tab's own menu. This is the one tab anybody wants it for every time,
		// so it is a click on the tab rather than two through a menu.
		this.addAction(POPOUT_ICON, "Move the deck to its own window", () => {
			try {
				const move = (
					this.app.workspace as unknown as {
						moveLeafToPopout?: (leaf: unknown) => void;
					}
				).moveLeafToPopout;
				if (typeof move === "function") move.call(this.app.workspace, this.leaf);
				else new Notice("Atlas: drag this tab out to give it a window.");
			} catch {
				new Notice("Atlas: drag this tab out to give it a window.");
			}
		});

		// Chromium prints on Ctrl+P, and a print dialog over a live talk is a
		// disaster. The deck swallows it too, but only while it is running: this
		// covers the tab itself, including a window it has been dragged into.
		this.registerDomEvent(
			this.containerEl.ownerDocument,
			"keydown",
			(e: KeyboardEvent) => {
				if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			true
		);
	}

	async onClose(): Promise<void> {
		const stop = this.onWindowClose;
		this.onWindowClose = null;
		stop?.();
	}
}
