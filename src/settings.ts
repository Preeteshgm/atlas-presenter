import {
	App,
	DropdownComponent,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";
import type AtlasPlugin from "./main";
import { IMAGE_EXT } from "./media";
import { renderReference } from "./settings-reference";
import {
	BackgroundMode,
	BrowserMode,
	Corner,
	FitMode,
	HeaderPosition,
	HeaderScope,
	SlideshowTransition,
	TimerMode,
	VerticalAlign,
} from "./types";

/** The handbook, which is this panel's reference with room to breathe. */
const DOCS_URL = "https://preeteshgm.github.io/atlas-presenter/";

export class AtlasSettingTab extends PluginSettingTab {
	private plugin: AtlasPlugin;

	constructor(app: App, plugin: AtlasPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	/** Every image in the vault, so a logo or backdrop is picked, not typed. */
	/**
	 * Images offered by the backdrop and logo pickers.
	 *
	 * Narrowed to the media folder when one is set. A folder that holds nothing
	 * falls back to the whole vault rather than offering an empty list: the
	 * setting is a convenience, and a convenience that can lock you out of your
	 * own images is worse than no setting at all.
	 */
	private imageChoices(): Record<string, string> {
		const all: string[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (file instanceof TFile && IMAGE_EXT.test(file.path)) all.push(file.path);
		}

		const folder = this.plugin.settings.mediaFolder.replace(/\/+$/, "");
		const inFolder = folder
			? all.filter((p) => p.toLowerCase().startsWith(`${folder.toLowerCase()}/`))
			: all;
		const use = inFolder.length > 0 ? inFolder : all;
		use.sort();

		const out: Record<string, string> = { "": "— none —" };
		// Shown by filename once they all come from one folder — the path is the
		// same on every row, so repeating it only makes them harder to tell apart.
		for (const path of use) {
			out[path] = folder && inFolder.length > 0 ? (path.split("/").pop() ?? path) : path;
		}
		return out;
	}

	/** Every folder in the vault, for the media-folder picker. */
	private folderChoices(): Record<string, string> {
		const out: Record<string, string> = { "": "— the whole vault —" };
		const seen = new Set<string>();
		for (const file of this.app.vault.getFiles()) {
			if (!IMAGE_EXT.test(file.path)) continue;
			const dir = file.path.split("/").slice(0, -1).join("/");
			// Only folders that actually hold an image: a picker listing empty
			// folders is a list of ways to get an empty picker.
			if (dir && !seen.has(dir)) seen.add(dir);
		}
		for (const dir of [...seen].sort()) out[dir] = dir;
		return out;
	}

	/**
	 * The binding currently attached to one of our commands.
	 *
	 * Hotkeys live in Obsidian's own settings, not ours, and the manager that
	 * holds them is not part of the public API — so this reads it defensively
	 * and falls back to naming the default.
	 */
	private currentHotkey(commandId: string): string {
		const symbols: Record<string, string> = {
			Mod: Platform.isMacOS ? "Cmd" : "Ctrl",
			Ctrl: "Ctrl",
			Meta: "Cmd",
			Alt: "Alt",
			Shift: "Shift",
		};
		try {
			const manager = (this.app as unknown as {
				hotkeyManager?: {
					customKeys?: Record<string, { modifiers: string[]; key: string }[]>;
					defaultKeys?: Record<string, { modifiers: string[]; key: string }[]>;
				};
			}).hotkeyManager;
			const id = `atlas-presenter:${commandId}`;
			const binding = manager?.customKeys?.[id] ?? manager?.defaultKeys?.[id];
			const first = binding?.[0];
			if (!first) return "not bound";
			const parts = first.modifiers.map((m) => symbols[m] ?? m);
			return [...parts, first.key.toUpperCase()].join(" + ");
		} catch {
			return "Ctrl + Shift + P";
		}
	}

	/** Jump to Obsidian's hotkey pane, already filtered to this plugin. */
	private openHotkeys(): void {
		try {
			const setting = (this.app as unknown as {
				setting: {
					openTabById(id: string): void;
					activeTab?: { searchInputEl?: HTMLInputElement; updateHotkeyVisibility?: () => void };
				};
			}).setting;
			setting.openTabById("hotkeys");
			const tab = setting.activeTab;
			if (tab?.searchInputEl) {
				tab.searchInputEl.value = "Atlas";
				tab.updateHotkeyVisibility?.();
			}
		} catch {
			new Notice("Open Settings → Hotkeys and search for Atlas.");
		}
	}

	/**
	 * The stylesheets in this vault that are actually Atlas themes.
	 *
	 * Sorting them to the top was not enough. A vault that has ever exported a
	 * reveal.js deck holds dozens of stylesheets, and picking one of those does
	 * nothing whatsoever — it styles `.reveal`, which a deck has never had. The
	 * list was the problem, so it now holds only files carrying Atlas's own
	 * selectors: everything you can choose is a theme that works.
	 */
	private async atlasThemes(): Promise<Record<string, string>> {
		const NOISE = /(^|\/)(dist|plugin|plugins|node_modules|\.obsidian)\//i;
		const found: string[] = [];

		for (const file of this.app.vault.getFiles()) {
			if (file.extension !== "css") continue;
			if (NOISE.test(file.path)) continue;
			try {
				if ((await this.app.vault.cachedRead(file)).includes(".atl-")) {
					found.push(file.path);
				}
			} catch {
				// Unreadable is not a theme either.
			}
		}
		found.sort();

		const out: Record<string, string> = { "": "— none —" };
		for (const path of found) {
			const name = path.split("/").pop()?.replace(/\.css$/, "") ?? path;
			out[path] = /(^|\/)Themes\//i.test(path) ? `Themes  ·  ${name}` : path;
		}
		return out;
	}

	/**
	 * Fill the theme dropdown once the stylesheets have been read.
	 *
	 * Whatever is saved stays in the list even when it is not a theme, and says
	 * why. A setting made before this filtering existed would otherwise vanish
	 * from its own dropdown and appear to be something else.
	 */
	private async fillThemes(c: DropdownComponent, current: string): Promise<void> {
		const choices = await this.atlasThemes();
		if (current && !(current in choices)) {
			const there = !!this.app.vault.getAbstractFileByPath(normalizePath(current));
			choices[current] = `${current}  —  ${there ? "not an Atlas theme" : "missing"}`;
		}
		c.selectEl.empty();
		c.addOptions(choices);
		c.setValue(current);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// --------------------------------------------------------- shortcut
		new Setting(containerEl).setName("Starting a presentation").setHeading();

		// The reference at the foot of this panel is the same material, but a
		// panel is a poor place to read anything at length.
		new Setting(containerEl)
			.setName("Documentation")
			.setDesc("Every feature, with examples, on one page in your browser.")
			.addButton((b) =>
				b
					.setButtonText("Open the handbook")
					.onClick(() => window.open(DOCS_URL, "_blank"))
			);

		new Setting(containerEl)
			.setName("Keyboard shortcut")
			.setDesc(
				`Currently ${this.currentHotkey("present-canvas")}. No shortcut is set by ` +
					"default, because a plugin picking one for you tends to collide with " +
					"something. With a card selected in the canvas the deck opens on that " +
					"card; with nothing selected it starts at the beginning."
			)
			.addButton((b) =>
				b.setButtonText("Change shortcut").onClick(() => this.openHotkeys())
			);

		// ---------------------------------------------------------- movement
		new Setting(containerEl).setName("Camera").setHeading();

		new Setting(containerEl)
			.setName("Flight duration")
			.setDesc("How long the camera takes to travel between cards, in milliseconds.")
			.addSlider((c) =>
				c.setLimits(0, 2000, 50).setValue(s.duration).onChange(async (v) => {
					s.duration = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Section overviews")
			.setDesc("Zoom out to frame a whole group before diving into its first card.")
			.addToggle((c) =>
				c.setValue(s.sectionOverviews).onChange(async (v) => {
					s.sectionOverviews = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Framing padding")
			.setDesc("Breathing room around a card, as a fraction of its size.")
			.addSlider((c) =>
				c.setLimits(0, 0.4, 0.01).setValue(s.padding).onChange(async (v) => {
					s.padding = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("How a card fills the screen")
			.setDesc(
				"Contain shows the whole card, so a card shaped differently from your " +
					"screen leaves margins. Cover fills the screen and crops the overhang — " +
					"only comfortable when the card is already close to your screen's shape."
			)
			.addDropdown((c) =>
				c
					.addOptions({ contain: "Contain — show all of it", cover: "Cover — fill the screen" })
					.setValue(s.fit)
					.onChange(async (v) => {
						s.fit = v as FitMode;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Maximum zoom")
			.setDesc("Stops a small card from filling the screen with enormous text.")
			.addSlider((c) =>
				c.setLimits(1, 6, 0.1).setValue(s.maxScale).onChange(async (v) => {
					s.maxScale = v;
					await this.save();
				})
			);

		// ----------------------------------------------------------- look
		new Setting(containerEl).setName("Theme and background").setHeading();

		// The theme comes first because it is the only choice most decks need:
		// it carries the colours, the type, the card roles and the backdrop.
		// Everything under it is a deliberate deviation from what it says.
		new Setting(containerEl)
			.setName("Theme stylesheet")
			.setDesc(
				"The one setting that decides how a deck looks — colours, type, the card " +
					"roles, and the backdrop behind them. The same idea as an Advanced Slides " +
					"theme, but it also reaches the chrome and inside HTML cards, though a card " +
					"that styles itself still wins. Only Atlas themes are listed: an exported " +
					"reveal.js stylesheet styles nothing here. A canvas whose #deck card carries " +
					"a theme: line overrides this."
			)
			.addDropdown((c) => {
				const current = s.themeCss;
				c.addOptions({ "": "— none —" });
				c.setValue(current);
				c.onChange(async (v) => {
					s.themeCss = v;
					await this.save();
				});
				// Reading the stylesheets is the only way to know which are ours,
				// so the real list arrives a moment after the panel does.
				void this.fillThemes(c, current);
			});

		new Setting(containerEl)
			.setName("Backdrop")
			.setDesc(
				"What sits behind the cards. The theme already sets this, so leave it alone " +
					"unless you want to override what the theme chose."
			)
			.addDropdown((c) =>
				c
					.addOptions({
						theme: "Whatever the theme says",
						colour: "A solid colour",
						image: "An image from the vault",
					})
					.setValue(s.background)
					.onChange(async (v) => {
						s.background = v as BackgroundMode;
						await this.save();
						this.display();
					})
			);

		if (s.background === "colour") {
			new Setting(containerEl)
				.setName("Backdrop colour")
				.addColorPicker((c) =>
					c.setValue(s.backgroundColour).onChange(async (v) => {
						s.backgroundColour = v;
						await this.save();
					})
				);
		}

		new Setting(containerEl)
			.setName("Image folder")
			.setDesc(
				"Where the backdrop and logo pickers look. A vault of any age has " +
					"thousands of images and only a handful are backdrops — keep those in " +
					"one folder and both pickers become a shortlist. Atlas ships samples in " +
					"Atlas/Backdrops. Leave it on the whole vault to list everything."
			)
			.addDropdown((c) =>
				c
					.addOptions(this.folderChoices())
					.setValue(s.mediaFolder)
					.onChange(async (v) => {
						s.mediaFolder = v;
						await this.save();
						// Both pickers below are built from this, so they have to
						// be rebuilt rather than left showing the old vault-wide list.
						this.display();
					})
			);

		if (s.background === "image") {
			new Setting(containerEl)
				.setName("Backdrop image")
				.setDesc("A backdrop sits behind the cards, so choose something quiet.")
				.addDropdown((c) =>
					c
						.addOptions(this.imageChoices())
						.setValue(s.backgroundImage)
						.onChange(async (v) => {
							s.backgroundImage = v;
							await this.save();
						})
				);

			new Setting(containerEl)
				.setName("Darken the backdrop")
				.setDesc("Keeps slide text readable over a busy photograph.")
				.addSlider((c) =>
					c.setLimits(0, 0.9, 0.05).setValue(s.backgroundDim).onChange(
						async (v) => {
							s.backgroundDim = v;
							await this.save();
						}
					)
				);
		}

		new Setting(containerEl)
			.setName("Accent colour")
			.setDesc("Used for the current card on the map and for highlights. Blank follows your theme.")
			.addText((c) =>
				c
					.setPlaceholder("#1D5A78, or blank")
					.setValue(s.accent)
					.onChange(async (v) => {
						s.accent = v.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Off-camera cards")
			.setDesc("How visible the rest of the map stays behind the current slide. Zero hides it.")
			.addSlider((c) =>
				c.setLimits(0, 1, 0.05).setValue(s.inactiveOpacity).onChange(
					async (v) => {
						s.inactiveOpacity = v;
						await this.save();
					}
				)
			);

		// ------------------------------------------------------- branding
		new Setting(containerEl).setName("Logo").setHeading();

		new Setting(containerEl)
			.setName("Logo image")
			.setDesc("Shown on every slide, above the cards.")
			.addDropdown((c) =>
				c
					.addOptions(this.imageChoices())
					.setValue(s.logo)
					.onChange(async (v) => {
						s.logo = v;
						await this.save();
						this.display();
					})
			);

		if (s.logo) {
			new Setting(containerEl)
				.setName("Corner")
				.addDropdown((c) =>
					c
						.addOptions({
							"top-left": "Top left",
							"top-right": "Top right",
							"bottom-left": "Bottom left",
							"bottom-right": "Bottom right",
						})
						.setValue(s.logoCorner)
						.onChange(async (v) => {
							s.logoCorner = v as Corner;
							await this.save();
						})
				);

			new Setting(containerEl)
				.setName("Height")
				.setDesc("In pixels.")
				.addSlider((c) =>
					c.setLimits(16, 160, 2).setValue(s.logoHeight).onChange(
						async (v) => {
							s.logoHeight = v;
							await this.save();
						}
					)
				);

			new Setting(containerEl)
				.setName("Opacity")
				.addSlider((c) =>
					c.setLimits(0.1, 1, 0.05).setValue(s.logoOpacity).onChange(
						async (v) => {
							s.logoOpacity = v;
							await this.save();
						}
					)
				);
		}

		// --------------------------------------------------------- media
		new Setting(containerEl).setName("Pictures and media").setHeading();

		new Setting(containerEl)
			.setName("Play video on arrival")
			.setDesc("Video and audio start when their card comes on camera, and pause when it leaves.")
			.addToggle((c) =>
				c.setValue(s.autoplayMedia).onChange(async (v) => {
					s.autoplayMedia = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Slide show transition")
			.setDesc("How one image gives way to the next inside a card.")
			.addDropdown((c) =>
				c
					.addOptions({
						slide: "Slide sideways",
						"slide-up": "Slide upwards",
						fade: "Fade",
						zoom: "Zoom",
						flip: "Flip",
					})
					.setValue(s.slideshowTransition)
					.onChange(async (v) => {
						s.slideshowTransition = v as SlideshowTransition;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Slide show images")
			.setDesc(
				"Contain keeps every picture whole, leaving bars when its shape differs " +
					"from the frame. Cover fills the frame and crops the overhang."
			)
			.addDropdown((c) =>
				c
					.addOptions({ contain: "Contain — whole picture", cover: "Cover — fill the frame" })
					.setValue(s.slideshowFit)
					.onChange(async (v) => {
						s.slideshowFit = v as "contain" | "cover";
						await this.save();
					})
			);

		// ------------------------------------------------------ on screen
		new Setting(containerEl).setName("On screen").setHeading();

		new Setting(containerEl)
			.setName("Show the bottom bar")
			.setDesc("Breadcrumbs, the Map and Notes buttons, and the slide counter.")
			.addToggle((c) =>
				c.setValue(s.showHud).onChange(async (v) => {
					s.showHud = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Show the slide counter")
			.addToggle((c) =>
				c.setValue(s.showCounter).onChange(async (v) => {
					s.showCounter = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Header line")
			.setDesc(
				"A standing line above the deck, for a welcome, a presenter or a date. " +
					"Tokens: {deck} {section} {n} {total} {date}. Leave blank for none."
			)
			.addText((c) =>
				c
					.setPlaceholder("{deck} — presented by Preetesh")
					.setValue(s.headerText)
					.onChange(async (v) => {
						s.headerText = v;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Header position")
			.addDropdown((c) =>
				c
					.addOptions({ "top-left": "Top left", "top-centre": "Top centre", "top-right": "Top right" })
					.setValue(s.headerPosition)
					.onChange(async (v) => {
						s.headerPosition = v as HeaderPosition;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Show the header")
			.setDesc(
				"On a card the camera fills the screen, so a header can only overlap it. " +
					"On a section overview the space above the group is empty and a title " +
					"reads well there."
			)
			.addDropdown((c) =>
				c
					.addOptions({
						sections: "On section overviews",
						first: "On the first card only",
						always: "On every card",
					})
					.setValue(s.headerScope)
					.onChange(async (v) => {
						s.headerScope = v as HeaderScope;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Section titles")
			.setDesc(
				"Each group's name, above it and to the left, in the map's own " +
					"coordinates — so a section can be read before you enter it."
			)
			.addToggle((c) =>
				c.setValue(s.sectionTitles).onChange(async (v) => {
					s.sectionTitles = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Where a card sits")
			.setDesc(
				"A card shorter than the screen leaves space. Centre splits it top and " +
					"bottom; Top gathers it all underneath, which reads better with a header."
			)
			.addDropdown((c) =>
				c
					.addOptions({ centre: "Centred", top: "Towards the top" })
					.setValue(s.verticalAlign)
					.onChange(async (v) => {
						s.verticalAlign = v as VerticalAlign;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Show what is next")
			.setDesc("The title of the card the next press will take you to.")
			.addToggle((c) =>
				c.setValue(s.showNext).onChange(async (v) => {
					s.showNext = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Progress rail")
			.setDesc("A thin line across the top, ticked where each section begins.")
			.addToggle((c) =>
				c.setValue(s.showProgress).onChange(async (v) => {
					s.showProgress = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Timer")
			.setDesc("Elapsed time since the deck opened, the wall clock, or both.")
			.addDropdown((c) =>
				c
					.addOptions({
						off: "Off",
						elapsed: "Elapsed",
						clock: "Time of day",
						both: "Both",
					})
					.setValue(s.timer)
					.onChange(async (v) => {
						s.timer = v as TimerMode;
						await this.save();
					})
			);

		new Setting(containerEl).setName("Notes and minutes").setHeading();

		new Setting(containerEl)
			.setName("Where minutes are filed")
			.setDesc(
				"Press N while presenting to note something against the card on screen. "
					+ "The write-up lands here, one note per session."
			)
			.addText((c) =>
				c
					.setPlaceholder("Meetings")
					.setValue(s.minutesFolder)
					.onChange(async (v) => {
						s.minutesFolder = v.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Write up on leaving")
			.setDesc(
				"When you noted something during a talk, leaving the deck writes the "
					+ "minutes. Turn this off to write them only with W."
			)
			.addToggle((c) =>
				c.setValue(s.minutesOnExit).onChange(async (v) => {
					s.minutesOnExit = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Include the cards' own notes")
			.setDesc(
				"Put each card's %%notes%% into the write-up as well as what you typed " +
					"during the talk. Off by default: those are your prompts — “they will " +
					"ask about the survey” — and minutes get sent round."
			)
			.addToggle((c) =>
				c.setValue(s.minutesIncludeNotes).onChange(async (v) => {
					s.minutesIncludeNotes = v;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Append to every action")
			.setDesc(
				"Added to each line you type beginning - [ ]. A tag the Tasks plugin can "
				+ "query, a person, or a due date in whatever syntax you already use."
			)
			.addText((c) =>
				c
					.setPlaceholder("#meeting")
					.setValue(s.actionSuffix)
					.onChange(async (v) => {
						s.actionSuffix = v.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Name the card on each action")
			.setDesc("So an action still says what it came out of once it has moved.")
			.addToggle((c) =>
				c.setValue(s.actionsLinkBack).onChange(async (v) => {
					s.actionsLinkBack = v;
					await this.save();
				})
			);

		// ------------------------------------------------------ browsing
		new Setting(containerEl).setName("Browsing the vault").setHeading();

		new Setting(containerEl)
			.setName("What G opens")
			.setDesc(
				"Obsidian's graph view is the real thing — filters, groups, forces, " +
					"local graph. The deck steps aside for it and shows a way back. The " +
					"built-in one stays inside the presentation and never leaves fullscreen."
			)
			.addDropdown((c) =>
				c
					.addOptions({
						obsidian: "Obsidian's graph view",
						builtin: "The built-in graph, inside the deck",
					})
					.setValue(s.browser)
					.onChange(async (v) => {
						s.browser = v as BrowserMode;
						await this.save();
					})
			);

		// ------------------------------------------------------- exporting
		new Setting(containerEl).setName("Exporting").setHeading();

		new Setting(containerEl)
			.setName("Open the file after exporting")
			.setDesc(
				"Obsidian will not render an HTML file, so an export you are not shown " +
					"is a path you have to go and find. The file is always written to the " +
					"same place and always replaces what was there, so opening it costs " +
					"nothing."
			)
			.addToggle((c) =>
				c.setValue(s.openExport).onChange(async (v) => {
					s.openExport = v;
					await this.save();
				})
			);

		// --------------------------------------------------- html cards
		new Setting(containerEl).setName("HTML cards").setHeading();

		new Setting(containerEl)
			.setName("Run scripts in HTML cards")
			.setDesc(
				"A card written as HTML can carry a <script> — a toggle, a chart, an " +
					"animation. That runs JavaScript stored in your vault, so it is off " +
					"until you turn it on. Cards still render either way."
			)
			.addToggle((c) =>
				c.setValue(s.allowScripts).onChange(async (v) => {
					s.allowScripts = v;
					await this.save();
				})
			);

		renderReference(containerEl);
	}

}
