import { App, Component, MarkdownRenderer, TFile, normalizePath } from "obsidian";
import { isElement } from "../dom";
import { CanvasNode } from "../types";
import { boundsOf, outsideCode, parseCanvas, rectOf } from "../canvas/parse";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from "../media";

/** Anything already addressable stays untouched. */
const ABSOLUTE = /^(https?:|data:|app:|blob:|file:|capacitor:)/i;

/** ```slide-html … ``` is the escape hatch: raw HTML+CSS for one card. */
const HTML_FENCE = /```(?:slide-html|html-slide)\s*\n([\s\S]*?)```/;

/** %%comments%% are speaker-only and never reach the screen. */
function stripComments(md: string): string {
	return md.replace(/%%[\s\S]*?%%/g, "");
}

export function speakerNotes(md: string): string {
	const notes: string[] = [];
	for (const m of md.matchAll(/%%([\s\S]*?)%%/g)) notes.push(m[1].trim());
	return notes.join("\n\n");
}

function cleanTitle(s: string): string {
	return s
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "image")
		.replace(/!?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
		.replace(/^#+\s*/, "")
		.replace(/^[->*+\s]+/, "")
		.replace(/[*_`~]/g, "")
		.trim();
}


/** A line holding nothing but tags: `#title #dark`. Not a heading, which needs a space. */
const TAG_LINE = /^[ \t]*#[\w\-/]+(?:[ \t]+#[\w\-/]+)*[ \t]*$/;

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Styling hooks that leave the card clean.
 *
 * Writing CSS inside a card means the note is unreadable on its own and
 * unshareable — the formatting should live in one stylesheet and the card should
 * only say what kind of card it is. A line of bare tags does that: it reads as
 * ordinary Obsidian, and it never reaches the slide.
 */
function extractHooks(md: string): { classes: string[]; text: string } {
	const classes: string[] = [];
	const kept: string[] = [];
	// A tag shown inside a code sample is documentation, not a hook — a card
	// explaining `#dark` should not itself turn dark.
	const bare = new Set(outsideCode(md).split("\n"));
	for (const line of md.split("\n")) {
		if (TAG_LINE.test(line) && bare.has(line)) {
			for (const tag of line.trim().split(/\s+/)) {
				const name = slug(tag.replace(/^#/, ""));
				if (name) classes.push(`atl-tag-${name}`);
			}
			continue;
		}
		kept.push(line);
	}
	return { classes, text: kept.join("\n") };
}

/** Obsidian's own `cssclasses:` frontmatter, honoured for note cards. */
function frontmatterClasses(app: App, file: TFile): string[] {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const raw = (fm?.cssclasses ?? fm?.cssclass) as unknown;
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
	return list.map((c) => slug(String(c))).filter(Boolean);
}

/**
 * An Excalidraw drawing is stored as markdown with the drawing's JSON inside,
 * so the extension alone does not identify one. The plugin always writes an
 * `excalidraw-plugin` key into the frontmatter.
 */
function isExcalidraw(app: App, file: TFile): boolean {
	if (/\.excalidraw$/i.test(file.path)) return true;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!fm && "excalidraw-plugin" in fm;
}

interface ExcalidrawAutomate {
	reset?: () => void;
	createSVG?: (
		templatePath?: string,
		embedFont?: boolean,
		exportSettings?: unknown,
		loader?: unknown,
		theme?: string,
		padding?: number
	) => Promise<SVGSVGElement>;
}

function excalidrawApi(app: App): ExcalidrawAutomate | null {
	const fromPlugin = (
		app as unknown as {
			plugins?: { plugins?: Record<string, { ea?: ExcalidrawAutomate }> };
		}
	).plugins?.plugins?.["obsidian-excalidraw-plugin"]?.ea;
	const fromWindow = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomate })
		.ExcalidrawAutomate;
	return fromPlugin ?? fromWindow ?? null;
}

/**
 * Hand the drawing to Excalidraw and put the SVG it returns on the card.
 * Returns false when there is nothing we can do, so the caller can say why.
 */
async function renderExcalidraw(app: App, body: HTMLElement, file: TFile): Promise<boolean> {
	const ea = excalidrawApi(app);
	if (!ea?.createSVG) return false;
	try {
		ea.reset?.();
		const svg = await ea.createSVG(file.path, true);
		if (!svg) return false;
		svg.addClass("atl-drawing");
		// The plugin sizes the SVG to the drawing; let the card decide instead.
		svg.removeAttribute("width");
		svg.removeAttribute("height");
		svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
		body.appendChild(svg);
		return true;
	} catch {
		return false;
	}
}

/**
 * Names a camera or a paste never chose.
 *
 * `Pasted image 20251029102222` is not a slide title. Where a filename is
 * clearly automatic, the card is named by what it is and when, which at least
 * reads as English on the map. A file you named yourself is left alone.
 */
const AUTO_NAMED = [
	/^Pasted image (\d{8})/i,
	/^Recording (\d{8})/i,
	/^Screenshot[ _-]?(\d{8})/i,
	/^(?:IMG|DSC|PXL|VID|MOV)[ _-]?\d+/i,
	/^WhatsApp (?:Image|Video|Audio) /i,
	/^image \d+$/i,
	/^untitled/i,
];

function mediaTitle(path: string): string | null {
	const base = (path.split("/").pop() ?? "").replace(/\.\w+$/, "");
	const kind = IMAGE_EXT.test(path)
		? "Image"
		: VIDEO_EXT.test(path)
			? "Video"
			: AUDIO_EXT.test(path)
				? "Audio"
				: null;
	if (!kind) return null;

	for (const pattern of AUTO_NAMED) {
		const m = base.match(pattern);
		if (!m) continue;
		const stamp = m[1];
		if (!stamp) return kind;
		const date = new Date(
			Number(stamp.slice(0, 4)),
			Number(stamp.slice(4, 6)) - 1,
			Number(stamp.slice(6, 8))
		);
		return Number.isNaN(date.getTime())
			? kind
			: `${kind} · ${date.toLocaleDateString(undefined, {
					day: "numeric",
					month: "short",
					year: "numeric",
				})}`;
	}
	return null;
}

/** A human label for a card, used by the minimap so boxes are choosable. */
export function titleOf(node: CanvasNode): string {
	if (node.type === "group") return node.label ?? "Section";
	if (node.type === "link") {
		try {
			return new URL(node.url ?? "").hostname.replace(/^www\./, "");
		} catch {
			return node.url || "Link";
		}
	}
	if (node.type === "file") {
		const auto = mediaTitle(node.file ?? "");
		if (auto) return auto;
		const base = (node.file ?? "").split("/").pop() ?? "";
		const stem = base.replace(/\.\w+$/, "");
		return node.subpath ? `${stem} ${node.subpath}` : stem || "File";
	}

	const raw = node.text ?? "";
	const fence = raw.match(HTML_FENCE);
	if (fence) {
		const heading = fence[1].match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
		if (heading) return cleanTitle(heading[1].replace(/<[^>]+>/g, " "));
		return "HTML slide";
	}
	for (const line of stripComments(raw).split("\n")) {
		const cleaned = cleanTitle(line);
		if (cleaned) return cleaned;
	}
	return "Empty card";
}

/** Resource URL for cards the minimap can show as a picture rather than a title. */
export function thumbnailFor(app: App, node: CanvasNode): string | null {
	if (node.type !== "file" || !node.file) return null;
	if (!IMAGE_EXT.test(node.file)) return null;
	return resourcePath(app, node.file);
}

/**
 * Vault API rather than Adapter API, as the plugin guidelines ask: the Vault
 * goes through Obsidian's cache, the adapter talks to the filesystem. Falls
 * back only when the path does not resolve to a file we know about.
 */
export function resourcePath(app: App, path: string): string {
	const normalised = normalizePath(path);
	const file = app.vault.getAbstractFileByPath(normalised);
	return file instanceof TFile
		? app.vault.getResourcePath(file)
		: app.vault.adapter.getResourcePath(normalised);
}

function resourceFor(app: App, link: string, sourcePath: string): string | null {
	const clean = decodeURIComponent(link.split("#")[0].split("|")[0]).trim();
	if (!clean) return null;
	const dest = app.metadataCache.getFirstLinkpathDest(clean, sourcePath);
	return resourcePath(app, dest ? dest.path : clean);
}

/**
 * Point relative media at the vault.
 *
 * A card written as plain HTML says `<img src="Assets/plan.png">`, which the
 * browser resolves against the app origin and fails to find. Rewriting to a
 * vault resource path is what makes images in HTML cards work at all.
 */
function resolveMedia(app: App, root: ParentNode, sourcePath: string): void {
	root.querySelectorAll("img[src], video[src], audio[src], source[src]").forEach((el) => {
		const raw = el.getAttribute("src") ?? "";
		if (!raw || ABSOLUTE.test(raw)) return;
		const url = resourceFor(app, raw, sourcePath);
		if (url) el.setAttribute("src", url);
	});
}

/**
 * Turn Obsidian's `![[picture.png]]` placeholders into real elements.
 *
 * MarkdownRenderer leaves embeds as empty spans for the workspace to fill in
 * later; nothing fills them in inside a presentation overlay, so a card written
 * with embeds would come up blank.
 */
async function resolveEmbeds(app: App, root: HTMLElement, sourcePath: string): Promise<void> {
	for (const span of Array.from(root.querySelectorAll("span.internal-embed"))) {
		const src = span.getAttribute("src");
		if (!src) continue;
		const dest = app.metadataCache.getFirstLinkpathDest(src.split("#")[0], sourcePath);
		if (!dest) continue;

		if (isExcalidraw(app, dest)) {
			const holder = createEl("div");
			holder.addClass("atl-embed");
			span.replaceWith(holder);
			if (!(await renderExcalidraw(app, holder, dest))) {
				holder.addClass("atl-missing");
				holder.setText(`${dest.basename} needs the Excalidraw plugin.`);
			}
			continue;
		}
		const url = app.vault.getResourcePath(dest);

		let replacement: HTMLElement | null = null;
		if (IMAGE_EXT.test(dest.path)) {
			const img = createEl("img");
			img.src = url;
			img.alt = span.getAttribute("alt") ?? dest.basename;
			replacement = img;
		} else if (VIDEO_EXT.test(dest.path)) {
			const video = createEl("video");
			video.src = url;
			video.controls = true;
			video.preload = "metadata";
			markAudioOnly(video);
			replacement = video;
		} else if (AUDIO_EXT.test(dest.path)) {
			// The same class the card-sized player uses, so a sound embedded in a
			// card is sized and spaced like one rather than like a browser default.
			const audio = createEl("audio");
			audio.className = "atl-audio";
			audio.src = url;
			audio.controls = true;
			audio.preload = "metadata";
			replacement = audio;
		}
		if (replacement) {
			replacement.addClass("atl-embed");
			span.replaceWith(replacement);
		}
	}
}


/**
 * A container extension does not tell you whether there is a picture inside.
 * A voice memo saved as .webm arrives here as a video element and paints a
 * large black rectangle; once metadata lands we can see there is no video
 * track and show it as a bar instead.
 */
function markAudioOnly(media: HTMLVideoElement): void {
	media.addEventListener("loadedmetadata", () => {
		if (!media.videoWidth) media.addClass("is-audio-only");
	});
}

/**
 * Turn a card's HTML into nodes, without assigning it to innerHTML.
 *
 * `innerHTML = html` is the thing every linter flags and the thing every
 * reviewer asks about, and here the string is a function parameter, so nothing
 * can tell by reading it where the HTML came from. DOMParser says plainly that
 * this is a document being parsed rather than markup being injected into a live
 * tree: nothing runs, nothing resolves, until the nodes are adopted.
 *
 * It is the same trust decision either way — the card is a file in your own
 * vault — but the reader of this code can now see which decision was made.
 */
function parseCardHtml(doc: Document, html: string): HTMLElement {
	const wrap = doc.createElement("div");
	const parsed = new DOMParser().parseFromString(html, "text/html");
	for (const node of Array.from(parsed.body.childNodes)) {
		wrap.appendChild(doc.importNode(node, true));
	}
	return wrap;
}

/**
 * Raw HTML goes into a shadow root so a card's `<style>` cannot leak into the
 * rest of the deck or into Obsidian. This is what makes "just write HTML" safe
 * as a default rather than a footgun.
 */
function renderRawHtml(
	app: App,
	host: HTMLElement,
	html: string,
	sourcePath: string,
	themeCss: string,
	allowScripts: boolean
): void {
	const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
	const RESET = `
		/* min-height, not height: a card that is pinned to exactly its box can
		   never overflow, so it can never scroll. This way short content still
		   fills the card and long content grows and becomes scrollable. */
		:host { display: block; width: 100%; min-height: 100%; }
		* { box-sizing: border-box; }
		:host > div { width: 100%; min-height: 100%; }
		img, video, svg { max-width: 100%; }
		.atl-step { opacity: 0; transition: opacity 340ms ease, transform 340ms ease; }
		.atl-step:not(.atl-frame-item) { transform: translateY(10px); }
		.atl-step.is-shown { opacity: 1; transform: none; }
		.atl-slideshow { position: relative; width: 100%; height: 62cqh;
			max-height: 62cqh; overflow: hidden; border-radius: 10px; }
		/* Opaque frames: a fading frame must not blend with the one beneath,
		   which is what reads as a flicker. */
		.atl-frame-item { position: absolute; inset: 0; display: flex;
			align-items: center; justify-content: center; background: inherit;
			transition: transform 520ms cubic-bezier(0.22,0.7,0.24,1), opacity 380ms ease;
			backface-visibility: hidden; }
		/* The frame owns the box; the picture fits inside it. */
		.atl-frame-item > img, .atl-frame-item > video,
		.atl-frame-item p > img, .atl-frame-item p > video {
			display: block; width: 100%; height: 100%;
			max-width: 100%; max-height: 100%;
			object-fit: var(--atl-show-fit, contain); border-radius: 8px; }
		.atl-frame-item > p { margin: 0; width: 100%; height: 100%; }
		.atl-scroll { display: flex; flex-direction: column; gap: 16px; }
		.atl-scroll img { display: block; width: 100%; height: auto;
			border-radius: 8px; }
		.atl-gallery { display: grid; gap: 14px;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
		.atl-gallery img { width: 100%; display: block; border-radius: 8px; }
		.atl-show.tx-flip { perspective: 1400px; }
		.atl-show-controls { position: absolute; left: 0; right: 0; bottom: 10px;
			z-index: 3; display: flex; align-items: center; justify-content: center;
			gap: 14px; pointer-events: none; }
		.atl-show-arrow { pointer-events: auto; cursor: pointer; padding: 0 6px;
			border: 0; background: none; color: inherit; font-size: 30px;
			line-height: 1; opacity: 0.45; transition: opacity 180ms ease; }
		.atl-show-arrow:hover { opacity: 1; }
		.atl-show-dots { display: flex; align-items: center; gap: 8px;
			pointer-events: none; }
		.atl-show-dot { pointer-events: auto; width: 9px; height: 9px; padding: 0;
			border-radius: 50%; border: 1px solid currentColor; background: none;
			opacity: 0.45; cursor: pointer; transition: opacity 200ms ease,
			transform 200ms ease; }
		.atl-show-dot.is-current { opacity: 1; transform: scale(1.25); }
	`;
	// Adopted stylesheets rather than <style> elements: the same CSS, without
	// putting a style element into the document, which the plugin guidelines
	// ask us not to do. The vault's own theme is adopted too — otherwise it
	// could never reach inside a shadow root and touch an HTML card — and it
	// comes first, so a card that styles itself still wins.
	const win = host.ownerDocument.defaultView ?? window;
	const sheets: CSSStyleSheet[] = [];
	for (const css of [RESET, themeCss]) {
		if (!css) continue;
		try {
			const sheet = new (win as unknown as { CSSStyleSheet: typeof CSSStyleSheet })
				.CSSStyleSheet();
			sheet.replaceSync(css);
			sheets.push(sheet);
		} catch {
			// A realm without constructable stylesheets: the card renders with
			// the plugin's own rules and without the vault theme, rather than
			// not rendering.
		}
	}
	shadow.adoptedStyleSheets = sheets;

	const wrap = parseCardHtml(host.ownerDocument, html);
	shadow.append(wrap);

	resolveMedia(app, wrap, sourcePath);

	// A <script> parsed out of innerHTML is inert — the HTML spec refuses to run
	// it. Re-creating the element is the only way to make an interactive slide
	// actually interactive, and it runs JavaScript from the vault, so it is off
	// until someone turns it on.
	if (!allowScripts) {
		if (wrap.querySelector("script")) {
			const note = createEl("div");
			note.addClass("atl-scripts-off");
			note.setText(
				"This card contains a script. Turn on Settings → Atlas Presenter → " +
					"Run scripts in HTML cards to let it run."
			);
			wrap.prepend(note);
		}
		return;
	}
	runCardScripts(shadow, host, wrap);
}

/**
 * Run a card's scripts, with the card handed to them.
 *
 * Not by inserting a <script>: an element in a shadow root is not reliably
 * executed, and `document.currentScript` is null when it is — which is why an
 * interactive card could look enabled and still do nothing. The code is
 * compiled directly instead, with `root` (the card's shadow root) and `host`
 * (the card element) as its two arguments.
 */
function runCardScripts(shadow: ShadowRoot, host: HTMLElement, wrap: HTMLElement): void {
	const scripts = Array.from(wrap.querySelectorAll("script"));
	const sources: string[] = [];
	for (const el of scripts) {
		const code = el.textContent ?? "";
		el.remove();
		if (!code.trim()) continue;
		// Kept, because running a script destroys it: it is compiled here and
		// the element removed, so by the time the export clones the stage there
		// is nothing left to find. An exported card animated in Obsidian and
		// sat still in the browser, with no sign of why.
		sources.push(code);
		try {
			// Compiled here rather than inserted, so it runs exactly once and we
			// can hand it what it needs.
			const run = new Function("root", "host", code) as (
				root: ShadowRoot,
				host: HTMLElement
			) => void;
			run(shadow, host);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			const note = createEl("div");
			note.addClass("atl-script-error");
			note.setText(`This card's script failed: ${message}`);
			shadow.appendChild(note);
			console.error("Atlas card script:", e);
		}
	}
	if (sources.length > 0) host.dataset.atlScripts = JSON.stringify(sources);
}

/**
 * Markdown the way a card gets it: rendered, then its embeds and relative media
 * turned into real elements. The header needs the same treatment — a deck card
 * with a logo in it was producing an empty span.
 */
export async function renderMarkdownInto(
	app: App,
	owner: Component,
	el: HTMLElement,
	md: string,
	sourcePath: string
): Promise<void> {
	await MarkdownRenderer.render(app, md, el, sourcePath, owner);
	await resolveEmbeds(app, el, sourcePath);
	resolveMedia(app, el, sourcePath);
}

async function renderMarkdown(
	app: App,
	owner: Component,
	body: HTMLElement,
	md: string,
	sourcePath: string,
	themeCss: string,
	allowScripts: boolean
): Promise<void> {
	const fence = md.match(HTML_FENCE);
	if (fence) {
		renderRawHtml(app, body, fence[1], sourcePath, themeCss, allowScripts);
		return;
	}
	await MarkdownRenderer.render(app, stripComments(md), body, sourcePath, owner);
	await resolveEmbeds(app, body, sourcePath);
	resolveMedia(app, body, sourcePath);
}

async function renderFileNode(
	app: App,
	owner: Component,
	body: HTMLElement,
	node: CanvasNode,
	themeCss: string,
	allowScripts: boolean
): Promise<void> {
	const path = normalizePath(node.file ?? "");
	const file = app.vault.getAbstractFileByPath(path);

	if (IMAGE_EXT.test(path)) {
		const img = body.createEl("img", { cls: "atl-media" });
		img.src = resourcePath(app, path);
		return;
	}
	if (VIDEO_EXT.test(path)) {
		const video = body.createEl("video", { cls: "atl-media" });
		video.src = resourcePath(app, path);
		video.controls = true;
		video.preload = "metadata";
		video.playsInline = true;
		markAudioOnly(video);
		return;
	}
	if (AUDIO_EXT.test(path)) {
		// A bare <audio> is a 40px bar adrift in the middle of a slide, which is
		// not a slide. Give it a face: what it is, and something to look at while
		// the room listens to it.
		const card = body.createDiv({ cls: "atl-audio-card" });
		const bars = card.createDiv({ cls: "atl-audio-bars" });
		for (let n = 0; n < 9; n++) bars.createEl("i");
		card.createDiv({
			cls: "atl-audio-title",
			text: mediaTitle(path) ?? (path.split("/").pop() ?? "").replace(/\.\w+$/, ""),
		});
		const time = card.createDiv({ cls: "atl-audio-time", text: "—" });

		const audio = card.createEl("audio", { cls: "atl-audio" });
		audio.src = resourcePath(app, path);
		audio.controls = true;
		audio.preload = "metadata";
		// The length is worth knowing before you commit a room to listening.
		audio.addEventListener("loadedmetadata", () => {
			const secs = Math.round(audio.duration);
			if (!Number.isFinite(secs)) return;
			time.setText(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);
		});
		// Bars move only while it is playing; a still card should be still.
		audio.addEventListener("play", () => card.addClass("is-playing"));
		for (const stop of ["pause", "ended"]) {
			audio.addEventListener(stop, () => card.removeClass("is-playing"));
		}
		return;
	}
	if (!(file instanceof TFile)) {
		body.createDiv({ cls: "atl-missing", text: `Missing: ${path || "(no file)"}` });
		return;
	}
	if (file.extension === "html") {
		renderRawHtml(
			app,
			body,
			await app.vault.cachedRead(file),
			file.path,
			themeCss,
			allowScripts
		);
		return;
	}
	if (file.extension === "canvas") {
		await renderSubdeck(app, body, file);
		return;
	}

	if (isExcalidraw(app, file)) {
		if (await renderExcalidraw(app, body, file)) return;
		body.createDiv({
			cls: "atl-missing",
			text: `${file.basename} is an Excalidraw drawing — install or enable the `
				+ "Excalidraw plugin to show it.",
		});
		return;
	}

	let md = await app.vault.cachedRead(file);
	if (node.subpath) md = sliceSubpath(md, node.subpath);
	for (const cls of frontmatterClasses(app, file)) {
		body.parentElement?.addClass(cls);
	}
	await renderMarkdown(app, owner, body, md, file.path, themeCss, allowScripts);
}

/** Support `note.md#Heading` cards: present just that section. */
function sliceSubpath(md: string, subpath: string): string {
	const heading = subpath.replace(/^#/, "").trim();
	if (!heading) return md;
	const lines = md.split("\n");
	const start = lines.findIndex(
		(l) => /^#+\s/.test(l) && l.trim().replace(/^#+\s*/, "").toLowerCase() === heading.toLowerCase()
	);
	if (start === -1) return md;
	const level = (lines[start].match(/^#+/) ?? ["#"])[0].length;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = lines[i].match(/^#+/);
		if (m && m[0].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

/**
 * Reveals within a slide, the way Advanced Slides does fragments.
 *
 * Three ways to mark them: a `+++` line between blocks in markdown, any element
 * carrying `.step` / `<deck-step>`, or the children of a `.atl-slideshow`, which
 * stack on top of each other so `→` runs a slide show inside one card.
 */
/** Every slide show in a card, so the deck can drive them. */
export function slideshowsIn(body: HTMLElement): HTMLElement[] {
	const scope: ParentNode = body.shadowRoot ?? body;
	return Array.from(scope.querySelectorAll<HTMLElement>(".atl-slideshow"));
}

/**
 * Roles that lay a card out in columns rather than one flow.
 *
 * These are the only ones that need real wrapper elements: CSS can put a card's
 * children in two columns, but it cannot say which children go in which. So the
 * card says, with a rule.
 */
const PANED = ["atl-tag-two", "atl-tag-compare", "atl-tag-left", "atl-tag-right"];

/**
 * Make a lone `---` mean a rule, whatever precedes it.
 *
 * Markdown's setext rule turns `---` directly under a line of text into an
 * underline for that line, which makes the line a heading and produces no
 * horizontal rule at all. So a card written the way the reference shows it —
 *
 *     ## Everything is on the plan
 *
 *     Loop numbers, panel references, the dates.
 *     ---
 *     ![[plan.svg]]
 *
 * — silently came out as one column with an enormous second heading, because
 * there was no <hr> to split it at. An author cannot be expected to know that
 * a blank line changes what the same three characters mean; giving it one is
 * the fix. Fences are left alone: `---` inside a code sample is a code sample.
 */
function spaceRules(md: string): string {
	const out: string[] = [];
	let fence = "";
	for (const line of md.split("\n")) {
		const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
		if (fence) {
			if (open && open[1].startsWith(fence[0]) && open[1].length >= fence.length) fence = "";
			out.push(line);
			continue;
		}
		if (open) {
			fence = open[1];
			out.push(line);
			continue;
		}
		if (/^\s*-{3,}\s*$/.test(line)) {
			if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
			out.push(line.trim(), "");
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

/**
 * Three ways of showing a card's pictures.
 *
 * The tags were documented, demonstrated and styled — and never implemented for
 * a markdown card. `.atl-gallery`, `.atl-scroll` and `.atl-slideshow` had rules,
 * but the only thing that ever carried one was an HTML card writing the div
 * itself. So `#slideshow` produced a column of stacked images, and the
 * transition setting had nothing to act on, which is what it looked like.
 *
 * Every element holding a picture is gathered into one container where the
 * first of them was. The rest of the card — heading, text — stays where it is.
 */
const PICTURES: [string, string][] = [
	["atl-tag-gallery", "atl-gallery"],
	["atl-tag-slideshow", "atl-slideshow"],
	["atl-tag-scroll", "atl-scroll"],
];

function layOutPictures(card: HTMLElement, body: HTMLElement): void {
	const kind = PICTURES.find(([tag]) => card.hasClass(tag));
	if (!kind) return;

	const media = Array.from(body.children).filter(
		(el) => isElement(el) && !!el.querySelector("img, video")
	) as HTMLElement[];
	if (media.length === 0) return;

	const box = body.createDiv({ cls: kind[1] });
	body.insertBefore(box, media[0]);
	for (const el of media) box.appendChild(el);
}

function isHeading(el: Element): boolean {
	return /^H[1-3]$/.test(el.tagName);
}

/**
 * Split a card at its `---` rules into columns.
 *
 *     # Spans both        <- taken as the heading band, because it is only
 *     ---                    headings, and there is something after it
 *     The left column
 *     ---
 *     The right column
 *
 * Two blocks make two columns; a leading block of nothing but headings becomes a
 * band across the top instead. Anything else is left exactly as it was — a card
 * that happens to contain a rule and is not tagged for columns must not move.
 */
function layOutPanes(card: HTMLElement, body: HTMLElement): void {
	if (!PANED.some((c) => card.hasClass(c))) return;

	const parts: HTMLElement[][] = [[]];
	for (const child of Array.from(body.children)) {
		if (!isElement(child)) continue;
		if (child.tagName === "HR") parts.push([]);
		else parts[parts.length - 1].push(child);
	}
	const blocks = parts.filter((p) => p.length > 0);
	if (blocks.length < 2) return;

	// A first block of nothing but headings is a title for the whole card.
	const head = blocks.length > 2 && blocks[0].every(isHeading) ? blocks.shift() : null;
	if (blocks.length < 2) return;

	body.empty();
	if (head) {
		const band = body.createDiv({ cls: "atl-pane-head" });
		for (const el of head) band.appendChild(el);
	}
	for (const block of blocks) {
		const pane = body.createDiv({ cls: "atl-pane" });
		for (const el of block) pane.appendChild(el);
	}
	body.dataset.panes = String(blocks.length);
}

export function buildSteps(body: HTMLElement): HTMLElement[] {
	const scope: ParentNode = body.shadowRoot ?? body;

	// Every frame is stacked; only the ones after the first are steps, so the
	// card is never blank before the first press.
	// Slide shows run themselves now — a reveal only ever stacks up, and an
	// album has to be able to go back to the picture before.
	if (scope.querySelector(".atl-slideshow") && !body.shadowRoot) {
		body.addClass("has-slideshow");
	}

	const explicit = Array.from(
		scope.querySelectorAll<HTMLElement>("deck-step, .step, [data-step]")
	);
	if (explicit.length > 0) {
		for (const el of explicit) el.classList.add("atl-step");
		return explicit;
	}

	// `+++` markers: everything after one becomes the next step. Only for
	// markdown cards — a shadow root has no Obsidian DOM helpers.
	if (body.shadowRoot) return [];

	// A card laid out in columns reveals within each column, so the steps are
	// gathered per pane. Without this the wrapper would be appended to the body
	// and the revealed text would jump out of its column.
	const flows: HTMLElement[] = body.dataset.panes
		? Array.from(body.querySelectorAll<HTMLElement>(".atl-pane"))
		: [body];

	const steps: HTMLElement[] = [];
	for (const flow of flows) {
		const kids = Array.from(flow.children) as HTMLElement[];
		if (!kids.some((k) => (k.textContent ?? "").trim() === "+++")) continue;

		let wrapper: HTMLElement | null = null;
		for (const kid of kids) {
			if ((kid.textContent ?? "").trim() === "+++") {
				kid.remove();
				wrapper = flow.createDiv({ cls: "atl-step" });
				steps.push(wrapper);
				continue;
			}
			// Appending to a wrapper that sits at the end of the flow preserves
			// document order, because we walk the children in order.
			if (wrapper) wrapper.appendChild(kid);
		}
	}
	return steps;
}

const NS = "http://www.w3.org/2000/svg";

/**
 * A canvas on a canvas: draw it to scale rather than name it.
 *
 * A signpost told you a sub-deck existed but nothing about it. This is the same
 * shape the map draws, small — you can see how big the detour is before taking
 * it.
 */
async function renderSubdeck(app: App, body: HTMLElement, file: TFile): Promise<void> {
	body.addClass("atl-subdeck");
	let data;
	try {
		data = parseCanvas(await app.vault.cachedRead(file));
	} catch {
		body.createDiv({ cls: "atl-missing", text: `Could not read ${file.basename}.` });
		return;
	}

	const cards = data.nodes.filter((n) => n.type !== "group");
	body.createDiv({ cls: "atl-subdeck-name", text: file.basename });

	const bounds = rectOf(boundsOf(data.nodes));
	const m = Math.max(bounds.width, bounds.height) * 0.04;
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute(
		"viewBox",
		`${bounds.x - m} ${bounds.y - m} ${bounds.width + m * 2} ${bounds.height + m * 2}`
	);
	svg.addClass("atl-subdeck-map");

	const stroke = Math.max(bounds.width * 0.002, 1);
	for (const node of data.nodes) {
		const r = rectOf(node);
		const el = document.createElementNS(NS, "rect");
		el.setAttribute("x", String(r.x));
		el.setAttribute("y", String(r.y));
		el.setAttribute("width", String(r.width));
		el.setAttribute("height", String(r.height));
		el.setAttribute("rx", String(Math.min(r.width, r.height) * 0.06));
		el.setAttribute("stroke-width", String(stroke));
		el.addClass(node.type === "group" ? "atl-sub-group" : "atl-sub-card");
		if (node.color) el.setAttribute("data-color", node.color);
		svg.appendChild(el);
	}
	const byId = new Map(data.nodes.map((n) => [n.id, n]));
	for (const edge of data.edges) {
		const a = byId.get(edge.fromNode);
		const b = byId.get(edge.toNode);
		if (!a || !b) continue;
		const ra = rectOf(a);
		const rb = rectOf(b);
		const line = document.createElementNS(NS, "line");
		line.setAttribute("x1", String(ra.x + ra.width / 2));
		line.setAttribute("y1", String(ra.y + ra.height / 2));
		line.setAttribute("x2", String(rb.x + rb.width / 2));
		line.setAttribute("y2", String(rb.y + rb.height / 2));
		line.setAttribute("stroke-width", String(stroke * 1.4));
		line.addClass("atl-sub-edge");
		svg.appendChild(line);
	}
	body.appendChild(svg);

	body.createDiv({
		cls: "atl-subdeck-hint",
		text: `${cards.length} cards · Enter to present it, Esc to come back`,
	});
}

/** Build the DOM for one card, positioned in canvas coordinates on the stage. */
export async function renderNode(
	app: App,
	owner: Component,
	stage: HTMLElement,
	node: CanvasNode,
	sourcePath: string,
	themeCss: string,
	allowScripts: boolean,
	groupLabel?: string
): Promise<HTMLElement> {
	const r = rectOf(node);
	const el = stage.createDiv({ cls: `atl-node atl-node-${node.type}` });
	el.style.left = `${r.x}px`;
	el.style.top = `${r.y}px`;
	el.style.width = `${r.width}px`;
	el.style.height = `${r.height}px`;
	if (node.color) el.dataset.color = node.color;
	el.dataset.nodeId = node.id;
	if (groupLabel) el.dataset.group = slug(groupLabel);

	if (node.type === "group") {
		if (node.label) el.createDiv({ cls: "atl-group-label", text: node.label });
		return el;
	}

	const body = el.createDiv({ cls: "atl-body" });
	try {
		if (node.type === "text") {
			const hooks = extractHooks(node.text ?? "");
			for (const cls of hooks.classes) el.addClass(cls);
			// Only for the layouts that split on a rule: everywhere else `---`
			// under a line is a heading on purpose, and people write it that way.
			const paned = hooks.classes.some((c) => PANED.includes(c));
			const text = paned ? spaceRules(hooks.text) : hooks.text;
			await renderMarkdown(app, owner, body, text, sourcePath, themeCss, allowScripts);
		} else if (node.type === "file") {
			await renderFileNode(app, owner, body, node, themeCss, allowScripts);
		} else if (node.type === "link") {
			const frame = body.createEl("iframe", { cls: "atl-frame" });
			frame.src = node.url ?? "";
		}
	} catch (e) {
		body.createDiv({ cls: "atl-missing", text: `Could not render this card: ${String(e)}` });
	}
	// Pictures first: a card is one or the other, and a paned card splits on a
	// rule rather than gathering its images.
	if (PANED.some((c) => el.hasClass(c))) layOutPanes(el, body);
	else layOutPictures(el, body);
	return el;
}
