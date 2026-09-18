import { CanvasData, CanvasEdge, CanvasNode, Scene, Stop } from "../types";
import { boundsOf, buildGroupMap, outsideCode, rectOf } from "./parse";

/**
 * Edges carry the running order. A label that starts with a number wins
 * ("1.", "2 - then this"); otherwise we fall back to reading order of the
 * target card, so an unlabelled canvas still presents sensibly.
 */
function edgeRank(edge: CanvasEdge, target: CanvasNode | undefined): [number, number, number] {
	const m = edge.label?.trim().match(/^(\d+(?:\.\d+)?)/);
	const explicit = m ? parseFloat(m[1]) : Number.POSITIVE_INFINITY;
	const t = target ? rectOf(target) : { x: 0, y: 0, width: 0, height: 0 };
	return [explicit, t.y, t.x];
}

function compareRank(a: [number, number, number], b: [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Pick where the talk starts: an explicitly labelled node, else the only node
 * with outgoing edges and no incoming ones, else the top-left card.
 */
function pickStart(slides: CanvasNode[], edges: CanvasEdge[]): CanvasNode | undefined {
	if (slides.length === 0) return undefined;

	const tagged = slides.find((n) =>
		/(^|\n)\s*(#start\b|<!--\s*start\s*-->)/i.test(n.text ?? "")
	);
	if (tagged) return tagged;

	const incoming = new Set(edges.map((e) => e.toNode));
	const outgoing = new Set(edges.map((e) => e.fromNode));
	const roots = slides.filter((n) => !incoming.has(n.id) && outgoing.has(n.id));
	if (roots.length > 0) {
		return roots.sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x)[0];
	}

	return [...slides].sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x)[0];
}

/** A card marked `#deck` is the deck's title block, not a slide. */
const DECK_CARD = /(^|\n)[ \t]*#deck[ \t]*(\n|$)/;

/**
 * `key: value` lines from the #deck card.
 *
 * The header belongs to the canvas rather than to a global setting — two
 * decks want two different titles, and the person writing the talk should not
 * have to go into plugin settings to say so.
 */
/**
 * Every `#deck` card on the canvas, topmost first.
 *
 * A canvas stores its nodes in the order they were created, which is not an
 * order anyone can see. If a canvas has two of these, the one that wins should
 * be the one nearer the top of the map — something you can point at — and not
 * whichever happened to be drawn first months ago.
 */
function deckCardsIn(nodes: CanvasNode[]): CanvasNode[] {
	return nodes
		.filter((n) => n.type === "text" && DECK_CARD.test(outsideCode(n.text ?? "")))
		.sort((a, b) => a.y - b.y || a.x - b.x);
}

function readDeckMeta(nodes: CanvasNode[]): Record<string, string> {
	const cards = deckCardsIn(nodes);
	const card = cards[0];
	if (!card) return {};
	const meta: Record<string, string> = {};
	const body: string[] = [];
	// Anything that is not a key becomes header text, so the card needs a way to
	// carry a note to itself. %%…%% is what the rest of Atlas already uses.
	const source = (card.text ?? "").replace(/%%[\s\S]*?%%/g, "");
	for (const line of source.split("\n")) {
		if (/^[ \t]*#deck[ \t]*$/.test(line)) continue;
		const m = line.match(/^[ \t]*([A-Za-z][\w -]*)[ \t]*:[ \t]*(.+?)[ \t]*$/);
		if (m) {
			// Keys are matched loosely, so `logo corner:` and `logo-corner:` agree.
			// The value is trimmed because `theme: ` — the key emptied but the
			// space left behind — captured that space and became a setting one
			// character long. Every consumer treats an empty value as "not set"
			// and falls back to Settings; a single space is not empty, so it
			// overrode Settings with a path no file could ever have.
			meta[m[1].trim().toLowerCase().replace(/[ -]/g, "")] = m[2].trim();
			continue;
		}
		body.push(line);
	}
	// Anything that is not a key is the header's own content, as markdown.
	const rest = body.join("\n").trim();
	if (rest) meta.__body = rest;
	// So the deck can say so out loud rather than quietly using one of them.
	if (cards.length > 1) meta.__decks = String(cards.length);
	return meta;
}

/**
 * Which talk a card belongs to.
 *
 * `#skip-exec` leaves it out of the exec talk; `#only-exec` keeps it for that
 * talk alone. No tags at all means every talk, which is what most cards want.
 */
function inVariant(node: CanvasNode, variant: string): boolean {
	const text = outsideCode(node.text ?? "");
	const only = [...text.matchAll(/(^|\n)[ \t]*#only-([\w-]+)\b/gi)].map((m) => m[2].toLowerCase());
	const skip = [...text.matchAll(/(^|\n)[ \t]*#skip-([\w-]+)\b/gi)].map((m) => m[2].toLowerCase());
	const v = variant.toLowerCase();
	if (skip.includes(v)) return false;
	if (only.length > 0 && !only.includes(v)) return false;
	return true;
}

/** The variant names a canvas mentions anywhere, for the picker. */
/** `variant:` on the #deck card, when it names a default. */
export function readDeckVariant(data: CanvasData): string {
	const card = deckCardsIn(data.nodes)[0];
	if (!card) return "";
	const m = outsideCode(card.text ?? "").match(/^[ \t]*variant[ \t]*:[ \t]*(.+?)[ \t]*$/mi);
	return m ? m[1].toLowerCase() : "";
}

export function variantsIn(data: CanvasData): string[] {
	const found = new Set<string>();
	for (const node of data.nodes) {
		for (const m of outsideCode(node.text ?? "").matchAll(/(^|\n)[ \t]*#(?:skip|only)-([\w-]+)\b/gi)) {
			found.add(m[2].toLowerCase());
		}
	}
	return [...found].sort();
}

/**
 * The #deck card as a slide, sized to the deck it belongs to.
 *
 * Width follows the first section, because a banner as wide as the talk below
 * it reads as a header rather than as another card — never wider than the
 * canvas, and never flatter than 4:1. Height is a card's height, so the banner
 * lines up with the row beneath it however wide it turns out to be.
 *
 * The node is synthetic: it carries the body alone, so the settings lines never
 * reach the renderer, and it keeps the deck card's id so notes and the journal
 * still recognise it.
 */
function bannerNode(nodes: CanvasNode[], meta: Record<string, string>): CanvasNode | null {
	const card = deckCardsIn(nodes)[0];
	if (!card || !meta.__body) return null;

	const groups = nodes.filter((n) => n.type === "group");
	const widest = groups.reduce((w, g) => Math.max(w, g.width), 0);
	const first = groups
		.slice()
		.sort((a, b) => a.y - b.y || a.x - b.x)[0];

	const wide = Math.min(first?.width ?? card.width, widest || card.width) || card.width;
	// As tall as the cards it sits above, not as tall as it is wide.
	const inFirst = first
		? nodes.filter(
				(n) =>
					n.type !== "group" &&
					n.x >= first.x &&
					n.y >= first.y &&
					n.x + n.width <= first.x + first.width &&
					n.y + n.height <= first.y + first.height
			)
		: [];
	const height = inFirst.reduce((h, n) => Math.max(h, n.height), 0) || card.height;
	// Never flatter than 4:1. A first section of six cards is 9000 units wide,
	// and a banner that shape is a 90-pixel strip across a 16:9 screen — past
	// four times its height there is nothing left to look at.
	const width = Math.min(wide, height * 4);
	const x = first?.x ?? card.x;

	// Themed like every other card, rather than left as bare markdown.
	//
	// A card with no role tag is an ordinary card: text from the top left, at
	// body size, which on a banner-shaped card leaves most of it empty.
	// #banner is the role written for this card in particular: the title and
	// its lines down the left, whatever follows a rule beside it, the whole
	// thing centred against a card that is far wider than it is tall — and no
	// band, because the deck's name belongs in the column, not across the top
	// of its own opening slide. Writing a role of your own on the #deck card
	// wins, so #title, #dark or #two still work.
	// `#band` and `#noband` say where the first block goes; they do not say what
	// kind of card this is. Counting them as a role meant writing `#band` on the
	// deck card quietly took the banner layout away and left the card looking
	// blank — the switch turned off the thing it was meant to steer.
	const MODIFIERS = /^#(band|noband|dark)$/i;
	const tags = [...meta.__body.matchAll(/(^|\n)[ \t]*((?:#[\w-]+[ \t]*)+)$/gm)]
		.flatMap((m) => m[2].trim().split(/[ \t]+/));
	const tagged = tags.some((t) => !MODIFIERS.test(t));
	const text = tagged ? meta.__body : `#banner\n\n${meta.__body}`;

	return {
		...card,
		text,
		x,
		// Sat above the first section, with a card's worth of air below it.
		y: (first?.y ?? card.y) - height - 240,
		width,
		height,
	};
}

export function buildScene(
	data: CanvasData,
	sectionOverviews: boolean,
	variant = ""
): Scene {
	const meta = readDeckMeta(data.nodes);
	// The title block is not a stop, and must not show up on the map either.
	const slides = data.nodes.filter(
		(n) =>
			n.type !== "group" &&
			!(n.type === "text" && DECK_CARD.test(outsideCode(n.text ?? "")))
	);
	const groups = data.nodes.filter((n) => n.type === "group");
	const groupOf = buildGroupMap(data.nodes);
	const byId = new Map(data.nodes.map((n) => [n.id, n]));

	const out = new Map<string, CanvasEdge[]>();
	for (const e of data.edges) {
		if (!out.has(e.fromNode)) out.set(e.fromNode, []);
		out.get(e.fromNode)!.push(e);
	}
	for (const [, list] of out) {
		list.sort((a, b) =>
			compareRank(edgeRank(a, byId.get(a.toNode)), edgeRank(b, byId.get(b.toNode)))
		);
	}

	const stops: Stop[] = [];
	const visited = new Set<string>();
	const openedGroups = new Set<string>();

	// The banner: the #deck card's own content, presented first.
	//
	// Everything under the settings used to be squeezed into the thin band over
	// a section overview and seen for two seconds a talk. Written as a card it
	// is the opening slide, and the card sits across the top of the canvas the
	// way a header sits on a profile. A #deck card carrying only settings has
	// no banner and no extra stop, so decks that already exist are untouched.
	const banner = bannerNode(data.nodes, meta);
	if (banner) {
		slides.unshift(banner);
		stops.push({ kind: "node", node: banner });
		// Placed by hand, so the sweep that picks up cards no edge reached must
		// not pick it up again — it did, and the banner closed the talk twice.
		visited.add(banner.id);
	}

	const push = (node: CanvasNode) => {
		const group = groupOf.get(node.id);
		// Entering a new section: zoom out to frame the whole group first.
		if (sectionOverviews && group && !openedGroups.has(group.id)) {
			openedGroups.add(group.id);
			stops.push({ kind: "group", node: group, group });
		}
		stops.push({ kind: "node", node, group });
	};

	// Depth-first: a branch of the mind map is told to its end before we
	// back out and take the next one. That is how people actually talk.
	const walk = (node: CanvasNode) => {
		if (visited.has(node.id)) return;
		visited.add(node.id);
		// Left out of this talk, but still a junction: its children are reached
		// through it, so skipping it must not break the chain.
		if (variant && !inVariant(node, variant)) {
			for (const edge of out.get(node.id) ?? []) {
				const next = byId.get(edge.toNode);
				if (next && next.type !== "group") walk(next);
			}
			return;
		}
		push(node);
		for (const edge of out.get(node.id) ?? []) {
			const next = byId.get(edge.toNode);
			if (next && next.type !== "group") walk(next);
		}
	};

	const start = pickStart(slides, data.edges);
	if (start) walk(start);

	// Anything the edges never reached still belongs in the deck, in reading order.
	const orphans = slides
		.filter((n) => !visited.has(n.id) && (!variant || inVariant(n, variant)))
		.sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x);
	for (const n of orphans) walk(n);

	return {
		meta,
		data,
		slides,
		groups,
		stops,
		bounds: boundsOf(data.nodes),
		groupOf,
	};
}
