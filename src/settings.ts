import { App, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type AtlasPlugin from "./main";
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

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

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
	private imageChoices(): Record<string, string> {
		const out: Record<string, string> = { "": "— none —" };
		for (const file of this.app.vault.getFiles()) {
			if (file instanceof TFile && IMAGE_EXT.test(file.path)) out[file.path] = file.path;
		}
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
			Mod: navigator.platform.startsWith("Mac") ? "Cmd" : "Ctrl",
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

	/** Stylesheets in the vault, so a theme is picked rather than typed. */
	private cssChoices(): Record<string, string> {
		const out: Record<string, string> = { "": "— none —" };
		for (const file of this.app.vault.getFiles()) {
			if (file.extension === "css") out[file.path] = file.path;
		}
		return out;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// --------------------------------------------------------- shortcut
		new Setting(containerEl).setName("Starting a presentation").setHeading();

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
				c.setLimits(0, 2000, 50).setValue(s.duration).setDynamicTooltip().onChange(async (v) => {
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
				c.setLimits(0, 0.4, 0.01).setValue(s.padding).setDynamicTooltip().onChange(async (v) => {
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
				c.setLimits(1, 6, 0.1).setValue(s.maxScale).setDynamicTooltip().onChange(async (v) => {
					s.maxScale = v;
					await this.save();
				})
			);

		// ----------------------------------------------------------- look
		new Setting(containerEl).setName("Background").setHeading();

		new Setting(containerEl)
			.setName("Backdrop")
			.setDesc("What sits behind the cards.")
			.addDropdown((c) =>
				c
					.addOptions({
						theme: "Follow the Obsidian theme",
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

		if (s.background === "image") {
			new Setting(containerEl)
				.setName("Backdrop image")
				.setDesc("Any image in the vault.")
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
					c.setLimits(0, 0.9, 0.05).setValue(s.backgroundDim).setDynamicTooltip().onChange(
						async (v) => {
							s.backgroundDim = v;
							await this.save();
						}
					)
				);
		}

		new Setting(containerEl)
			.setName("Theme stylesheet")
			.setDesc(
				"A .css file in your vault, applied to every deck — the same idea as an " +
					"Advanced Slides theme. It reaches markdown cards, the chrome, and inside " +
					"HTML cards too, though a card that styles itself still wins."
			)
			.addDropdown((c) =>
				c
					.addOptions(this.cssChoices())
					.setValue(s.themeCss)
					.onChange(async (v) => {
						s.themeCss = v;
						await this.save();
					})
			);

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
				c.setLimits(0, 1, 0.05).setValue(s.inactiveOpacity).setDynamicTooltip().onChange(
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
					c.setLimits(16, 160, 2).setValue(s.logoHeight).setDynamicTooltip().onChange(
						async (v) => {
							s.logoHeight = v;
							await this.save();
						}
					)
				);

			new Setting(containerEl)
				.setName("Opacity")
				.addSlider((c) =>
					c.setLimits(0.1, 1, 0.05).setValue(s.logoOpacity).setDynamicTooltip().onChange(
						async (v) => {
							s.logoOpacity = v;
							await this.save();
						}
					)
				);
		}

		// ---------------------------------------------------- slide shows
		new Setting(containerEl).setName("Slide shows").setHeading();

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
			.setName("Speaker notes on screen")
			.setDesc(
				"Show a card's %%notes%% under it while presenting. For a single screen — " +
					"with a second screen you would rather leave this off."
			)
			.addToggle((c) =>
				c.setValue(s.showNotes).onChange(async (v) => {
					s.showNotes = v;
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

		new Setting(containerEl).setName("Chrome").setHeading();

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
			.setName("Play video on arrival")
			.setDesc("Video and audio start when their card comes on camera, and pause when it leaves.")
			.addToggle((c) =>
				c.setValue(s.autoplayMedia).onChange(async (v) => {
					s.autoplayMedia = v;
					await this.save();
				})
			);

		this.reference(containerEl);
	}

	/**
	 * The authoring reference.
	 *
	 * None of this syntax is discoverable from the canvas editor, so it belongs
	 * where someone will look for it rather than in a README they never opened.
	 */
	private reference(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Writing cards").setHeading();

		const note = containerEl.createDiv({ cls: "atl-ref-lead" });
		note.setText(
			"Everything below is written on the canvas itself — in a card, on an edge, " +
				"or as a group. Nothing here needs a plugin setting turned on."
		);

		const section = (title: string) =>
			containerEl.createDiv({ cls: "atl-ref-section" }).createEl("h4", { text: title })
				.parentElement as HTMLElement;

		const entry = (host: HTMLElement, name: string, desc: string, code?: string) => {
			const row = host.createDiv({ cls: "atl-ref" });
			row.createDiv({ cls: "atl-ref-name", text: name });
			row.createDiv({ cls: "atl-ref-desc", text: desc });
			if (code === undefined) return;
			const box = row.createDiv({ cls: "atl-ref-code" });
			box.createEl("pre", { text: code });
			const copy = box.createEl("button", { cls: "atl-ref-copy", text: "Copy" });
			copy.addEventListener("click", async () => {
				await navigator.clipboard.writeText(code);
				copy.setText("Copied");
				window.setTimeout(() => copy.setText("Copy"), 1200);
			});
		};

		// ------------------------------------------------- on the canvas
		const canvas = section("On the canvas");

		entry(canvas, "Arrows set the order",
			"The deck follows the arrows between cards, depth first — a branch is told " +
				"to its end before the next one starts.");

		entry(canvas, "Numbered edge labels",
			"Label an arrow with a leading number to force the running order. Unlabelled " +
				"arrows fall back to the position of the card they point at.",
			`1.
2.
3. then this one`);

		entry(canvas, "Groups are sections",
			"Put cards inside a Canvas group and the camera frames the whole group on the " +
				"way in, then dives to its first card. The group name shows in the " +
				"breadcrumb and on the map.");

		entry(canvas, "No arrows at all",
			"A canvas with no edges still presents: cards run top to bottom, left to right.");

		entry(canvas, "Choosing the first card",
			"The start is the card with arrows out and none in. To override it, put #start " +
				"anywhere in a card.",
			"#start");

		entry(canvas, "Cards nothing points to",
			"Still part of the deck and still on the map. Press M and click one to fly " +
				"there, Backspace to come back. This is the card you keep for a question " +
				"you expect.");

		entry(canvas, "Canvas colours",
			"The colour you give a card in the editor is mirrored on the map, so a colour " +
				"can mean 'skip this in the short version'.");

		entry(canvas, "A section of a note",
			"Drop a note on the canvas, then set the card's link to a heading. Only that " +
				"section is presented.",
			"Note.md#Some heading");

		// ------------------------------------------------- inside a card
		const card = section("Inside a card");

		entry(card, "Reveals",
			"A line of three plus signs splits the card into steps. → shows the next one, " +
				"and only moves to the following card once they are all out.",
			`The claim.

+++

The evidence.

+++

The conclusion.`);

		entry(card, "Speaker notes",
			"Anything between double percent signs is stripped before the card is drawn. " +
				"Use it for the thing you meant to say.",
			"%%Slow down here. Ask whether anyone has seen the report.%%");

		entry(card, "Read a linked note",
			"Click a wikilink while presenting and the whole note opens over the slide. " +
				"Wheel or ↓ to scroll it, Esc to land back on the same slide.",
			"See [[Controls Plan]] for the detail.");

		entry(card, "Images",
			"Obsidian embeds work, and so does a plain img tag with a vault path.",
			"![[site-photo.png]]");

		entry(card, "Several images at once",
			"A gallery lays them out side by side, all visible together.",
			`<div class="atl-gallery">
` +
				`  <img src="Ref Images/a.png">
` +
				`  <img src="Ref Images/b.png">
` +
				"</div>");

		entry(card, "A column you scroll",
			"Stacked full width, one under the next. The card scrolls through them, "
				+ "so \u2192 walks down the pictures before moving on.",
			'<div class="atl-scroll">\n'
				+ '  <img src="Ref Images/a.png">\n'
				+ '  <img src="Ref Images/b.png">\n'
				+ "</div>");

		entry(card, "A slide show in one card",
			"The same images stacked instead. → steps through them without the camera " +
				"moving. Better than four cards when it is one idea.",
			`<div class="atl-slideshow">
` +
				`  <img src="Ref Images/a.png">
` +
				`  <img src="Ref Images/b.png">
` +
				"</div>");

		entry(card, "Excalidraw drawings",
			"A drawing is stored as markdown with its JSON inside, so it needs the "
				+ "Excalidraw plugin to become a picture. Drop the drawing on the canvas, "
				+ "or embed it — either way it renders as the drawing, not the file.",
			"![[Drawing 2026-01-14.excalidraw]]");

		entry(card, "Video and audio",
			"Drop the file on the canvas, or embed it. It starts when the camera arrives " +
				"and pauses when it leaves. Audio saved as .webm shows as a player bar.",
			"![[walkthrough.mp4]]");

		entry(card, "A card longer than the screen",
			"Just keep writing. The card scrolls a screenful per press and moves on when " +
				"it reaches the bottom — one long thought stays one card.");

		// ------------------------------------------------- html
		const html = section("Writing a card as HTML");

		entry(html, "A styled card",
			"Its CSS is sealed into a shadow root, so it cannot leak into the rest of the " +
				"deck and the deck cannot reach in. A .html file dropped on the canvas " +
				"behaves the same way.",
			`\`\`\`slide-html
` +
				`<style>
` +
				`  .hero { display: grid; place-items: center; height: 100%;
` +
				`          background: #141a2e; color: #e9ecf5; }
` +
				`</style>
` +
				`<div class="hero"><h1>Anything you like</h1></div>
` +
				"```");

		entry(html, "Reveals in HTML",
			"Give any element the class step and it becomes a reveal, in document order.",
			'<div class="step">appears on the next press</div>');

		entry(html, "Interactive cards",
			"Script tags run, so a card can hold a toggle, a chart or an animation. " +
				"Clicking a control does not advance the slide.");

		entry(html, "Pausing an animation",
			"A card that animates should stop when it is off camera. Listen on the shadow " +
				"host for these two events.",
			`const root = document.currentScript.getRootNode();
` +
				`root.host.addEventListener('atlas:enter', start);
` +
				"root.host.addEventListener('atlas:leave', stop);");

		// ------------------------------------------------- keys
		const keys = section("Keys while presenting");
		for (const [k, what] of [
			["→  Space  PageDown", "reveal, then scroll, then the next card"],
			["←  PageUp", "back the same way"],
			["M", "the map of this canvas — click any card to fly to it"],
			["G", "the graph of the whole vault"],
			["Backspace", "return from a jump, or one level out of a peeked note"],
			["O", "zoom out to the whole map"],
			["Home  End", "first and last card"],
			["F", "fullscreen"],
			["Esc", "close the map or the note, then leave the deck"],
		] as [string, string][]) {
			const row = keys.createDiv({ cls: "atl-ref atl-ref-key" });
			row.createDiv({ cls: "atl-ref-name", text: k });
			row.createDiv({ cls: "atl-ref-desc", text: what });
		}
	}
}
