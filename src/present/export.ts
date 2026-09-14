import { App, Notice, TFile, normalizePath } from "obsidian";
import { safeFileName } from "../format";
import { mimeFor } from "../media";
import { fail, offer } from "../notice";

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
		/** A section overview's group label, if this stop is one. */
		label: string;
		/** The card's own name — the same one the deck and the minutes use. */
		title: string;
	}[];
	/** The plugin stylesheet plus the deck's own theme. */
	css: string;
	padding: number;
	maxScale: number;
	/** Camera flight, in milliseconds. The export used to hardcode its own. */
	duration: number;
	/**
	 * The deck's logo, if it has one.
	 *
	 * It lives on the overlay rather than the stage, so cloning the stage left
	 * it behind — a branded deck exported unbranded, which is the one context
	 * where the branding was the point.
	 */
	logo?: { src: string; corner: string; height: number; opacity: number };
}

/** The logo markup, with its source inlined along with everything else. */
function logoTag(input: ExportInput): string {
	const logo = input.logo;
	if (!logo?.src) return "";
	return (
		`<img class="atl-logo" data-corner="${logo.corner}" src="${logo.src}" ` +
		`style="height:${logo.height}px;opacity:${logo.opacity}">`
	);
}

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
async function dataUri(app: App, src: string): Promise<string | null> {
	if (!src || src.startsWith("data:")) return src || null;

	// A resource path carries the vault-relative path in its query or body.
	const match = decodeURIComponent(src).match(/([^/?#]+\.\w+)(?:\?|$)/);
	const name = match?.[1];
	const file = name ? app.vault.getFiles().find((f) => f.name === name) : undefined;
	if (!file) return null;
	try {
		const data = await app.vault.readBinary(file);
		return `data:${mimeFor(file.extension)};base64,${base64(data)}`;
	} catch {
		return null;
	}
}

async function inlineMedia(app: App, root: HTMLElement): Promise<number> {
	let inlined = 0;
	const holders = Array.from(root.querySelectorAll<HTMLElement>("img, video, audio, source"));
	for (const el of holders) {
		const src = el.getAttribute("src");
		if (!src || src.startsWith("data:")) continue;
		const uri = await dataUri(app, src);
		if (uri) {
			el.setAttribute("src", uri);
			inlined++;
		} else {
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

/**
 * The deck's behaviour, shipped with the file.
 *
 * This used to be a camera and two arrow keys, which made the export a much
 * poorer thing than the deck it came from: a `+++` reveal is `opacity: 0` until
 * something shows it, so every revealed point was *invisible* rather than
 * merely un-animated, and a slide show sat on its first frame for ever.
 *
 * It now walks a card the way the deck does — reveals, then the pictures, then
 * the next card — and carries the map, blanking and the progress rail with it.
 * Plain ES5 in one string: no build step, no dependency, and it has to run from
 * a file:// URL on whatever browser is on the machine in the room.
 */
const RUNTIME = `
(function () {
  var stage = document.getElementById('stage');
  var view = document.getElementById('view');
  var counter = document.getElementById('counter');
  var railfill = document.getElementById('railfill');
  var blank = document.getElementById('blank');
  var map = document.getElementById('map');
  var stops = window.__ATLAS_STOPS__, pad = window.__ATLAS_PAD__, max = window.__ATLAS_MAX__;
  var i = 0, step = 0;

  function cardAt(n) {
    return stage.querySelector('[data-node-id="' + stops[n].nodeId + '"]');
  }
  function stepsIn(el) {
    return el ? [].slice.call(el.querySelectorAll('.atl-step')) : [];
  }
  function showsIn(el) {
    return el ? [].slice.call(el.querySelectorAll('.atl-slideshow')) : [];
  }
  function framesIn(show) {
    return [].slice.call(show.querySelectorAll('.atl-frame-item'));
  }

  /* A slide show is a stack of frames with one marked current; the deck and the
     export agree on that, so moving one is a matter of moving the mark. */
  function frameAt(show) {
    var f = framesIn(show);
    for (var n = 0; n < f.length; n++) if (f[n].classList.contains('is-current')) return n;
    return 0;
  }
  function setFrame(show, n) {
    var f = framesIn(show), dots = [].slice.call(show.querySelectorAll('.atl-show-dots > *'));
    if (!f.length) return;
    n = Math.max(0, Math.min(n, f.length - 1));
    for (var k = 0; k < f.length; k++) f[k].classList.toggle('is-current', k === n);
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('is-current', d === n);
    return n;
  }

  function resetCard(el, shown) {
    var st = stepsIn(el);
    for (var n = 0; n < st.length; n++) st[n].classList.toggle('is-shown', shown);
    var sh = showsIn(el);
    for (var m = 0; m < sh.length; m++) setFrame(sh[m], shown ? framesIn(sh[m]).length - 1 : 0);
  }

  function paint(animate) {
    var s = stops[i];
    var scale = Math.min(
      view.clientWidth / (s.width * (1 + pad * 2)),
      view.clientHeight / (s.height * (1 + pad * 2)),
      max
    );
    stage.style.transition = animate ? '' : 'none';
    stage.style.transform =
      'translate(' + view.clientWidth / 2 + 'px,' + view.clientHeight / 2 + 'px) ' +
      'scale(' + scale + ') ' +
      'translate(' + -(s.x + s.width / 2) + 'px,' + -(s.y + s.height / 2) + 'px)';
    if (!animate) { void stage.offsetWidth; stage.style.transition = ''; }
    var cards = stage.querySelectorAll('.atl-node');
    for (var c = 0; c < cards.length; c++) cards[c].classList.remove('is-active');
    var active = cardAt(i);
    if (active) active.classList.add('is-active');
    var total = stops.length;
    var name = s.label || s.title;
    counter.textContent = (i + 1) + ' / ' + total + (name ? '  \\u00b7  ' + name : '');
    railfill.style.width = (total < 2 ? 100 : (i / (total - 1)) * 100) + '%';
    if (map.classList.contains('on')) markMap();
  }

  /* Arriving forwards starts a card folded; arriving backwards starts it fully
     open, so stepping back into a card does not replay it. */
  function go(n, back) {
    n = Math.max(0, Math.min(n, stops.length - 1));
    if (n === i) { paint(true); return; }
    resetCard(cardAt(i), false);
    i = n;
    var el = cardAt(i);
    resetCard(el, !!back);
    step = back ? stepsIn(el).length : 0;
    paint(true);
  }

  /* Reveals, then the pictures, then the next card — the deck's own order. */
  function advance() {
    var el = cardAt(i), st = stepsIn(el);
    if (step < st.length) { st[step].classList.add('is-shown'); step++; return; }
    var sh = showsIn(el);
    for (var m = 0; m < sh.length; m++) {
      var f = framesIn(sh[m]);
      if (f.length > 1 && frameAt(sh[m]) < f.length - 1) { setFrame(sh[m], frameAt(sh[m]) + 1); return; }
    }
    go(i + 1);
  }
  function retreat() {
    var el = cardAt(i), sh = showsIn(el);
    for (var m = sh.length - 1; m >= 0; m--) {
      if (framesIn(sh[m]).length > 1 && frameAt(sh[m]) > 0) { setFrame(sh[m], frameAt(sh[m]) - 1); return; }
    }
    var st = stepsIn(el);
    if (step > 0) { step--; st[step].classList.remove('is-shown'); return; }
    go(i - 1, true);
  }

  /* ---- the map ---------------------------------------------------------- */

  function buildMap() {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var n = 0; n < stops.length; n++) {
      var s = stops[n];
      minx = Math.min(minx, s.x); miny = Math.min(miny, s.y);
      maxx = Math.max(maxx, s.x + s.width); maxy = Math.max(maxy, s.y + s.height);
    }
    var pad2 = 120;
    var svg = '<svg viewBox="' + (minx - pad2) + ' ' + (miny - pad2) + ' ' +
      (maxx - minx + pad2 * 2) + ' ' + (maxy - miny + pad2 * 2) + '" preserveAspectRatio="xMidYMid meet">';
    for (var k = 0; k < stops.length; k++) {
      var t = stops[k];
      svg += '<rect class="' + (t.label ? 'mg' : 'mn') + '" data-i="' + k + '" x="' + t.x +
        '" y="' + t.y + '" width="' + t.width + '" height="' + t.height + '" rx="14"></rect>';
      var label = t.label || t.title;
      if (label) {
        svg += '<text class="ml" x="' + (t.x + 16) + '" y="' + (t.y - 14) + '">' +
          String(label).replace(/[<&]/g, ' ') + '</text>';
      }
    }
    map.insertAdjacentHTML('beforeend', svg + '</svg>');
    map.addEventListener('click', function (e) {
      var hit = e.target.closest('rect[data-i]');
      if (hit) { toggleMap(false); go(+hit.getAttribute('data-i')); }
    });
  }
  function markMap() {
    var r = map.querySelectorAll('rect[data-i]');
    for (var n = 0; n < r.length; n++) r[n].classList.toggle('on', +r[n].getAttribute('data-i') === i);
  }
  function toggleMap(on) {
    if (!map.querySelector('svg')) buildMap();
    map.classList.toggle('on', on === undefined ? !map.classList.contains('on') : on);
    if (map.classList.contains('on')) markMap();
  }

  /* ---- keys ------------------------------------------------------------- */

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (map.classList.contains('on')) {
      if (k === 'Escape' || k === 'm' || k === 'M') { e.preventDefault(); toggleMap(false); }
      return;
    }
    if (['ArrowRight', ' ', 'PageDown', 'ArrowDown'].indexOf(k) > -1) { e.preventDefault(); advance(); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].indexOf(k) > -1) { e.preventDefault(); retreat(); }
    else if (k === 'Home') { e.preventDefault(); go(0); }
    else if (k === 'End') { e.preventDefault(); go(stops.length - 1); }
    else if (k === 'm' || k === 'M') { e.preventDefault(); toggleMap(); }
    else if (k === 'b' || k === 'B') { e.preventDefault(); blank.classList.toggle('on'); }
    else if (k === 'f' || k === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    }
  });

  blank.addEventListener('click', function () { blank.classList.remove('on'); });
  view.addEventListener('click', function (e) {
    if (e.target.closest('a, button, video, audio, input, .atl-show-controls')) return;
    if (e.clientX > window.innerWidth / 3) advance(); else retreat();
  });
  addEventListener('resize', function () { paint(false); });

  /* Every card starts folded, or a reveal would be showing before its turn. */
  var all = stage.querySelectorAll('.atl-node');
  for (var z = 0; z < all.length; z++) resetCard(all[z], false);
  paint(false);
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
		// A page cannot be pressed through, so everything on the card has to be
		// there at once: a reveal is invisible until something shows it, and a
		// slide show would print its first frame and lose the rest.
		for (const s of Array.from(page.querySelectorAll(".atl-step"))) s.addClass("is-shown");
		for (const show of Array.from(page.querySelectorAll<HTMLElement>(".atl-slideshow"))) {
			const frames = Array.from(show.querySelectorAll<HTMLElement>(".atl-frame-item"));
			for (const f of frames) f.addClass("is-current");
			show.addClass("print-all");
		}
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
	offer((el, close) => {
		el.createDiv({ text: `Atlas: exported to ${path}` });
		el.createDiv({
			cls: "atl-notice-sub",
			text:
				`${inlined} file${inlined === 1 ? "" : "s"} inlined. ` +
				"Print it from the browser for a PDF.",
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
				fail(`could not launch ${path} — open it yourself`);
			}
			close();
		});
	});
}

/**
 * The whole exported document, as a string.
 *
 * Separate from writing it, because the preview shows this same HTML in an
 * iframe with no file existing at all — and a preview that built something
 * different from the export would be worth nothing.
 */
export async function buildDeckHtml(
	app: App,
	input: ExportInput
): Promise<{ html: string; inlined: number }> {
	const clone = input.stage.cloneNode(true) as HTMLElement;
	flattenShadows(input.stage, clone);
	const inlined = await inlineMedia(app, clone);

	// The logo is written into the template rather than cloned, so it misses
	// the pass above and has to be inlined on its own.
	if (input.logo?.src) {
		const uri = await dataUri(app, input.logo.src);
		input = { ...input, logo: uri ? { ...input.logo, src: uri } : undefined };
	}

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
    transition: transform ${input.duration}ms cubic-bezier(0.6, 0, 0.2, 1); }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex;
    justify-content: space-between; padding: 10px 18px; font-size: 13px;
    color: #6b7a80; pointer-events: none; }
  #rail { position: fixed; left: 0; right: 0; top: 0; height: 3px; background: rgb(0 0 0 / 0.08); }
  #railfill { height: 100%; width: 0; background: #1d5a78; transition: width 420ms ease; }
  #blank { position: fixed; inset: 0; background: #000; display: none; z-index: 40; }
  #blank.on { display: block; }
  #map { position: fixed; inset: 0; z-index: 50; display: none;
    background: rgb(16 22 26 / 0.93); padding: 4vh 4vw; box-sizing: border-box; }
  #map.on { display: block; }
  #map svg { width: 100%; height: 100%; }
  #map .mn { fill: rgb(255 255 255 / 0.16); stroke: rgb(255 255 255 / 0.3);
    stroke-width: 2; cursor: pointer; }
  #map .mn:hover { fill: rgb(255 255 255 / 0.3); }
  #map .mn.on { fill: #7cc6ff; stroke: #7cc6ff; }
  #map .mg { fill: none; stroke: rgb(255 255 255 / 0.22); stroke-dasharray: 10 8; }
  #map .ml { fill: rgb(255 255 255 / 0.85); font: 500 13px system-ui, sans-serif;
    pointer-events: none; }
  #map .mh { position: absolute; left: 4vw; top: 1.6vh; color: rgb(255 255 255 / 0.6);
    font: 13px system-ui, sans-serif; }
  #print { display: none; }
  @media print {
    html, body { height: auto; overflow: visible; background: #fff; }
    #view, #bar { display: none !important; }
    #print { display: block; }
    .page { page-break-after: always; break-after: page; padding: 0; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .atl-node { box-shadow: none !important; border: 1px solid #ddd; }
    /* #print carries .atl-overlay so the theme's tokens reach it, but the
       overlay is a fixed, clipped full-screen layer — which on paper would
       print one page and swallow the rest. */
    #print.atl-overlay { position: static !important; inset: auto !important;
      overflow: visible !important; height: auto !important; background: none !important; }
    .atl-logo { display: none !important; }
    /* Stacked frames have to be un-stacked, or every picture but one prints
       underneath the others. */
    .print-all { position: static !important; height: auto !important;
      display: flex !important; flex-wrap: wrap; gap: 8px; }
    .print-all .atl-frame-item { position: static !important; opacity: 1 !important;
      transform: none !important; width: 48% !important; height: auto !important; }
    .print-all .atl-show-controls { display: none !important; }
  }
  @page { size: landscape; margin: 12mm; }
${input.css}
</style>
</head>
<body>
<div id="view" class="atl-overlay"><div id="stage" class="atl-stage"></div>${logoTag(input)}</div>
<div id="rail"><div id="railfill"></div></div>
<div id="blank"></div>
<div id="map"><div class="mh">Click a card to fly to it &middot; M or Esc to close</div></div>
<div id="bar"><span>${input.title}</span><span id="counter"></span></div>
<div id="print" class="atl-overlay">__PRINT__</div>
<script>
  window.__ATLAS_STOPS__ = ${JSON.stringify(input.stops)};
  window.__ATLAS_PAD__ = ${input.padding};
  window.__ATLAS_MAX__ = ${input.maxScale};
</script>
<script>${RUNTIME}</script>
</body>
</html>`;

	const stageHtml = clone.innerHTML;
	return {
		inlined,
		html: html
			.replace('<div id="stage" class="atl-stage"></div>', `<div id="stage" class="atl-stage">${stageHtml}</div>`)
			.replace("__PRINT__", printPages(clone, input.stops.filter((s) => !s.label))),
	};
}

export async function exportDeck(app: App, input: ExportInput): Promise<string | null> {
	const { html: out, inlined } = await buildDeckHtml(app, input);
	const folder = safeFileName(input.title);
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
