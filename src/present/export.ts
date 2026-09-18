import { App, Notice, TFile, normalizePath } from "obsidian";
import { safeFileName } from "../format";
import { mimeFor } from "../media";
import { fail, offer, say } from "../notice";

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
		/** The colour given in the canvas editor, mirrored on the map. */
		colour: string;
		/** Its place in the running order, for the badge on the map. */
		order: number;
	}[];
	/**
	 * What the map is drawn from.
	 *
	 * The exported map used to be rectangles and nothing else — no group names,
	 * no numbers, no arrows, no colours — which made it useless for the one
	 * thing a map is for. It is drawn from the same shapes and with the same
	 * class names as the deck's own, so the plugin stylesheet that travels with
	 * the file styles both.
	 */
	map: {
		groups: { x: number; y: number; width: number; height: number; label: string }[];
		edges: { x1: number; y1: number; x2: number; y2: number }[];
	};
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
	logo?: { srcs: string[]; corner: string; height: number; opacity: number };
	/**
	 * The rest of the deck's branding.
	 *
	 * The logo was carried across because a branded deck exported unbranded is
	 * the one context where the branding was the point. That is just as true of
	 * the accent colour, the backdrop and how far an image behind the cards is
	 * dimmed — all of which the deck writes onto the overlay as inline styles,
	 * and the export built a fresh overlay without.
	 */
	look: {
		accent: string;
		background: string;
		backgroundImage: string;
		dim: number;
		inactive: number;
		sectionTitles: boolean;
	};
	/**
	 * Whether this vault runs card scripts.
	 *
	 * The export follows the same answer. A card not trusted to run in Obsidian
	 * should not start running because it was sent to somebody.
	 */
	allowScripts: boolean;
	/**
	 * Open the file as soon as it is written.
	 *
	 * A notice with a button in it can be missed — you look away, it goes, and
	 * you are left with a path. The file is always written to the same place and
	 * always replaces what was there, so opening it is safe to do without being
	 * asked.
	 */
	openAfter: boolean;
}

/** The deck's look, as the attributes the exported overlay is opened with. */
function lookAttrs(input: ExportInput): string {
	const k = input.look;
	const style = [`--atl-inactive:${k.inactive}`];
	if (k.accent) style.push(`--atl-accent:${k.accent}`);
	if (k.backgroundImage) {
		style.push(`background-image:url("${k.backgroundImage}")`, `--atl-dim:${k.dim}`);
	} else if (k.background) {
		style.push(`background:${k.background}`);
	}
	const classes = ["atl-overlay"];
	if (k.backgroundImage) classes.push("has-image");
	if (!k.sectionTitles) classes.push("hide-sections");
	return `class="${classes.join(" ")}" style="${style.join(";")}"`;
}

/** The logo markup, with its source inlined along with everything else. */
function logoTag(input: ExportInput): string {
	const logo = input.logo;
	if (!logo || logo.srcs.length === 0) return "";
	// The row carries the corner and the opacity, exactly as the deck does, so
	// several marks sit on one baseline here too.
	const imgs = logo.srcs
		.map((src) => `<img class="atl-logo" src="${src}" style="height:${logo.height}px">`)
		.join("");
	return (
		`<div class="atl-logos" data-corner="${logo.corner}" ` +
		`style="opacity:${logo.opacity}">${imgs}</div>`
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

/**
 * The cards' own scripts, rewritten to run in a plain document.
 *
 * A card script is handed `root` — its shadow root — and `host`, the card
 * element. Both mean the same in the exported file, because wrapShadows() gives
 * the cards their shadow roots back; if one could not be attached the script
 * falls back to the card itself, and `root.querySelector` still finds that
 * card's own content and nothing else.
 *
 * Only emitted when the vault has script execution turned on: a card that is
 * not trusted to run in Obsidian should not start running because it was sent
 * to somebody.
 */
function cardScripts(clone: HTMLElement): string {
	const out: string[] = [];
	for (const body of Array.from(clone.querySelectorAll<HTMLElement>("[data-atl-scripts]"))) {
		const raw = body.dataset.atlScripts ?? "";
		body.removeAttribute("data-atl-scripts");
		const card = body.closest<HTMLElement>("[data-node-id]");
		const id = card?.dataset.nodeId;
		if (!id) continue;

		let sources: string[];
		try {
			sources = JSON.parse(raw) as string[];
		} catch {
			continue;
		}

		const selector = `[data-node-id="${id}"] .atl-body`;
		for (const code of sources) {
			// A literal </script> inside the card would close this one early.
			const safe = code.replace(/<\/script/gi, "<\\/script");
			out.push(`<script>
(function () {
  var host = document.querySelector(${JSON.stringify(selector)});
  if (!host) return;
  // The shadow root if it was given one back, the card itself otherwise —
  // either way root.querySelector finds the card's own content and nothing
  // else, which is the whole of what a card script uses it for.
  var root = host.shadowRoot || host;
  try {
${safe}
  } catch (e) {
    var note = document.createElement('div');
    note.className = 'atl-script-error';
    note.textContent = "This card's script failed: " + ((e && e.message) || e);
    host.appendChild(note);
  }
})();
</script>`);
		}
	}
	return out.join("\n");
}

/**
 * Give the exported HTML cards their shadow roots back.
 *
 * Flattening is how the content survives cloning, but a flattened card is not
 * the same card: `:host` — which is how every one of these stylesheets declares
 * its own tokens — matches nothing outside a shadow root, so the card arrives
 * with its CSS silently inert. Its `<style>` also stops being scoped, and leaks
 * over every other card in the file.
 *
 * So the flattened content is parked in a `<template>` and a shadow root is
 * built from it when the page loads. Done after the media is inlined and the
 * print pages are taken, because neither reaches inside a template.
 */
function wrapShadows(clone: HTMLElement): string {
	const hosts = Array.from(clone.querySelectorAll<HTMLElement>(".atl-was-shadow"));
	if (hosts.length === 0) return "";

	for (const host of hosts) {
		// createElement, not Obsidian's createEl: called on a Document, createEl
		// appends what it makes — and a document already has its one element, so
		// it throws. The same line in the card renderer is what made every HTML
		// card blank; this one would have made every exported one blank too.
		const tpl = host.ownerDocument.createElement("template");
		tpl.className = "card-shadow";
		while (host.firstChild) tpl.content.appendChild(host.firstChild);
		host.appendChild(tpl);
	}

	return `<script>
(function () {
  var tpls = document.querySelectorAll('.atl-was-shadow > template.card-shadow');
  for (var i = 0; i < tpls.length; i++) {
    var tpl = tpls[i], host = tpl.parentElement;
    try {
      var root = host.attachShadow({ mode: 'open' });
      tpl.remove();
      root.appendChild(tpl.content);
    } catch (e) {
      /* Already attached, or a host that cannot take one: leave it flattened. */
    }
  }
})();
</script>`;
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
			// Not copied as markup. A card's scripts are re-emitted at the foot
			// of the document by cardScripts(), wrapped so `root` and `host`
			// mean there what they mean here — copying the tag would run it
			// with neither in scope.
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
  var keys = document.getElementById('keys');
  var stops = window.__ATLAS_STOPS__, pad = window.__ATLAS_PAD__, max = window.__ATLAS_MAX__;
  var mapData = window.__ATLAS_MAP__;
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
  /* A frame's place is an inline transform and opacity, not the class: the deck
     writes them as it moves. Toggling only the class left every clone frozen on
     whichever frame it was exported showing, because inline styles win. This is
     the deck's own layout, in the same five modes, read off the root's tx- class. */
  function modeOf(show) {
    var c = show.classList;
    if (c.contains('tx-slide')) return 'slide';
    if (c.contains('tx-slide-up')) return 'slide-up';
    if (c.contains('tx-zoom')) return 'zoom';
    if (c.contains('tx-flip')) return 'flip';
    return 'fade';
  }
  function setFrame(show, n) {
    var f = framesIn(show), dots = [].slice.call(show.querySelectorAll('.atl-show-dots > *'));
    if (!f.length) return 0;
    n = Math.max(0, Math.min(n, f.length - 1));
    var mode = modeOf(show);
    for (var k = 0; k < f.length; k++) {
      var d = k - n, st = f[k].style;
      f[k].classList.toggle('is-current', d === 0);
      if (mode === 'slide') {
        st.transform = 'translateX(' + d * 100 + '%)'; st.opacity = '1';
      } else if (mode === 'slide-up') {
        st.transform = 'translateY(' + d * 100 + '%)'; st.opacity = '1';
      } else if (mode === 'zoom') {
        st.transform = d === 0 ? 'scale(1)' : 'scale(1.06)'; st.opacity = d === 0 ? '1' : '0';
      } else if (mode === 'flip') {
        st.transform = 'perspective(1400px) rotateY(' + d * 78 + 'deg)';
        st.opacity = d === 0 ? '1' : '0';
      } else {
        st.transform = 'none'; st.opacity = d === 0 ? '1' : '0';
      }
    }
    for (var j = 0; j < dots.length; j++) dots[j].classList.toggle('is-current', j === n);
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
    /* Cards, the way the deck counts them: a section overview is a stop but
       not a card, and the banner is the cover rather than card one, so
       counting stops here made the exported file disagree with the deck it
       came from, slide for slide. */
    var total = cardTotal();
    var name = s.label || s.title;
    counter.textContent =
      '? for keys  \\u00b7  ' + (s.order ? s.order + ' / ' + total : '') + (name ? '  \\u00b7  ' + name : '');
    railfill.style.width = (stops.length < 2 ? 100 : (i / (stops.length - 1)) * 100) + '%';
    if (map.classList.contains('is-open')) markMap();
  }

  /* A card is told when it arrives and when it leaves, under the same names
     the deck uses, so a script that stops its animation off camera behaves the
     same here. Without this an exported animation would run for every card in
     the file at once, for as long as the tab stayed open. */
  function cardTotal() {
    var n = 0;
    for (var i = 0; i < stops.length; i++) if (stops[i].order > n) n = stops[i].order;
    return n;
  }

  function signal(el, kind) {
    var body = el && el.querySelector('.atl-body');
    if (body) body.dispatchEvent(new CustomEvent('atlas:' + kind));
  }

  /* Arriving forwards starts a card folded; arriving backwards starts it fully
     open, so stepping back into a card does not replay it. */
  function go(n, back) {
    n = Math.max(0, Math.min(n, stops.length - 1));
    if (n === i) { paint(true); return; }
    var leaving = cardAt(i);
    resetCard(leaving, false);
    signal(leaving, 'leave');
    i = n;
    var el = cardAt(i);
    resetCard(el, !!back);
    step = back ? stepsIn(el).length : 0;
    paint(true);
    signal(el, 'enter');
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

  function bounds() {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var n = 0; n < stops.length; n++) {
      var s = stops[n];
      minx = Math.min(minx, s.x); miny = Math.min(miny, s.y);
      maxx = Math.max(maxx, s.x + s.width); maxy = Math.max(maxy, s.y + s.height);
    }
    return { x: minx, y: miny, width: maxx - minx, height: maxy - miny };
  }

  /* O — the whole map, readable, every card clickable. Its counterpart is M,
     the schematic index; this one is the cards themselves. */
  var overview = false, pickScale = 1, viewCx = 0, viewCy = 0;

  /* Pan at a scale already chosen, rather than re-deciding it: browsing holds
     the zoom and only moves. Fitting the whole deck is what M is for, and on a
     real deck it makes every card too small to read — the opposite of useful
     when the question is which card it was. */
  function placeAt(cx, cy, scale, animate) {
    stage.style.transition = animate ? '' : 'none';
    stage.style.transform =
      'translate(' + view.clientWidth / 2 + 'px,' + view.clientHeight / 2 + 'px) ' +
      'scale(' + scale + ') ' +
      'translate(' + -cx + 'px,' + -cy + 'px)';
    if (!animate) { void stage.offsetWidth; stage.style.transition = ''; }
  }
  /* The framing the camera uses between sections: the group this card is in,
     or its own neighbourhood where there is no group. Then it is held while
     you scroll — nothing here selects a card, because a selection meant an
     arrow key yanked the view back to it and threw away where you had got to. */
  function sectionOf(n) {
    for (var k = n; k >= 0; k--) if (stops[k].label) return stops[k];
    return null;
  }
  /* Keep the deck on screen. Scrolling used to run off into empty space above
     the first group and keep going, which leaves you nowhere with nothing to
     steer by. Half a screen past the edge is enough to see that it is one. */
  function clampView() {
    var b = bounds();
    var halfW = view.clientWidth / pickScale / 2, halfH = view.clientHeight / pickScale / 2;
    function pick(lo, hi, half, centre, at) {
      if (hi - lo < half * 2) return centre;
      return Math.min(Math.max(at, lo - half * 0.5), hi + half * 0.5);
    }
    viewCx = pick(b.x, b.x + b.width, halfW, b.x + b.width / 2, viewCx);
    viewCy = pick(b.y, b.y + b.height, halfH, b.y + b.height / 2, viewCy);
  }
  function look(animate) { clampView(); placeAt(viewCx, viewCy, pickScale, animate); }
  function pan(dx, dy, animate) {
    viewCx += dx / pickScale;
    viewCy += dy / pickScale;
    look(animate);
  }
  function fitScale() {
    var b = bounds();
    return Math.min(view.clientWidth / (b.width * 1.06), view.clientHeight / (b.height * 1.06));
  }
  /* Zoom about a point, so what is under the cursor stays under it. */
  function zoom(factor, ox, oy, animate) {
    var was = pickScale;
    var next = Math.min(Math.max(was * factor, fitScale()), Math.max(max, fitScale()));
    if (next === was) return;
    viewCx += (ox || 0) / was - (ox || 0) / next;
    viewCy += (oy || 0) / was - (oy || 0) / next;
    pickScale = next;
    look(animate);
  }
  function showAll() {
    var b = bounds();
    pickScale = fitScale();
    viewCx = b.x + b.width / 2;
    viewCy = b.y + b.height / 2;
    look(true);
  }
  function openOverview() {
    if (overview) return;
    overview = true;
    view.classList.add('is-overview');
    var g = sectionOf(i), r = g || stops[i];
    pickScale = Math.min(
      view.clientWidth / (r.width * (1 + pad * 2)),
      view.clientHeight / (r.height * (1 + pad * 2)),
      max
    );
    if (!g) pickScale = pickScale / 2.2;
    viewCx = r.x + r.width / 2;
    viewCy = r.y + r.height / 2;
    look(true);
  }
  function closeOverview(at) {
    if (!overview) return;
    overview = false;
    view.classList.remove('is-overview');
    if (at === undefined) paint(true); else go(at);
  }

  /* The same shapes and the same class names as the deck's own map, so the
     plugin stylesheet that travels with this file styles both: groups with
     their names, the arrows between cards, each card's canvas colour, its
     title, and its number in the running order. It used to be grey rectangles
     and nothing else, which is not a map. */
  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /* Break a title into at most max lines of about per characters. */
  function wrap(text, per, max) {
    var words = String(text).split(/\\s+/), out = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var next = line ? line + ' ' + words[i] : words[i];
      if (next.length <= per || !line) { line = next; continue; }
      out.push(line); line = words[i];
      if (out.length === max - 1) break;
    }
    if (line && out.length < max) out.push(line);
    if (out.length === max && words.join(' ').length > out.join(' ').length) {
      out[max - 1] = out[max - 1].replace(/.$/, '\u2026');
    }
    return out;
  }

  function buildMap() {
    var b = bounds();
    var m = Math.max(b.width, b.height) * 0.05;
    var unit = Math.max(b.width, b.height) / 900;
    var stroke = Math.max(unit, 1);
    var svg = '<svg class="atl-minimap-svg" viewBox="' + (b.x - m) + ' ' + (b.y - m) + ' ' +
      (b.width + m * 2) + ' ' + (b.height + m * 2) + '" preserveAspectRatio="xMidYMid meet">';

    for (var g = 0; g < mapData.groups.length; g++) {
      var gr = mapData.groups[g];
      svg += '<rect class="atl-mm-group" x="' + gr.x + '" y="' + gr.y + '" width="' + gr.width +
        '" height="' + gr.height + '" rx="' + stroke * 12 + '" stroke-width="' + stroke + '"></rect>';
      if (gr.label) {
        /* Sized to the gap above it, not to the canvas: a name taller than the
           space between two sections is drawn over the section above. */
        var above = b.y;
        for (var q = 0; q < mapData.groups.length; q++) {
          var o = mapData.groups[q];
          if (o.y + o.height <= gr.y + 1) above = Math.max(above, o.y + o.height);
        }
        var gap = Math.max(gr.y - above, 0);
        var gs = Math.min(stroke * 22, Math.max(gap * 0.55, 1), gr.height * 0.16);
        var inside = gap < gs * 1.3;
        svg += '<text class="atl-mm-grouplabel" x="' + (gr.x + gs * 0.5) + '" y="' +
          (inside ? gr.y + gs * 1.15 : gr.y - gs * 0.38) + '" font-size="' + gs + '">' +
          esc(gr.label) + '</text>';
      }
    }

    for (var e = 0; e < mapData.edges.length; e++) {
      var ed = mapData.edges[e];
      svg += '<line class="atl-mm-edge" x1="' + ed.x1 + '" y1="' + ed.y1 + '" x2="' + ed.x2 +
        '" y2="' + ed.y2 + '" stroke-width="' + stroke * 1.6 + '"></line>';
    }

    for (var k = 0; k < stops.length; k++) {
      var t = stops[k];
      if (t.label) continue; /* a section overview is the group, already drawn */
      var rx = Math.min(t.width, t.height) * 0.05;
      svg += '<g class="atl-mm-card" data-i="' + k + '">';
      svg += '<rect class="atl-mm-node" data-i="' + k + '" x="' + t.x + '" y="' + t.y +
        '" width="' + t.width + '" height="' + t.height + '" rx="' + rx +
        '" stroke-width="' + stroke + '"' +
        (t.colour ? ' data-color="' + esc(t.colour) + '"' : '') + '></rect>';

      var size = Math.max(Math.min(t.height * 0.15, t.width * 0.08), stroke * 6, 9);
      var lines = wrap(t.title, Math.floor(t.width / (size * 0.54)), 3);
      var top = t.y + t.height / 2 - ((lines.length - 1) * size * 1.25) / 2 + size * 0.34;
      svg += '<text class="atl-mm-label" text-anchor="middle" font-size="' + size + '">';
      for (var L = 0; L < lines.length; L++) {
        svg += '<tspan x="' + (t.x + t.width / 2) + '" y="' + (top + L * size * 1.25) + '">' +
          esc(lines[L]) + '</tspan>';
      }
      svg += '</text>';

      var br = Math.max(Math.min(t.width, t.height) * 0.07, stroke * 7);
      svg += '<circle class="atl-mm-badge" cx="' + (t.x + br * 1.35) + '" cy="' + (t.y + br * 1.35) +
        '" r="' + br + '"></circle>';
      svg += '<text class="atl-mm-badgetext" x="' + (t.x + br * 1.35) + '" y="' +
        (t.y + br * 1.35 + br * 0.36) + '" text-anchor="middle" font-size="' + br * 1.05 + '">' +
        t.order + '</text>';
      svg += '</g>';
    }

    map.insertAdjacentHTML('beforeend', svg + '</svg>');
    map.addEventListener('click', function (ev) {
      var hit = ev.target.closest('[data-i]');
      if (hit) { toggleMap(false); go(+hit.getAttribute('data-i')); }
    });
  }
  function markMap() {
    var r = map.querySelectorAll('rect.atl-mm-node');
    for (var n = 0; n < r.length; n++) {
      r[n].classList.toggle('is-current', +r[n].getAttribute('data-i') === i);
    }
  }
  function toggleMap(on) {
    if (!map.querySelector('svg')) buildMap();
    map.classList.toggle('is-open', on === undefined ? !map.classList.contains('is-open') : on);
    if (map.classList.contains('is-open')) markMap();
  }

  /* ---- keys ------------------------------------------------------------- */

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    /* The key card is modal: it closes, and nothing else happens. */
    if (keys.classList.contains('on')) {
      e.preventDefault();
      keys.classList.remove('on');
      return;
    }
    if (k === '?' || k === '/' || k === 'h' || k === 'H') {
      e.preventDefault();
      keys.classList.add('on');
      return;
    }
    if (map.classList.contains('is-open')) {
      if (k === 'Escape' || k === 'm' || k === 'M') { e.preventDefault(); toggleMap(false); }
      return;
    }
    /* The overview is a look, not a place. */
    if (overview) {
      e.preventDefault();
      var w = view.clientWidth * 0.6, h = view.clientHeight * 0.6;
      if (k === 'o' || k === 'O' || k === 'Escape') closeOverview();
      else if (k === 'ArrowRight') pan(w, 0, true);
      else if (k === 'ArrowLeft') pan(-w, 0, true);
      else if (k === 'ArrowDown' || k === 'PageDown' || k === ' ') pan(0, h, true);
      else if (k === 'ArrowUp' || k === 'PageUp') pan(0, -h, true);
      else if (k === '+' || k === '=') zoom(1.25, 0, 0, true);
      else if (k === '-' || k === '_') zoom(0.8, 0, 0, true);
      else if (k === '0') showAll();
      else if (k === 'Home' || k === 'End') {
        var e2 = stops[k === 'Home' ? 0 : stops.length - 1];
        viewCx = e2.x + e2.width / 2; viewCy = e2.y + e2.height / 2; look(true);
      }
      return;
    }
    if (['ArrowRight', ' ', 'PageDown', 'ArrowDown'].indexOf(k) > -1) { e.preventDefault(); advance(); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].indexOf(k) > -1) { e.preventDefault(); retreat(); }
    else if (k === 'Home') { e.preventDefault(); go(0); }
    else if (k === 'End') { e.preventDefault(); go(stops.length - 1); }
    else if (k === 'm' || k === 'M') { e.preventDefault(); toggleMap(); }
    else if (k === 'o' || k === 'O') { e.preventDefault(); openOverview(); }
    else if (k === 'b' || k === 'B') { e.preventDefault(); blank.classList.toggle('on'); }
    else if (k === 'f' || k === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    }
  });

  /* The preview pane holds this file in a sandboxed frame, so it cannot reach
     in and call print(). It can send a message, and this answers it. */
  addEventListener('message', function (e) {
    if (e.data === 'atlas:print') window.print();
  });

  /* Dragging the map. A few pixels is a click on a card; more is a pan, and the
     click that follows a pan must not also choose. */
  var from = null, moved = false;
  view.addEventListener('pointerdown', function (e) {
    if (!overview || e.button !== 0) return;
    from = { x: e.clientX, y: e.clientY };
    moved = false;
  });
  view.addEventListener('pointermove', function (e) {
    if (!from) return;
    var dx = e.clientX - from.x, dy = e.clientY - from.y;
    if (!moved && Math.sqrt(dx * dx + dy * dy) < 5) return;
    moved = true;
    view.classList.add('is-dragging');
    from = { x: e.clientX, y: e.clientY };
    pan(-dx, -dy, false);
  });
  function release() {
    from = null;
    view.classList.remove('is-dragging');
    setTimeout(function () { moved = false; }, 0);
  }
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);

  blank.addEventListener('click', function () { blank.classList.remove('on'); });
  keys.addEventListener('click', function () { keys.classList.remove('on'); });
  /* A click inside a card's shadow root is retargeted to the host, so e.target
     is the card and never the button that was pressed — pressing a control in
     an interactive card advanced the slide instead of working. The composed
     path still holds the real chain. Same list the deck uses, so a card that
     behaves in Obsidian behaves here. */
  var INTERACTIVE = 'a, button, video, audio, iframe, input, textarea, select,' +
    ' label, summary, .atl-hud, .atl-show-controls';
  function interactiveHit(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    for (var n = 0; n < path.length; n++) {
      var el = path[n];
      if (el === stage) break;
      if (el && el.nodeType === 1 && el.matches && el.matches(INTERACTIVE)) return true;
    }
    return false;
  }

  view.addEventListener('click', function (e) {
    if (overview) {
      if (moved) return;
      var path = e.composedPath ? e.composedPath() : [e.target];
      var id = null;
      for (var n = 0; n < path.length && !id; n++) {
        if (path[n] && path[n].getAttribute) id = path[n].getAttribute('data-node-id');
      }
      var at;
      if (id) for (var k = 0; k < stops.length; k++) if (stops[k].nodeId === id) { at = k; break; }
      closeOverview(at);
      return;
    }
    if (interactiveHit(e)) return;
    if (e.clientX > window.innerWidth / 3) advance(); else retreat();
  });
  addEventListener('resize', function () {
    if (overview) look(false); else paint(false);
  });

  /* Scrolling is how you move around a map. The camera centre is its own pair
     of numbers: nudging the stop's own x and y would move the card itself, and
     the deck would be wrong ever after. */
  view.addEventListener('wheel', function (e) {
    if (!overview) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      var box = view.getBoundingClientRect();
      zoom(Math.pow(0.9988, e.deltaY),
        e.clientX - box.left - box.width / 2,
        e.clientY - box.top - box.height / 2, false);
      return;
    }
    /* Shift swaps the axis: most mice have one wheel, and a deck laid out left
       to right needs the other direction. */
    pan(e.shiftKey ? e.deltaY : e.deltaX, e.shiftKey ? 0 : e.deltaY, false);
  }, { passive: false });

  /* Every card starts folded, or a reveal would be showing before its turn. */
  var all = stage.querySelectorAll('.atl-node');
  for (var z = 0; z < all.length; z++) resetCard(all[z], false);
  paint(false);
  signal(cardAt(i), 'enter');
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
		// On a page a card is the page, not a rectangle on a plane. Its height
		// comes from its own proportions, so this is arithmetic, not a class.
		page.setCssStyles({
			position: "static",
			left: "",
			top: "",
			width: "100%",
			height: `${(stop.height / stop.width) * 100}%`,
		});
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
		// The number a printed deck is referred to by. A section overview carries
		// none: it is the same view as the cards under it.
		const n = stop.order ? ` data-n="${stop.order}"` : "";
		pages.push(`<div class="page"${n}>${page.outerHTML}</div>`);
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
function launcher(app: App): ((p: string) => void) | null {
	const open = (app as unknown as { openWithDefaultApp?: (p: string) => void })
		.openWithDefaultApp;
	return typeof open === "function" ? (p: string) => open.call(app, p) : null;
}

function reveal(app: App, path: string, inlined: number, openAfter: boolean): void {
	const open = launcher(app);
	const files = `${inlined} file${inlined === 1 ? "" : "s"} inlined.`;

	if (openAfter && open) {
		try {
			open(path);
			say(`exported to ${path} and opened. ${files}`, 7000);
			return;
		} catch {
			// Fall through to the notice with a button, which is the same offer
			// made a second time rather than a failure worth reporting.
		}
	}

	offer((el, close) => {
		el.createDiv({ text: `Atlas: exported to ${path}` });
		el.createDiv({
			cls: "atl-notice-sub",
			text:
				`${inlined} file${inlined === 1 ? "" : "s"} inlined. ` +
				"Print it from the browser for a PDF.",
		});

		if (!open) return;

		const btn = el.createEl("button", { cls: "atl-notice-btn", text: "Open in browser" });
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			try {
				open(path);
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
	if (input.logo && input.logo.srcs.length > 0) {
		const uris = (await Promise.all(input.logo.srcs.map((src) => dataUri(app, src)))).filter(
			(u): u is string => !!u
		);
		input = { ...input, logo: uris.length > 0 ? { ...input.logo, srcs: uris } : undefined };
	}
	if (input.look.backgroundImage) {
		const uri = await dataUri(app, input.look.backgroundImage);
		input = { ...input, look: { ...input.look, backgroundImage: uri ?? "" } };
	}

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${input.title}</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
  /* #view carries .atl-overlay so the theme's tokens reach the cards, and that
     class brings z-index:100 with it — which put the slide above the map and
     the blanking layer. An id beats a class, so the stack is stated here. */
  /* Obsidian's font variables, which a theme's fallbacks point at and a
     browser has never heard of. Left undefined, every font declaration in the
     deck collapsed to the browser default — so the exported cards were set in
     Segoe UI where the deck was set in Inter, and text that fitted a column in
     Obsidian wrapped a word early here. Same names, same order Obsidian uses,
     so a theme that names a real font still gets it and everything else lands
     on the same stack at both ends. */
  #view.atl-overlay, #print.atl-overlay {
    --font-interface: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    --font-text: var(--font-interface);
    --font-monospace: ui-monospace, "Cascadia Mono", "Source Code Pro", Menlo,
      Consolas, monospace;
    --text-normal: var(--ink, #14232a);
    --text-muted: var(--ink-soft, #4e5f66);
    --text-faint: var(--ink-faint, rgb(20 35 42 / 0.3));
    --background-primary: var(--paper, #fff);
    --background-secondary: var(--panel, #f6f6f4);
    --background-modifier-border: var(--rule, #d7dbd7);
    --interactive-accent: var(--accent, #1d5a78);
  }
  #view { position: fixed; inset: 0; overflow: hidden; z-index: 0; }
  #stage { position: absolute; top: 0; left: 0; transform-origin: 0 0;
    transition: transform ${input.duration}ms cubic-bezier(0.6, 0, 0.2, 1); }
  #bar { z-index: 30; position: fixed; left: 0; right: 0; bottom: 0; display: flex;
    justify-content: space-between; padding: 10px 18px; font-size: 13px;
    color: var(--ink-soft, #6b7a80); pointer-events: none; }
  #rail { z-index: 30; position: fixed; left: 0; right: 0; top: 0; height: 3px; background: rgb(0 0 0 / 0.08); }
  #railfill { height: 100%; width: 0; background: var(--accent, #1d5a78); transition: width 420ms ease; }
  #blank { position: fixed; inset: 0; background: #000; display: none; z-index: 40; }
  #blank.on { display: block; }
  /* The map carries .atl-minimap, so the plugin's own stylesheet — which
     travels with this file — draws it exactly as the deck does. Only the
     stacking is stated here, because .atl-minimap is positioned inside the
     overlay and this one is a layer over the whole page. */
  /* The map carries .atl-overlay for one reason: every colour in it comes from
     a theme token, and those tokens are declared on .atl-overlay. Outside one,
     a browser resolves them to nothing and falls back to Obsidian's own
     variables, which do not exist in a file opened from disk — so the cards
     came out as black rectangles and the labels as black text on black. The
     overlay's own layout is undone here; only its tokens are wanted. */
  #map.atl-overlay { position: fixed; inset: 0; z-index: 50;
    background: color-mix(in srgb, var(--paper, #fff) 88%, transparent);
    overflow: hidden; }
  #map.atl-minimap:not(.is-open) { display: none; }
  #map.atl-minimap.is-open { display: flex; }
  /* The overview: the same map, readable, every card clickable. Off-camera
     cards are dimmed by the plugin stylesheet so the audience keeps its
     bearings; here that is exactly wrong. */
  #view.is-overview { cursor: grab; }
  #view.is-overview.is-dragging { cursor: grabbing; user-select: none; }
  #view.is-overview .atl-node { opacity: 1 !important; cursor: pointer; }
  #view.is-overview.is-dragging .atl-node { cursor: grabbing; }
  #view.is-overview .atl-node:not(.atl-node-group) { outline: 2px solid transparent;
    outline-offset: 3px; transition: outline-color 140ms ease; }
  #view.is-overview .atl-node:not(.atl-node-group):hover { outline-color: var(--accent, #1d5a78); }
  #view.is-overview .atl-node.is-active { outline-color: var(--accent, #1d5a78); outline-style: dashed; }
  #hint { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
    z-index: 31; display: none; padding: 7px 15px; border-radius: 999px;
    font-size: 13px; color: var(--ink-soft, #6b7a80); background: var(--panel, #fff); border: 1px solid var(--rule, #dfe4dd);
    box-shadow: 0 4px 18px rgb(0 0 0 / 0.18); pointer-events: none; }
  #view.is-overview ~ #hint { display: block; }
  /* The keys, for someone who was sent this file and has never seen the
     plugin. Discoverable from the bar rather than only by being told. */
  #keys { position: fixed; inset: 0; z-index: 60; display: none;
    background: rgb(16 22 26 / 0.9); }
  #keys.on { display: flex; align-items: center; justify-content: center; }
  #keys table { border-collapse: collapse; font: 15px/1.7 inherit; color: #e9eef3;
    background: #1a232b; border-radius: 14px; padding: 10px 8px;
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.45); }
  #keys caption { padding: 16px 22px 10px; font-weight: 600; font-size: 17px;
    color: #fff; text-align: left; }
  #keys td { padding: 5px 22px; }
  #keys td:first-child { color: #7cc6ff; font-family: ui-monospace, Consolas, monospace;
    white-space: nowrap; }
  #keys tr:last-child td { color: #8a98a4; padding-top: 14px; padding-bottom: 16px; }
  #print { display: none; }
  @media print {
    html, body { height: auto; overflow: visible; background: #fff; }
    #view, #bar { display: none !important; }
    #print { display: block; }
    .page { page-break-after: always; break-after: page; padding: 0; position: relative; }
    /* The card number, where a printed deck is read from: bottom right, on
       every page that is a card. */
    .page[data-n]::after {
      content: attr(data-n);
      position: absolute;
      right: 2mm;
      bottom: 2mm;
      font: 10pt/1 ui-sans-serif, system-ui, sans-serif;
      color: #777;
    }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .atl-node { box-shadow: none !important; border: 1px solid #ddd; }
    /* #print carries .atl-overlay so the theme's tokens reach it, but the
       overlay is a fixed, clipped full-screen layer — which on paper would
       print one page and swallow the rest. */
    #print.atl-overlay { position: static !important; inset: auto !important;
      overflow: visible !important; height: auto !important; background: none !important; }
    .atl-logos { display: none !important; }
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
<div id="view" ${lookAttrs(input)}><div id="stage" class="atl-stage"></div>${logoTag(input)}</div>
<div id="hint">Drag or scroll &middot; Ctrl+wheel or +/&minus; to zoom &middot; 0 shows all &middot; click a card to go there &middot; Esc</div>
<div id="rail"><div id="railfill"></div></div>
<div id="blank"></div>
<div id="map" class="atl-minimap atl-overlay"><div class="atl-minimap-hint">Click a card to fly to it &middot; M or Esc to close</div></div>
<div id="bar"><span>${input.title}</span><span id="counter"></span></div>
<div id="keys"><table>
<caption>Keys</caption>
<tr><td>→  Space</td><td>Reveal, then the pictures, then the next card</td></tr>
<tr><td>←</td><td>Back, the same way</td></tr>
<tr><td>O</td><td>The overview — the whole deck, click a card to go to it</td></tr>
<tr><td>M</td><td>The map — the same thing as a diagram</td></tr>
<tr><td>Home  End</td><td>First and last card</td></tr>
<tr><td>B</td><td>Blank the screen</td></tr>
<tr><td>F</td><td>Fullscreen</td></tr>
<tr><td>Ctrl+P</td><td>Print, or save as PDF — one card to a page</td></tr>
<tr><td>?</td><td>Close this</td></tr>
</table></div>
<div id="print" class="atl-overlay">__PRINT__</div>
<script>
  window.__ATLAS_STOPS__ = ${JSON.stringify(input.stops)};
  window.__ATLAS_PAD__ = ${input.padding};
  window.__ATLAS_MAX__ = ${input.maxScale};
  window.__ATLAS_MAP__ = ${JSON.stringify(input.map)};
</script>
__SCRIPTS__
<script>${RUNTIME}</script>
</body>
</html>`;

	// Read before the stage is serialised: it strips the attribute it reads.
	// Taken while the cards are still flattened: a template's content is invisible
	// to querySelectorAll, and paper has no shadow roots to give them back. The
	// `:host` rules are re-aimed at the host itself so a printed HTML card keeps
	// the look it had on screen.
	const printHtml = printPages(clone, input.stops.filter((s) => !s.label)).replace(
		/:host\b/g,
		".atl-body"
	);
	const scripts = input.allowScripts ? cardScripts(clone) : "";
	const shadows = wrapShadows(clone);
	const stageHtml = clone.innerHTML;

	return {
		inlined,
		html: html
			.replace('<div id="stage" class="atl-stage"></div>', `<div id="stage" class="atl-stage">${stageHtml}</div>`)
			.replace("__PRINT__", printHtml)
			// Shadow roots first, then the cards' own scripts, then the runtime.
			// A script needs its root to exist before it looks anything up, and
			// the runtime announces the opening card as it starts — a listener
			// bound after that announcement never hears it, so the very first
			// card's animation, the one you are looking at, would be the one
			// that stayed still.
			.replace("__SCRIPTS__", `${shadows}\n${scripts}`),
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
		reveal(app, path, inlined, input.openAfter);
		return path;
	} catch (e) {
		new Notice(`Atlas: could not write the export — ${String(e)}`);
		return null;
	}
}
