import { App, Component, TFile } from "obsidian";
import { renderLinkedFile } from "./render";
import { isElement } from "../dom";

/**
 * Click a wikilink in a slide and read the note without leaving the deck.
 *
 * This is the other half of the map idea: the deck is a path across the vault,
 * so the vault has to stay reachable from inside it. Escape returns you to
 * exactly the slide you were on, camera untouched.
 */
export class Peek {
	private root: HTMLElement;
	private titleEl: HTMLElement;
	private bodyEl: HTMLElement;
	private crumbEl: HTMLElement;
	/** Links followed from inside the peek, so you can walk back out. */
	private trail: string[] = [];
	private open = false;

	constructor(container: HTMLElement, private app: App, private owner: Component) {
		this.root = container.createDiv({ cls: "atl-peek" });
		this.root.addEventListener("click", (e) => {
			if (e.target !== this.root) return;
			e.stopPropagation();
			this.close();
		});

		const panel = this.root.createDiv({ cls: "atl-peek-panel" });
		const head = panel.createDiv({ cls: "atl-peek-head" });
		this.titleEl = head.createDiv({ cls: "atl-peek-title" });
		this.crumbEl = head.createDiv({ cls: "atl-peek-crumb" });
		const close = head.createEl("button", { cls: "atl-peek-close", text: "Esc" });
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			this.close();
		});
		this.bodyEl = panel.createDiv({ cls: "atl-peek-body" });
		// Focusable so the wheel and the scrollbar land here rather than on the
		// deck behind it.
		this.bodyEl.tabIndex = 0;

		// Links inside the peek keep working, one level deeper each time.
		this.bodyEl.addEventListener("click", (e) => {
			const target = (e.target as HTMLElement | null)?.closest("a.internal-link");
			if (!isElement(target)) return;
			e.preventDefault();
			e.stopPropagation();
			const href = target.getAttr("href") ?? target.innerText;
			if (href) void this.show(href, this.trail[this.trail.length - 1] ?? "");
		});
	}

	get isOpen(): boolean {
		return this.open;
	}

	get scroller(): HTMLElement {
		return this.bodyEl;
	}

	/** Open a note we already resolved, e.g. one picked out of the browser. */
	async showFile(file: TFile): Promise<void> {
		await this.show(file.path, "");
	}

	async show(linktext: string, sourcePath: string): Promise<boolean> {
		const file = this.app.metadataCache.getFirstLinkpathDest(
			linktext.split("#")[0].split("|")[0],
			sourcePath
		);
		if (!(file instanceof TFile)) {
			this.titleEl.setText(linktext);
			this.bodyEl.empty();
			this.bodyEl.createDiv({ cls: "atl-missing", text: `No note called "${linktext}".` });
			this.reveal();
			return false;
		}

		this.trail.push(file.path);
		this.titleEl.setText(file.basename);
		this.crumbEl.setText(this.trail.length > 1 ? `${this.trail.length} deep · Backspace` : "");
		this.bodyEl.empty();
		this.bodyEl.scrollTop = 0;
		// The same renderer a card uses, so a drawing, a picture, a recording or
		// a sub-canvas opens as itself rather than as its source.
		const hash = linktext.indexOf("#");
		await renderLinkedFile(
			this.app,
			this.owner,
			this.bodyEl,
			file,
			hash >= 0 ? linktext.slice(hash) : ""
		);
		this.reveal();
		return true;
	}

	/** Step back one link, or close if we are at the note we started from. */
	async back(): Promise<void> {
		this.trail.pop();
		const previous = this.trail.pop();
		if (!previous) {
			this.close();
			return;
		}
		await this.show(previous, "");
	}

	private reveal(): void {
		this.open = true;
		this.root.addClass("is-open");
		this.bodyEl.focus();
	}

	close(): void {
		this.open = false;
		this.trail = [];
		this.root.removeClass("is-open");
		this.bodyEl.empty();
	}
}
