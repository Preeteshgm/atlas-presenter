import { ItemView, Notice, Plugin, TFile, addIcon } from "obsidian";
import { AtlasSettings, DEFAULT_SETTINGS } from "./types";
import { Presentation } from "./present/presentation";
import { parseCanvas } from "./canvas/parse";
import { variantsIn } from "./canvas/path";
import { VariantPicker } from "./variant-picker";
import { PRESENTER_VIEW, PresenterView } from "./present/presenter";
import { DECK_VIEW, DeckView } from "./present/deck-window";
import { PREVIEW_VIEW, PreviewView, openPreview } from "./present/preview";
import { AtlasSettingTab } from "./settings";

/**
 * Our own icon rather than a built-in name: which Lucide icons ship with
 * Obsidian varies by version, and a name that is missing renders as nothing at
 * all. Obsidian expects a 0 0 100 100 viewBox and inherits colour from the theme.
 *
 * Three stops joined by a route — the map, which is the whole idea.
 */
const ICON_ID = "atlas-route";
const ICON_SVG = `<g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
	<path d="M24 76 C 42 76 34 50 52 48 C 68 46 66 28 78 24" stroke-dasharray="3 12" />
	<circle cx="24" cy="76" r="10" fill="currentColor" stroke="none" />
	<circle cx="52" cy="48" r="8" />
	<circle cx="78" cy="24" r="10" />
</g>`;

export default class AtlasPlugin extends Plugin {
	settings: AtlasSettings = { ...DEFAULT_SETTINGS };
	private active: Presentation | null = null;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		addIcon(ICON_ID, ICON_SVG);
		this.registerView(PRESENTER_VIEW, (leaf) => new PresenterView(leaf));
		this.registerView(DECK_VIEW, (leaf) => new DeckView(leaf));
		this.registerView(PREVIEW_VIEW, (leaf) => new PreviewView(leaf, () => this.settings));

		this.addCommand({
			id: "present-canvas",
			name: "Present",
			// No default binding on purpose: Obsidian's plugin guidelines warn
			// that defaults collide between plugins and differ across platforms.
			// The settings tab links straight to the hotkey pane instead.
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "canvas") return false;
				if (!checking) void this.present(file, this.selectedCardId());
				return true;
			},
		});

		this.addCommand({
			id: "present-canvas-windowed",
			name: "Present on a second screen",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "canvas") return false;
				if (!checking) {
					void this.present(file, this.selectedCardId(), "", { windowed: true });
				}
				return true;
			},
		});

		this.addCommand({
			id: "present-canvas-variant",
			name: "Present a variant…",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "canvas") return false;
				if (!checking) void this.presentVariant(file);
				return true;
			},
		});

		this.addCommand({
			id: "present-canvas-from-start",
			name: "Present from the beginning",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "canvas") return false;
				if (!checking) void this.present(file);
				return true;
			},
		});

		// Worth a command of its own: Escape is on the deck's own window, and if
		// that window is behind something, or on a screen you cannot see, there
		// was no way to end the talk from here. Give this one a hotkey and it
		// pairs with whichever present command you bind.
		this.addCommand({
			id: "stop-presenting",
			name: "Stop presenting",
			checkCallback: (checking: boolean) => {
				if (!this.active) return false;
				if (!checking) {
					this.active.stop();
					this.active = null;
				}
				return true;
			},
		});

		this.addCommand({
			id: "preview-export",
			name: "Preview the export",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "canvas") return false;
				if (!checking) void openPreview(this.app, file);
				return true;
			},
		});

		// Works with or without a deck running. Having to present a canvas
		// before you could export it made the obvious loop — edit, export,
		// look — into three steps instead of one.
		this.addCommand({
			id: "export-deck",
			name: "Export to HTML",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!this.active && file?.extension !== "canvas") return false;
				if (!checking) {
					if (this.active) void this.active.exportToHtml();
					else if (file) void this.exportCanvas(file);
				}
				return true;
			},
		});

		this.addRibbonIcon(ICON_ID, "Atlas: present this canvas", () => {
			const file = this.app.workspace.getActiveFile();
			if (file && file.extension === "canvas") void this.present(file, this.selectedCardId());
			else new Notice("Atlas: open a canvas first.");
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "canvas") return;
				menu.addItem((item) =>
					item
						.setTitle("Present with Atlas")
						.setIcon(ICON_ID)
						.onClick(() => void this.present(file))
				);
				menu.addItem((item) =>
					item
						.setTitle("Preview the Atlas export")
						.setIcon(ICON_ID)
						.onClick(() => void openPreview(this.app, file))
				);
				menu.addItem((item) =>
					item
						.setTitle("Present with Atlas on a second screen")
						.setIcon(ICON_ID)
						.onClick(() => void this.present(file, undefined, "", { windowed: true }))
				);
			})
		);

		this.addSettingTab(new AtlasSettingTab(this.app, this));
	}

	onunload(): void {
		if (this.active) this.active.stop(true);
		this.active = null;
	}

	/**
	 * The card selected in the canvas editor, if there is exactly one.
	 *
	 * The canvas view is a core plugin with no public API, so this reaches for
	 * an internal field and shrugs if the shape ever changes — starting from the
	 * first card is a perfectly good fallback.
	 */
	private selectedCardId(): string | undefined {
		try {
			const view = this.app.workspace.getActiveViewOfType(ItemView) as
				| (ItemView & {
						canvas?: {
							selection?: Set<{ id?: string }>;
							getSelectionData?: () => { nodes?: { id?: string }[] };
						};
				  })
				| null;
			const canvas = view?.canvas;
			if (!canvas) return undefined;

			// getSelectionData() serialises the selection the same way the file
			// stores it, so its ids are the ones the canvas JSON uses. Reading
			// the live selection objects is the fallback.
			const data = canvas.getSelectionData?.();
			const fromData = data?.nodes;
			if (Array.isArray(fromData) && fromData.length === 1) {
				const id = fromData[0]?.id;
				if (typeof id === "string") return id;
			}

			const selection = canvas.selection;
			if (!selection || selection.size !== 1) return undefined;
			const [node] = Array.from(selection);
			return typeof node?.id === "string" ? node.id : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Offer the talks this canvas contains.
	 *
	 * The list comes from the cards, so a canvas with no variant tags simply
	 * presents as usual rather than asking a pointless question.
	 */
	private async presentVariant(file: TFile): Promise<void> {
		let names: string[];
		try {
			names = variantsIn(parseCanvas(await this.app.vault.cachedRead(file)));
		} catch {
			// An unreadable canvas is the presenter's problem, not the picker's.
			names = [];
		}
		if (names.length === 0) {
			new Notice("Atlas: this canvas has no variants. Tag a card #skip-short or #only-short.");
			void this.present(file, this.selectedCardId());
			return;
		}

		const choices = [
			{ id: "", label: "The whole canvas", detail: "every card" },
			...names.map((n) => ({
				id: n,
				label: n,
				detail: `cards tagged #only-${n}, and everything not tagged #skip-${n}`,
			})),
		];
		new VariantPicker(this.app, choices, (id) =>
			void this.present(file, this.selectedCardId(), id)
		).open();
	}

	private async present(
		file: TFile,
		startNodeId?: string,
		variant = "",
		options: { windowed?: boolean } = {}
	): Promise<void> {
		if (this.active) this.active.stop();
		const show = new Presentation(this.app, file, this.settings, startNodeId, variant);
		this.active = show;
		// A deck that ends on its own — Escape, or its window closed — has to be
		// forgotten here too, or the next talk starts by stopping a dead one.
		show.onStopped = () => {
			if (this.active === show) this.active = null;
		};
		this.addChild(show);
		try {
			// Before start(), because the deck is built into whichever window it
			// is given. A window that will not open is not a reason to abandon
			// the talk: say so and present in place.
			if (options.windowed && !(await show.useOwnWindow())) {
				new Notice("Atlas: could not open a second window; presenting here.");
			}
			await show.start();
		} catch (e) {
			new Notice(`Atlas: ${String(e)}`);
			show.stop();
			this.active = null;
		}
	}

	/**
	 * Export a canvas without presenting it.
	 *
	 * The deck is rendered off to one side — laid out at a real size, because
	 * the cards measure themselves — written out, and thrown away.
	 */
	private async exportCanvas(file: TFile): Promise<void> {
		new Notice("Atlas: exporting…");
		const host = document.body.createDiv({ cls: "atl-preview-host" });
		const deck = new Presentation(this.app, file, this.settings);
		this.addChild(deck);
		try {
			if (await deck.startHeadless(host)) await deck.exportToHtml();
			else new Notice("Atlas: this canvas has no cards to export.");
		} catch (e) {
			new Notice(`Atlas: could not export — ${String(e)}`);
		} finally {
			deck.stop();
			this.removeChild(deck);
			host.remove();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
