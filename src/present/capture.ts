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
	/**
	 * Put the cards' own `%%notes%%` into the write-up.
	 *
	 * Off by default. Those are the speaker's prompts — "they will ask about the
	 * survey" — and minutes get sent round. Including them should be a decision
	 * rather than something that happened to you.
	 */
	includePrepared: boolean;
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
 * The talk, written up as minutes.
 *
 * Ordered the way minutes are read rather than the way the talk ran: what has
 * to happen first, then what was said, under the card it was said on. Someone
 * opening this a fortnight later wants the actions, and they should not have to
 * scroll past twenty cards to find them.
 *
 * Frontmatter so a vault can count them; empty Attendees and Decisions headings
 * because a set of minutes has both and only a person can fill them in.
 */
function minutesFor(session: Session, options: MinutesOptions): string {
	const started = new Date(session.startedAt);
	const date = started.toLocaleDateString(undefined, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const mins = Math.max(1, Math.round((session.endedAt - session.startedAt) / 60000));

	// Captures in the order they were made, gathered under the card they are on.
	const byCard = new Map<string, Capture[]>();
	for (const c of [...session.captures].sort((a, b) => a.at - b.at)) {
		const list = byCard.get(c.nodeId);
		if (list) list.push(c);
		else byCard.set(c.nodeId, [c]);
	}

	// Left exactly as typed apart from what is appended, so the Tasks plugin
	// parses its own due-date and priority syntax untouched.
	const actions: string[] = [];
	for (const capture of [...session.captures].sort((a, b) => a.at - b.at)) {
		for (const line of capture.text.split("\n")) {
			if (!/^\s*-\s*\[ \]/.test(line)) continue;
			const parts = [line.trim()];
			if (options.linkBack) parts.push(`(${capture.title})`);
			if (options.actionSuffix) parts.push(options.actionSuffix);
			actions.push(parts.join(" "));
		}
	}

	const noted = new Set(session.captures.map((c) => c.nodeId)).size;
	const lines: string[] = [];

	// ------------------------------------------------------------ frontmatter
	lines.push(
		"---",
		"type: minutes",
		`deck: "${session.deck.replace(/"/g, "'")}"`,
		`date: ${stamp(session.startedAt)}`,
		`start: ${hhmm(session.startedAt)}`,
		`end: ${hhmm(session.endedAt)}`,
		`minutes: ${mins}`,
		`cards: ${session.visits.length}`,
		`actions: ${actions.length}`,
		"---",
		""
	);

	// ------------------------------------------------------------- the header
	lines.push(`# ${session.deck} \u2014 ${date}`, "");

	const talk = session.variant ? ` \u00b7 *${session.variant}*` : "";
	lines.push(
		"> [!info] At a glance",
		`> **When** ${hhmm(session.startedAt)}\u2013${hhmm(session.endedAt)} \u00b7 ${mins} min`,
		`> **Deck** [[${session.deck}]]${talk}`,
		`> **Covered** ${session.visits.length} cards \u00b7 **noted on** ${noted} \u00b7 ` +
			`**actions** ${actions.length}`,
		""
	);

	lines.push("## Attendees", "", "- ", "");
	lines.push("## Decisions", "", "- ", "");

	// ---------------------------------------------------------------- actions
	lines.push("## Actions", "");
	if (actions.length > 0) lines.push(...actions, "");
	else lines.push("*None raised.*", "");

	// ------------------------------------------------------------------ notes
	lines.push("## Notes", "");

	let section = "";
	let written = 0;
	for (const visit of session.visits) {
		const prepared = options.includePrepared ? session.prepared.get(visit.nodeId) ?? "" : "";
		const typed = byCard.get(visit.nodeId) ?? [];
		// A card nobody wrote anything about is noise in a set of minutes.
		if (!prepared && typed.length === 0) continue;

		if (visit.section && visit.section !== section) {
			section = visit.section;
			lines.push(`### ${section}`, "");
		}

		// The card's name in bold rather than as a heading: a heading per card
		// makes the outline unreadable on a deck of any size, and these are
		// items under a section, not sections of their own.
		lines.push(`**${visit.title}**`, "");
		if (prepared) lines.push(`*Prepared:* ${prepared.replace(/\n/g, " ")}`, "");
		for (const c of typed) {
			// An action is a checkbox once, under Actions. Repeating the box here
			// would have the Tasks plugin count it twice, and ticking one would
			// leave the other undone \u2014 so here it is the sentence, not the task.
			const body = c.text
				.split("\n")
				.map((line) => line.replace(/^(\s*)-\s*\[ \]\s*/, "$1\u2192 "))
				.join("\n");
			lines.push(`${hhmm(c.at)} \u2014 ${body}`, "");
		}
		byCard.delete(visit.nodeId);
		written++;
	}

	if (written === 0) lines.push("*Nothing was noted against a card.*", "");

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
