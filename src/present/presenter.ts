import { ItemView, WorkspaceLeaf } from "obsidian";

export const PRESENTER_VIEW = "atlas-presenter-view";

export interface DeckSnapshot {
	deck: string;
	section: string;
	card: string;
	notes: string;
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

function clock(ms: number): string {
	const secs = Math.floor(ms / 1000);
	return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
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
		this.nextEl.setText(s.next ? `Next  ·  ${s.next}` : "Last card");
		this.countEl.setText(`${s.index} / ${s.total}`);
		this.paintTime();
	}

	private paintTime(): void {
		if (!current) return;
		this.timeEl.setText(
			`${clock(current.snapshot().elapsedMs)}   ·   ${new Date().toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})}`
		);
	}

	async onClose(): Promise<void> {
		if (this.ticker) window.clearInterval(this.ticker);
		this.ticker = 0;
		this.unsubscribeStop?.();
		this.unsubscribeDeck?.();
	}
}
