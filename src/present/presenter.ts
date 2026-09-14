import { ItemView, WorkspaceLeaf } from "obsidian";
import { hhmm, mmss } from "../format";

export const PRESENTER_VIEW = "atlas-presenter-view";

export interface DeckSnapshot {
	deck: string;
	/** Which card, so the note box knows when it is looking at a different one. */
	nodeId: string;
	section: string;
	card: string;
	notes: string;
	/** What has been written against this card already. */
	remark: string;
	next: string;
	index: number;
	total: number;
	elapsedMs: number;
}

/** What the presenter window is allowed to know and do about a running deck. */
export interface DeckHandle {
	snapshot(): DeckSnapshot;
	next(): void;
	prev(): void;
	setRemark(text: string): void;
	onChange(listener: () => void): () => void;
}

/**
 * The running deck, if there is one.
 *
 * A popout view is created by Obsidian from a view type, so it cannot be handed
 * the deck directly — it looks it up here instead.
 */
let current: DeckHandle | null = null;
const watchers = new Set<() => void>();

export function setDeck(deck: DeckHandle | null): void {
	current = deck;
	for (const w of watchers) w();
}

function watchDeck(listener: () => void): () => void {
	watchers.add(listener);
	return () => watchers.delete(listener);
}

/**
 * The second screen: what you need and the audience does not.
 *
 * Notes, the time, where you are and what is coming — while the projector shows
 * only the deck. Arrow keys here drive the deck in the main window.
 */
export class PresenterView extends ItemView {
	private unsubscribeDeck: (() => void) | null = null;
	private unsubscribeStop: (() => void) | null = null;
	private ticker = 0;

	private cardEl!: HTMLElement;
	private sectionEl!: HTMLElement;
	private notesEl!: HTMLElement;
	private remarkEl!: HTMLTextAreaElement;
	/** The card the box is showing, so typing is never wiped by a repaint. */
	private remarkFor = "";
	private nextEl!: HTMLElement;
	private timeEl!: HTMLElement;
	private countEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private bodyEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return PRESENTER_VIEW;
	}

	getDisplayText(): string {
		return "Presenter";
	}

	getIcon(): string {
		return "atlas-route";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("atl-presenter");

		this.emptyEl = root.createDiv({ cls: "atl-presenter-empty" });
		this.emptyEl.setText("No deck is running. Start one and this fills in.");

		this.bodyEl = root.createDiv({ cls: "atl-presenter-body" });

		const head = this.bodyEl.createDiv({ cls: "atl-presenter-head" });
		this.sectionEl = head.createDiv({ cls: "atl-presenter-section" });
		this.timeEl = head.createDiv({ cls: "atl-presenter-time" });

		this.cardEl = this.bodyEl.createDiv({ cls: "atl-presenter-card" });
		this.notesEl = this.bodyEl.createDiv({ cls: "atl-presenter-notes" });

		// A box that is already open, on the screen you are already looking at.
		// N opens the same note in a modal on the deck; this is for when your
		// eyes are here anyway and reaching for the deck would be the long way
		// round. One card holds one note, so the two are the same thing.
		const remark = this.bodyEl.createDiv({ cls: "atl-presenter-remark" });
		remark.createDiv({ cls: "atl-presenter-label", text: "Your remark on this card" });
		this.remarkEl = remark.createEl("textarea", {
			cls: "atl-presenter-input",
			attr: { placeholder: "Type here, or press N on the deck…", rows: "4" },
		});
		this.remarkEl.addEventListener("input", () => {
			// Written straight through rather than on blur: a talk can end with
			// the cursor still in the box, and a note lost that way is the one
			// you most wanted.
			current?.setRemark(this.remarkEl.value);
		});
		// The deck must not steal keys from a box that is being typed into.
		this.remarkEl.addEventListener("keydown", (e) => e.stopPropagation());

		const foot = this.bodyEl.createDiv({ cls: "atl-presenter-foot" });
		this.nextEl = foot.createDiv({ cls: "atl-presenter-next" });
		this.countEl = foot.createDiv({ cls: "atl-presenter-count" });

		const controls = this.bodyEl.createDiv({ cls: "atl-presenter-controls" });
		const back = controls.createEl("button", { text: "‹  Back" });
		back.addEventListener("click", (e) => {
			e.stopPropagation();
			current?.prev();
		});
		const on = controls.createEl("button", { cls: "mod-cta", text: "Next  ›" });
		on.addEventListener("click", (e) => {
			e.stopPropagation();
			current?.next();
		});

		// The presenter window has its own focus, so it needs its own keys — and
		// must stop them there. Obsidian's keymap is shared across windows, so a
		// key left to travel reaches the canvas in the main window, where the
		// arrows move whichever card is selected.
		const FORWARD = ["ArrowRight", " ", "PageDown", "ArrowDown"];
		const BACK = ["ArrowLeft", "PageUp", "ArrowUp"];
		const OWNED = [...FORWARD, ...BACK, "Home", "End", "Escape", "Backspace"];

		this.registerDomEvent(this.containerEl.ownerDocument, "keydown", (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			// Anything typed into a field in this window belongs to that field.
			if (target?.closest("input, textarea, [contenteditable='true']")) return;
			if (!OWNED.includes(e.key)) return;

			e.preventDefault();
			e.stopPropagation();
			if (FORWARD.includes(e.key)) current?.next();
			else if (BACK.includes(e.key)) current?.prev();
		});

		this.unsubscribeDeck = watchDeck(() => this.attach());
		this.attach();
		this.ticker = window.setInterval(() => this.paintTime(), 1000);
	}

	/**
	 * Put the cursor in the note box.
	 *
	 * An Obsidian modal belongs to the main window, so N pressed on a deck that
	 * has a window of its own opens a box in the window you are not looking at.
	 * The panel is already here, on the screen you are using, and already holds
	 * the same note — so N comes here instead.
	 */
	focusRemark(): void {
		this.remarkEl.focus();
		const end = this.remarkEl.value.length;
		this.remarkEl.setSelectionRange(end, end);
	}

	/** Follow whichever deck is running now, and stop following the last one. */
	private attach(): void {
		this.unsubscribeStop?.();
		this.unsubscribeStop = current ? current.onChange(() => this.paint()) : null;
		this.paint();
	}

	private paint(): void {
		const live = !!current;
		this.emptyEl.toggleClass("is-hidden", live);
		this.bodyEl.toggleClass("is-hidden", !live);
		if (!current) return;

		const s = current.snapshot();
		this.sectionEl.setText(s.section ? `${s.deck}  ›  ${s.section}` : s.deck);
		this.cardEl.setText(s.card);
		this.notesEl.setText(s.notes);
		this.notesEl.toggleClass("is-empty", !s.notes);
		if (!s.notes) this.notesEl.setText("No note on this card.");
		// Only when the card changes: replacing the value on every repaint would
		// take the cursor from under you mid-word.
		if (s.nodeId !== this.remarkFor) {
			this.remarkFor = s.nodeId;
			this.remarkEl.value = s.remark;
		}
		this.remarkEl.toggleClass("has-text", !!this.remarkEl.value.trim());

		this.nextEl.setText(s.next ? `Next  ·  ${s.next}` : "Last card");
		this.countEl.setText(`${s.index} / ${s.total}`);
		this.paintTime();
	}

	private paintTime(): void {
		if (!current) return;
		this.timeEl.setText(
			`${mmss(current.snapshot().elapsedMs)}   ·   ${hhmm()}`
		);
	}

	async onClose(): Promise<void> {
		if (this.ticker) window.clearInterval(this.ticker);
		this.ticker = 0;
		this.unsubscribeStop?.();
		this.unsubscribeDeck?.();
	}
}
