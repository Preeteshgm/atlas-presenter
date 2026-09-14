import {
	App,
	Component,
	Notice,
	TFile,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import { AtlasSettings, Scene, Stop } from "../types";
import { parseCanvas, rectOf } from "../canvas/parse";
import { readDeckVariant } from "../canvas/path";
import { buildScene } from "../canvas/path";
import { Camera } from "./camera";
import { Minimap } from "./minimap";
import { Peek } from "./peek";
import { Browser } from "./browse";
import {
	buildSteps,
	renderNode,
	renderMarkdownInto,
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
	CaptureModal,
	MinutesOptions,
	ReviewModal,
	Session,
	Visit,
	writeMinutes,
} from "./capture";

/** Anything that handles its own clicks must not also advance the slide. */
const INTERACTIVE = "a, button, video, audio, iframe, input, textarea, select, .atl-hud";

export class Presentation extends Component {
	private overlay!: HTMLElement;
	private stage!: HTMLElement;
	private camera!: Camera;
	private minimap!: Minimap;
	private peek!: Peek;
	private browser!: Browser;
	private hud!: HTMLElement;
	private header: HTMLElement | null = null;
	private headerRendered = "";
	private notesEl: HTMLElement | null = null;
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
	/** True while the deck has a window to itself. */
	private windowed = false;
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
		this.settings = this.withDeckOverrides(this.settings);
		this.themeCss = await this.loadThemeCss();
		await this.collectNotes();
		this.buildChrome();
		await this.buildStage();

		this.peek = new Peek(this.overlay, this.app, this);
		this.browser = new Browser(this.overlay, this.app, (file) => void this.peek.showFile(file));
		this.minimap = new Minimap(this.overlay, this.app, this.scene, (i) => this.jumpTo(i));
		this.began = Date.now();
		if (this.headless) {
			// Everything past this point is about being driven by someone.
			this.goTo(this.startIndex(), { animate: false });
			return;
		}
		setDeck(this);
		if (this.windowed) await this.openPresenterPanel();
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
				"→ advances · M for the map · click a link to peek · Esc exits",
			6000
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

		if (m.theme) next.themeCss = m.theme;
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
		if (m.headeron) next.headerScope = m.headeron as AtlasSettings["headerScope"];
		if (m.headerposition) {
			next.headerPosition = m.headerposition as AtlasSettings["headerPosition"];
		}
		return next;
	}

	private async loadThemeCss(): Promise<string> {
		const path = this.settings.themeCss;
		if (!path) return "";
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) {
			new Notice(`Atlas: theme file not found — ${path}`);
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
	private applyTheme(): void {
		const s = this.settings;
		this.overlay.style.setProperty("--atl-inactive", String(s.inactiveOpacity));
		// The section name used to be a floating overlay; it now lives on the
		// group itself, so this is what the setting governs.
		this.overlay.toggleClass("hide-sections", !s.sectionTitles);
		if (s.accent) this.overlay.style.setProperty("--atl-accent", s.accent);

		if (s.background === "colour") {
			this.overlay.style.background = s.backgroundColour;
		} else if (s.background === "image" && s.backgroundImage) {
			const url = resourcePath(this.app, s.backgroundImage);
			this.overlay.style.backgroundImage = `url("${url}")`;
			this.overlay.addClass("has-image");
			// A dim layer keeps slide text readable over an arbitrary photo.
			this.overlay.style.setProperty("--atl-dim", String(s.backgroundDim));
		}

		if (s.logo) {
			const logo = this.overlay.createEl("img", { cls: "atl-logo" });
			logo.src = resourcePath(this.app, s.logo);
			logo.dataset.corner = s.logoCorner;
			logo.style.height = `${s.logoHeight}px`;
			logo.style.opacity = String(s.logoOpacity);
		}
	}

	private buildChrome(): void {
		this.overlay = (this.headless ?? this.doc.body).createDiv({ cls: "atl-overlay" });
		if (this.themeCss) {
			this.overlay.createEl("style", { text: this.themeCss });
		}
		this.applyTheme();
		const viewport = this.overlay.createDiv({ cls: "atl-viewport" });
		this.stage = viewport.createDiv({ cls: "atl-stage" });
		this.camera = new Camera(this.stage, viewport, {
			padding: this.settings.padding,
			maxScale: this.settings.maxScale,
			fit: this.settings.fit,
			align: this.settings.verticalAlign,
		});

		if (
			this.settings.headerText ||
			this.scene.meta.header ||
			this.scene.meta.__body ||
			this.scene.meta.title
		) {
			this.header = this.overlay.createDiv({ cls: "atl-header" });
			this.header.dataset.position = this.settings.headerPosition;
		}
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
		if (this.settings.showNotes || this.settings.showNext) {
			const band = this.overlay.createDiv({ cls: "atl-band" });
			if (this.settings.showNotes) {
				this.notesEl = band.createDiv({ cls: "atl-notes" });
			}
			if (this.settings.showNext) {
				this.nextEl = band.createDiv({ cls: "atl-next" });
			}
		}

		this.hud = this.overlay.createDiv({ cls: "atl-hud" });
		this.hud.toggleClass("is-hidden", !this.settings.showHud);
		this.hud.createDiv({ cls: "atl-crumbs" });

		const right = this.hud.createDiv({ cls: "atl-hud-right" });
		// The map is the whole point of the plugin, so it needs a control on
		// screen. A bare keyboard shortcut is invisible to anyone who has not
		// read the README.
		const mapBtn = right.createEl("button", { cls: "atl-map-btn", text: "Map" });
		mapBtn.setAttribute("aria-label", "Open the map (M)");
		mapBtn.dataset.key = "M";
		mapBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.minimap.toggle();
		});

		const browseBtn = right.createEl("button", { cls: "atl-map-btn", text: "Notes" });
		browseBtn.setAttribute("aria-label", "Browse every note in the vault (G)");
		browseBtn.dataset.key = "G";
		browseBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this.settings.browser === "obsidian") void this.openVaultGraph();
			else this.browser.toggle();
		});

		if (this.settings.timer !== "off") {
			this.timerEl = right.createDiv({ cls: "atl-timer" });
			this.began = Date.now();
			this.tickClock();
			this.ticker = window.setInterval(() => this.tickClock(), 1000);
		}

		// The same treatment as Map and Notes: a key nobody can guess needs a
		// control they can see.
		const remarkBtn = right.createEl("button", { cls: "atl-map-btn", text: "Remark" });
		remarkBtn.setAttribute("aria-label", "Note something against this card (N)");
		remarkBtn.dataset.key = "N";
		remarkBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.captureNote();
		});

		const writeBtn = right.createEl("button", { cls: "atl-map-btn", text: "Write up" });
		writeBtn.setAttribute("aria-label", "Write the session up as a note (W)");
		writeBtn.dataset.key = "W";
		writeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.reviewSession();
		});

		const counter = right.createDiv({ cls: "atl-counter" });
		counter.toggleClass("is-hidden", !this.settings.showCounter);

		// Wikilinks open the note in place rather than navigating Obsidian
		// underneath the deck, which would leave you somewhere else on exit.
		this.stage.addEventListener("click", (e) => {
			const link = this.matchInPath(e, "a.internal-link");
			if (!link) return;
			e.preventDefault();
			e.stopPropagation();
			const href = link.getAttr("href") ?? link.innerText;
			if (href) void this.peek.show(href, this.file.path);
		});

		viewport.addEventListener("click", (e) => {
			if (this.minimap?.isOpen || this.peek?.isOpen || this.browser?.isOpen) return;
			if (this.matchInPath(e, INTERACTIVE)) return;
			// Acting on an event means owning it: anything left to travel reaches
			// the app behind the deck.
			e.preventDefault();
			e.stopPropagation();
			// Click the right two-thirds to advance, the left third to go back.
			if (e.clientX > this.win.innerWidth / 3) this.advance();
			else this.retreat();
		});
	}

	private async buildStage(): Promise<void> {
		// Groups first so they sit behind the cards they contain.
		for (const g of this.scene.groups) {
			this.nodeEls.set(
				g.id,
				await renderNode(
					this.app,
					this,
					this.stage,
					g,
					this.file.path,
					this.themeCss,
					this.settings.allowScripts
				)
			);
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
			this.nodeEls.set(n.id, el);
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

			if (this.away) {
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
				this.overview();
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
			if (node instanceof HTMLElement && node.matches(selector)) return node;
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

		const target = rectOf(stop.node);
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
		}
		for (const listener of this.listeners) listener();
	}

	/**
	 * Tell a card it is on or off camera.
	 *
	 * A slide running its own animation loop would otherwise burn a core on
	 * every card in the deck at once, forever. HTML cards listen for these on
	 * their shadow host: `document.currentScript.getRootNode().host`.
	 */
	private signal(nodeId: string, kind: "enter" | "leave"): void {
		const body = this.nodeEls.get(nodeId)?.querySelector<HTMLElement>(".atl-body");
		body?.dispatchEvent(new CustomEvent(`atlas-presenter:${kind}`));
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
	private async openVaultGraph(): Promise<void> {
		if (this.away) return;
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

		this.away = true;
		// With the deck in a window of its own, the graph opens in the main
		// window — on your screen, beside the canvas — and the projector goes on
		// showing the card. There is nothing to step aside from, and no way back
		// to offer: the deck never left.
		if (this.windowed) return;

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
		if (!this.away) return;
		this.away = false;
		this.returnBar?.remove();
		this.returnBar = null;
		try {
			if (!keepLeaf) this.awayLeaf?.detach();
		} catch {
			// The tab may already be closed by hand; nothing to undo.
		}
		this.awayLeaf = null;
		this.overlay?.removeClass("is-away");
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
			padding: this.settings.padding,
			maxScale: this.settings.maxScale,
			stops: this.scene.stops.map((stop) => {
				const r = rectOf(stop.node);
				return {
					nodeId: stop.node.id,
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height,
					label: stop.kind === "group" ? stop.node.label ?? "" : "",
				};
			}),
		};
	}

	async exportToHtml(): Promise<void> {
		new Notice("Atlas: exporting…");
		await exportDeck(this.app, this.exportInput());
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
			section: stop.group?.label ?? "",
			card: titleOf(stop.node),
			notes: this.notes.get(stop.node.id) ?? "",
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
	async useOwnWindow(): Promise<boolean> {
		try {
			const leaf = this.app.workspace.openPopoutLeaf();
			await leaf.setViewState({ type: DECK_VIEW, active: true });

			// Deliberately not an `instanceof DeckView` test. Obsidian may hand
			// back a deferred stand-in for a view it has not rendered yet, and
			// failing on that would mean the second attempt at presenting
			// silently fell back to the main window. What actually matters is
			// that this is a *different* document from the one we are in.
			const doc = leaf.view.containerEl.ownerDocument;
			const win = doc.defaultView;
			if (!win || doc === document) {
				leaf.detach();
				return false;
			}

			this.deckLeaf = leaf;
			this.doc = doc;
			this.win = win;
			this.windowed = true;

			// Closing the window by hand is a way of ending the talk, and must
			// end it properly — the write-up included. The view hook is the
			// clean way; `pagehide` catches the window going with the view
			// deferred, so the deck can never be left running with no screen.
			if (leaf.view instanceof DeckView) {
				leaf.view.onWindowClose = () => {
					this.deckLeaf = null;
					this.stop();
				};
			}
			this.win.addEventListener(
				"pagehide",
				() => {
					this.deckLeaf = null;
					this.stop();
				},
				{ once: true }
			);
			return true;
		} catch {
			return false;
		}
	}

	/** Obsidian restores its own windows, so leave the leaf alone on unload. */
	private closeDeckWindow(unloading: boolean): void {
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
			this.app.workspace.revealLeaf(leaf);
			this.presenterLeaf = leaf;
		} catch {
			// No sidebar to put it in; P still opens a window.
		}
	}

	private async openPresenter(): Promise<void> {
		if (this.presenterLeaf) {
			this.app.workspace.setActiveLeaf(this.presenterLeaf, { focus: true });
			return;
		}
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
	private captureNote(): void {
		const stop = this.stopAt(this.index);
		const title = titleOf(stop.node);
		const existing = this.captures.filter((c) => c.nodeId === stop.node.id);
		const firstAt = existing.length > 0 ? existing[0].at : Date.now();

		this.capturing = true;
		new CaptureModal(
			this.app,
			title,
			existing.map((c) => c.text).join("\n\n"),
			(text) => {
				this.captures = this.captures.filter((c) => c.nodeId !== stop.node.id);
				if (text) {
					this.captures.push({ nodeId: stop.node.id, title, text, at: firstAt });
					new Notice(`Atlas: noted against “${title}”`);
				} else {
					new Notice(`Atlas: note on “${title}” removed`);
				}
				this.updateHud(this.stopAt(this.index), 0);
				for (const listener of this.listeners) listener();
			},
			// However it closes — saved or dismissed — the deck takes the
			// keyboard back only then. A timer here would hand it back mid-word.
			() => {
				this.capturing = false;
			}
		).open();
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

		this.capturing = true;
		const modal = new ReviewModal(this.app, {
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
				this.updateHud(this.stopAt(this.index), 0);
			},
			onWrite: () => void this.writeUp(),
		});
		const close = modal.onClose.bind(modal);
		modal.onClose = () => {
			close();
			this.capturing = false;
		};
		modal.open();
	}

	private minutesOptions(): MinutesOptions {
		return {
			actionSuffix: this.settings.actionSuffix,
			linkBack: this.settings.actionsLinkBack,
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
		};
	}

	/**
	 * The talk, written up as one note — and then opened, so it is not a file
	 * you have to go looking for.
	 */
	async writeUp(): Promise<void> {
		if (this.captures.length === 0 && this.visits.length === 0) {
			new Notice("Atlas: nothing to write up yet.");
			return;
		}
		const file = await writeMinutes(
			this.app,
			this.session(),
			this.settings.minutesFolder,
			this.minutesOptions()
		);
		this.written = true;
		if (!file) return;

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
		const file = this.app.vault.getAbstractFileByPath(normalizePath(node.file));
		if (!(file instanceof TFile)) {
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

	private overview(): void {
		void this.camera.flyTo(this.scene.bounds, this.settings.duration);
	}

	private tickClock(): void {
		if (!this.timerEl) return;
		const mode = this.settings.timer;
		const parts: string[] = [];
		if (mode === "elapsed" || mode === "both") {
			const secs = Math.floor((Date.now() - this.began) / 1000);
			const mm = String(Math.floor(secs / 60)).padStart(2, "0");
			const ss = String(secs % 60).padStart(2, "0");
			parts.push(`${mm}:${ss}`);
		}
		if (mode === "clock" || mode === "both") {
			parts.push(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
		}
		this.timerEl.setText(parts.join("  ·  "));
	}

	/** Collect %%notes%% once, rather than re-reading a file on every move. */
	private async collectNotes(): Promise<void> {
		for (const node of this.scene.slides) {
			if (node.type === "text") {
				const text = speakerNotes(node.text ?? "");
				if (text) this.notes.set(node.id, text);
			} else if (node.type === "file" && node.file?.endsWith(".md")) {
				const file = this.app.vault.getAbstractFileByPath(normalizePath(node.file));
				if (file instanceof TFile) {
					const text = speakerNotes(await this.app.vault.cachedRead(file));
					if (text) this.notes.set(node.id, text);
				}
			}
		}
	}

	/** {deck} {section} {n} {total} {date} in the header line. */
	private renderHeader(stop: Stop): void {
		if (this.header) {
			// A card fills the screen, so a header over it can only overlap. A
			// group overview leaves the band above it empty, which is exactly
			// where a title belongs.
			const scope = this.settings.headerScope;
			const visible =
				scope === "always" ||
				(scope === "first" && this.index === 0) ||
				(scope === "sections" && (stop.kind === "group" || this.index === 0));
			this.header.toggleClass("is-shown", visible);

			const meta = this.scene.meta;
			const template = meta.header ?? meta.__body ?? this.settings.headerText;
			const filled = template
				.replace(/\{(\w[\w -]*)\}/g, (whole, key: string) => {
					const value = meta[key.toLowerCase()];
					return value === undefined ? whole : value;
				})
				.replace(/\{deck\}/g, this.file.basename)
				.replace(/\{section\}/g, stop.group?.label ?? "")
				.replace(/\{n\}/g, String(this.index + 1))
				.replace(/\{total\}/g, String(this.scene.stops.length))
				.replace(/\{date\}/g, new Date().toLocaleDateString());
			// Rendered rather than set as text, so the deck card can carry a
			// heading, emphasis, a link or a small image in its header.
			if (filled !== this.headerRendered) {
				this.headerRendered = filled;
				this.header.empty();
				void renderMarkdownInto(this.app, this, this.header, filled, this.file.path);
			}
		}

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
		return this.scene.stops.filter((s) => s.kind === "node").length;
	}

	private cardNumber(index: number): number {
		let seen = 0;
		for (let i = 0; i <= index; i++) {
			if (this.scene.stops[i]?.kind === "node") seen++;
		}
		// On a section overview, name the card it is about to show.
		return this.scene.stops[index]?.kind === "node" ? seen : Math.min(seen + 1, this.cardTotal);
	}

	private updateHud(stop: Stop, stepCount: number): void {
		this.renderHeader(stop);

		if (this.railFill) {
			const through = this.index / Math.max(1, this.scene.stops.length - 1);
			this.railFill.style.width = `${through * 100}%`;
		}

		if (this.notesEl) {
			const text = this.notes.get(stop.node.id) ?? "";
			this.notesEl.setText(text);
			// Never on the audience's screen. Notes come off the deck the moment
			// there is anywhere else to read them — and always when the deck has
			// a window of its own, because then the deck *is* the projector and
			// the main window is where you are looking. No setting overrides
			// this: the cost of getting it wrong is your notes on a wall.
			const elsewhere = !!this.presenterLeaf || this.windowed;
			this.notesEl.toggleClass("is-shown", !!text && !elsewhere);
		}

		const remark = this.hud.querySelector<HTMLElement>(".atl-map-btn[data-key='N']");
		if (remark) {
			remark.setText(this.captures.length ? `Remark ${this.captures.length}` : "Remark");
			remark.toggleClass("has-note", this.captures.some((c) => c.nodeId === stop.node.id));
		}

		if (this.nextEl) {
			const upcoming = this.scene.stops[this.index + 1];
			this.nextEl.setText(
				upcoming ? `Next · ${titleOf(upcoming.node)}` : "Last card"
			);
		}
		const crumbs = this.hud.querySelector<HTMLElement>(".atl-crumbs");
		const counter = this.hud.querySelector<HTMLElement>(".atl-counter");
		if (crumbs) {
			const parts = [this.file.basename];
			if (stop.group && stop.group.label) parts.push(stop.group.label);
			crumbs.setText(parts.join("  ›  "));
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
		// A deck can be stopped from several directions at once — the window
		// closing, Escape, and the next deck starting. Writing the minutes twice
		// or unloading twice is not something to leave to chance.
		if (this.stopped) return;
		this.stopped = true;
		this.stopAutoAdvance();
		// Leaving is the one click: a talk that was noted gets written up.
		if (!unloading && !this.written && this.captures.length > 0 && this.settings.minutesOnExit) {
			// Leaving is the one click, so the note opens rather than waiting to
			// be found.
			void this.writeUp();
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
		if (this.doc.fullscreenElement) void this.doc.exitFullscreen();
		if (this.onKey) this.doc.removeEventListener("keydown", this.onKey, true);
		if (this.onResize) this.win.removeEventListener("resize", this.onResize);
		if (this.overlay) this.overlay.remove();
		this.closeDeckWindow(unloading);
		const done = this.onStopped;
		this.onStopped = null;
		done?.();
		this.unload();
	}
}
