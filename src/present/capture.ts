import { App, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";

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
		private onSave: (text: string) => void,
		/** Called however the box closes — saved, or dismissed. */
		private onDismiss: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(`Note on “${this.cardTitle}”`);
		contentEl.addClass("atl-capture");

		const box = contentEl.createEl("textarea", { cls: "atl-capture-box" });
		box.placeholder =
			"What was said, what was asked, what to do next.\nA line starting - [ ] becomes an action.";
		box.rows = 6;
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
			text: "Enter saves · Shift+Enter for a new line · Esc discards",
		});
		const save = row.createEl("button", { cls: "mod-cta", text: "Save" });
		save.addEventListener("click", () => this.save());

		window.setTimeout(() => box.focus(), 0);
	}

	private save(): void {
		const text = this.value.trim();
		this.close();
		if (text) this.onSave(text);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss();
	}
}

function hhmm(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
export function minutesFor(session: Session): string {
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
	for (const c of session.captures) {
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

	const actions = session.captures
		.flatMap((c) => c.text.split("\n"))
		.filter((l) => /^\s*-\s*\[ \]/.test(l))
		.map((l) => l.trim());
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
	folder: string
): Promise<TFile | null> {
	const dir = normalizePath(folder || "Meetings");
	try {
		if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
			await app.vault.createFolder(dir);
		}
	} catch {
		// Already there, or the name is taken by a file; the write below will say.
	}

	const safe = session.deck.replace(/[\\/:*?"<>|]/g, "-");
	let path = normalizePath(`${dir}/${safe} ${stamp(session.startedAt)}.md`);
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(`${dir}/${safe} ${stamp(session.startedAt)} (${n++}).md`);
	}

	try {
		const file = await app.vault.create(path, minutesFor(session));
		new Notice(`Atlas: written up to ${path}`);
		return file;
	} catch (e) {
		new Notice(`Atlas: could not write the minutes — ${String(e)}`);
		return null;
	}
}
