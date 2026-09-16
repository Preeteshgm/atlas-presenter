import { App, TFile, TFolder, normalizePath } from "obsidian";
import { Capture, Visit } from "./capture";
import { safeFileName } from "../format";

/**
 * The session, on disk, while it is still happening.
 *
 * Notes lived in memory until the deck was closed cleanly. Obsidian crashing,
 * the tab being force-closed, or the laptop dying took an entire meeting with
 * it — and a meeting is the one thing that cannot be repeated to get the notes
 * back. Everything is written as it happens instead.
 *
 * The file is small and rewritten whole on each change: a few kilobytes, and a
 * whole-file write cannot leave a half-appended record behind.
 */

export interface JournalData {
	deck: string;
	deckPath: string;
	variant: string;
	startedAt: number;
	/** Last touched, so a stale journal can say how long it ran. */
	updatedAt: number;
	visits: Visit[];
	captures: Capture[];
	/** Prepared %%notes%%, so a recovered session reads like the live one. */
	prepared: Record<string, string>;
	/** The session recording, once it has been written out. */
	audio?: { path: string; startedAt: number; ms: number };
	/** A recording still in progress — the part file, and when it began. */
	recording?: { path: string; startedAt: number };
}

/** `2026-09-16 14-02`, which sorts and is legal in a filename. */
function stamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}-${pad(d.getMinutes())}`
	);
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const dir = normalizePath(path);
	if (app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
	try {
		await app.vault.createFolder(dir);
	} catch {
		// Already there, or the name is taken by a file; the write says so.
	}
}

export class Journal {
	private path: string;
	/** A write is in flight; another is wanted when it lands. */
	private writing = false;
	private again = false;
	private dead = false;

	constructor(
		private app: App,
		folder: string,
		private data: JournalData
	) {
		this.path = normalizePath(
			`${folder}/Sessions/${safeFileName(data.deck)} ${stamp(data.startedAt)}.json`
		);
	}

	get file(): string {
		return this.path;
	}

	/**
	 * Write what has happened so far.
	 *
	 * Never awaited by a caller in the middle of a talk: a note is saved the
	 * moment it is typed, and nothing on screen waits for the disk. Overlapping
	 * calls collapse into one more write, so holding a key cannot queue fifty.
	 */
	save(patch: Partial<JournalData>): void {
		if (this.dead) return;
		this.data = { ...this.data, ...patch, updatedAt: Date.now() };
		void this.flush();
	}

	private async flush(): Promise<void> {
		if (this.writing) {
			this.again = true;
			return;
		}
		this.writing = true;
		try {
			await ensureFolder(this.app, this.path.split("/").slice(0, -1).join("/"));
			const body = JSON.stringify(this.data, null, "\t");
			const existing = this.app.vault.getAbstractFileByPath(this.path);
			if (existing instanceof TFile) await this.app.vault.modify(existing, body);
			else await this.app.vault.create(this.path, body);
		} catch {
			// A journal that cannot be written must not interrupt the talk. The
			// notes are still in memory; this only costs the safety net.
		} finally {
			this.writing = false;
			if (this.again) {
				this.again = false;
				await this.flush();
			}
		}
	}

	/**
	 * The session is written up, so the journal has done its job.
	 *
	 * Deleted rather than kept: its whole purpose is to be the copy that
	 * survives a crash, and once the minutes exist it is a duplicate of them
	 * that nobody will ever read.
	 */
	async done(): Promise<void> {
		this.dead = true;
		const file = this.app.vault.getAbstractFileByPath(this.path);
		if (file instanceof TFile) {
			try {
				await this.app.fileManager.trashFile(file);
			} catch {
				// Left behind; it will show up as an orphan and can be cleared.
			}
		}
	}
}

/** A session that was never written up. */
export interface Orphan {
	path: string;
	data: JournalData;
}

/**
 * Sessions left behind by a deck that never closed cleanly.
 *
 * Read on load and offered back, because the one time this matters is the one
 * time nobody thinks to go looking in a folder.
 */
export async function orphans(app: App, folder: string): Promise<Orphan[]> {
	const dir = normalizePath(`${folder}/Sessions`);
	const found = app.vault.getAbstractFileByPath(dir);
	if (!(found instanceof TFolder)) return [];

	const out: Orphan[] = [];
	for (const child of found.children) {
		if (!(child instanceof TFile) || child.extension !== "json") continue;
		try {
			const data = JSON.parse(await app.vault.cachedRead(child)) as JournalData;
			// A session with nothing in it is not worth offering back.
			if (data?.captures?.length > 0 || data?.audio || data?.recording) {
				out.push({ path: child.path, data });
			}
		} catch {
			// Not ours, or half-written. Leaving it alone is the safe answer.
		}
	}
	out.sort((a, b) => b.data.startedAt - a.data.startedAt);
	return out;
}
