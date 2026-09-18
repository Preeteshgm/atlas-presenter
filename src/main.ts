import { ItemView, Notice, Plugin, TFile } from "obsidian";
import { AtlasSettings, DEFAULT_SETTINGS } from "./types";
import { ICON_ID, registerIcons } from "./icons";
import { Presentation } from "./present/presentation";
import { parseCanvas } from "./canvas/parse";
import { variantsIn } from "./canvas/path";
import { VariantPicker } from "./variant-picker";
import { PRESENTER_VIEW, PresenterView } from "./present/presenter";
import { DECK_VIEW, DeckView } from "./present/deck-window";
import { PREVIEW_VIEW, PreviewView, openPreview } from "./present/preview";
import { AtlasSettingTab } from "./settings";
import { Orphan, orphans } from "./present/journal";
import { writeMinutes } from "./present/capture";
import { offer } from "./notice";
import { AskModal } from "./ask-modal";
import { hasModel } from "./ask";
import { REFERENCE_NAME, REFERENCE_NOTE } from "./reference-note";

export default class AtlasPlugin extends Plugin {
	settings: AtlasSettings = { ...DEFAULT_SETTINGS };
	private active: Presentation | null = null;
	/** The ask icon, hidden until a model is configured. */
	private askIcon: HTMLElement | null = null;

	async onload(): Promise<void> {
		// loadData() is untyped, so the shape is asserted once, here, rather than
		// letting an `any` spread through every setting read.
		const saved = ((await this.loadData()) ?? {}) as Partial<AtlasSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		registerIcons();

		// The placement markers, quietened wherever Obsidian renders markdown.
		//
		// `:::pin top-right` is an instruction to Atlas, not a line of the talk.
		// On a canvas card Obsidian draws it as ordinary text, so a card you
		// have laid out reads with its scaffolding showing. Marked here, the
		// stylesheet sets it small and faint — still visible, because a block
		// you cannot see the start of is a block you cannot edit, but no longer
		// competing with the words.
		this.registerMarkdownPostProcessor((el) => {
			el.querySelectorAll("p").forEach((p) => {
				const text = p.textContent?.trim() ?? "";
				if (/^:::/.test(text) && text.length < 60) p.addClass("atl-marker-line");
			});
		});
		this.registerView(PRESENTER_VIEW, (leaf) => new PresenterView(leaf));
		this.registerView(DECK_VIEW, (leaf) => new DeckView(leaf));
		this.registerView(
			PREVIEW_VIEW,
			(leaf) =>
				new PreviewView(
					leaf,
					() => this.settings,
					(file) => void this.present(file)
				)
		);

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

		// Its own icon rather than a button folded into the graph bar: asking
		// your notes is its own job, and it is useful when no deck is running.
		// Shown only once a model is configured — see hasModel(). The command
		// stays in the palette either way, where it can explain itself.
		this.askIcon = this.addRibbonIcon("search", "Atlas: ask your notes", () => {
			new AskModal(this.app, this.settings).open();
		});
		this.showAskIcon();

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
						.setTitle("Export this canvas to HTML")
						.setIcon(ICON_ID)
						.onClick(() => void this.exportCanvas(file))
				);
			})
		);

		this.addSettingTab(new AtlasSettingTab(this.app, this));

		this.addCommand({
			id: "open-reference-note",
			name: "How to write a card",
			callback: () => void this.openReference(),
		});

		this.addCommand({
			id: "ask-notes",
			name: "Ask your notes",
			callback: () => new AskModal(this.app, this.settings).open(),
		});

		this.addCommand({
			id: "write-up-session",
			name: "Write up an unfinished session",
			callback: () => void this.recoverSessions(),
		});

		// After layout, so a vault still indexing does not report no sessions.
		this.app.workspace.onLayoutReady(() => {
			this.closeStaleViews();
			void this.offerRecovery();
		});
	}

	/**
	 * The reference, in a pane beside whatever you are writing.
	 *
	 * Found by name wherever it is in the vault, so a copy you have moved or
	 * annotated is the one that opens. Written beside the canvas you are on the
	 * first time, because that is where you will look for it again.
	 */
	private async openReference(): Promise<void> {
		const wanted = `${REFERENCE_NAME}.md`;
		let file =
			this.app.vault
				.getMarkdownFiles()
				.find((f) => f.name === wanted || f.basename.endsWith(REFERENCE_NAME)) ?? null;

		if (!file) {
			const here = this.app.workspace.getActiveFile()?.parent?.path ?? "";
			const path = here ? `${here}/${wanted}` : wanted;
			try {
				file = await this.app.vault.create(path, REFERENCE_NOTE);
			} catch {
				new Notice("Atlas: could not write the reference note here.");
				return;
			}
		}
		await this.app.workspace.getLeaf("split").openFile(file);
	}

	/**
	 * Views left over from last time.
	 *
	 * Ending a talk closes its presenter panel and its deck tab. Obsidian then
	 * restores whatever was open when it last quit — so a session that ended
	 * with the app still running came back to a panel reading "No deck is
	 * running" and an empty deck tab, both of which had to be closed by hand.
	 *
	 * Neither means anything without a deck, and a deck cannot survive a
	 * restart, so on load there is never a reason to keep one.
	 */
	private closeStaleViews(): void {
		for (const type of [PRESENTER_VIEW, DECK_VIEW]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				try {
					leaf.detach();
				} catch {
					// Already gone; nothing to tidy.
				}
			}
		}
	}

	/**
	 * A talk that ended without being written up.
	 *
	 * Offered once, on load, because the one time this matters is the one time
	 * nobody thinks to go looking in a folder for it.
	 */
	private async offerRecovery(): Promise<void> {
		const left = await orphans(this.app, this.settings.minutesFolder || "Meetings");
		if (left.length === 0) return;
		const when = new Date(left[0].data.startedAt).toLocaleString(undefined, {
			weekday: "long",
			hour: "2-digit",
			minute: "2-digit",
		});
		const more = left.length > 1 ? ` (and ${left.length - 1} more)` : "";
		offer((el, close) => {
			el.createDiv({
				text: `Atlas: a session from ${when} was never written up${more}.`,
			});
			el.createDiv({
				cls: "atl-notice-sub",
				text:
					`${left[0].data.captures.length} notes · ` +
					`${left[0].data.visits.length} cards`,
			});
			const btn = el.createEl("button", { cls: "atl-notice-btn", text: "Write it up" });
			btn.addEventListener("click", () => {
				close();
				void this.recoverSessions();
			});
		});
	}

	/** Pick an unfinished session and turn it into minutes. */
	private async recoverSessions(): Promise<void> {
		const folder = this.settings.minutesFolder || "Meetings";
		const left = await orphans(this.app, folder);
		if (left.length === 0) {
			new Notice("Atlas: no unfinished sessions.");
			return;
		}

		const choices = left.map((o) => {
			const d = new Date(o.data.startedAt);
			return {
				id: o.path,
				label: `${o.data.deck} — ${d.toLocaleString()}`,
				detail:
					`${o.data.captures.length} notes · ${o.data.visits.length} cards` +
					(o.data.audio || o.data.recording ? " · recorded" : ""),
			};
		});

		new VariantPicker(this.app, choices, (path) => {
			const chosen = left.find((o) => o.path === path);
			if (chosen) void this.writeRecovered(chosen, folder);
		}).open();
	}

	private async writeRecovered(orphan: Orphan, folder: string): Promise<void> {
		const d = orphan.data;
		const file = await writeMinutes(
			this.app,
			{
				deck: d.deck,
				deckPath: d.deckPath,
				variant: d.variant,
				startedAt: d.startedAt,
				endedAt: d.updatedAt,
				visits: d.visits ?? [],
				captures: d.captures ?? [],
				prepared: new Map(Object.entries(d.prepared ?? {})),
				audio: d.audio,
			},
			folder,
			{
				actionSuffix: this.settings.actionSuffix,
				linkBack: this.settings.actionsLinkBack,
				includePrepared: this.settings.minutesIncludeNotes,
			}
		);
		if (!file) return;
		// Only once the minutes exist. A journal deleted before that would take
		// the meeting with it, which is the exact thing it was there to prevent.
		const journal = this.app.vault.getAbstractFileByPath(orphan.path);
		if (journal instanceof TFile) {
			try {
				await this.app.fileManager.trashFile(journal);
			} catch {
				// Left behind, and it will be offered again. Harmless.
			}
		}
		await this.app.workspace.getLeaf(true).openFile(file);
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
				  });

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
			// A tab of its own, before start(), because the deck is built inside
			// whichever container it is given. Drag that tab to another screen and
			// it takes the deck with it. A tab that will not open is not a reason
			// to abandon the talk: say so and present over this window instead.
			if (!(await show.useTab())) {
				new Notice("Atlas: could not open a tab; presenting over this window.");
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

	/** The ask icon belongs on the ribbon only when there is a model behind it. */
	private showAskIcon(): void {
		if (!this.askIcon) return;
		if (hasModel(this.settings)) this.askIcon.show();
		else this.askIcon.hide();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// A model set or cleared in the panel changes what belongs on screen.
		this.showAskIcon();
	}
}
