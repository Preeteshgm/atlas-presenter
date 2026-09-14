import { App, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { ICON_ID } from "../icons";
import { AtlasSettings } from "../types";
import { Presentation } from "./presentation";

export const PREVIEW_VIEW = "atlas-preview-view";

/**
 * The exported deck, running, beside the canvas that made it.
 *
 * Advanced Slides gets its live preview by running an HTTP server inside
 * Obsidian and pointing an iframe at localhost, which is why it is desktop
 * only. This wants the same loop — edit, refresh, see it — without the server:
 * the deck is rendered off to one side, turned into exactly the HTML the export
 * writes, and handed to an iframe as srcdoc. No port, no socket, no file.
 *
 * The point is fidelity. It is not another way to present — Atlas already
 * presents natively, and better. It is the answer to "what will the person I
 * send this to actually see", which is a question only the exported document
 * can answer.
 */
export class PreviewView extends ItemView {
	private frame!: HTMLIFrameElement;
	private status!: HTMLElement;
	private file: TFile | null = null;
	private building = false;

	constructor(
		leaf: WorkspaceLeaf,
		private settings: () => AtlasSettings,
		/** Hand a canvas to a real presentation, from the tab reviewing it. */
		private onPresent: (file: TFile) => void
	) {
		super(leaf);
	}

	getViewType(): string {
		return PREVIEW_VIEW;
	}

	getDisplayText(): string {
		return this.file ? `Preview · ${this.file.basename}` : "Export preview";
	}

	getIcon(): string {
		return ICON_ID;
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("atl-preview");

		// Everything you would want to do with a finished deck, on the tab where
		// you are already looking at it. Advanced Slides puts Refresh and Open in
		// Browser on its preview for the same reason: the pane is where you end
		// up, so it should not send you back to the command palette.
		const bar = root.createDiv({ cls: "atl-preview-bar" });
		const act = (text: string, run: () => void, cta = false) => {
			const b = bar.createEl("button", { cls: cta ? "mod-cta" : "", text });
			b.addEventListener("click", run);
			return b;
		};

		act("⟳  Refresh", () => void this.rebuild(), true);
		act("Present", () => this.present());
		act("Open in browser", () => void this.exportAnd(true));
		act("Export", () => void this.exportAnd(false));
		// The iframe is sandboxed without same-origin, so its window cannot be
		// reached from here — but it can be spoken to, and its runtime answers.
		act("Print / PDF", () => this.frame.contentWindow?.postMessage("atlas:print", "*"));
		act("⧉  New window", () => this.popOut());

		this.status = bar.createDiv({ cls: "atl-preview-status" });

		this.frame = root.createEl("iframe", { cls: "atl-preview-frame" });
		// allow-scripts without allow-same-origin: the deck's runtime needs to
		// run, and nothing in it needs to reach back into the vault.
		this.frame.setAttribute("sandbox", "allow-scripts");
		this.frame.setAttribute("allow", "fullscreen");

		this.say("Open a canvas and press Refresh.");
	}

	/** Point the preview at a canvas and build it. */
	async show(file: TFile): Promise<void> {
		this.file = file;
		// The tab renames itself, so two previews are told apart by their decks.
		this.leaf.setViewState({ type: PREVIEW_VIEW, active: false, state: {} });
		await this.rebuild();
	}

	private say(text: string): void {
		this.status.setText(text);
	}

	/**
	 * Render the canvas off to one side and hand the deck to `use`.
	 *
	 * Building the preview and writing the export are the same work up to the
	 * last line, so they share it: whatever you see here is what the file gets,
	 * because there is only one path that makes it.
	 */
	private async withDeck(what: string, use: (deck: Presentation) => Promise<void>): Promise<void> {
		if (this.building) return;
		if (!this.file) {
			const active = this.app.workspace.getActiveFile();
			if (active?.extension === "canvas") this.file = active;
		}
		if (!this.file) {
			this.say("No canvas. Open one, then press Refresh.");
			return;
		}

		this.building = true;
		this.say(`${what}…`);

		// Laid out at a real size but off the screen: the cards measure
		// themselves with container queries, and a host with no width would
		// render every one of them wrong.
		const host = this.contentEl.createDiv({ cls: "atl-preview-host" });
		const deck = new Presentation(this.app, this.file, this.settings());
		this.addChild(deck);

		try {
			if (!(await deck.startHeadless(host))) {
				this.say("That canvas has no cards to present.");
				return;
			}
			await use(deck);
		} catch (e) {
			this.say(`Could not ${what.toLowerCase()} — ${String(e)}`);
			new Notice(`Atlas: ${what.toLowerCase()} failed — ${String(e)}`);
		} finally {
			deck.stop();
			this.removeChild(deck);
			host.remove();
			this.building = false;
		}
	}

	/**
	 * A whole rebuild rather than a patch: the canvas may have gained cards,
	 * lost edges or changed theme since the last one, and there is no version of
	 * "some of that" worth the complication.
	 */
	private async rebuild(): Promise<void> {
		await this.withDeck("Building", async (deck) => {
			this.frame.srcdoc = await deck.buildHtml();
			this.say(`${this.file?.basename} · built ${new Date().toLocaleTimeString()}`);
		});
	}

	/** Write the file, and optionally open it where it will be looked at. */
	private async exportAnd(open: boolean): Promise<void> {
		await this.withDeck("Exporting", async (deck) => {
			const path = await deck.exportToHtml();
			this.say(path ? `Exported to ${path}` : "Could not write the export.");
			if (!open || !path) return;
			const launch = (this.app as unknown as { openWithDefaultApp?: (p: string) => void })
				.openWithDefaultApp;
			if (typeof launch === "function") launch.call(this.app, path);
		});
	}

	/** Hand the canvas to a real presentation, from where you are reviewing it. */
	private present(): void {
		if (this.file) this.onPresent(this.file);
	}

	/**
	 * Move this tab into a window of its own.
	 *
	 * Any Obsidian leaf can be dragged out by hand; this is the same thing
	 * without the dragging, because the reason to want it — put the deck on the
	 * other screen and keep working here — is worth one click.
	 */
	private popOut(): void {
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
	}

	async onClose(): Promise<void> {
		// srcdoc keeps a whole document, pictures included, alive in memory.
		this.frame.srcdoc = "";
	}
}

/**
 * Open the preview beside the canvas, reusing the one already open.
 *
 * A second preview tab for the same vault is never what anyone wants: the point
 * is to watch one deck while editing it.
 */
export async function openPreview(app: App, file: TFile): Promise<void> {
	const existing = app.workspace.getLeavesOfType(PREVIEW_VIEW);
	const leaf = existing[0] ?? app.workspace.getLeaf("split", "vertical");
	if (!existing[0]) await leaf.setViewState({ type: PREVIEW_VIEW, active: true });
	app.workspace.revealLeaf(leaf);
	const view = leaf.view;
	if (view instanceof PreviewView) await view.show(file);
}
