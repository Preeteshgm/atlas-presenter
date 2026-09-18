import { App, TAbstractFile, TFile, normalizePath } from "obsidian";
import { Capture } from "./capture";

/**
 * One note per canvas, kept beside it, with a section per card.
 *
 * A write-up used to be a new file every time — `Deck 18 Sep.md`, then
 * `Deck 24 Sep.md` — so a remark made in September was in one file and its
 * follow-up in another, and pressing N on a card always started blank. The
 * notes were a log of sessions rather than a document about the deck.
 *
 * This is the other way round: the deck has one note, each card has a section
 * in it, and presenting the same canvas again opens the same words ready to be
 * edited. The file is the source of truth — the note box reads from it and
 * writes back to it.
 *
 * A card is identified by its canvas **node id**, never by its title:
 *
 *   ## The controls plan
 *   %%card: 3f9a21%%
 *   Lead with the programme, not the model.
 *
 * Rename the card and the notes stay, because the id did not change. Delete the
 * card and its notes are moved to the end rather than lost, so re-adding the
 * card — or undoing the deletion — puts them back. The `%%…%%` marker is
 * Obsidian's own comment syntax: invisible when the note is read, and already
 * what Atlas uses for speaker notes.
 */

/** A card's notes, as the file holds them. */
export interface CardNote {
	id: string;
	title: string;
	text: string;
}

export interface DeckNotes {
	file: TFile | null;
	/** node id -> what is written about that card */
	byCard: Map<string, CardNote>;
	/** The dates this deck has been presented, as written in the file. */
	presented: string[];
}

const MARKER = /^%%card:\s*([^%\s]+)\s*%%$/;
const GONE = "Cards no longer on the canvas";

/**
 * A file rather than a folder, asked of the object instead of its constructor.
 *
 * `x instanceof TFile` asks whether it was made by *this* copy of the class,
 * and this plugin has been caught twice by that question being answered "no"
 * across a window boundary. A file has an extension and a folder has children:
 * that holds wherever the object came from.
 */
function isFile(node: TAbstractFile | null): node is TFile {
	return !!node && "extension" in node;
}

/** Beside the canvas, with the canvas's own name. */
export function notePathFor(canvas: TFile): string {
	const dir = canvas.parent?.path ?? "";
	return normalizePath(dir ? `${dir}/${canvas.basename}.md` : `${canvas.basename}.md`);
}

/**
 * The deck's note, found by the canvas it belongs to.
 *
 * By path first, because that is where it lives; then by the `canvas:` line in
 * its frontmatter, which is what makes the notes survive the canvas being
 * renamed or moved.
 */
export async function readDeckNotes(app: App, canvas: TFile): Promise<DeckNotes> {
	const empty: DeckNotes = { file: null, byCard: new Map(), presented: [] };

	let file: TAbstractFile | null = app.vault.getAbstractFileByPath(notePathFor(canvas));
	if (!isFile(file)) {
		// Named for a canvas that has since been renamed: the frontmatter says
		// which canvas these notes belong to, and that is what makes them
		// survive a rename or a move.
		file =
			app.vault
				.getMarkdownFiles()
				.find(
					(f) =>
						app.metadataCache.getFileCache(f)?.frontmatter?.canvas === canvas.path
				) ?? null;
	}
	if (!isFile(file)) return empty;

	const text = await app.vault.cachedRead(file);
	return { file, byCard: parse(text), presented: presentedIn(text) };
}

function presentedIn(text: string): string[] {
	const m = text.match(/^Presented:\s*(.+)$/m);
	return m
		? m[1]
				.split("·")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
}

/**
 * Sections out of the file.
 *
 * A section is a heading, a card marker, and everything up to the next heading.
 * Anything without a marker is somebody's own writing and is left alone — it is
 * kept verbatim and put back where it was.
 */
function parse(text: string): Map<string, CardNote> {
	const out = new Map<string, CardNote>();
	// The footer belongs to the file, not to the last card. Left in, it was read
	// back as part of that card's notes and written out again inside them.
	const lines = text.replace(/\n-{3,}[ \t]*\nPresented:[^\n]*\n?/, "\n").split("\n");
	let title = "";
	let id = "";
	let body: string[] = [];

	const flush = () => {
		if (id) out.set(id, { id, title, text: body.join("\n").trim() });
		id = "";
		body = [];
	};

	for (const line of lines) {
		// ## for a card, ### for one that has left the canvas.
		const heading = line.match(/^#{2,3}[ \t]+(.*\S)[ \t]*$/);
		if (heading) {
			flush();
			title = heading[1];
			continue;
		}
		const marker = line.trim().match(MARKER);
		if (marker) {
			id = marker[1];
			continue;
		}
		if (id) body.push(line);
	}
	flush();
	return out;
}

/** What the note box shows for each card, as captures the deck already speaks. */
export function capturesFrom(notes: DeckNotes, at: number): Capture[] {
	return [...notes.byCard.values()]
		.filter((c) => c.text.trim())
		.map((c) => ({ nodeId: c.id, title: c.title, text: c.text, at }));
}

function frontmatter(canvas: TFile): string {
	return ["---", "type: deck-notes", `canvas: ${canvas.path}`, "---", ""].join("\n");
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/**
 * One shape of date, written the same way every time.
 *
 * toLocaleDateString gives "Sep 18, 2026" on one machine and "18 Sep 2026" on
 * another, so the list of dates in the file came out in two formats and the
 * check for "already written today" never matched.
 */
function today(): string {
	const d = new Date();
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Write the deck's note back.
 *
 * `order` is the cards as the talk runs them, so the file reads in the same
 * order as the deck. Anything with notes that is no longer on the canvas is
 * moved to the end under its own heading rather than dropped: a card deleted by
 * accident, or moved to another canvas, should not take a month of remarks with
 * it.
 */
export async function saveDeckNotes(
	app: App,
	canvas: TFile,
	notes: DeckNotes,
	order: { id: string; title: string }[],
	entries: Map<string, string>
): Promise<TFile | null> {
	const byCard = new Map(notes.byCard);
	for (const [id, text] of entries) {
		const title = order.find((o) => o.id === id)?.title ?? byCard.get(id)?.title ?? "Card";
		const trimmed = text.trim();
		if (trimmed) byCard.set(id, { id, title, text: trimmed });
		else byCard.delete(id);
	}
	// A title can change under a note that is not being edited this time.
	for (const o of order) {
		const held = byCard.get(o.id);
		if (held && held.title !== o.title) byCard.set(o.id, { ...held, title: o.title });
	}

	const onCanvas = new Set(order.map((o) => o.id));
	const lines = [frontmatter(canvas), `# ${canvas.basename}`, ""];

	for (const o of order) {
		const note = byCard.get(o.id);
		if (!note?.text.trim()) continue;
		lines.push(`## ${note.title}`, `%%card: ${note.id}%%`, note.text.trim(), "");
	}

	const orphans = [...byCard.values()].filter((c) => !onCanvas.has(c.id) && c.text.trim());
	if (orphans.length > 0) {
		lines.push(`## ${GONE}`, "");
		for (const c of orphans) {
			lines.push(`### ${c.title}`, `%%card: ${c.id}%%`, c.text.trim(), "");
		}
	}

	const stamp = today();
	const presented = notes.presented.includes(stamp)
		? notes.presented
		: [...notes.presented, stamp];
	lines.push("---", `Presented: ${presented.join(" · ")}`, "");

	const body = lines.join("\n");
	const path = notes.file?.path ?? notePathFor(canvas);
	try {
		const dir = path.split("/").slice(0, -1).join("/");
		const there = app.vault.getAbstractFileByPath(dir);
		if (dir && !there) {
			await app.vault.createFolder(dir);
		}
		if (notes.file) {
			await app.vault.modify(notes.file, body);
			// The canvas may have been renamed since the note was written.
			const wanted = notePathFor(canvas);
			if (notes.file.path !== wanted && !app.vault.getAbstractFileByPath(wanted)) {
				await app.fileManager.renameFile(notes.file, wanted);
			}
			return notes.file;
		}
		return await app.vault.create(path, body);
	} catch {
		return null;
	}
}
