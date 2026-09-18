import {
	App,
	Component,
	Notice,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import { isElement } from "../dom";
import { AtlasSettings, CanvasNode, Rect, Scene, Stop } from "../types";
import { hhmm, mmss, safeFileName } from "../format";
import { fileAt, readFileAt } from "../vault";
import { AUDIO_EXT } from "../media";
import { parseCanvas, rectOf } from "../canvas/parse";
import { buildScene, readDeckVariant } from "../canvas/path";
import { Camera } from "./camera";
import { Minimap } from "./minimap";
import { Peek } from "./peek";
import { Browser } from "./browse";
import {
	buildSteps,
	renderNode,
	resourcePath,
	slideshowsIn,
	speakerNotes,
	titleOf,
} from "./render";
import { Slideshow } from "./slideshow";
import { ExportInput, buildDeckHtml, exportDeck } from "./export";
import { DeckSnapshot, PRESENTER_VIEW, setDeck } from "./presenter";
import { DECK_VIEW, DeckView } from "./deck-window";
import {
	Capture,
	MinutesOptions,
	ReviewPanel,
	Session,
	Visit,
	writeMinutes,
} from "./capture";
import { Clip, Recorder, transcribe } from "./recorder";
import { Journal } from "./journal";
import { DeckNotes, capturesFrom, readDeckNotes, saveDeckNotes } from "./deck-notes";
import {
	askBest,
	chooseNotes,
	Passage,
	findPassages,
	hasModel,
	isLocal,
	scopeOf,
	searchTerms,
	verify,
} from "../ask";
import { fail, say } from "../notice";

/**
 * Anything that handles its own clicks must not also advance the slide.
 *
 * `label` and `summary` belong here for the same reason as `button`: clicking a
 * details toggle, or a checkbox by its label, is a click the card is answering,
 * and answering it twice — once in the card and once as "next" — is wrong. The
 * exported deck is held to the same list.
 */
const INTERACTIVE =
	"a, button, video, audio, iframe, input, textarea, select, label, summary, .atl-hud";

export class Presentation extends Component {
	private overlay!: HTMLElement;
	private stage!: HTMLElement;
	private camera!: Camera;
	private minimap!: Minimap;
	private peek!: Peek;
	private browser!: Browser;
	private hud!: HTMLElement;
	private nextEl: HTMLElement | null = null;
	private railFill: HTMLElement | null = null;
	private timerEl: HTMLElement | null = null;
	private notes = new Map<string, string>();
	private began = 0;
	private ticker = 0;
	/** Anything following along — the presenter window, today. */
	private listeners = new Set<() => void>();
	/**
	 * The window the deck is drawn in.
	 *
	 * The main Obsidian window by default. When the deck is presented into its
	 * own window these point at that one instead, and the main window is left
	 * entirely alone — still on the canvas, still yours to work in.
	 */
	private doc: Document = document;
	private win: Window = window;
	private deckLeaf: WorkspaceLeaf | null = null;
	/** The tab's own container, which the overlay is built inside. */
	private host: HTMLElement | null = null;
	/**
	 * Built to be read, not driven.
	 *
	 * The export is a clone of the live stage, so producing one has always
	 * needed a deck on screen. A headless deck renders into a host element the
	 * caller supplies — off to one side, laid out but not looked at — so a
	 * canvas can be exported without being presented first. It takes no keys,
	 * registers no deck for the presenter window and starts no timers.
	 */
	private headless: HTMLElement | null = null;
	private presenterLeaf: WorkspaceLeaf | null = null;
	/** The talk as it actually happened, detours included. */
	private visits: Visit[] = [];
	private captures: Capture[] = [];
	/** The deck's own note file, read at the start and written back on W. */
	private deckNotes: DeckNotes | null = null;
	/** Set while the note box owns the keyboard. */
	private capturing = false;
	private written = false;
	/** A blanked screen, and the unattended-run timer. */
	private blanked = false;
	private autoAdvance = 0;
	/** A sub-deck opened from a card, and the deck it was opened from. */
	private child: Presentation | null = null;
	private onReturn: (() => void) | null = null;
	private scene!: Scene;

	private index = 0;
	/** Detours pushed by minimap jumps, so Backspace always gets you home. */
	private history: number[] = [];
	private nodeEls = new Map<string, HTMLElement>();
	private steps = new Map<string, HTMLElement[]>();
	private shows = new Map<string, Slideshow[]>();
	private stepIndex = 0;
	private onKey!: (e: KeyboardEvent) => void;
	private onResize!: () => void;
	/** Set while Obsidian's own graph view has the screen. */
	private away = false;
	private awayLeaf: WorkspaceLeaf | null = null;
	private returnBar: HTMLElement | null = null;

	/** A CSS file from the vault, applied to the whole deck. */
	private themeCss = "";
	/** Whether the theme came from this canvas's #deck card or from Settings. */
	private themeFromDeck = false;
	/**
	 * A backdrop written on the #deck card, as raw CSS.
	 *
	 * Not a setting, because it is per-canvas the way `theme:` is: the theme
	 * carries the default and one line on the card overrides it. Anything CSS
	 * accepts as a background works — a colour, a gradient, a stack of them.
	 */
	private deckBackdrop = "";

	constructor(
		private app: App,
		private file: TFile,
		private settings: AtlasSettings,
		/** Card to open on, when starting from a selection in the editor. */
		private startNodeId?: string,
		/** Which talk to give, when the canvas offers more than one. */
		private variant = ""
	) {
		super();
	}

	/** Render without presenting, for an export or a preview. */
	async startHeadless(host: HTMLElement): Promise<boolean> {
		this.headless = host;
		this.doc = host.ownerDocument;
		this.win = host.ownerDocument.defaultView ?? window;
		await this.start();
		return this.scene !== undefined && this.scene.stops.length > 0;
	}

	async start(): Promise<void> {
		const data = parseCanvas(await this.app.vault.cachedRead(this.file));
		// A canvas may name its own default talk; an explicit choice wins.
		const declared = readDeckVariant(data);
		this.variant = this.variant || declared;
		this.scene = buildScene(data, this.settings.sectionOverviews, this.variant);
		if (this.scene.stops.length === 0) {
			if (!this.headless) new Notice("Atlas: this canvas has no cards to present.");
			return;
		}

		// A canvas may dress itself, so the deck's own keys land before
		// anything reads a setting.
		// Two title blocks on one canvas is a mistake, not a feature, and it used
		// to be a silent one: the extras were hidden from the deck like the first,
		// so nothing happened and nothing said why.
		const decks = Number(this.scene.meta.__decks ?? "1");
		if (decks > 1 && !this.headless) {
			new Notice(
				`Atlas: this canvas has ${decks} #deck cards. The topmost one is used; ` +
					"the rest are ignored and stay off the deck.",
				9000
			);
		}

		this.settings = this.withDeckOverrides(this.settings);
		this.themeCss = await this.loadThemeCss();
		await this.collectNotes();
		this.buildChrome();
		await this.buildStage();

		this.peek = new Peek(this.overlay, this.app, this);
		this.browser = new Browser(this.overlay, this.app, (file) => void this.peek.showFile(file));
		this.minimap = new Minimap(this.overlay, this.app, this.scene, (i) => this.jumpTo(i));
		this.began = Date.now();
		// What was said about these cards last time.
		//
		// Read before anything can be typed, so pressing N on a card opens with
		// the words already there rather than blank — and so the dot shows on
		// every card that carries one, from the first slide.
		//
		// Read for a headless deck too, which is how a canvas is exported
		// without being presented: the write-up that travels beside the export
		// is made of exactly these, and exporting from the canvas produced a
		// deck with no remarks at all — the one way anybody would do it.
		if (this.settings.deckNotes) {
			this.deckNotes = await readDeckNotes(this.app, this.file);
			this.captures = capturesFrom(this.deckNotes, this.began);
		}

		if (this.headless) {
			// Everything past this point is about being driven by someone.
			this.goTo(this.startIndex(), { animate: false });
			return;
		}

		// From here on, nothing typed or recorded is only in memory.
		this.journal = new Journal(this.app, this.settings.minutesFolder || "Meetings", {
			deck: this.file.basename,
			deckPath: this.file.path,
			variant: this.variant,
			startedAt: this.began,
			updatedAt: this.began,
			visits: [],
			captures: [],
			prepared: {},
		});

		setDeck(this);
		await this.openPresenterPanel();
		this.startAutoAdvance();
		this.goTo(this.startIndex(), { animate: false });
		this.bindKeys();

		// Name the card we opened on, so a wrong start is visible rather than
		// puzzling — the canvas selection API is not public and can drift.
		const opening = this.stopAt(this.startIndex());
		const talk = this.variant ? ` · ${this.variant}` : "";
		const where =
			this.startNodeId && opening.node.id === this.startNodeId
				? `starting on “${titleOf(opening.node)}”`
				: `${this.cardTotal} cards${talk}`;
		new Notice(
			`Atlas · ${where}\n` +
				"Drag this tab to another screen if you want it there · F fullscreen\n" +
				"→ advances · O the overview · M the map · Esc leaves\n" +
				"N notes · R speaks one · Shift+R records the meeting · W writes it up · E exports",
			8000
		);
	}

	/**
	 * Let the #deck card override the look for this canvas alone.
	 *
	 * A client deck and an internal deck want different branding, and neither
	 * author should have to go into plugin settings to get it.
	 */
	private withDeckOverrides(base: AtlasSettings): AtlasSettings {
		const m = this.scene.meta;
		if (Object.keys(m).length === 0) return base;
		const next = { ...base };
		const num = (v: string | undefined, fallback: number) => {
			const parsed = Number(v);
			return Number.isFinite(parsed) ? parsed : fallback;
		};

		if (m.theme) {
			next.themeCss = m.theme;
			this.themeFromDeck = true;
		}
		if (m.backdrop) this.deckBackdrop = m.backdrop;
		if (m.logo) next.logo = m.logo;
		if (m.logocorner) next.logoCorner = m.logocorner as AtlasSettings["logoCorner"];
		if (m.logoheight) next.logoHeight = num(m.logoheight, base.logoHeight);
		if (m.accent) next.accent = m.accent;
		if (m.background) next.background = m.background as AtlasSettings["background"];
		if (m.colour) {
			next.background = "colour";
			next.backgroundColour = m.colour;
		}
		if (m.image) {
			next.background = "image";
			next.backgroundImage = m.image;
		}
		if (m.dim) next.backgroundDim = num(m.dim, base.backgroundDim);
		if (m.align) next.verticalAlign = m.align as AtlasSettings["verticalAlign"];
		if (m.fit) next.fit = m.fit as AtlasSettings["fit"];
		if (m.transition) {
			next.slideshowTransition = m.transition as AtlasSettings["slideshowTransition"];
		}
		// `header on: no` still turns the line off, which is what anyone who
		// wrote the old key meant by it.
		if (m.headeron) next.showHeader = !/^(no|off|never|false)$/i.test(m.headeron);
		return next;
	}

	private async loadThemeCss(): Promise<string> {
		const path = this.settings.themeCss;
		if (!path) return "";
		const file = fileAt(this.app, path);
		if (!file) {
			// Naming where the path came from is the whole message. A theme set
			// in Settings looks correct there while a stale line on the canvas
			// quietly wins, and the old notice named the path but never which of
			// the two had asked for it.
			const source = this.themeFromDeck ? "this canvas's #deck card" : "Settings";
			new Notice(`Atlas: theme file not found — ${path}, asked for by ${source}.`, 9000);
			return "";
		}
		const css = await this.app.vault.cachedRead(file);
		// A stylesheet with none of our class names is almost always a reveal.js
		// theme picked out of an export folder, and will do nothing at all.
		if (css && !css.includes(".atl-")) {
			new Notice(
				`Atlas: ${file.name} has no Atlas selectors in it, so it will not ` +
					"change anything. Try Atlas/Themes/Paper.css.",
				9000
			);
		}
		return css;
	}

	/** Open on the card that was selected in the canvas, when there was one. */
	private startIndex(): number {
		if (!this.startNodeId) return 0;
		const i = this.scene.stops.findIndex(
			(s) => s.kind === "node" && s.node.id === this.startNodeId
		);
		return i >= 0 ? i : 0;
	}

	/** Everything the settings panel controls about how the deck looks. */
	/**
	 * The vault's theme, adopted rather than put in a <style> element.
	 *
	 * A theme is a CSS file chosen at runtime, so it cannot live in styles.css —
	 * but the guidelines ask us not to add style elements to the document, and a
	 * constructed stylesheet is the same CSS without one. Every rule in it is
	 * scoped to .atl-overlay, so adopting it into the document affects nothing
	 * outside the deck; it is dropped again when the deck stops.
	 */
	private themeSheet: CSSStyleSheet | null = null;

	private adoptTheme(): void {
		if (!this.themeCss) return;
		try {
			const sheet = new (this.win as unknown as { CSSStyleSheet: typeof CSSStyleSheet })
				.CSSStyleSheet();
			sheet.replaceSync(this.themeCss);
			this.doc.adoptedStyleSheets = [...this.doc.adoptedStyleSheets, sheet];
			this.themeSheet = sheet;
		} catch {
			// No constructable stylesheets here: the deck runs on the plugin's
			// own rules, unthemed, rather than not running.
		}
	}

	private dropTheme(): void {
		const sheet = this.themeSheet;
		this.themeSheet = null;
		if (!sheet) return;
		this.doc.adoptedStyleSheets = this.doc.adoptedStyleSheets.filter((s) => s !== sheet);
	}

	private applyTheme(): void {
		const s = this.settings;
		this.overlay.style.setProperty("--atl-inactive", String(s.inactiveOpacity));
		// The section name used to be a floating overlay; it now lives on the
		// group itself, so this is what the setting governs.
		this.overlay.toggleClass("hide-sections", !s.sectionTitles);
		if (s.accent) this.overlay.style.setProperty("--atl-accent", s.accent);

		// The token the stylesheet already reads, set inline so it beats the
		// theme's own value. An explicit colour or image below still wins, since
		// choosing one of those is a more specific thing to have asked for.
		if (this.deckBackdrop) this.overlay.style.setProperty("--backdrop", this.deckBackdrop);

		if (s.background === "colour") {
			this.overlay.style.background = s.backgroundColour;
		} else if (s.background === "image" && s.backgroundImage) {
			const url = resourcePath(this.app, s.backgroundImage);
			this.overlay.style.backgroundImage = `url("${url}")`;
			this.overlay.addClass("has-image");
			// A dim layer keeps slide text readable over an arbitrary photo.
			this.overlay.style.setProperty("--atl-dim", String(s.backgroundDim));
		}

		// Several, separated by commas: a joint venture, a client mark beside
		// your own, a funder. One is by far the common case and reads as one.
		const logos = s.logo
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean);
		if (logos.length > 0) {
			const row = this.overlay.createDiv({ cls: "atl-logos" });
			row.dataset.corner = s.logoCorner;
			row.setCssStyles({ opacity: String(s.logoOpacity) });
			// Through a custom property rather than straight onto the element,
			// so the banner can show the same logo larger without fighting an
			// inline style.
			row.style.setProperty("--atl-logo-height", `${s.logoHeight}px`);
			for (const path of logos) {
				const logo = row.createEl("img", { cls: "atl-logo" });
				logo.src = resourcePath(this.app, path);
				logo.style.height = "var(--atl-logo-height)";
			}
		}
	}

	private buildChrome(): void {
		this.overlay = (this.headless ?? this.host ?? this.doc.body).createDiv({
			cls: "atl-overlay",
		});
		// Inside a tab the overlay fills the tab, not the window.
		if (this.host && !this.headless) this.overlay.addClass("is-embedded");
		this.adoptTheme();
		this.applyTheme();
		const viewport = this.overlay.createDiv({ cls: "atl-viewport" });
		this.stage = viewport.createDiv({ cls: "atl-stage" });
		this.camera = new Camera(this.stage, viewport, {
			padding: this.settings.padding,
			maxScale: this.settings.maxScale,
			fit: this.settings.fit,
			align: this.settings.verticalAlign,
		});

		if (this.settings.showProgress) {
			const rail = this.overlay.createDiv({ cls: "atl-rail" });
			this.railFill = rail.createDiv({ cls: "atl-rail-fill" });
			// A tick wherever a new section starts, so the rail reads as chapters
			// rather than one undifferentiated bar.
			this.scene.stops.forEach((stop, i) => {
				if (stop.kind !== "group") return;
				const tick = rail.createDiv({ cls: "atl-rail-tick" });
				tick.style.left = `${(i / Math.max(1, this.scene.stops.length - 1)) * 100}%`;
			});
		}
		// No notes band. Speaker notes live in the presenter panel and nowhere
		// else: the panel opens itself with every deck, so the setting that used
		// to put them on the slide could never fire again — a switch that cannot
		// do anything is worse than no switch, because it reads like a promise.
		if (this.settings.showNext) {
			const band = this.overlay.createDiv({ cls: "atl-band" });
			this.nextEl = band.createDiv({ cls: "atl-next" });
		}

		this.hud = this.overlay.createDiv({ cls: "atl-hud" });
		this.hud.toggleClass("is-hidden", !this.settings.showHud);
		this.hud.createDiv({ cls: "atl-crumbs" });

		const right = this.hud.createDiv({ cls: "atl-hud-right" });

		/**
		 * One button on the bar.
		 *
		 * A key nobody can guess needs a control they can see, and there are now
		 * six of them — so they are grouped by what they are for rather than
		 * lined up as one undifferentiated row: look at the deck, put something
		 * into it, finish with it.
		 */
		const button = (
			into: HTMLElement,
			text: string,
			key: string,
			label: string,
			onClick: () => void
		): HTMLButtonElement => {
			const btn = into.createEl("button", { cls: "atl-map-btn" });
			btn.createSpan({ cls: "atl-btn-key", text: key });
			btn.createSpan({ cls: "atl-btn-text", text });
			btn.setAttribute("aria-label", `${label} (${key})`);
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick();
			});
			return btn;
		};

		// Looking at the deck.
		const look = right.createDiv({ cls: "atl-btns" });
		button(look, "Map", "M", "Open the map", () => this.minimap.toggle());
		button(look, "Notes", "G", "Browse every note in the vault", () => {
			if (this.settings.browser === "obsidian") void this.openVaultGraph();
			else this.browser.toggle();
		});

		// Putting something into it. Grouped because in a meeting these three
		// are the ones you reach for without looking.
		const take = right.createDiv({ cls: "atl-btns" });
		button(take, "Remark", "N", "Note something against this card", () =>
			this.captureNote()
		);
		button(take, "Speak", "R", "Speak a note against this card", () =>
			void this.dictateNote()
		);
		this.recordBtn = button(take, "Record", "⇧R", "Record the whole meeting", () =>
			void this.toggleSessionRecording()
		);

		// Finishing.
		const end = right.createDiv({ cls: "atl-btns" });
		// Only when there is a model to ask. Everything else on this bar works
		// for everyone; this one would not.
		if (hasModel(this.settings)) {
			button(end, "Ask", "A", "Ask your notes a question", () => this.askNotes());
		}
		button(end, "Write up", "W", "Write the session up as a note", () =>
			this.reviewSession()
		);
		// E has always done this; nothing said so, which is the same as not
		// having it. The one thing on this bar that leaves the vault.
		button(end, "Export", "E", "Export this deck to a folder you can send", () =>
			void this.exportToHtml()
		);

		if (this.settings.timer !== "off") {
			this.timerEl = right.createDiv({ cls: "atl-timer" });
			this.began = Date.now();
			this.tickClock();
			this.ticker = window.setInterval(() => this.tickClock(), 1000);
		}

		const counter = right.createDiv({ cls: "atl-counter" });
		counter.toggleClass("is-hidden", !this.settings.showCounter);

		// Wikilinks open the note in place rather than navigating Obsidian
		// underneath the deck, which would leave you somewhere else on exit.
		this.stage.addEventListener("click", (e) => {
			// A link to the web used to send you out of the talk: Obsidian hands
			// it to the system browser, the deck is left behind, and getting back
			// means finding the window again. It opens over the deck instead.
			const site = this.matchInPath(e, "a.external-link, a[href^='http']");
			if (site) {
				e.preventDefault();
				e.stopPropagation();
				const href = site.getAttr("href");
				if (href) this.openSite(href);
				return;
			}

			const link = this.matchInPath(e, "a.internal-link");
			if (!link) return;
			e.preventDefault();
			e.stopPropagation();
			const href = link.getAttr("href") ?? link.innerText;
			if (href) void this.peek.show(href, this.file.path);
		});

		viewport.addEventListener("click", (e) => {
			if (this.minimap?.isOpen || this.peek?.isOpen || this.browser?.isOpen) return;
			// In the overview the whole map is on screen and readable, so a click
			// means "that one" rather than "next".
			if (this.overviewing) {
				e.preventDefault();
				e.stopPropagation();
				// The click that ends a drag is not a choice of card.
				if (this.dragged?.()) return;
				const card = this.matchInPath(e, "[data-node-id]");
				const id = card?.dataset.nodeId;
				const at = id ? this.scene.stops.findIndex((s) => s.node.id === id) : -1;
				this.closeOverview(at >= 0 ? at : undefined);
				return;
			}
			if (this.matchInPath(e, INTERACTIVE)) return;
			// Acting on an event means owning it: anything left to travel reaches
			// the app behind the deck.
			e.preventDefault();
			e.stopPropagation();
			// Measured on the deck, not the window. In a tab the overlay starts
			// after the sidebars and the tab bar, so splitting the window put the
			// boundary at about a sixth of the deck rather than a third — and the
			// presenter panel, which opens itself, made it worse.
			const box = this.overlay.getBoundingClientRect();
			if (e.clientX - box.left > box.width / 3) this.advance();
			else this.retreat();
		});
	}

	private async buildStage(): Promise<void> {
		// Groups first so they sit behind the cards they contain.
		for (const [i, g] of this.scene.groups.entries()) {
			const el = await renderNode(
				this.app,
				this,
				this.stage,
				g,
				this.file.path,
				this.themeCss,
				this.settings.allowScripts
			);
			// Which section this is, so a theme can give each one its own colour.
			// CSS has no way to count siblings by section, and a deck of eight
			// sections wants eight colours rather than one accent repeated.
			// Cycles at six: a palette longer than that stops reading as a set.
			el.style.setProperty("--group-i", String((i % 6) + 1));
			el.style.setProperty("--section", `var(--section-${(i % 6) + 1}, var(--atl-accent))`);
			this.nodeEls.set(g.id, el);
		}
		for (const n of this.scene.slides) {
			const el = await renderNode(
				this.app,
				this,
				this.stage,
				n,
				this.file.path,
				this.themeCss,
				this.settings.allowScripts,
				this.scene.groupOf.get(n.id)?.label
			);
			// A card is positioned on the stage, not nested inside its group's
			// box, so the section colour cannot be inherited — it is stamped on
			// each card the same way.
			const group = this.scene.groupOf.get(n.id);
			const at = group ? this.scene.groups.findIndex((g) => g.id === group.id) : -1;
			if (at >= 0) {
				el.style.setProperty("--group-i", String((at % 6) + 1));
				el.style.setProperty("--section", `var(--section-${(at % 6) + 1}, var(--atl-accent))`);
			}
			this.nodeEls.set(n.id, el);
			// The banner is marked on the card, not only on the overlay while it
			// happens to be on screen. The rules that centre its panes are
			// written `.atl-node.is-banner`, so with the class living on the
			// overlay alone they matched nothing — and an exported file, which
			// has every card at once and no notion of which is current, could
			// never have carried that state anyway.
			if (this.scene.meta.__body && n.id === this.scene.stops[0]?.node.id) {
				el.addClass("is-banner");
			}
			const body = el.querySelector<HTMLElement>(".atl-body");
			if (body) {
				const albums = slideshowsIn(body).map(
					(host) =>
						new Slideshow(
							host,
							this.settings.slideshowTransition,
							this.settings.slideshowFit
						)
				);
				if (albums.length > 0) this.shows.set(n.id, albums);
				const steps = buildSteps(body);
				if (steps.length > 0) this.steps.set(n.id, steps);
				body.addEventListener("scroll", () => this.markScroll(body));
			}
		}
	}

	private bindKeys(): void {
		this.onKey = (e: KeyboardEvent) => {
			const key = e.key;
			const handled = () => {
				e.preventDefault();
				e.stopPropagation();
			};
			// Anything the deck navigates with. Letting one of these through
			// reaches the canvas behind the overlay, where the arrow keys *move*
			// the selected card — presenting would quietly edit the file.
			const NAVIGATION = new Set([
				"ArrowLeft",
				"ArrowRight",
				"ArrowUp",
				"ArrowDown",
				"PageUp",
				"PageDown",
				"Home",
				"End",
				" ",
				"Backspace",
				"Escape",
			]);

			// The note box is a Modal with its own key scope. Touching the event
			// here would either steal the keystroke or let it through to the deck.
			if (this.capturing || this.child) return;

			// The note box's own keys, handled from here.
			//
			// They were on the textarea, and a modified Enter never arrived:
			// some other plugin in the vault stops the event at the document
			// before it can reach an element that deep. stopPropagation only
			// stops an event travelling to *other* nodes, though — handlers on
			// the same node and phase still run, and this one is on the
			// document in the capture phase, which is exactly where the event
			// is being stopped. So it is the one place in the plugin that can
			// still hear them.
			if (this.noteBox && e.target === this.noteBox && key === "Enter") {
				// Plain Enter makes a line, and nothing here touches it.
				//
				// Every modified Enter was tried and none of them arrive: some
				// plugin in this vault claims Ctrl/Alt/Shift+Enter and ends the
				// event with stopImmediatePropagation, which no other handler
				// can hear past — not even this one, on the same node and phase
				// as the blocker. Plain Enter does arrive, so that is the key
				// the box uses, and saving moved to something that cannot be
				// intercepted at all: a button.
				return;
			}

			// Anything being typed into belongs to whatever is being typed into.
			//
			// This listens on the document in the capture phase, so that the
			// arrows never reach the canvas behind the deck — which also means it
			// runs before the thing you are typing in and cannot be stopped by
			// it. The presenter panel's note box is in this same document, so
			// writing a remark was driving the deck: m opened the map, b blanked
			// the screen, space advanced the talk. Asking what the event is for
			// is the only guard that works from up here.
			if (
				isElement(e.target) &&
				e.target.closest("input, textarea, select, [contenteditable='true'], .cm-editor")
			) {
				return;
			}

			// Browsing, not presenting: the arrows move the pick through the deck
			// and the camera follows at the same zoom. Nothing here moves the
			// talk on — you are looking for a card, and the deck stays where it
			// was until you choose one or give up.
			const ZOOM = new Set(["+", "=", "-", "_", "0"]);
			// Whatever is open over the deck closes first, innermost last opened.
			if (key === "Escape" && this.askPanel && !this.peek.isOpen) {
				handled();
				this.askPanel.remove();
				this.askPanel = null;
				this.stage.focus();
				return;
			}
			if (key === "Escape" && (this.siteEl || this.review?.isOpen || this.noteBox)) {
				handled();
				if (this.siteEl) this.closeSite();
				else if (this.review?.isOpen) this.review.close();
				else if (this.noteSave) {
					// Escape on the note box saves it. This branch runs before
					// the box's own handler — it is on the document, in the
					// capture phase — so leaving it to remove the panel threw
					// away whatever had just been typed.
					this.noteSave();
				} else {
					this.noteBox?.closest(".atl-note")?.remove();
					this.noteBox = null;
				}
				return;
			}

			if (this.overviewing && (NAVIGATION.has(key) || ZOOM.has(key))) {
				handled();
				const w = this.overlay.clientWidth * 0.6;
				const h = this.overlay.clientHeight * 0.6;
				if (key === "Escape" || key === "Backspace") this.closeOverview();
				else if (key === "ArrowRight") this.pan(w, 0);
				else if (key === "ArrowLeft") this.pan(-w, 0);
				else if (key === "ArrowDown" || key === "PageDown" || key === " ") this.pan(0, h);
				else if (key === "ArrowUp" || key === "PageUp") this.pan(0, -h);
				else if (key === "+" || key === "=") this.zoom(1.25, 0, 0, 160);
				else if (key === "-" || key === "_") this.zoom(0.8, 0, 0, 160);
				else if (key === "0") this.showAll();
				else if (key === "Home" || key === "End") {
					// The ends of the deck, without picking anything there.
					const r = rectOf(
						this.stopAt(key === "Home" ? 0 : this.scene.stops.length - 1).node
					);
					this.viewCx = r.x + r.width / 2;
					this.viewCy = r.y + r.height / 2;
					this.look(260);
				}
				return;
			}

			// A modified key belongs to Obsidian or to the OS, never to the
			// deck. Without this, Ctrl+P — reaching for the command palette —
			// opened the presenter window instead, and Ctrl+E exported.
			if (e.ctrlKey || e.metaKey || e.altKey) {
				// The exception is the browser's own print shortcut. A deck in
				// its own window is a plain Chromium window as far as that key
				// is concerned, so Ctrl+P there raises a print dialog — on the
				// projector, over a live talk. Swallow it and do nothing.
				if ((e.ctrlKey || e.metaKey) && (key === "p" || key === "P")) handled();
				return;
			}

			this.stopAutoAdvance();

			if (this.steppedAside) {
				// While the deck has stepped aside you are using Obsidian: the
				// graph, or a note you opened from it. Anything you are typing in
				// has already been let through above.
				if (key === "Escape") {
					handled();
					this.closeVaultGraph();
				}
				return;
			}

			if (this.browser?.isOpen) {
				// Typing must still reach the search box, so only the keys the
				// list steers with are taken.
				if (["Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) {
					e.preventDefault();
					e.stopPropagation();
				}
				if (key === "Escape") {
					handled();
					this.browser.hide();
				} else if (key === "ArrowDown") {
					handled();
					this.browser.move(1);
				} else if (key === "ArrowUp") {
					handled();
					this.browser.move(-1);
				} else if (key === "Enter") {
					handled();
					this.browser.choose();
				}
				return;
			}

			// The peek sits on top of everything and swallows navigation.
			if (this.peek?.isOpen) {
				if (NAVIGATION.has(key)) {
					e.preventDefault();
					e.stopPropagation();
				}
				if (key === "Escape") {
					handled();
					this.peek.close();
				} else if (key === "Backspace") {
					handled();
					void this.peek.back();
				} else if (key === "ArrowDown" || key === "PageDown" || key === " ") {
					handled();
					this.peek.scroller.scrollBy({ top: this.peek.scroller.clientHeight * 0.85, behavior: "smooth" });
				} else if (key === "ArrowUp" || key === "PageUp") {
					handled();
					this.peek.scroller.scrollBy({ top: -this.peek.scroller.clientHeight * 0.85, behavior: "smooth" });
				} else if (key === "Home") {
					handled();
					this.peek.scroller.scrollTo({ top: 0, behavior: "smooth" });
				} else if (key === "End") {
					handled();
					this.peek.scroller.scrollTo({ top: this.peek.scroller.scrollHeight, behavior: "smooth" });
				}
				return;
			}

			if (NAVIGATION.has(key)) {
				e.preventDefault();
				e.stopPropagation();
			}

			// While the map is up it owns the screen: moving the deck behind it
			// is disorienting, and Escape should close the map first.
			if (this.minimap?.isOpen && key !== "Escape" && key !== "m" && key !== "M") {
				return;
			}

			if (key === "Escape") {
				handled();
				if (this.minimap.isOpen) this.minimap.hide();
				else this.stop();
			} else if (key === "m" || key === "M") {
				handled();
				this.minimap.toggle();
			} else if (key === "g" || key === "G") {
				handled();
				if (this.settings.browser === "obsidian") void this.openVaultGraph();
				else this.browser.toggle();
			} else if (key === "Backspace") {
				handled();
				this.back();
			} else if (key === "ArrowRight" || key === " " || key === "PageDown" || key === "ArrowDown") {
				handled();
				this.advance();
			} else if (key === "ArrowLeft" || key === "PageUp" || key === "ArrowUp") {
				handled();
				this.retreat();
			} else if (key === "Home") {
				handled();
				this.goTo(0);
			} else if (key === "End") {
				handled();
				this.goTo(this.scene.stops.length - 1);
			} else if (key === "o" || key === "O") {
				handled();
				this.toggleOverview();
			} else if (key === "Enter") {
				handled();
				void this.enterSubdeck();
			} else if (key === "b" || key === "B") {
				handled();
				this.blanked = !this.blanked;
				this.overlay.toggleClass("is-blank", this.blanked);
			} else if (key === "n" || key === "N") {
				handled();
				this.captureNote();
			} else if (key === "a" || key === "A") {
				handled();
				this.askNotes();
			} else if (key === "r" && !e.shiftKey) {
				handled();
				void this.dictateNote();
			} else if (key === "R" || (key === "r" && e.shiftKey)) {
				handled();
				void this.toggleSessionRecording();
			} else if (key === "w" || key === "W") {
				handled();
				this.reviewSession();
			} else if (key === "p" || key === "P") {
				handled();
				void this.openPresenter();
			} else if (key === "e" || key === "E") {
				handled();
				void this.exportToHtml();
			} else if (key === "f" || key === "F") {
				handled();
				if (this.doc.fullscreenElement) void this.doc.exitFullscreen();
				else void this.overlay.requestFullscreen().catch(() => undefined);
			}
		};
		// Capture phase, so Obsidian's own hotkeys do not steal the arrow keys.
		this.doc.addEventListener("keydown", this.onKey, true);

		// Scrolling is how you move around a map. Only while browsing: a wheel
		// during the talk belongs to whatever card is under it.
		this.overlay.addEventListener(
			"wheel",
			(e: WheelEvent) => {
				if (!this.overviewing) return;
				e.preventDefault();
				// Ctrl or Cmd with the wheel is how every map zooms, and it keeps
				// the point under the cursor still.
				if (e.ctrlKey || e.metaKey) {
					const box = this.overlay.getBoundingClientRect();
					this.zoom(
						Math.pow(0.9988, e.deltaY),
						e.clientX - box.left - box.width / 2,
						e.clientY - box.top - box.height / 2
					);
					return;
				}
				// Shift swaps the axis, because most mice have one wheel and a
				// deck laid out left to right needs the other direction.
				this.pan(e.shiftKey ? e.deltaY : e.deltaX, e.shiftKey ? 0 : e.deltaY, 0);
			},
			{ passive: false }
		);

		// Dragging the map is how you move a map. Whether a press was a drag or a
		// click is decided by distance: a few pixels is a click on a card, more
		// than that is a pan, and the click that follows it must not also pick.
		let from: { x: number; y: number } | null = null;
		let moved = false;
		this.overlay.addEventListener("pointerdown", (e: PointerEvent) => {
			if (!this.overviewing || e.button !== 0) return;
			from = { x: e.clientX, y: e.clientY };
			moved = false;
		});
		this.overlay.addEventListener("pointermove", (e: PointerEvent) => {
			if (!from) return;
			const dx = e.clientX - from.x;
			const dy = e.clientY - from.y;
			if (!moved && Math.hypot(dx, dy) < 5) return;
			moved = true;
			this.overlay.addClass("is-dragging");
			from = { x: e.clientX, y: e.clientY };
			this.pan(-dx, -dy, 0);
		});
		const release = () => {
			from = null;
			this.overlay.removeClass("is-dragging");
			// Cleared after the click has been and gone, not before it.
			this.win.setTimeout(() => (moved = false), 0);
		};
		this.overlay.addEventListener("pointerup", release);
		this.overlay.addEventListener("pointercancel", release);
		this.dragged = () => moved;

		this.onResize = () => this.goTo(this.index, { animate: false });
		this.win.addEventListener("resize", this.onResize);
	}

	/**
	 * A click inside an HTML card's shadow root is retargeted to the host, so
	 * `event.target` is the card, not the button that was pressed. The composed
	 * path still holds the real chain — without this, clicking a control in a
	 * slide would also advance the deck.
	 */
	private matchInPath(e: Event, selector: string): HTMLElement | null {
		for (const node of e.composedPath()) {
			if (isElement(node) && node.matches(selector)) return node;
			if (node === this.stage) break;
		}
		return null;
	}

	private stopAt(i: number): Stop {
		return this.scene.stops[Math.max(0, Math.min(i, this.scene.stops.length - 1))];
	}

	private bodyAt(i: number): HTMLElement | null {
		const el = this.nodeEls.get(this.stopAt(i).node.id);
		return el ? el.querySelector<HTMLElement>(".atl-body") : null;
	}

	private markScroll(body: HTMLElement): void {
		const max = body.scrollHeight - body.clientHeight;
		body.toggleClass("is-scrollable", max > 8);
		body.toggleClass("at-end", max <= 8 || body.scrollTop >= max - 4);
	}

	/**
	 * What the camera frames when the talk enters a section.
	 *
	 * Containing the whole group works on a section of one card and fails on a
	 * section of five: a group five cards wide is pushed so far back that the
	 * cards are smudges and the section's own name — the thing the stop exists
	 * to announce — shrinks with them. One rule was doing two jobs, *show me
	 * this section* and *announce this section*, and the second is the one that
	 * matters here.
	 *
	 * So the camera frames a window anchored at the section's top-left corner,
	 * where the name is: the section's own height, and as wide as the section
	 * or two cards, whichever is smaller. A narrow section is framed whole,
	 * exactly as before. A wide one is framed at its start — the name large,
	 * the first cards behind it, the rest off to the right where the talk is
	 * about to go. The name then reads at the same size on every section,
	 * because the window is the same size on every section.
	 *
	 * `section:` on the #deck card overrules it: `contain` for the old
	 * behaviour, `whole` to force the entire section into view however wide.
	 */
	private sectionFrame(group: CanvasNode): Rect {
		const r = rectOf(group);
		const how = (this.scene.meta.section ?? "title").toLowerCase();
		if (how === "contain" || how === "whole") return r;

		// A card's width, taken from the section rather than assumed: a deck of
		// 1600-wide cards and a deck of 800-wide cards should both get a window
		// of two of their own cards.
		const cards = this.scene.slides.filter((n) => this.scene.groupOf.get(n.id)?.id === group.id);
		const card = cards.reduce((w, n) => Math.max(w, n.width), 0) || r.width / 2;
		const window = Math.min(r.width, card * 2 + 240);
		// A section only a little wider than the window is shown whole. Cutting
		// a hand's width off the last card to save nothing is worse than the
		// slightly smaller name it costs.
		const width = window > r.width * 0.85 ? r.width : window;
		return { x: r.x, y: r.y, width, height: r.height };
	}

	private goTo(i: number, opts: { animate?: boolean } = {}): void {
		const clamped = Math.max(0, Math.min(i, this.scene.stops.length - 1));
		const backwards = clamped < this.index;
		const previous = this.stopAt(this.index);
		this.index = clamped;
		const stop = this.stopAt(clamped);

		if (previous.node.id !== stop.node.id) {
			this.setMedia(previous.node.id, false);
			this.signal(previous.node.id, "leave");
		}

		const target = stop.kind === "group" ? this.sectionFrame(stop.node) : rectOf(stop.node);
		if (opts.animate === false) this.camera.snapTo(target);
		else void this.camera.flyTo(target, this.settings.duration);

		for (const [id, el] of this.nodeEls) el.toggleClass("is-active", id === stop.node.id);

		// Arriving forwards starts a slide clean; arriving backwards lands it
		// fully revealed and scrolled to the bottom, where you left it.
		const steps = this.steps.get(stop.node.id) ?? [];
		this.stepIndex = backwards ? steps.length : 0;
		steps.forEach((s, n) => s.toggleClass("is-shown", n < this.stepIndex));

		for (const show of this.shows.get(stop.node.id) ?? []) show.reset(backwards);

		const body = this.bodyAt(clamped);
		if (body) {
			body.scrollTop = backwards ? body.scrollHeight - body.clientHeight : 0;
			this.markScroll(body);
		}

		this.setMedia(stop.node.id, true);
		this.signal(stop.node.id, "enter");
		this.minimap?.setCurrent(stop.kind === "node" ? stop.node.id : undefined);
		this.updateHud(stop, steps.length);
		if (stop.kind === "node" && this.visits[this.visits.length - 1]?.nodeId !== stop.node.id) {
			this.visits.push({
				nodeId: stop.node.id,
				title: titleOf(stop.node),
				section: stop.group?.label ?? "",
				at: Date.now(),
			});
			this.journalSave();
		}
		for (const listener of this.listeners) listener();
	}

	/**
	 * Tell a card it is on or off camera.
	 *
	 * A slide running its own animation loop would otherwise burn a core on
	 * every card in the deck at once, forever. A card script listens on `host`,
	 * which is handed to it already in scope.
	 *
	 * The name is `atlas:enter`, which is what the reference, the cheat sheet
	 * and the documentation have always told people to listen for. It used to
	 * dispatch `atlas-presenter:enter`, so every script written from the
	 * documentation bound a listener that could never fire — and a card that
	 * quietly does nothing gives you no way to find out why.
	 */
	private signal(nodeId: string, kind: "enter" | "leave"): void {
		const body = this.nodeEls.get(nodeId)?.querySelector<HTMLElement>(".atl-body");
		body?.dispatchEvent(new CustomEvent(`atlas:${kind}`));
	}

	/** Autoplay on arrival, pause on departure — a video should not run offscreen. */
	private setMedia(nodeId: string, play: boolean): void {
		const el = this.nodeEls.get(nodeId);
		if (!el) return;
		el.querySelectorAll("video, audio").forEach((m) => {
			const media = m as HTMLMediaElement;
			if (play && this.settings.autoplayMedia) void media.play().catch(() => undefined);
			else media.pause();
		});
	}

	/** Scroll a long card by one screenful. Returns false when it cannot move. */
	private scrollStep(dir: 1 | -1): boolean {
		const body = this.bodyAt(this.index);
		if (!body) return false;
		const max = body.scrollHeight - body.clientHeight;
		if (max <= 8) return false;
		if (dir > 0 && body.scrollTop >= max - 4) return false;
		if (dir < 0 && body.scrollTop <= 4) return false;
		body.scrollBy({ top: dir * body.clientHeight * 0.85, behavior: "smooth" });
		return true;
	}

	/**
	 * Hand the screen to Obsidian's own graph view.
	 *
	 * Its container cannot be borrowed into this overlay — the view type is not
	 * even public — so instead the deck steps aside and puts a way back on
	 * screen. You get the real graph, filters, groups and all.
	 */
	/**
	 * Is the deck still stepped aside?
	 *
	 * Holding the leaf is not the same as the leaf existing. Closing the graph
	 * tab by hand left `away` true, and the key handler answers nothing but
	 * Escape while it is — so the deck went deaf to the arrows, M, O, N and W,
	 * with the return bar still pinned over the workspace and G unable to
	 * recover it. The workspace is the only answer that cannot go out of date.
	 */
	private get steppedAside(): boolean {
		if (!this.away) return false;
		const leaf = this.awayLeaf;
		if (leaf && this.app.workspace.getLeavesOfType(leaf.view.getViewType()).includes(leaf)) {
			return true;
		}
		this.closeVaultGraph();
		return false;
	}

	/** Set while the graph has the screen, so we can put fullscreen back after. */
	private wasFullscreen = false;

	/**
	 * A page from the web, over the deck.
	 *
	 * In the overlay, like everything else you can open mid-talk, so it works in
	 * fullscreen. Some sites refuse to be framed — they send a header saying so,
	 * and there is no way to know from here whether one has — so the way out to a
	 * real browser is always on it rather than offered after it fails.
	 */
	private siteEl: HTMLElement | null = null;

	private openSite(url: string): void {
		this.closeSite();
		const panel = this.overlay.createDiv({ cls: "atl-site" });
		const bar = panel.createDiv({ cls: "atl-site-bar" });
		bar.createDiv({ cls: "atl-site-url", text: url });

		const out = bar.createEl("button", { text: "Open in browser" });
		out.addEventListener("click", (e) => {
			e.stopPropagation();
			window.open(url, "_blank");
		});
		const shut = bar.createEl("button", { cls: "mod-cta", text: "Close" });
		shut.addEventListener("click", (e) => {
			e.stopPropagation();
			this.closeSite();
		});

		const frame = panel.createEl("iframe", { cls: "atl-site-frame" });
		frame.src = url;
		frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
		this.siteEl = panel;
	}

	private closeSite(): void {
		this.siteEl?.remove();
		this.siteEl = null;
	}

	private async openVaultGraph(): Promise<void> {
		if (this.steppedAside) return;

		// The graph is Obsidian's own view, and the browser paints nothing over a
		// fullscreen element except that element. Fullscreen therefore has to go:
		// it was showing the graph underneath a deck that still owned the screen,
		// so it could be seen and not touched. It comes back on the way home.
		this.wasFullscreen = !!this.doc.fullscreenElement;
		if (this.wasFullscreen) {
			try {
				await this.doc.exitFullscreen();
			} catch {
				// Refused; the graph will open behind, and Escape still returns.
			}
		}
		try {
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: "graph", active: true });
			this.awayLeaf = leaf;
		} catch {
			// The graph view is a core plugin with no public API; if it will not
			// open, the built-in one is a perfectly good fallback.
			new Notice("Atlas: could not open the graph view; using the built-in one.");
			this.browser.show();
			return;
		}

		// The graph opens as a tab beside the deck's own, which covers it — so the
		// deck really has stepped aside, and must say how to come back.
		this.away = true;
		this.overlay.addClass("is-away");
		const bar = this.doc.body.createDiv({ cls: "atl-return" });
		bar.createSpan({ text: "Presenting · " });
		const btn = bar.createEl("button", { text: "Back to the deck" });
		btn.addEventListener("click", () => this.closeVaultGraph());
		bar.createSpan({ cls: "atl-return-key", text: "Esc" });

		this.returnBar = bar;
	}

	/**
	 * `keepLeaf` is set while Obsidian is unloading us: the guidelines say not
	 * to detach leaves in onunload, because Obsidian restores them itself.
	 */
	private closeVaultGraph(keepLeaf = false): void {
		// Guarded on the leaf as well as the flag: the graph has to be tidied up
		// either way.
		if (!this.away && !this.awayLeaf) return;
		this.away = false;
		this.returnBar?.remove();
		this.returnBar = null;

		const leaf = this.awayLeaf;
		this.awayLeaf = null;
		try {
			// Only if it is still the graph. Clicking a node in the graph opens
			// the note in that same leaf, and closing it would throw away the
			// note you went there to find — which is the whole point of going.
			if (!keepLeaf && leaf?.view?.getViewType() === "graph") leaf.detach();
		} catch {
			// Closed by hand already; nothing to undo.
		}

		this.overlay?.removeClass("is-away");
		// Back to the deck's own tab. As a full-screen overlay there was nothing
		// to come back to — it had never gone anywhere. A tab has.
		try {
			if (!keepLeaf && this.deckLeaf) void this.app.workspace.revealLeaf(this.deckLeaf);
		} catch {
			// The deck's tab has gone; stop() is already on its way.
		}

		// You were fullscreen when you left, so you are fullscreen when you come
		// back. Anything else is a change you did not ask for, mid-talk.
		if (this.wasFullscreen && !keepLeaf) {
			this.wasFullscreen = false;
			void this.overlay?.requestFullscreen().catch(() => undefined);
		}
	}

	/** A minimap pick is a detour: remember where we were. */
	private jumpTo(i: number): void {
		if (i !== this.index) this.history.push(this.index);
		this.goTo(i);
	}

	private back(): void {
		const prev = this.history.pop();
		if (prev === undefined) {
			new Notice("Atlas: no detour to return from.");
			return;
		}
		this.goTo(prev);
	}

	/** Reveals first, then scrolling, then the next card. */
	private advance(): void {
		const steps = this.steps.get(this.stopAt(this.index).node.id) ?? [];
		if (this.stepIndex < steps.length) {
			steps[this.stepIndex].addClass("is-shown");
			this.stepIndex++;
			this.updateHud(this.stopAt(this.index), steps.length);
			return;
		}
		// Reveals, then the album, then scrolling, then the next card.
		for (const show of this.shows.get(this.stopAt(this.index).node.id) ?? []) {
			if (show.next()) return;
		}
		if (this.scrollStep(1)) return;
		if (this.index >= this.scene.stops.length - 1) return;
		this.goTo(this.index + 1);
	}

	private retreat(): void {
		if (this.scrollStep(-1)) return;
		const albums = this.shows.get(this.stopAt(this.index).node.id) ?? [];
		for (const show of [...albums].reverse()) {
			if (show.prev()) return;
		}
		const steps = this.steps.get(this.stopAt(this.index).node.id) ?? [];
		if (this.stepIndex > 0) {
			this.stepIndex--;
			steps[this.stepIndex].removeClass("is-shown");
			this.updateHud(this.stopAt(this.index), steps.length);
			return;
		}
		if (this.index <= 0) return;
		this.goTo(this.index - 1);
	}

	/**
	 * One self-contained HTML file: the cards as they stand, their media as data
	 * URIs, and a small camera. It opens in any browser with no Obsidian.
	 */
	/** What the export is made of, gathered once for both of its uses. */
	private exportInput(): ExportInput {
		// Obsidian injects a plugin's styles.css as a <style> element; find ours
		// by something only it contains.
		const pluginCss =
			Array.from(document.querySelectorAll("style"))
				.map((el) => el.textContent ?? "")
				.find((text) => text.includes(".atl-stage") && text.includes(".atl-node")) ?? "";

		return {
			title: this.file.basename,
			stage: this.stage,
			css: `${pluginCss}
${this.themeCss}`,
			// The theme by itself, for the write-up: a document wants the deck's
			// colours and type, not its layout.
			theme: this.themeCss,
			padding: this.settings.padding,
			maxScale: this.settings.maxScale,
			duration: this.settings.duration,
			allowScripts: this.settings.allowScripts,
			look: {
				accent: this.settings.accent,
				// lookAttrs writes this straight into `background:`, so a gradient
				// from the deck card travels into the exported file as itself.
				background:
					this.settings.background === "colour"
						? this.settings.backgroundColour
						: this.deckBackdrop,
				backgroundImage:
					this.settings.background === "image" && this.settings.backgroundImage
						? resourcePath(this.app, this.settings.backgroundImage)
						: "",
				dim: this.settings.backgroundDim,
				inactive: this.settings.inactiveOpacity,
				sectionTitles: this.settings.sectionTitles,
			},
			openAfter: this.settings.openExport,
			exportFolder: this.settings.exportFolder,
			// The remarks, in the order the talk runs them, so the page beside the
			// deck reads as the talk did. Empty when the setting is off: the
			// export should not carry what nobody asked it to carry.
			notes: this.settings.exportNotes
				? this.scene.stops
						.filter((stop) => stop.kind === "node")
						.map((stop) => ({
							title: titleOf(stop.node),
							text: (
								this.captures.find((c) => c.nodeId === stop.node.id)?.text ?? ""
							).trim(),
						}))
						.filter((n) => n.text)
				: [],
			logo: this.settings.logo
				? {
						srcs: this.settings.logo
							.split(",")
							.map((p) => p.trim())
							.filter(Boolean)
							.map((p) => resourcePath(this.app, p)),
						corner: this.settings.logoCorner,
						height: this.settings.logoHeight,
						opacity: this.settings.logoOpacity,
					}
				: undefined,
			map: {
				groups: this.scene.groups.map((g) => {
					const r = rectOf(g);
					return { ...r, label: g.label ?? "" };
				}),
				edges: this.scene.data.edges.flatMap((e) => {
					const a = this.scene.data.nodes.find((n) => n.id === e.fromNode);
					const b = this.scene.data.nodes.find((n) => n.id === e.toNode);
					if (!a || !b) return [];
					const ra = rectOf(a);
					const rb = rectOf(b);
					return [{
						x1: ra.x + ra.width / 2,
						y1: ra.y + ra.height / 2,
						x2: rb.x + rb.width / 2,
						y2: rb.y + rb.height / 2,
					}];
				}),
			},
			stops: this.scene.stops.map((stop, i) => {
				const r = rectOf(stop.node);
				return {
					nodeId: stop.node.id,
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height,
					label: stop.kind === "group" ? stop.node.label ?? "" : "",
					// The export had no card names at all, so its counter and its
					// map could only ever label the sections.
					title: stop.kind === "node" ? titleOf(stop.node) : "",
					colour: stop.node.color ?? "",
					order: stop.kind === "node" ? this.cardNumber(i) : 0,
				};
			}),
		};
	}

	/** Returns where it was written, so a caller can offer to open it. */
	async exportToHtml(): Promise<string | null> {
		new Notice("Atlas: exporting…");
		return exportDeck(this.app, this.exportInput());
	}

	/** The exported document itself, for a preview that writes no file. */
	async buildHtml(): Promise<string> {
		return (await buildDeckHtml(this.app, this.exportInput())).html;
	}

	// ---- what a presenter window is allowed to know and do ----------------

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): DeckSnapshot {
		const stop = this.stopAt(this.index);
		const upcoming = this.scene.stops[this.index + 1];
		return {
			deck: this.file.basename,
			nodeId: stop.node.id,
			section: stop.group?.label ?? "",
			card: titleOf(stop.node),
			notes: this.notes.get(stop.node.id) ?? "",
			remark: this.remarkOn(stop.node.id),
			next: upcoming ? titleOf(upcoming.node) : "",
			index: this.cardNumber(this.index),
			total: this.cardTotal,
			elapsedMs: Date.now() - this.began,
		};
	}

	/** Public so the presenter window's own keys can drive the deck. */
	next(): void {
		this.advance();
	}

	prev(): void {
		this.retreat();
	}

	/**
	 * Give the deck a window of its own, before it is built.
	 *
	 * Everything the deck draws then lands in that window, leaving the main one
	 * on the canvas — so the map, the note you were writing and the minutes stay
	 * in front of you while the talk runs on the projector. Drag the new window
	 * to the second screen and press F.
	 *
	 * Returns false if the window could not be opened, so the caller can fall
	 * back to presenting in place rather than not presenting at all.
	 */
	async useTab(): Promise<boolean> {
		try {
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: DECK_VIEW, active: true });
			// Narrowed before anything is read off it. A leaf that is not our view
			// — the type not registered yet, a restored layout racing us — would
			// otherwise have the deck built into a foreign container with nothing
			// to stop it when that container closes.
			const view = leaf.view;
			const doc = view.containerEl.ownerDocument;
			if (!(view instanceof DeckView) || !doc.defaultView) {
				leaf.detach();
				return false;
			}

			this.deckLeaf = leaf;
			this.host = view.contentEl;
			this.doc = doc;
			this.win = doc.defaultView;

			// Closing the tab is a way of ending the talk, and must end it
			// properly — the write-up included.
			view.onWindowClose = () => {
				this.deckLeaf = null;
				this.stop();
			};

			// Dragging the tab into a window of its own moves the DOM, and the
			// keys are bound to a document that is then the wrong one. Nothing
			// announces that, so it is noticed here instead.
			this.registerEvent(this.app.workspace.on("layout-change", () => this.followTab()));
			return true;
		} catch {
			return false;
		}
	}

	/** Re-aim the keyboard and the camera at whichever window the tab is in. */
	private followTab(): void {
		const view = this.deckLeaf?.view;
		if (!view) return;
		const doc = view.containerEl.ownerDocument;
		if (doc === this.doc || !doc.defaultView) return;

		if (this.onKey) this.doc.removeEventListener("keydown", this.onKey, true);
		if (this.onResize) this.win.removeEventListener("resize", this.onResize);
		// The theme travels too. A constructed stylesheet belongs to the window
		// that made it and can only be adopted by that window's document, so a
		// deck dragged into a window of its own arrived unthemed — the CSS was
		// still adopted, into the document it had just left. Dropped from the
		// old one and rebuilt in the new one, because the sheet itself cannot
		// cross.
		this.dropTheme();
		this.doc = doc;
		this.win = doc.defaultView;
		this.adoptTheme();
		this.applyTheme();
		if (this.onKey) this.doc.addEventListener("keydown", this.onKey, true);
		if (this.onResize) this.win.addEventListener("resize", this.onResize);
		this.goTo(this.index, { animate: false });
	}

	/** Obsidian restores its own leaves, so leave this one alone on unload. */
	private closeDeckTab(unloading: boolean): void {
		const leaf = this.deckLeaf;
		this.deckLeaf = null;
		if (!leaf || unloading) return;
		const view = leaf.view;
		// Detaching calls onClose, which would call stop() again.
		if (view instanceof DeckView) view.onWindowClose = null;
		try {
			leaf.detach();
		} catch {
			// Closed by hand already.
		}
	}

	/**
	 * A second screen: notes, the clock, and what is coming — while the
	 * projector shows only the deck.
	 */
	/**
	 * With the deck on its own screen, the presenter belongs in the sidebar of
	 * the window you are actually looking at — beside the canvas, not covering
	 * it, and opened for you rather than waiting to be asked for. Notes have
	 * just come off the deck, so there has to be somewhere they still are.
	 */
	private async openPresenterPanel(): Promise<void> {
		try {
			const leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: PRESENTER_VIEW, active: false });
			void this.app.workspace.revealLeaf(leaf);
			this.presenterLeaf = leaf;
		} catch {
			// No sidebar to put it in; P still opens a window.
		}
	}

	/**
	 * Is there still a presenter to speak of?
	 *
	 * Holding the leaf is not the same as the leaf existing. Closing the
	 * presenter window by hand detaches it without telling us, and the stale
	 * reference then meant pressing P again focused a window that was gone —
	 * silently, because `setActiveLeaf` on a detached leaf does nothing at all.
	 * Asking the workspace is the only answer that cannot go out of date, and
	 * it clears the reference on the way past so the next P opens a new one.
	 */
	private get presenterOpen(): boolean {
		const leaf = this.presenterLeaf;
		if (!leaf) return false;
		if (this.app.workspace.getLeavesOfType(PRESENTER_VIEW).includes(leaf)) return true;
		this.presenterLeaf = null;
		return false;
	}

	private async openPresenter(): Promise<void> {
		if (this.presenterOpen && this.presenterLeaf) {
			this.app.workspace.setActiveLeaf(this.presenterLeaf, { focus: true });
			return;
		}
		// The sidebar first: that is where it opens itself, and where it can be
		// seen beside the deck without covering it.
		await this.openPresenterPanel();
		if (this.presenterOpen) return;
		try {
			const leaf = this.app.workspace.openPopoutLeaf();
			await leaf.setViewState({ type: PRESENTER_VIEW, active: true });
			this.presenterLeaf = leaf;
			// Takes the notes off the deck, now rather than on the next card.
			this.updateHud(this.stopAt(this.index), 0);
		} catch {
			new Notice("Atlas: could not open a presenter window.");
		}
	}

	/**
	 * A note against whichever card is on screen — or the one already there.
	 *
	 * Pressing N twice on the same card should let you add a line, not start a
	 * blank note you cannot see. One card therefore holds one note, kept at the
	 * time it was first made so the write-up stays in order.
	 */
	/** What has been written against a card so far, wherever it was written. */
	private remarkOn(nodeId: string): string {
		return this.captures
			.filter((c) => c.nodeId === nodeId)
			.map((c) => c.text)
			.join("\n\n");
	}

	/**
	 * Write a remark against the card on screen, from wherever you are.
	 *
	 * N opens a box on the deck; the presenter panel has one always open. They
	 * are the same note — one card holds one — so typing in either shows up in
	 * the other and in the write-up. The time is the time it was first made, so
	 * editing a remark later does not move it in the minutes.
	 */
	setRemark(text: string): void {
		const stop = this.stopAt(this.index);
		const title = titleOf(stop.node);
		const existing = this.captures.filter((c) => c.nodeId === stop.node.id);
		const firstAt = existing.length > 0 ? existing[0].at : Date.now();
		const body = text.trim();

		this.captures = this.captures.filter((c) => c.nodeId !== stop.node.id);
		if (body) this.captures.push({ nodeId: stop.node.id, title, text: body, at: firstAt });
		this.journalSave();
		this.updateHud(stop, 0);
		for (const listener of this.listeners) listener();
	}

	/**
	 * A box to write a remark in, inside the deck itself.
	 *
	 * It was an Obsidian modal, then it was the presenter panel's box. Neither
	 * can be seen while the deck is fullscreen: a modal belongs to the app's own
	 * DOM, which the browser does not paint over a fullscreen element, and the
	 * sidebar is not on the screen at all. So N appeared to do nothing at the one
	 * time you are most likely to press it.
	 *
	 * This lives in the overlay, which *is* the fullscreen element, so it is
	 * there whatever state the deck is in. The keyboard is safe because the deck
	 * lets anything aimed at a text box through untouched.
	 */
	// --------------------------------------------------------------- journal
	private journal: Journal | null = null;

	/**
	 * Put the session on disk.
	 *
	 * Called after anything that would be a loss — a note, a visit, a recording
	 * landing. Never awaited: a note is saved the instant it is typed and
	 * nothing on screen waits for the disk.
	 */
	private journalSave(): void {
		this.journal?.save({
			visits: this.visits,
			captures: this.captures,
			prepared: Object.fromEntries(this.notes),
			audio: this.sessionAudio ?? undefined,
		});
	}

	// ------------------------------------------------------------- recording
	private recorder: Recorder | null = null;
	/** The Record button, so it can show that it is on. */
	private recordBtn: HTMLButtonElement | null = null;
	/** The pip in the corner, present only while something is recording. */
	private recEl: HTMLElement | null = null;
	private recTimer = 0;
	/** Set while the running recording is the whole session, not one card. */
	private recordingSession = false;
	/** The session recording, once it has been written. */
	private sessionAudio: { path: string; startedAt: number; ms: number } | null = null;

	private get recordings(): string {
		const dir = this.settings.minutesFolder || "Meetings";
		return `${dir}/Recordings`;
	}

	/**
	 * The recording light.
	 *
	 * Deliberately impossible to miss, and it carries a live level meter: a
	 * recorder that silently captured nothing is only discovered after the
	 * meeting, when the thing it was recording cannot be repeated. It also
	 * means everyone in the room can see that the room is being recorded,
	 * which is the least a recording feature owes them.
	 */
	private showRecordingPip(what: string): void {
		this.hideRecordingPip();
		const pip = this.overlay.createDiv({ cls: "atl-rec" });
		pip.createDiv({ cls: "atl-rec-dot" });
		const label = pip.createDiv({ cls: "atl-rec-label", text: what });
		const time = pip.createDiv({ cls: "atl-rec-time", text: "0:00" });
		const bar = pip.createDiv({ cls: "atl-rec-level" });
		const fill = bar.createDiv({ cls: "atl-rec-fill" });
		this.recEl = pip;

		this.recTimer = this.win.setInterval(() => {
			const r = this.recorder;
			if (!r?.isRecording) return;
			time.setText(mmss(Math.floor(r.elapsed / 1000)));
			fill.style.width = `${Math.round(r.level() * 100)}%`;
			label.setText(what);
		}, 200);
		this.register(() => this.win.clearInterval(this.recTimer));
	}

	private hideRecordingPip(): void {
		if (this.recTimer) this.win.clearInterval(this.recTimer);
		this.recTimer = 0;
		this.recEl?.remove();
		this.recEl = null;
	}

	/**
	 * Overwrite the in-progress recording.
	 *
	 * One file that keeps growing rather than a pile of fragments: each write is
	 * a complete, playable recording of everything so far, so whatever is on
	 * disk when the power goes is something you can actually listen to.
	 */
	private async writePart(path: string, data: ArrayBuffer): Promise<void> {
		try {
			await this.app.vault.adapter.writeBinary(normalizePath(path), data);
		} catch {
			// The safety net failing must not stop the recording it protects.
		}
	}

	/** Write a clip into the vault and hand back its path. */
	private async saveClip(clip: Clip, label: string): Promise<string | null> {
		const dir = normalizePath(this.recordings);
		try {
			if (!(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
				await this.app.vault.createFolder(dir);
			}
		} catch {
			// Already there, or the name is taken; the write below will say.
		}
		const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
		let path = normalizePath(
			`${dir}/${safeFileName(this.file.basename)} ${stamp} ${safeFileName(label)}.${clip.ext}`
		);
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = path.replace(/(\.\w+)$/, ` (${n++})$1`);
		}
		try {
			await this.app.vault.createBinary(path, clip.data);
			return path;
		} catch (e) {
			fail("could not save the recording", e);
			return null;
		}
	}

	/**
	 * Speak a note against this card.
	 *
	 * The same result as pressing N and typing: it becomes a capture on this
	 * card and flows into the write-up. The audio is embedded alongside
	 * whatever a speech server made of it, so a transcript you disagree with
	 * can always be checked against what was actually said.
	 */
	private async dictateNote(): Promise<void> {
		if (this.recorder?.isRecording) {
			if (this.recordingSession) {
				say("the session is recording — Shift+R stops it");
				return;
			}
			await this.finishDictation();
			return;
		}

		const recorder = new Recorder(this.win);
		if (!(await recorder.start())) {
			// Say which of the several possible failures it was.
			fail(recorder.problem || "could not reach a microphone");
			return;
		}
		this.recorder = recorder;
		this.recordingSession = false;
		this.showRecordingPip("Note — R to stop");
	}

	private async finishDictation(): Promise<void> {
		const recorder = this.recorder;
		if (!recorder) return;
		const stop = this.stopAt(this.index);
		const title = titleOf(stop.node);

		this.hideRecordingPip();
		const clip = await recorder.stop();
		this.recorder = null;
		if (!clip) {
			fail("nothing was recorded");
			return;
		}

		const path = await this.saveClip(clip, title);
		if (!path) return;

		const name = path.split("/").pop() ?? path;
		const spoken = await transcribe(this.settings.transcribeUrl, clip, name);
		// The embed always goes in. A transcript is an opinion about the audio;
		// the audio is the record.
		const parts = [spoken, `![[${path}]]`].filter(Boolean) as string[];

		const existing = this.captures.filter((c) => c.nodeId === stop.node.id);
		const firstAt = existing.length > 0 ? existing[0].at : Date.now();
		const text = [...existing.map((c) => c.text), parts.join("\n\n")].join("\n\n").trim();
		this.captures = this.captures.filter((c) => c.nodeId !== stop.node.id);
		this.captures.push({ nodeId: stop.node.id, title, text, at: firstAt });

		this.journalSave();
		this.updateHud(this.stopAt(this.index), 0);
		for (const listener of this.listeners) listener();
		say(
			spoken
				? `noted against “${title}” — ${mmss(Math.round(clip.ms / 1000))} transcribed`
				: `recorded against “${title}” — ${mmss(Math.round(clip.ms / 1000))}`
		);
	}

	/**
	 * Record the whole meeting.
	 *
	 * Worth its own mode because the deck knows something no recorder does:
	 * which card was on screen at every moment. One long file becomes an index
	 * of the talk, and the write-up can point at the minute a thing was said.
	 */
	private async toggleSessionRecording(): Promise<void> {
		if (this.recorder?.isRecording && !this.recordingSession) {
			say("a note is recording — R stops it");
			return;
		}

		if (this.recordingSession && this.recorder) {
			const recorder = this.recorder;
			const startedAt = Date.now() - recorder.elapsed;
			this.hideRecordingPip();
			const clip = await recorder.stop();
			this.recorder = null;
			this.recordingSession = false;
			this.recordBtn?.removeClass("is-live");
			if (!clip) {
				fail("nothing was recorded");
				return;
			}
			const path = await this.saveClip(clip, "session");
			if (path) {
				this.sessionAudio = { path, startedAt, ms: clip.ms };
				// The real file exists, so the safety copy is now a duplicate.
				const part = normalizePath(
					`${this.recordings}/${safeFileName(this.file.basename)} in progress.webm`
				);
				try {
					if (await this.app.vault.adapter.exists(part)) {
						await this.app.vault.adapter.remove(part);
					}
				} catch {
					// Harmless if it stays; it is overwritten by the next talk.
				}
				this.journal?.save({ recording: undefined });
				this.journalSave();
				say(`recording saved — ${mmss(Math.round(clip.ms / 1000))}. Press W to write it up`);
			}
			return;
		}

		// A whole meeting is the one recording worth protecting while it runs:
		// every two minutes what has been captured so far is written out, so a
		// crash costs the gap rather than the hour.
		const part = normalizePath(
			`${this.recordings}/${safeFileName(this.file.basename)} in progress.webm`
		);
		const recorder = new Recorder(this.win, (data) => {
			void this.writePart(part, data);
		});
		if (!(await recorder.start())) {
			// Say which of the several possible failures it was.
			fail(recorder.problem || "could not reach a microphone");
			return;
		}
		this.recorder = recorder;
		this.recordingSession = true;
		this.journal?.save({ recording: { path: part, startedAt: Date.now() } });
		this.recordBtn?.addClass("is-live");
		this.showRecordingPip("Recording — Shift+R stops");
	}

	/**
	 * A question put to your notes, without leaving the deck.
	 *
	 * Built into the overlay rather than opened as a modal, for the same reason
	 * the note box is: a modal belongs to the app's DOM, and the browser paints
	 * nothing over a fullscreen element except that element. The ribbon icon
	 * uses a modal quite happily — there is no deck in the way there.
	 */
	private askPanel: HTMLElement | null = null;

	/**
	 * The deck itself, as something the question can be answered from.
	 *
	 * Asked to summarise the canvas being presented, the panel searched
	 * markdown notes — which is everything except the one document on screen —
	 * and answered from two unrelated plans. The deck was never a candidate,
	 * because a `.canvas` is not a note and nothing read it.
	 *
	 * It is offered as its outline: the sections and the card titles, which is
	 * what "what is this deck about" actually wants, plus the text of any cards
	 * carrying the question's words. Whether it is the right source is then
	 * decided the same way as for every other candidate — by the model, looking
	 * at the extract.
	 */
	private deckAsPassage(question: string): Passage {
		const words = question
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length > 3);

		const lines: string[] = [];
		let section = "";
		for (const stop of this.scene.stops) {
			if (stop.kind !== "node") continue;
			const group = stop.group?.label ?? "";
			if (group && group !== section) {
				section = group;
				lines.push(`## ${section}`);
			}
			lines.push(`- ${titleOf(stop.node)}`);
		}

		// The cards that mention what was asked about, in full, after the outline.
		const hits: string[] = [];
		for (const node of this.scene.slides) {
			const text = (node.text ?? "").replace(/%%[\s\S]*?%%/g, "").trim();
			if (!text) continue;
			const low = text.toLowerCase();
			if (words.some((w) => low.includes(w))) hits.push(text.slice(0, 400));
			if (hits.length >= 3) break;
		}

		const outline = [
			`The deck "${this.file.basename}" has ${this.cardTotal} cards:`,
			...lines,
			...(hits.length > 0 ? ["", "Cards mentioning what was asked:", ...hits] : []),
		].join("\n");

		return {
			file: this.file,
			label: `this deck — ${this.file.basename}`,
			text: outline.slice(0, 2400),
			score: Number.MAX_SAFE_INTEGER,
		};
	}

	/**
	 * The card on screen, as a passage.
	 *
	 * "What is on this slide" has one right answer and it is already rendered;
	 * searching the vault for it can only go wrong.
	 */
	private slideAsPassage(): Passage {
		const stop = this.stopAt(this.index);
		const body = (stop.node.text ?? "").replace(/%%[\s\S]*?%%/g, "").trim();
		const section = stop.group?.label ? `Section: ${stop.group.label}\n` : "";
		return {
			file: this.file,
			label: `the slide on screen — ${titleOf(stop.node)}`,
			text: `${section}${body || titleOf(stop.node)}`.slice(0, 2400),
			score: Number.MAX_SAFE_INTEGER,
		};
	}

	private askNotes(): void {
		if (this.askPanel) {
			this.askPanel.querySelector<HTMLInputElement>(".atl-ask-input")?.focus();
			return;
		}

		const canLocal = isLocal(this.settings.askUrl);
		const canCloud = this.settings.askWhere !== "local" && !!this.settings.cloudKey;
		if (!canLocal && !canCloud) {
			say("no model set — Settings → Atlas → Asking your notes", 7000);
			return;
		}

		const panel = this.overlay.createDiv({ cls: "atl-note atl-ask-panel" });
		this.askPanel = panel;
		panel.createDiv({
			cls: "atl-note-title",
			text: `Ask this deck, or your notes — ${
				this.settings.askFolder || "the whole vault"
			}`,
		});

		const row = panel.createDiv({ cls: "atl-ask-row" });
		const input = row.createEl("input", { cls: "atl-ask-input", type: "text" });
		input.placeholder = "What did we decide about…";
		const go = row.createEl("button", { cls: "mod-cta", text: "Ask" });
		const out = panel.createDiv({ cls: "atl-ask-out" });
		panel.createDiv({ cls: "atl-note-hint", text: "Enter asks · Esc closes" });

		const close = () => {
			this.askPanel = null;
			panel.remove();
			this.stage.focus();
		};

		// The conversation, for as long as the panel is open. Closing it forgets
		// everything: a question asked on slide four should not still be steering
		// an answer on slide nineteen.
		const turns: { q: string; a: string }[] = [];
		let working = false;

		const run = async (): Promise<void> => {
			const question = input.value.trim();
			if (!question || working) return;
			working = true;
			input.value = "";

			out.createDiv({ cls: "atl-ask-q", text: question });

			// The work, shown as it happens. Four model calls take several
			// seconds, and seconds of nothing read as a hang — where the same
			// seconds with the steps on screen read as thinking. It is also the
			// only way to see which note it decided to read, and why.
			const steps = out.createDiv({ cls: "atl-ask-steps" });
			const step = (text: string): HTMLElement => {
				const row = steps.createDiv({ cls: "atl-ask-step is-doing" });
				row.createSpan({ cls: "atl-ask-tick" });
				row.createSpan({ cls: "atl-ask-step-text", text });
				out.scrollTop = out.scrollHeight;
				return row;
			};
			const done = (row: HTMLElement, text?: string) => {
				row.removeClass("is-doing");
				if (text) row.querySelector(".atl-ask-step-text")?.setText(text);
			};
			out.scrollTop = out.scrollHeight;

			const answerFrom = async (passages: Passage[]): Promise<void> => {
				const writing = step("Writing the answer…");
				const answer = await askBest(
					{
						where: this.settings.askWhere,
						url: this.settings.askUrl,
						model: this.settings.askModel,
						cloudKey: this.settings.cloudKey,
						cloudModel: this.settings.cloudModel,
					},
					question,
					passages,
					turns
				);
				if (!this.askPanel) return;
				done(writing);

				out.createDiv({
					cls: answer ? "atl-ask-answer" : "atl-ask-status",
					text: answer ? answer.text : "The model did not answer. The notes below mention it.",
				});
				if (answer) {
					turns.push({ q: question, a: answer.text });
					// Read back against the passages it came from. A claim that is
					// fluent, plausible and absent from the notes is the one failure
					// every other rule here lets through — so the answer is shown
					// with a caution rather than quietly deleted, because a verifier
					// that hides good answers would be worse than none.
					const checking = step("Checking it against the notes…");
					const sound = await verify(
						this.settings.askUrl,
						this.settings.askModel,
						answer.text,
						passages
					);
					if (!this.askPanel) return;
					done(checking, sound ? "Every part of it is in the notes" : "Some of it is not in the notes");
					if (!sound) {
						out.createDiv({
							cls: "atl-ask-caution",
							text: "Not all of this is in the notes — check the sources below.",
						});
					}
				}

				// The deck itself is not a source to go and open: it is already on
				// screen, and peek cannot show a canvas anyway.
				const sources = passages.filter((p) => p.file !== this.file);
				if (sources.length > 0) {
					const list = out.createDiv({ cls: "atl-ask-sources" });
					list.createDiv({ cls: "atl-ask-label", text: "From" });
					for (const p of sources) {
						// Two notes really can be called the same thing, and a chip
						// that names neither is worse than a long one.
						const twin = sources.some(
							(o) => o !== p && o.file.basename === p.file.basename
						);
						const name = twin ? p.file.path.replace(/\.md$/, "") : p.file.basename;
						const chip = list.createDiv({ cls: "atl-ask-source", text: name });
						// Over the deck, like a wikilink — leaving the talk to read a note
						// is the thing peek exists to avoid.
						chip.addEventListener("click", () => void this.peek.showFile(p.file));
					}
				}
				working = false;
				out.scrollTop = out.scrollHeight;
				input.focus();
			};

			// What the question points at, decided here rather than by the model.
			// A question naming the deck, the canvas or the slide on screen has
			// its answer in front of us; searching for it can only find notes
			// that happen to share a word. Judgement in code, generation in the
			// model — the same division that fixed every other wrong answer.
			const scope = scopeOf(question);
			if (scope !== "vault") {
				const here = scope === "slide" ? this.slideAsPassage() : this.deckAsPassage(question);
				const reading = step(`Reading ${here.label}…`);
				done(reading);
				await answerFrom([here]);
				return;
			}

			// What to search for is its own question, and the model answers it
			// better than a stop list can: it drops "can you brief me on", and
			// it knows "dept" is worth looking for when you typed "department".
			const looking = step("Working out what to look for…");
			const search = await searchTerms(
				this.settings.askUrl,
				this.settings.askModel,
				question
			);
			if (!this.askPanel) return;
			const terms = search === question ? question : search.slice(question.length).trim();
			done(looking, `Looking for: ${terms || question}`);

			const searching = step("Searching your notes…");
			const found = await findPassages(this.app, this.settings.askFolder, search, 10);
			if (!this.askPanel) return;

			// The deck is always a candidate when one is running: the question
			// may well be about what is on screen.
			const deck = this.deckAsPassage(question);
			found.unshift(deck);
			done(searching, `${found.length - 1} notes mention it, plus this deck`);

			// The model reads the extracts and says which are worth opening —
			// or that none of them are, which is the honest answer no amount of
			// word-counting ever produced.
			const choosing = step("Choosing which to read…");
			const passages = await chooseNotes(
				this.settings.askUrl,
				this.settings.askModel,
				question,
				found
			);
			if (!this.askPanel) return;
			if (passages.length === 0) {
				working = false;
				done(choosing, "None of them are about that.");
				out.createDiv({ cls: "atl-ask-status", text: "No note found on that topic." });
				out.scrollTop = out.scrollHeight;
				return;
			}
			done(choosing, `Reading ${passages.map((p) => p.file.basename).join(", ")}`);

			await answerFrom(passages);
		};

		go.addEventListener("click", () => void run());
		input.addEventListener("keydown", (e) => {
			// The deck must not hear any of this: typing a question used to drive
			// the presentation.
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				void run();
			} else if (e.key === "Escape") {
				e.preventDefault();
				close();
			}
		});
		this.win.setTimeout(() => input.focus(), 0);
	}

	private noteBox: HTMLTextAreaElement | null = null;
	/** Saving the open note, callable from the deck's own key handler. */
	private noteSave: (() => void) | null = null;
	/** The session review, built into the deck so fullscreen can show it. */
	private review: ReviewPanel | null = null;

	private captureNote(): void {
		if (this.noteBox) {
			this.noteBox.focus();
			return;
		}

		const stop = this.stopAt(this.index);
		const title = titleOf(stop.node);
		const existing = this.captures.filter((c) => c.nodeId === stop.node.id);
		const firstAt = existing.length > 0 ? existing[0].at : Date.now();

		const panel = this.overlay.createDiv({ cls: "atl-note" });
		panel.createDiv({ cls: "atl-note-title", text: `Note on “${title}”` });
		const box = panel.createEl("textarea", { cls: "atl-note-box" });
		box.rows = 3;

		// Grows with what is in it, like the ask panel.
		//
		// A fixed four rows means a long note is typed through a letterbox with
		// the start of it scrolled out of sight — and the thing you most want
		// while talking is to see what you have already written. It stops at
		// 40% of the deck's height so the card underneath is never buried.
		const grow = () => {
			box.style.height = "auto";
			box.style.height = `${Math.min(box.scrollHeight, this.overlay.clientHeight * 0.4)}px`;
		};
		box.addEventListener("input", grow);
		box.placeholder =
			"What was said, what was asked, what to do next.\n" +
			"A line starting - [ ] becomes an action.";
		box.value = existing.map((c) => c.text).join("\n\n");
		this.noteBox = box;

		panel.createDiv({
			cls: "atl-note-hint",
			text: "Enter makes a new line · Esc or Save note keeps it · Close discards it · empty it to delete",
		});
		const buttons = panel.createDiv({ cls: "atl-note-buttons" });

		const close = () => {
			this.noteBox = null;
			this.noteSave = null;
			panel.remove();
			this.stage.focus();
		};

		const save = () => {
			const text = box.value.trim();
			this.captures = this.captures.filter((c) => c.nodeId !== stop.node.id);
			if (text) {
				this.captures.push({ nodeId: stop.node.id, title, text, at: firstAt });
				new Notice(`Atlas: noted against “${title}”`);
			} else if (existing.length > 0) {
				new Notice(`Atlas: note on “${title}” removed`);
			}
			this.journalSave();
			this.updateHud(this.stopAt(this.index), 0);
			for (const listener of this.listeners) listener();
			close();
		};

		this.noteSave = save;

		// A button, so no key combination is load-bearing.
		const cancel = buttons.createEl("button", { text: "Close" });
		cancel.addEventListener("click", () => close());
		const keep = buttons.createEl("button", { cls: "mod-cta", text: "Save note" });
		keep.addEventListener("click", () => save());

		box.addEventListener("keydown", (e) => {
			// Whatever happens, the deck does not also hear it.
			e.stopPropagation();
			// Enter is left alone: it makes a new line, the way a textarea
			// already does. Saving is Esc or a button, because every modified
			// Enter is claimed by something else in this vault and never
			// arrives here at all.
			if (e.key === "Escape") {
				// Saving, not discarding. A box that throws away what you typed
				// because you reached for the key that closes things is a trap,
				// and this one is opened mid-sentence while talking.
				e.preventDefault();
				save();
			}
		});

		this.win.setTimeout(() => {
			box.focus();
			box.setSelectionRange(box.value.length, box.value.length);
			// A note reopened on a card already has text in it.
			grow();
		}, 0);
	}

	/**
	 * Read the session before it becomes a file.
	 *
	 * Editing here writes into the same store the cards use, so pressing N on a
	 * card afterwards shows what was changed.
	 */
	private reviewSession(): void {
		const seen = new Set<string>();
		const entries = [];
		for (const visit of this.visits) {
			if (seen.has(visit.nodeId)) continue;
			seen.add(visit.nodeId);
			const prepared = this.notes.get(visit.nodeId) ?? "";
			const typed = this.captures.find((c) => c.nodeId === visit.nodeId)?.text ?? "";
			if (!prepared && !typed) continue;
			entries.push({
				nodeId: visit.nodeId,
				title: visit.title,
				section: visit.section,
				prepared,
				text: typed,
			});
		}

		const span = `${new Date(this.began).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		})} \u2014 now`;

		// A modal belongs to the main window. With the deck dragged to a screen
		this.review = new ReviewPanel(this.overlay, {
			title: `${this.file.basename} \u2014 the session so far`,
			subtitle: `${span}  \u00b7  ${this.visits.length} cards visited  \u00b7  ${entries.length} with notes`,
			entries,
			onEdit: (nodeId, text) => {
				const visit = this.visits.find((v) => v.nodeId === nodeId);
				const at = this.captures.find((c) => c.nodeId === nodeId)?.at ?? Date.now();
				this.captures = this.captures.filter((c) => c.nodeId !== nodeId);
				if (text) {
					this.captures.push({ nodeId, title: visit?.title ?? "", text, at });
				}
				this.journalSave();
				this.updateHud(this.stopAt(this.index), 0);
			},
			onWrite: () => void this.writeUp(),
		});
		this.review.open();
	}

	private minutesOptions(): MinutesOptions {
		return {
			actionSuffix: this.settings.actionSuffix,
			linkBack: this.settings.actionsLinkBack,
			includePrepared: this.settings.minutesIncludeNotes,
		};
	}

	private session(): Session {
		return {
			deck: this.file.basename,
			deckPath: this.file.path,
			variant: this.variant,
			startedAt: this.began,
			endedAt: Date.now(),
			visits: this.visits,
			captures: this.captures,
			prepared: this.notes,
			audio: this.sessionAudio ?? undefined,
		};
	}

	/**
	 * The talk, written up as one note — and then opened, so it is not a file
	 * you have to go looking for.
	 */
	/**
	 * The deck's one note, written back.
	 *
	 * Every card that has something written on it, in the order the talk runs,
	 * merged into the file the deck opened with. A card whose notes were not
	 * touched this time keeps exactly the words it had — including anything
	 * edited by hand between talks, which is the point of there being one file.
	 */
	private async saveToDeckNote(): Promise<TFile | null> {
		const notes = this.deckNotes ?? (await readDeckNotes(this.app, this.file));
		const order = this.scene.stops
			.filter((stop) => stop.kind === "node")
			.map((stop) => ({ id: stop.node.id, title: titleOf(stop.node) }));

		const entries = new Map<string, string>();
		for (const capture of this.captures) entries.set(capture.nodeId, capture.text);
		// A card whose note was emptied has to say so, or the old text stays.
		for (const id of notes.byCard.keys()) {
			if (!entries.has(id)) entries.set(id, "");
		}

		const file = await saveDeckNotes(this.app, this.file, notes, order, entries);
		if (file) {
			this.deckNotes = await readDeckNotes(this.app, this.file);
			new Notice(`Atlas: notes kept in ${file.path}`, 6000);
		} else {
			new Notice("Atlas: could not write the deck's notes.");
		}
		return file;
	}

	/**
	 * `open` is false when the deck is going away under us: closing the tab or
	 * quitting is no time to be opening another one.
	 */
	async writeUp(open = true): Promise<void> {
		if (this.captures.length === 0 && this.visits.length === 0) {
			new Notice("Atlas: nothing to write up yet.");
			return;
		}
		const file = this.settings.deckNotes
			? await this.saveToDeckNote()
			: await writeMinutes(
					this.app,
					this.session(),
					this.settings.minutesFolder,
					this.minutesOptions()
				);
		this.written = true;
		if (!file) return;
		// The journal existed to survive a crash. The minutes now say everything
		// it said, so keeping it leaves a duplicate nobody will read — and a
		// Sessions folder that only ever grows.
		void this.journal?.done();
		this.journal = null;

		if (!open) return;
		// Opened behind the deck: it is waiting when you leave, and the deck
		// does not lose its place while you are still presenting.
		try {
			await this.app.workspace.getLeaf(true).openFile(file);
		} catch {
			// A workspace that refuses a leaf is not a reason to lose the note.
		}
	}

	/**
	 * `advance: 8s` on the #deck card runs the deck by itself — a lobby screen,
	 * a stand. Any keypress stops it, because someone has arrived.
	 */
	private startAutoAdvance(): void {
		const raw = this.scene.meta.advance;
		if (!raw) return;
		const m = raw.match(/([\d.]+)\s*(ms|s|m)?/i);
		if (!m) return;
		const n = parseFloat(m[1]);
		const unit = (m[2] ?? "s").toLowerCase();
		const ms = unit === "ms" ? n : unit === "m" ? n * 60000 : n * 1000;
		if (!Number.isFinite(ms) || ms < 500) return;

		this.autoAdvance = window.setInterval(() => {
			if (this.index >= this.scene.stops.length - 1) this.goTo(0);
			else this.advance();
		}, ms);
	}

	private stopAutoAdvance(): void {
		if (this.autoAdvance) window.clearInterval(this.autoAdvance);
		this.autoAdvance = 0;
	}

	/**
	 * Dive into the canvas this card points at, and come back to it.
	 *
	 * The parent is not torn down, only hidden — so returning lands on the same
	 * card, with the same history and the same notes still gathering.
	 */
	private async enterSubdeck(): Promise<void> {
		const node = this.stopAt(this.index).node;
		if (node.type !== "file" || !node.file?.endsWith(".canvas")) return;
		const file = fileAt(this.app, node.file);
		if (!file) {
			new Notice(`Atlas: ${node.file} is missing.`);
			return;
		}

		const child = new Presentation(this.app, file, this.settings);
		this.child = child;
		this.overlay.addClass("is-behind");
		child.onReturn = () => {
			this.child = null;
			this.overlay.removeClass("is-behind");
			// The parent went quiet while the child had the keyboard.
			setDeck(this);
			for (const listener of this.listeners) listener();
		};
		this.addChild(child);
		try {
			await child.start();
		} catch (e) {
			new Notice(`Atlas: ${String(e)}`);
			child.stop();
		}
	}

	/**
	 * The whole map, readable, with every card clickable.
	 *
	 * This used only to fly the camera out, which looked broken: off-camera
	 * cards sit at `--atl-inactive` — 0.18 in Paper — so the "overview" was one
	 * bright card in a field of ghosts, and the next arrow press flew straight
	 * back. Undimming is what makes it an overview rather than a wide shot.
	 *
	 * It is the counterpart to M, not a duplicate of it: M is the schematic
	 * index, fast and labelled, for a deck too big to read at once; this is the
	 * cards themselves, for picking the one you can see.
	 */
	private overviewing = false;
	/** Where the overview is looking, and how close. Held while you scroll. */
	private viewCx = 0;
	private viewCy = 0;
	private viewScale = 1;
	/** Whether the press that is ending was a drag rather than a click. */
	private dragged: (() => boolean) | null = null;

	private toggleOverview(): void {
		if (this.overviewing) this.closeOverview();
		else this.openOverview();
	}

	/**
	 * How big a card should be while browsing.
	 *
	 * Fitting the whole deck on screen is what M is for, and on any real deck it
	 * makes every card too small to read — which is the opposite of what you
	 * want when the question is "which one was it". So the zoom is set to show
	 * the current section, or about two and a half cards where there is no
	 * section, and then held while you scroll.
	 */
	private openOverview(): void {
		if (this.overviewing) return;
		this.overviewing = true;
		this.overlay.addClass("is-overview");

		// Exactly the framing the camera uses when it pulls back between
		// sections — the same call, so it is the same picture rather than a
		// near miss. Where there is no section, the card's own neighbourhood.
		const stop = this.stopAt(this.index);
		const frame = stop.group ?? stop.node;
		const pose = this.camera.poseFor(rectOf(frame));
		this.viewScale = stop.group ? pose.scale : pose.scale / 2.2;
		this.viewCx = pose.cx;
		this.viewCy = pose.cy;
		this.look(this.settings.duration);
	}

	/**
	 * Pan, holding the zoom.
	 *
	 * Nothing here chooses a card. Moving a selection about meant an arrow key
	 * yanked the camera back to whatever was selected, throwing away wherever
	 * you had scrolled to — so the arrows scroll too, and a card is chosen by
	 * clicking the one you can see.
	 */
	private look(duration: number): void {
		this.clampView();
		void this.camera.moveTo(
			{ cx: this.viewCx, cy: this.viewCy, scale: this.viewScale },
			duration
		);
	}

	/**
	 * Keep the deck on screen.
	 *
	 * Scrolling used to run off into empty space above the first group and keep
	 * going, which leaves you nowhere with nothing to steer by. You can overrun
	 * the edge by half a screen — enough to see that it is the edge — and no
	 * further. Where the whole deck already fits in one direction, it is simply
	 * centred in that direction.
	 */
	private clampView(): void {
		const b = this.scene.bounds;
		const halfW = this.overlay.clientWidth / this.viewScale / 2;
		const halfH = this.overlay.clientHeight / this.viewScale / 2;
		const pick = (lo: number, hi: number, half: number, centre: number, at: number) =>
			hi - lo < half * 2 ? centre : Math.min(Math.max(at, lo - half * 0.5), hi + half * 0.5);

		this.viewCx = pick(b.x, b.x + b.width, halfW, b.x + b.width / 2, this.viewCx);
		this.viewCy = pick(b.y, b.y + b.height, halfH, b.y + b.height / 2, this.viewCy);
	}

	private pan(dx: number, dy: number, duration = 180): void {
		this.viewCx += dx / this.viewScale;
		this.viewCy += dy / this.viewScale;
		this.look(duration);
	}

	/** The scale at which the whole deck is on screen — the floor for zooming. */
	private fitScale(): number {
		const b = this.scene.bounds;
		return Math.min(
			this.overlay.clientWidth / (b.width * 1.06 || 1),
			this.overlay.clientHeight / (b.height * 1.06 || 1)
		);
	}

	/**
	 * Zoom about a point, so what is under the cursor stays under the cursor.
	 *
	 * `ox`/`oy` are pixels from the middle of the screen; pass zero for the
	 * keyboard, which has no cursor to zoom about.
	 */
	private zoom(factor: number, ox = 0, oy = 0, duration = 0): void {
		const was = this.viewScale;
		const next = Math.min(
			Math.max(was * factor, this.fitScale()),
			Math.max(this.settings.maxScale, this.fitScale())
		);
		if (next === was) return;
		// The world point under the cursor, held still across the change.
		this.viewCx += ox / was - ox / next;
		this.viewCy += oy / was - oy / next;
		this.viewScale = next;
		this.look(duration);
	}

	/** Everything at once — the way out of being lost. */
	private showAll(): void {
		const b = this.scene.bounds;
		this.viewScale = this.fitScale();
		this.viewCx = b.x + b.width / 2;
		this.viewCy = b.y + b.height / 2;
		this.look(300);
	}

	private closeOverview(go?: number): void {
		if (!this.overviewing) return;
		this.overviewing = false;
		this.overlay.removeClass("is-overview");
		if (go === undefined) this.goTo(this.index, { animate: true });
		else this.jumpTo(go);
	}

	private tickClock(): void {
		if (!this.timerEl) return;
		const mode = this.settings.timer;
		const parts: string[] = [];
		if (mode === "elapsed" || mode === "both") parts.push(mmss(Date.now() - this.began));
		if (mode === "clock" || mode === "both") parts.push(hhmm());
		this.timerEl.setText(parts.join("  ·  "));
	}

	/** Collect %%notes%% once, rather than re-reading a file on every move. */
	private async collectNotes(): Promise<void> {
		for (const node of this.scene.slides) {
			if (node.type === "text") {
				const text = speakerNotes(node.text ?? "");
				if (text) this.notes.set(node.id, text);
			} else if (node.type === "file" && node.file?.endsWith(".md")) {
				const raw = await readFileAt(this.app, node.file);
				const text = raw ? speakerNotes(raw) : "";
				if (text) this.notes.set(node.id, text);
			}
		}
	}

	/**
	 * The deck's line, as text.
	 *
	 * `{deck} {section} {n} {total} {date}` and any key from the #deck card.
	 * It used to be drawn as markdown into a band across the top of the screen,
	 * shown on section overviews only — which put the deck's name, the section
	 * and the position on screen twice, since the bar carries all three, and
	 * the two disagreed: the band counted stops, the bar counts cards. One
	 * line, in the place that is always visible and never over the slide.
	 */
	private headerLine(stop: Stop): string {
		const meta = this.scene.meta;
		const template = meta.header ?? this.settings.headerText;
		if (!template.trim()) return "";
		return template
			.replace(/\{(\w[\w -]*)\}/g, (whole, key: string) => {
				// Normalised the same way the #deck card's keys are stored, so
				// `{logo corner}` finds `logo corner:` — it did not, because the
				// key was filed under `logocorner` and looked up verbatim.
				const value = meta[key.toLowerCase().replace(/[ -]/g, "")];
				return value === undefined ? whole : value;
			})
			.replace(/\{deck\}/g, this.file.basename)
			.replace(/\{section\}/g, stop.group?.label ?? "")
			// Cards, the way the bar has always counted, rather than stops —
			// which included the section overviews and made the same slide 6/17
			// here and 4/12 an inch below.
			.replace(/\{n\}/g, String(this.cardNumber(this.index)))
			.replace(/\{total\}/g, String(this.cardTotal))
			.replace(/\{date\}/g, new Date().toLocaleDateString())
			.trim();
	}

	private renderHeader(stop: Stop): void {
		// The section name lives on the group itself, above it and to the
		// left, so it sits in the map rather than floating over it.
		for (const group of this.scene.groups) {
			const el = this.nodeEls.get(group.id);
			el?.toggleClass("is-current-section", group.id === stop.group?.id);
		}
	}

	/**
	 * Cards, not stops.
	 *
	 * A section overview is a stop but not a card, so counting stops made the
	 * number jump by two where the audience saw one new slide — and disagreed
	 * with the numbered badges on the map, which count cards.
	 */
	private get cardTotal(): number {
		return this.scene.stops.filter((s) => s.kind === "node" && !this.isBanner(s)).length;
	}

	/**
	 * The banner is not card one.
	 *
	 * It is the deck's own card, presented before the talk starts — the cover,
	 * not the first thing being said. Counting it put every card one ahead of
	 * where the deck plainly was, and an exported page numbered the same way
	 * would disagree with anyone's notes. It is numbered 0, which is to say not
	 * numbered: nothing shows a number on it.
	 */
	private cardNumber(index: number): number {
		const stop = this.scene.stops[index];
		if (stop && this.isBanner(stop)) return 0;
		let seen = 0;
		for (let i = 0; i <= index; i++) {
			const s = this.scene.stops[i];
			if (s?.kind === "node" && !this.isBanner(s)) seen++;
		}
		// On a section overview, name the card it is about to show.
		return stop?.kind === "node" ? seen : Math.min(seen + 1, this.cardTotal);
	}

	/**
	 * Is this stop the deck's banner?
	 *
	 * The banner is a synthetic node built from the #deck card, so it is the
	 * only stop whose node is not in the canvas file. Matching on the id is
	 * enough, and it survives a rebuild of the scene.
	 */
	private isBanner(stop: Stop): boolean {
		return stop.kind === "node" && stop.node.id === this.scene.stops[0]?.node.id
			&& !!this.scene.meta.__body;
	}

	/**
	 * Which cards have a note on them, marked on the cards themselves.
	 *
	 * The Remark button lights up on a card that has one, but that says nothing
	 * about the card you are about to reach — and on the overview the whole
	 * deck is on screen at once. One dot, on the card itself, answers both.
	 */
	private markNotedCards(): void {
		const noted = new Set(this.captures.map((c) => c.nodeId));
		// A note that carries an audio embed was spoken rather than typed. R
		// stores a spoken note as an ordinary note with the clip embedded in
		// it, so this is the only thing that tells the two apart — and it is
		// the same mark either way, with a ring round it, rather than a second
		// indicator meaning something adjacent.
		const spoken = new Set(
			this.captures.filter((c) => AUDIO_EXT.test(c.text)).map((c) => c.nodeId)
		);
		for (const [id, el] of this.nodeEls) {
			el.toggleClass("has-note", noted.has(id));
			el.toggleClass("has-audio", spoken.has(id));
		}
	}

	private updateHud(stop: Stop, stepCount: number): void {
		this.renderHeader(stop);
		// The logo belongs to the deck, so on the deck's own card it is shown
		// at its own size rather than as the small standing mark.
		this.overlay.toggleClass("is-banner", this.isBanner(stop));

		if (this.railFill) {
			const through = this.index / Math.max(1, this.scene.stops.length - 1);
			this.railFill.style.width = `${through * 100}%`;
		}

		const remark = this.hud.querySelector<HTMLElement>(".atl-map-btn[data-key='N']");
		if (remark) {
			remark.setText(this.captures.length ? `Remark ${this.captures.length}` : "Remark");
			remark.toggleClass("has-note", this.captures.some((c) => c.nodeId === stop.node.id));
		}
		this.markNotedCards();

		if (this.nextEl) {
			const upcoming = this.scene.stops[this.index + 1];
			this.nextEl.setText(
				upcoming ? `Next · ${titleOf(upcoming.node)}` : "Last card"
			);
		}
		const crumbs = this.hud.querySelector<HTMLElement>(".atl-crumbs");
		const counter = this.hud.querySelector<HTMLElement>(".atl-counter");
		if (crumbs) {
			// What the deck card asked for, or the breadcrumbs when it asked for
			// nothing. Hidden on the banner, where a position and a section name
			// make an opening slide look unfinished.
			const line = this.settings.showHeader && !this.isBanner(stop) ? this.headerLine(stop) : "";
			if (line) {
				crumbs.setText(line);
			} else {
				const parts = [this.file.basename];
				if (stop.group && stop.group.label) parts.push(stop.group.label);
				crumbs.setText(this.isBanner(stop) ? this.file.basename : parts.join("  ›  "));
			}
		}
		if (counter) {
			const reveal = stepCount > 0 ? ` · ${this.stepIndex}/${stepCount}` : "";
			counter.setText(`${this.cardNumber(this.index)} / ${this.cardTotal} ${reveal}`.trim());
		}
	}

	/** Told when the deck ends, however it ends, so the plugin can forget it. */
	onStopped: (() => void) | null = null;

	private stopped = false;

	stop(unloading = false): void {
		// A deck can be stopped from several directions at once — the tab
		// closing, Escape, and the next deck starting. Writing the minutes twice
		// or unloading twice is not something to leave to chance.
		if (this.stopped) return;
		this.stopped = true;
		this.stopAutoAdvance();
		// The microphone goes back before anything else. A recording that
		// outlived the deck would keep the light on with nothing watching it,
		// and the audio would have nowhere to be written.
		this.recorder?.dispose();
		this.recorder = null;
		this.hideRecordingPip();

		// A headless deck was never presented: it registered nothing, took no
		// keys and owns no screen. Running the full teardown had it unregister
		// the *live* deck from the presenter panel and drop the real talk out of
		// fullscreen — exporting one canvas broke the one being presented.
		if (this.headless) {
			this.overlay?.remove();
			this.unload();
			return;
		}
		// Leaving is the one click: a talk that was noted gets written up.
		//
		// Closing the tab used to skip this, which was right when a write-up
		// meant a new dated file — but the deck's one note is written here too,
		// and skipping it left the remarks nowhere but the crash journal. Every
		// talk closed by its tab then came back on the next launch as a session
		// that "was never written up", because it never was.
		//
		// The note is written either way now; only the opening of it is skipped
		// when the deck is going away under us.
		const unsaved = !this.written && this.captures.length > 0;
		if (unsaved && (this.settings.deckNotes || this.settings.minutesOnExit)) {
			void this.writeUp(!unloading);
		}
		// Returning to a parent hands the deck back; nulling it here would blank
		// the presenter window the instant you came up a level.
		const returned = !!this.onReturn;
		this.onReturn?.();
		this.onReturn = null;
		if (!returned) setDeck(null);
		this.listeners.clear();
		// Obsidian restores its own windows, so leave the leaf alone on unload.
		if (!unloading) {
			try {
				this.presenterLeaf?.detach();
			} catch {
				// Closed by hand already.
			}
		}
		this.presenterLeaf = null;
		if (this.ticker) window.clearInterval(this.ticker);
		this.ticker = 0;
		this.closeVaultGraph(unloading);
		// The graph runs an animation loop while it is open. Removing the
		// overlay does not stop it — it would keep drawing into a detached
		// canvas for as long as Obsidian stayed open.
		this.browser?.hide();
		this.minimap?.hide();
		this.peek?.close();
		this.closeSite();
		if (this.doc.fullscreenElement) void this.doc.exitFullscreen();
		if (this.onKey) this.doc.removeEventListener("keydown", this.onKey, true);
		if (this.onResize) this.win.removeEventListener("resize", this.onResize);
		this.dropTheme();
		if (this.overlay) this.overlay.remove();
		this.closeDeckTab(unloading);
		const done = this.onStopped;
		this.onStopped = null;
		done?.();
		this.unload();
	}
}
