import {
	App,
	Component,
	MarkdownRenderer,
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
	resourcePath,
	slideshowsIn,
	speakerNotes,
	titleOf,
} from "./render";
import { Slideshow } from "./slideshow";
import { exportDeck } from "./export";

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

	async start(): Promise<void> {
		const data = parseCanvas(await this.app.vault.cachedRead(this.file));
		// A canvas may name its own default talk; an explicit choice wins.
		const declared = readDeckVariant(data);
		this.variant = this.variant || declared;
		this.scene = buildScene(data, this.settings.sectionOverviews, this.variant);
		if (this.scene.stops.length === 0) {
			new Notice("Atlas: this canvas has no cards to present.");
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
		return this.app.vault.cachedRead(file);
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
		this.overlay = document.body.createDiv({ cls: "atl-overlay" });
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
			// Click the right two-thirds to advance, the left third to go back.
			if (e.clientX > window.innerWidth / 3) this.next();
			else this.prev();
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
				this.next();
			} else if (key === "ArrowLeft" || key === "PageUp" || key === "ArrowUp") {
				handled();
				this.prev();
			} else if (key === "Home") {
				handled();
				this.goTo(0);
			} else if (key === "End") {
				handled();
				this.goTo(this.scene.stops.length - 1);
			} else if (key === "o" || key === "O") {
				handled();
				this.overview();
			} else if (key === "e" || key === "E") {
				handled();
				void this.exportToHtml();
			} else if (key === "f" || key === "F") {
				handled();
				if (document.fullscreenElement) void document.exitFullscreen();
				else void this.overlay.requestFullscreen().catch(() => undefined);
			}
		};
		// Capture phase, so Obsidian's own hotkeys do not steal the arrow keys.
		document.addEventListener("keydown", this.onKey, true);

		this.onResize = () => this.goTo(this.index, { animate: false });
		window.addEventListener("resize", this.onResize);
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
		this.overlay.addClass("is-away");
		const bar = document.body.createDiv({ cls: "atl-return" });
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
		this.overlay.removeClass("is-away");
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
	private next(): void {
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

	private prev(): void {
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
	async exportToHtml(): Promise<void> {
		new Notice("Atlas: exporting…");
		// Obsidian injects a plugin's styles.css as a <style> element; find ours
		// by something only it contains.
		const pluginCss =
			Array.from(document.querySelectorAll("style"))
				.map((el) => el.textContent ?? "")
				.find((text) => text.includes(".atl-stage") && text.includes(".atl-node")) ?? "";

		await exportDeck(this.app, {
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
		});
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
		if (!this.settings.showNotes) return;
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
				void MarkdownRenderer.render(this.app, filled, this.header, this.file.path, this);
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
			this.notesEl.toggleClass("is-shown", !!text);
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

	stop(unloading = false): void {
		if (this.ticker) window.clearInterval(this.ticker);
		this.ticker = 0;
		this.closeVaultGraph(unloading);
		// The graph runs an animation loop while it is open. Removing the
		// overlay does not stop it — it would keep drawing into a detached
		// canvas for as long as Obsidian stayed open.
		this.browser?.hide();
		this.minimap?.hide();
		this.peek?.close();
		if (document.fullscreenElement) void document.exitFullscreen();
		if (this.onKey) document.removeEventListener("keydown", this.onKey, true);
		if (this.onResize) window.removeEventListener("resize", this.onResize);
		if (this.overlay) this.overlay.remove();
		this.unload();
	}
}
