import { App, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
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

	constructor(leaf: WorkspaceLeaf, private settings: () => AtlasSettings) {
		super(leaf);
	}

	getViewType(): string {
		return PREVIEW_VIEW;
	}

	getDisplayText(): string {
		return this.file ? `Preview · ${this.file.basename}` : "Export preview";
	}

	getIcon(): string {
		return "atlas-route";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("atl-preview");

		const bar = root.createDiv({ cls: "atl-preview-bar" });
		const refresh = bar.createEl("button", { cls: "mod-cta", text: "⟳  Refresh" });
		refresh.addEventListener("click", () => void this.rebuild());
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
	 * Render the canvas afresh and swap the document in.
	 *
	 * A whole rebuild rather than a patch: the canvas may have gained cards,
	 * lost edges or changed theme since the last one, and there is no version of
	 * "some of that" worth the complication.
	 */
	private async rebuild(): Promise<void> {
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
		this.say("Building…");

		// Laid out at a real size but off the screen: the cards measure
		// themselves with container queries, and a host with no width would
		// render every one of them wrong.
		const host = this.contentEl.createDiv({ cls: "atl-preview-host" });
		const deck = new Presentation(this.app, this.file, this.settings());
		this.addChild(deck);

		try {
			const ok = await deck.startHeadless(host);
			if (!ok) {
				this.say("That canvas has no cards to present.");
				return;
			}
			this.frame.srcdoc = await deck.buildHtml();
			this.say(`${this.file.basename} · built ${new Date().toLocaleTimeString()}`);
		} catch (e) {
			this.say(`Could not build it — ${String(e)}`);
			new Notice(`Atlas: preview failed — ${String(e)}`);
		} finally {
			deck.stop();
			this.removeChild(deck);
			host.remove();
			this.building = false;
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
