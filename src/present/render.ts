import { App, Component, MarkdownRenderer, TFile, normalizePath } from "obsidian";
import { CanvasNode } from "../types";
import { outsideCode, rectOf } from "../canvas/parse";

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac)$/i;
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
			const holder = document.createElement("div");
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
			const img = document.createElement("img");
			img.src = url;
			img.alt = span.getAttribute("alt") ?? dest.basename;
			replacement = img;
		} else if (VIDEO_EXT.test(dest.path)) {
			const video = document.createElement("video");
			video.src = url;
			video.controls = true;
			video.preload = "metadata";
			markAudioOnly(video);
			replacement = video;
		} else if (AUDIO_EXT.test(dest.path)) {
			const audio = document.createElement("audio");
			audio.src = url;
			audio.controls = true;
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
	const reset = document.createElement("style");
	reset.textContent = `
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
	// The vault's own theme reaches inside the shadow root too, otherwise it
	// could never touch an HTML card. It goes before the card's own <style>,
	// so a card that styles itself still wins.
	const theme = document.createElement("style");
	theme.textContent = themeCss;
	const wrap = document.createElement("div");
	wrap.innerHTML = html;
	shadow.append(reset, theme, wrap);

	resolveMedia(app, wrap, sourcePath);

	// A <script> parsed out of innerHTML is inert — the HTML spec refuses to run
	// it. Re-creating the element is the only way to make an interactive slide
	// actually interactive, and it runs JavaScript from the vault, so it is off
	// until someone turns it on.
	if (!allowScripts) {
		if (wrap.querySelector("script")) {
			const note = document.createElement("div");
			note.addClass("atl-scripts-off");
			note.setText(
				"This card contains a script. Turn on Settings → Atlas Presenter → " +
					"Run scripts in HTML cards to let it run."
			);
			wrap.prepend(note);
		}
		return;
	}
	wrap.querySelectorAll("script").forEach((old) => {
		const fresh = document.createElement("script");
		for (const attr of Array.from(old.attributes)) fresh.setAttribute(attr.name, attr.value);
		fresh.textContent = old.textContent;
		old.replaceWith(fresh);
	});
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
		const audio = body.createEl("audio", { cls: "atl-audio" });
		audio.src = resourcePath(app, path);
		audio.controls = true;
		audio.preload = "metadata";
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
		// Nested decks land in v0.2; for now show it as a signpost.
		body.createDiv({ cls: "atl-subdeck", text: `↳ ${file.basename}` });
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
	const kids = Array.from(body.children) as HTMLElement[];
	if (!kids.some((k) => (k.textContent ?? "").trim() === "+++")) return [];

	const steps: HTMLElement[] = [];
	let wrapper: HTMLElement | null = null;
	for (const kid of kids) {
		if ((kid.textContent ?? "").trim() === "+++") {
			kid.remove();
			wrapper = body.createDiv({ cls: "atl-step" });
			steps.push(wrapper);
			continue;
		}
		// Appending to a wrapper that sits at the end of the body preserves
		// document order, because we walk the children in order.
		if (wrapper) wrapper.appendChild(kid);
	}
	return steps;
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
			await renderMarkdown(app, owner, body, hooks.text, sourcePath, themeCss, allowScripts);
		} else if (node.type === "file") {
			await renderFileNode(app, owner, body, node, themeCss, allowScripts);
		} else if (node.type === "link") {
			const frame = body.createEl("iframe", { cls: "atl-frame" });
			frame.src = node.url ?? "";
		}
	} catch (e) {
		body.createDiv({ cls: "atl-missing", text: `Could not render this card: ${String(e)}` });
	}
	return el;
}
