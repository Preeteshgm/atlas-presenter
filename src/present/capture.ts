import { App, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { hhmm, safeFileName } from "../format";

export interface Visit {
	nodeId: string;
	title: string;
	section: string;
	at: number;
}

export interface Capture {
	nodeId: string;
	title: string;
	text: string;
	at: number;
}

export interface MinutesOptions {
	/** Appended to each action — a tag, a person, a due date. */
	actionSuffix: string;
	/** Name the card each action came from, so it survives being moved. */
	linkBack: boolean;
}

export interface Session {
	deck: string;
	deckPath: string;
	variant: string;
	startedAt: number;
	endedAt: number;
	visits: Visit[];
	captures: Capture[];
	/** Prepared `%%notes%%`, by card. */
	prepared: Map<string, string>;
}

/**
 * A box to type into, over the deck.
 *
 * Deliberately a Modal: Obsidian gives a modal its own key scope, so typing
 * cannot leak to the deck underneath — or, worse, to the canvas behind it,
 * where the arrow keys move cards. Rolling our own overlay would put the
 * keyboard back in play.
 */
export class CaptureModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private cardTitle: string,
		/** What was already noted on this card, so it can be added to or edited. */
		private initial: string,
		private onSave: (text: string) => void,
		/** Called however the box closes — saved, or dismissed. */
		private onDismiss: () => void
	) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(
			this.initial
				? `Note on “${this.cardTitle}” — editing`
				: `Note on “${this.cardTitle}”`
		);
		contentEl.addClass("atl-capture");

		const box = contentEl.createEl("textarea", { cls: "atl-capture-box" });
		box.placeholder =
			"What was said, what was asked, what to do next.\nA line starting - [ ] becomes an action.";
		box.rows = 6;
		// Pre-filled with whatever is already on this card: a second press adds
		// to the note rather than starting a blank one you cannot see.
		box.value = this.initial;
		box.addEventListener("input", () => (this.value = box.value));
		box.addEventListener("keydown", (e) => {
			// Enter saves, Shift+Enter makes a new line. The event goes no further
			// than this box either way.
			e.stopPropagation();
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.save();
			}
		});

		const row = contentEl.createDiv({ cls: "atl-capture-row" });
		row.createDiv({
			cls: "atl-capture-hint",
			text: this.initial
				? "Enter saves · Shift+Enter for a new line · clear it to delete the note"
				: "Enter saves · Shift+Enter for a new line · Esc discards",
		});
		const save = row.createEl("button", { cls: "mod-cta", text: "Save" });
		save.addEventListener("click", () => this.save());

		window.setTimeout(() => {
			box.focus();
			// Land at the end, ready to add a line.
			box.setSelectionRange(box.value.length, box.value.length);
		}, 0);
	}

	private save(): void {
		const text = this.value.trim();
		this.close();
		// An emptied box on an existing note means delete it, which is why this
		// is not guarded by `if (text)` any more.
		if (text || this.initial) this.onSave(text);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss();
	}
}

interface ReviewEntry {
	nodeId: string;
	title: string;
	section: string;
	/** The `%%note%%` written into the card beforehand. Not editable here. */
	prepared: string;
	/** What was typed during the talk. */
	text: string;
}

interface ReviewOptions {
	title: string;
	subtitle: string;
	entries: ReviewEntry[];
	onEdit: (nodeId: string, text: string) => void;
	onWrite: () => void;
}

/**
 * The session, before it becomes a file.
 *
 * Writing minutes you have not read is how a meeting record ends up wrong. This
 * shows every card that carries anything, in the order it was visited, and lets
 * each one be fixed — into the same store the cards use, so pressing N on a card
 * afterwards shows the edit.
 */
export class ReviewModal extends Modal {
	private actionsEl!: HTMLElement;

	constructor(app: App, private options: ReviewOptions) {
		super(app);
	}

	private countActions(): number {
		return this.options.entries
			.flatMap((e) => e.text.split("\n"))
			.filter((l) => /^\s*-\s*\[ \]/.test(l)).length;
	}

	private paintActions(): void {
		const n = this.countActions();
		this.actionsEl.setText(
			n === 0
				? "No actions yet \u2014 a line beginning - [ ] becomes one"
				: `${n} action${n === 1 ? "" : "s"}`
		);
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("atl-review-modal");
		titleEl.setText(this.options.title);
		contentEl.addClass("atl-review");
		contentEl.createDiv({ cls: "atl-review-sub", text: this.options.subtitle });

		const list = contentEl.createDiv({ cls: "atl-review-list" });
		if (this.options.entries.length === 0) {
			list.createDiv({
				cls: "atl-review-empty",
				text: "Nothing noted yet. Press N on a card to start.",
			});
		}

		let section = "";
		for (const entry of this.options.entries) {
			if (entry.section && entry.section !== section) {
				section = entry.section;
				list.createDiv({ cls: "atl-review-section", text: section });
			}
			const block = list.createDiv({ cls: "atl-review-entry" });
			block.createDiv({ cls: "atl-review-card", text: entry.title });
			if (entry.prepared) {
				block.createDiv({ cls: "atl-review-prepared", text: entry.prepared });
			}
			const box = block.createEl("textarea", { cls: "atl-review-box" });
			box.value = entry.text;
			box.rows = Math.max(2, entry.text.split("\n").length + 1);
			box.placeholder = "Nothing typed on this card \u2014 you can add it here.";
			box.addEventListener("keydown", (e) => e.stopPropagation());
			box.addEventListener("input", () => {
				entry.text = box.value;
				this.options.onEdit(entry.nodeId, box.value.trim());
				this.paintActions();
			});
		}

		const foot = contentEl.createDiv({ cls: "atl-review-foot" });
		this.actionsEl = foot.createDiv({ cls: "atl-review-actions" });
		this.paintActions();

		const buttons = foot.createDiv({ cls: "atl-review-buttons" });
		const later = buttons.createEl("button", { text: "Keep presenting" });
		later.addEventListener("click", () => this.close());
		const write = buttons.createEl("button", { cls: "mod-cta", text: "Create the note" });
		write.addEventListener("click", () => {
			this.close();
			this.options.onWrite();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Sortable, for a filename: a folder of minutes should read in order. */
function stamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The talk, written up.
 *
 * Cards appear in the order they were actually visited — detours through the
 * map included, which is often where the interesting part happened.
 */
function minutesFor(session: Session, options: MinutesOptions): string {
	const lines: string[] = [];
	const date = new Date(session.startedAt).toLocaleDateString(undefined, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});

	lines.push(`# ${session.deck} — ${date}`, "");
	const spans = [
		`${hhmm(session.startedAt)}–${hhmm(session.endedAt)}`,
		`${session.visits.length} cards`,
	];
	if (session.variant) spans.push(session.variant);
	lines.push(spans.join(" · "), "", `Deck: [[${session.deck}]]`, "");

	const byCard = new Map<string, Capture[]>();
	for (const c of [...session.captures].sort((a, b) => a.at - b.at)) {
		const list = byCard.get(c.nodeId);
		if (list) list.push(c);
		else byCard.set(c.nodeId, [c]);
	}

	let section = "";
	let written = 0;
	for (const visit of session.visits) {
		const prepared = session.prepared.get(visit.nodeId) ?? "";
		const typed = byCard.get(visit.nodeId) ?? [];
		// A card nobody wrote anything about is noise in a set of minutes.
		if (!prepared && typed.length === 0) continue;

		if (visit.section && visit.section !== section) {
			section = visit.section;
			lines.push(`## ${section}`, "");
		}
		lines.push(`### ${visit.title}`, "");
		if (prepared) lines.push(prepared, "");
		for (const c of typed) lines.push(`> ${hhmm(c.at)} — ${c.text.replace(/\n/g, "\n> ")}`, "");
		byCard.delete(visit.nodeId);
		written++;
	}

	// Left exactly as typed apart from what is appended, so the Tasks plugin
	// parses its own due-date and priority syntax untouched.
	const actions: string[] = [];
	for (const capture of session.captures) {
		for (const line of capture.text.split("\n")) {
			if (!/^\s*-\s*\[ \]/.test(line)) continue;
			const parts = [line.trim()];
			if (options.linkBack) parts.push(`(${capture.title})`);
			if (options.actionSuffix) parts.push(options.actionSuffix);
			actions.push(parts.join(" "));
		}
	}
	if (actions.length > 0) {
		lines.push("## Actions", "", ...actions, "");
	}

	if (written === 0 && actions.length === 0) {
		lines.push("*Nothing was noted during this session.*", "");
	}
	return lines.join("\n");
}

/** Write the minutes into the vault, in their own folder, and open them. */
export async function writeMinutes(
	app: App,
	session: Session,
	folder: string,
	options: MinutesOptions
): Promise<TFile | null> {
	const dir = normalizePath(folder || "Meetings");
	try {
		if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
			await app.vault.createFolder(dir);
		}
	} catch {
		// Already there, or the name is taken by a file; the write below will say.
	}

	const safe = safeFileName(session.deck);
	let path = normalizePath(`${dir}/${safe} ${stamp(session.startedAt)}.md`);
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(`${dir}/${safe} ${stamp(session.startedAt)} (${n++}).md`);
	}

	try {
		const file = await app.vault.create(path, minutesFor(session, options));
		new Notice(`Atlas: written up to ${path}`, 8000);
		return file;
	} catch (e) {
		new Notice(`Atlas: could not write the minutes — ${String(e)}`);
		return null;
	}
}
