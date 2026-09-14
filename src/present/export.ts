import { App, Notice, TFile, normalizePath } from "obsidian";

/**
 * Write the running deck out as one HTML file.
 *
 * The stage is already a plane of absolutely positioned cards, so exporting is
 * mostly: take that DOM, make every reference self-contained, and ship a small
 * camera with it. No Obsidian, no network, no plugin — it opens in a browser.
 */
export interface ExportInput {
	title: string;
	/** The live stage element, cloned and cleaned. */
	stage: HTMLElement;
	/** Canvas-space rectangles, in running order. */
	stops: {
		nodeId: string;
		x: number;
		y: number;
		width: number;
		height: number;
		label: string;
	}[];
	/** The plugin stylesheet plus the deck's own theme. */
	css: string;
	padding: number;
	maxScale: number;
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	svg: "image/svg+xml",
	webp: "image/webp",
	avif: "image/avif",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
};

function base64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	// Chunked: apply() on a whole large file blows the argument limit.
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/**
 * Turn every vault reference into a data URI.
 *
 * An exported file that still points at `app://` paths only works on the
 * machine that made it, which defeats the purpose.
 */
async function inlineMedia(app: App, root: HTMLElement): Promise<number> {
	let inlined = 0;
	const holders = Array.from(root.querySelectorAll<HTMLElement>("img, video, audio, source"));
	for (const el of holders) {
		const src = el.getAttribute("src");
		if (!src || src.startsWith("data:")) continue;

		// A resource path carries the vault-relative path in its query or body.
		const match = decodeURIComponent(src).match(/([^/?#]+\.\w+)(?:\?|$)/);
		const name = match?.[1];
		const file = name
			? app.vault.getFiles().find((f) => f.name === name)
			: undefined;
		if (!file) {
			el.removeAttribute("src");
			continue;
		}
		try {
			const data = await app.vault.readBinary(file);
			const mime = MIME[file.extension.toLowerCase()] ?? "application/octet-stream";
			el.setAttribute("src", `data:${mime};base64,${base64(data)}`);
			inlined++;
		} catch {
			el.removeAttribute("src");
		}
	}
	return inlined;
}

/** Shadow roots do not survive cloneNode, so their content is folded back in. */
function flattenShadows(live: HTMLElement, clone: HTMLElement): void {
	const liveHosts = Array.from(live.querySelectorAll<HTMLElement>(".atl-body"));
	const cloneHosts = Array.from(clone.querySelectorAll<HTMLElement>(".atl-body"));
	liveHosts.forEach((host, i) => {
		const shadow = host.shadowRoot;
		const target = cloneHosts[i];
		if (!shadow || !target) return;
		target.empty();
		for (const child of Array.from(shadow.children)) {
			// Scripts are dropped: an exported file should render, not execute.
			if (child.tagName === "SCRIPT") continue;
			target.appendChild(child.cloneNode(true));
		}
		target.addClass("atl-was-shadow");
	});
}

const RUNTIME = `
(function () {
  var stage = document.getElementById('stage');
  var view = document.getElementById('view');
  var counter = document.getElementById('counter');
  var stops = window.__ATLAS_STOPS__, pad = window.__ATLAS_PAD__, max = window.__ATLAS_MAX__;
  var i = 0;
  function go(n) {
    i = Math.max(0, Math.min(n, stops.length - 1));
    var s = stops[i];
    var scale = Math.min(
      view.clientWidth / (s.width * (1 + pad * 2)),
      view.clientHeight / (s.height * (1 + pad * 2)),
      max
    );
    stage.style.transform =
      'translate(' + view.clientWidth / 2 + 'px,' + view.clientHeight / 2 + 'px) ' +
      'scale(' + scale + ') ' +
      'translate(' + -(s.x + s.width / 2) + 'px,' + -(s.y + s.height / 2) + 'px)';
    var cards = stage.querySelectorAll('.atl-node');
    for (var c = 0; c < cards.length; c++) cards[c].classList.remove('is-active');
    var active = stage.querySelector('[data-node-id="' + s.nodeId + '"]');
    if (active) active.classList.add('is-active');
    counter.textContent = (i + 1) + ' / ' + stops.length + (s.label ? '  ·  ' + s.label : '');
  }
  document.addEventListener('keydown', function (e) {
    if (['ArrowRight', ' ', 'PageDown', 'ArrowDown'].indexOf(e.key) > -1) { e.preventDefault(); go(i + 1); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].indexOf(e.key) > -1) { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { go(0); }
    else if (e.key === 'End') { go(stops.length - 1); }
    else if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    }
  });
  view.addEventListener('click', function (e) {
    if (e.target.closest('a, button, video, audio, input')) return;
    go(e.clientX > window.innerWidth / 3 ? i + 1 : i - 1);
  });
  addEventListener('resize', function () { go(i); });
  go(0);
})();
`;

/**
 * The same deck as pages, for printing.
 *
 * The screen version is a camera over a plane, which a printer cannot follow.
 * These are the same cards laid out one per page, hidden until you print — so
 * one file serves both, and PDF is the browser's job rather than ours.
 */
function printPages(clone: HTMLElement, stops: ExportInput["stops"]): string {
	const pages: string[] = [];
	for (const stop of stops) {
		const card = clone.querySelector<HTMLElement>(`[data-node-id="${stop.nodeId}"]`);
		if (!card) continue;
		const page = card.cloneNode(true) as HTMLElement;
		// On a page a card is the page, not a rectangle on a plane.
		page.style.position = "static";
		page.style.left = "";
		page.style.top = "";
		page.style.width = "100%";
		page.style.height = `${(stop.height / stop.width) * 100}%`;
		page.addClass("is-active");
		pages.push(`<div class="page">${page.outerHTML}</div>`);
	}
	return pages.join("\n");
}

/**
 * Say where the file went, and offer to open it.
 *
 * An exported deck is an HTML file in the vault, and Obsidian will not render
 * one — so a notice naming a path leaves you with a file you cannot look at,
 * which is exactly how the minutes used to behave. The notice is a button
 * instead. Opening it needs the desktop app; on mobile the path alone is all
 * there is to give, so that is what is given.
 */
function reveal(app: App, path: string, inlined: number): void {
	const notice = new Notice("", 12000);
	const el = notice.noticeEl;
	el.empty();
	el.createDiv({ text: `Exported to ${path}` });
	el.createDiv({
		cls: "atl-notice-sub",
		text: `${inlined} file${inlined === 1 ? "" : "s"} inlined. Print it from the browser for a PDF.`,
	});

	const open = (app as unknown as { openWithDefaultApp?: (p: string) => void })
		.openWithDefaultApp;
	if (typeof open !== "function") return;

	const btn = el.createEl("button", { cls: "atl-notice-btn", text: "Open in browser" });
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		try {
			open.call(app, path);
		} catch {
			new Notice(`Atlas: open ${path} yourself — this vault could not launch it.`);
		}
		notice.hide();
	});
}

export async function exportDeck(app: App, input: ExportInput): Promise<string | null> {
	const clone = input.stage.cloneNode(true) as HTMLElement;
	flattenShadows(input.stage, clone);
	const inlined = await inlineMedia(app, clone);

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${input.title}</title>
<style>
  html, body { margin: 0; height: 100%; background: #f4f6f1; overflow: hidden;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
  #view { position: fixed; inset: 0; overflow: hidden; }
  #stage { position: absolute; top: 0; left: 0; transform-origin: 0 0;
    transition: transform 900ms cubic-bezier(0.6, 0, 0.2, 1); }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex;
    justify-content: space-between; padding: 10px 18px; font-size: 13px;
    color: #6b7a80; pointer-events: none; }
  #print { display: none; }
  @media print {
    html, body { height: auto; overflow: visible; background: #fff; }
    #view, #bar { display: none !important; }
    #print { display: block; }
    .page { page-break-after: always; break-after: page; padding: 0; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .atl-node { box-shadow: none !important; border: 1px solid #ddd; }
  }
  @page { size: landscape; margin: 12mm; }
${input.css}
</style>
</head>
<body>
<div id="view"><div id="stage"></div></div>
<div id="bar"><span>${input.title}</span><span id="counter"></span></div>
<div id="print">__PRINT__</div>
<script>
  window.__ATLAS_STOPS__ = ${JSON.stringify(input.stops)};
  window.__ATLAS_PAD__ = ${input.padding};
  window.__ATLAS_MAX__ = ${input.maxScale};
</script>
<script>${RUNTIME}</script>
</body>
</html>`;

	const stageHtml = clone.innerHTML;
	const out = html
		.replace('<div id="stage"></div>', `<div id="stage">${stageHtml}</div>`)
		.replace("__PRINT__", printPages(clone, input.stops.filter((s) => !s.label)));

	const folder = input.title.replace(/[\\/:*?"<>|]/g, "-");
	const path = normalizePath(`${folder} — deck.html`);
	try {
		const existing = app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await app.vault.modify(existing, out);
		else await app.vault.create(path, out);
		reveal(app, path, inlined);
		return path;
	} catch (e) {
		new Notice(`Atlas: could not write the export — ${String(e)}`);
		return null;
	}
}
